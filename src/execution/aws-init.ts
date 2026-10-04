import { randomUUID } from 'node:crypto';
import {
  DescribeContinuousBackupsCommand,
  DescribeTableCommand,
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { DescribeKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { GetBucketVersioningCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { validateState } from '../state/index.ts';
import type { StateFile } from '../state/types.ts';
import type { DeploymentScope } from './types.ts';
import { scopeKey } from './backends.ts';
import { lockKey } from './aws.ts';

export interface AwsInitOptions {
  tableName: string;
  kmsKeyId: string;
  bucket: string;
  scope: DeploymentScope;
  expectedIdentity?: AwsInitResult['identity'];
  dynamodb?: DynamoDBClient;
  document?: DynamoDBDocumentClient;
  kms?: KMSClient;
  s3?: S3Client;
}

export interface AwsInitResult {
  status: 'initialized' | 'already-initialized';
  state: StateFile;
  identity: { tableArn: string; kmsKeyArn: string; bucketRegion: string };
}

function conditionalFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TransactionCanceledException' ||
      error.name === 'ConditionalCheckFailedException')
  );
}

/** Checks the provisioned AWS resources, then conditionally seeds one empty deployment state. */
export async function initializeAwsBackend({
  tableName,
  kmsKeyId,
  bucket,
  scope,
  expectedIdentity,
  dynamodb = new DynamoDBClient({}),
  document,
  kms = new KMSClient({}),
  s3 = new S3Client({}),
}: AwsInitOptions): Promise<AwsInitResult> {
  if (!tableName || !kmsKeyId || !bucket)
    throw new Error('AWS init needs a tableName, kmsKeyId, and bucket.');
  const store =
    document ??
    DynamoDBDocumentClient.from(dynamodb, { marshallOptions: { removeUndefinedValues: true } });
  const [table, backups, key, bucketHead, versioning] = await Promise.all([
    dynamodb.send(new DescribeTableCommand({ TableName: tableName })),
    dynamodb.send(new DescribeContinuousBackupsCommand({ TableName: tableName })),
    kms.send(new DescribeKeyCommand({ KeyId: kmsKeyId })),
    s3.send(new HeadBucketCommand({ Bucket: bucket })),
    s3.send(new GetBucketVersioningCommand({ Bucket: bucket })),
  ]);
  const description = table.Table;
  if (
    description?.TableStatus !== 'ACTIVE' ||
    description.KeySchema?.find((key) => key.KeyType === 'HASH')?.AttributeName !== 'PK' ||
    description.KeySchema?.find((key) => key.KeyType === 'RANGE')?.AttributeName !== 'SK' ||
    description.AttributeDefinitions?.find((attribute) => attribute.AttributeName === 'PK')
      ?.AttributeType !== 'S' ||
    description.AttributeDefinitions?.find((attribute) => attribute.AttributeName === 'SK')
      ?.AttributeType !== 'S'
  ) {
    throw new Error(`DynamoDB table ${tableName} must be ACTIVE with string PK and SK keys.`);
  }
  if (
    backups.ContinuousBackupsDescription?.PointInTimeRecoveryDescription
      ?.PointInTimeRecoveryStatus !== 'ENABLED'
  ) {
    throw new Error(`Enable point-in-time recovery on DynamoDB table ${tableName} before init.`);
  }
  if (versioning.Status !== 'Enabled')
    throw new Error(`Enable versioning on S3 bucket ${bucket} before init.`);
  if (
    key.KeyMetadata?.KeyState !== 'Enabled' ||
    key.KeyMetadata.KeyUsage !== 'ENCRYPT_DECRYPT' ||
    key.KeyMetadata.KeySpec !== 'SYMMETRIC_DEFAULT'
  ) {
    throw new Error(`KMS key ${kmsKeyId} must be an enabled symmetric encryption key.`);
  }
  const tableArn = description.TableArn;
  const kmsKeyArn = key.KeyMetadata.Arn;
  const tableRegion = tableArn?.split(':')[3];
  const keyRegion = kmsKeyArn?.split(':')[3];
  const bucketRegion = bucketHead.BucketRegion;
  if (
    !tableArn ||
    !kmsKeyArn ||
    !tableRegion ||
    !keyRegion ||
    !bucketRegion ||
    tableRegion !== keyRegion ||
    tableRegion !== bucketRegion
  ) {
    throw new Error('AWS table, KMS key, and S3 bucket must have identifiable matching regions.');
  }
  const identity = { tableArn, kmsKeyArn, bucketRegion };
  if (
    expectedIdentity &&
    (expectedIdentity.tableArn !== tableArn ||
      expectedIdentity.kmsKeyArn !== kmsKeyArn ||
      expectedIdentity.bucketRegion !== bucketRegion)
  ) {
    throw new Error(
      'AWS backend identity changed. Review the target and rerun init --reconfigure.',
    );
  }

  const PK = `DEPLOY#${scopeKey(scope)}`;
  const chain = { id: scope.chainId, genesisHash: scope.genesisHash };
  const read = async (): Promise<StateFile | null> => {
    const found = await store.send(
      new GetCommand({ TableName: tableName, Key: { PK, SK: 'STATE' }, ConsistentRead: true }),
    );
    if (!found.Item) return null;
    if (typeof found.Item.version !== 'string' || !found.Item.version)
      throw new Error('Remote state has no storage version.');
    const state = validateState(found.Item.value);
    if (
      state.chain.id !== chain.id ||
      state.chain.genesisHash.toLowerCase() !== chain.genesisHash.toLowerCase()
    ) {
      throw new Error('Remote state belongs to a different chain.');
    }
    return state;
  };
  const existing = await read();
  if (existing) return { status: 'already-initialized', state: existing, identity };
  const history = await store.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': PK, ':prefix': 'J#' },
      ConsistentRead: true,
      Limit: 1,
    }),
  );
  if ((history.Items?.length ?? 0) > 0)
    throw new Error(
      'Remote journal exists without state. Reconcile it before initializing this scope.',
    );
  const state: StateFile = { formatVersion: 1, chain, resources: {} };
  const now = Date.now();
  try {
    await store.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: tableName,
              Key: { PK, SK: 'J#HEAD' },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            ConditionCheck: {
              TableName: tableName,
              Key: { PK: lockKey({ ...scope, kind: 'deployment' }), SK: 'LEASE' },
              ConditionExpression: 'attribute_not_exists(#expiresAt) OR #expiresAt < :now',
              ExpressionAttributeNames: { '#expiresAt': 'expiresAt' },
              ExpressionAttributeValues: { ':now': now },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                PK,
                SK: 'STATE',
                version: randomUUID(),
                value: state,
                at: new Date(now).toISOString(),
                principal: 'etherplan-init',
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (!conditionalFailure(error)) throw error;
    const winner = await read();
    if (winner) return { status: 'already-initialized', state: winner, identity };
    throw new Error(
      'Remote journal or writer already exists without state. Reconcile it before initializing this scope.',
      { cause: error },
    );
  }
  return { status: 'initialized', state, identity };
}
