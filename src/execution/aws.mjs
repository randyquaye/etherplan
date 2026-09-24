import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { hashJson, canonicalJson } from '../identity.mjs';
import { scopeKey } from './backends.mjs';

const lockKey = scope => `LOCK#${[scope.project, scope.environment, scope.chainId, scope.genesisHash, scope.kind, scope.label ?? scope.address].map(encodeURIComponent).join('/')}`;
const deploymentKey = scope => `DEPLOY#${scopeKey(scope)}`;
const isConditional = error => error?.name === 'ConditionalCheckFailedException' || error?.name === 'TransactionCanceledException';

function requireFence(fence) {
  if (!Array.isArray(fence) || fence.length < 2 || fence.some(item => !Number.isSafeInteger(item.token) || !item.holderId)) throw new Error('A deployment and signer fencing token are required for every write.');
  return fence.map(({ scope, token, holderId }) => ({
    ConditionCheck: {
      TableName: undefined,
      Key: { PK: lockKey(scope), SK: 'LEASE' },
      ConditionExpression: '#token = :token AND #holderId = :holderId AND #expiresAt > :now',
      ExpressionAttributeNames: { '#token': 'token', '#holderId': 'holderId', '#expiresAt': 'expiresAt' },
      ExpressionAttributeValues: { ':token': token, ':holderId': holderId, ':now': Date.now() },
    },
  }));
}

function checks(tableName, fence) {
  return requireFence(fence).map(item => ({ ConditionCheck: { ...item.ConditionCheck, TableName: tableName } }));
}

export function createAwsBackend({ tableName, kmsKeyId, bucket, prefix = 'etherplan', dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }), kms = new KMSClient({}), s3 = new S3Client({}) }) {
  if (!tableName || !kmsKeyId) throw new Error('AWS backend needs tableName and kmsKeyId.');
  const send = command => dynamodb.send(command);

  const lockProvider = {
    async acquire(scope, holder, ttlMs) {
      const key = { PK: lockKey(scope), SK: 'LEASE' };
      const now = Date.now();
      let item;
      try {
        const result = await send(new UpdateCommand({
          TableName: tableName, Key: key,
          UpdateExpression: 'SET #token = if_not_exists(#token, :zero) + :one, #holderId = :holderId, #holder = :holder, #expiresAt = :expiresAt, #updatedAt = :updatedAt',
          ConditionExpression: 'attribute_not_exists(#expiresAt) OR #expiresAt < :now',
          ExpressionAttributeNames: { '#token': 'token', '#holderId': 'holderId', '#holder': 'holder', '#expiresAt': 'expiresAt', '#updatedAt': 'updatedAt' },
          ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':holderId': holder.id, ':holder': holder, ':expiresAt': now + ttlMs, ':updatedAt': new Date(now).toISOString(), ':now': now },
          ReturnValues: 'ALL_NEW',
        }));
        item = result.Attributes;
      } catch (error) {
        if (!isConditional(error)) throw error;
        const current = await send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }));
        const holderName = current.Item?.holder?.principal ?? 'unknown';
        const locked = new Error(`Writer lock is held by ${holderName} until ${new Date(current.Item?.expiresAt ?? 0).toISOString()}.`);
        locked.code = 'state-locked';
        locked.holder = current.Item?.holder ?? null;
        throw locked;
      }
      const fencingToken = item.token;
      const condition = { '#token': 'token', '#holderId': 'holderId', '#expiresAt': 'expiresAt' };
      const values = { ':token': fencingToken, ':holderId': holder.id };
      return {
        fencingToken,
        async renew() {
          const current = Date.now();
          await send(new UpdateCommand({ TableName: tableName, Key: key,
            UpdateExpression: 'SET #expiresAt = :newExpiry, #updatedAt = :updatedAt',
            ConditionExpression: '#token = :token AND #holderId = :holderId AND #expiresAt > :now',
            ExpressionAttributeNames: { ...condition, '#updatedAt': 'updatedAt' },
            ExpressionAttributeValues: { ...values, ':newExpiry': current + ttlMs, ':updatedAt': new Date(current).toISOString(), ':now': current },
          }));
        },
        async assertHeld() {
          const found = await send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }));
          if (found.Item?.token !== fencingToken || found.Item?.holderId !== holder.id || found.Item.expiresAt <= Date.now()) throw new Error('Writer lease is no longer held.');
        },
        async release() {
          try {
            await send(new UpdateCommand({ TableName: tableName, Key: key,
              UpdateExpression: 'SET #expiresAt = :zero, #updatedAt = :updatedAt REMOVE #holderId, #holder',
              ConditionExpression: '#token = :token AND #holderId = :holderId',
              ExpressionAttributeNames: { ...condition, '#holder': 'holder', '#updatedAt': 'updatedAt' },
              ExpressionAttributeValues: { ...values, ':zero': 0, ':updatedAt': new Date().toISOString() },
            }));
          } catch (error) { if (!isConditional(error)) throw error; }
        },
      };
    },
    async inspect(scope) {
      const found = await send(new GetCommand({ TableName: tableName, Key: { PK: lockKey(scope), SK: 'LEASE' }, ConsistentRead: true }));
      const item = found.Item;
      return item ? { holder: item.holder ?? null, expiresAt: item.expiresAt ? new Date(item.expiresAt).toISOString() : null, active: Boolean(item.holderId && item.expiresAt > Date.now()), fencingToken: item.token } : null;
    },
  };

  const stateStore = {
    async read(scope) {
      const found = await send(new GetCommand({ TableName: tableName, Key: { PK: deploymentKey(scope), SK: 'STATE' }, ConsistentRead: true }));
      return found.Item ? { version: found.Item.version, value: found.Item.value, at: found.Item.at, principal: found.Item.principal } : null;
    },
    async compareAndSwap(scope, expectedVersion, state, { fence } = {}) {
      const version = randomUUID();
      const at = new Date().toISOString();
      const item = { PK: deploymentKey(scope), SK: 'STATE', version, value: state, at, principal: fence[0].principal };
      await send(new TransactWriteCommand({ TransactItems: [
        ...checks(tableName, fence),
        { Put: { TableName: tableName, Item: item, ConditionExpression: expectedVersion === null ? 'attribute_not_exists(#version)' : '#version = :expected', ExpressionAttributeNames: { '#version': 'version' }, ...(expectedVersion === null ? {} : { ExpressionAttributeValues: { ':expected': expectedVersion } }) } },
      ] }));
      return { version, value: state, at, principal: item.principal };
    },
  };

  const journalStore = {
    async head(scope) {
      const found = await send(new GetCommand({ TableName: tableName, Key: { PK: deploymentKey(scope), SK: 'J#HEAD' }, ConsistentRead: true }));
      return found.Item ? { sequence: found.Item.sequence, recordHash: found.Item.recordHash } : null;
    },
    async *read(scope) {
      let ExclusiveStartKey;
      do {
        const page = await send(new QueryCommand({ TableName: tableName, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)', ExpressionAttributeValues: { ':pk': deploymentKey(scope), ':prefix': 'J#' }, ConsistentRead: true, ExclusiveStartKey }));
        for (const item of page.Items ?? []) if (/^J#\d{12}$/.test(item.SK)) yield item.record;
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
    },
    async append(scope, record, { expectedSequence, expectedPreviousHash, fence } = {}) {
      if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 1 ||
        record.sequence !== expectedSequence || record.previousHash !== expectedPreviousHash ||
        (expectedSequence === 1 ? expectedPreviousHash !== null : !/^0x[0-9a-fA-F]{64}$/.test(expectedPreviousHash ?? '')) || !fence) {
        throw new Error('Journal append needs the exact expected sequence, predecessor, and fence.');
      }
      const PK = deploymentKey(scope);
      const previous = expectedSequence - 1;
      await send(new TransactWriteCommand({ TransactItems: [
        ...checks(tableName, fence),
        { Update: { TableName: tableName, Key: { PK, SK: 'J#HEAD' }, UpdateExpression: 'SET #sequence = :sequence, #recordHash = :recordHash, #at = :at', ConditionExpression: previous === 0 ? 'attribute_not_exists(#sequence)' : '#sequence = :previous AND #recordHash = :previousHash', ExpressionAttributeNames: { '#sequence': 'sequence', '#recordHash': 'recordHash', '#at': 'at' }, ExpressionAttributeValues: { ':sequence': expectedSequence, ':recordHash': record.recordHash, ':at': record.at, ...(previous === 0 ? {} : { ':previous': previous, ':previousHash': expectedPreviousHash }) } } },
        { Put: { TableName: tableName, Item: { PK, SK: `J#${String(expectedSequence).padStart(12, '0')}`, record }, ConditionExpression: 'attribute_not_exists(PK)' } },
      ] }));
      return record;
    },
  };

  const journalCipher = {
    async encrypt(plaintext, context) {
      const EncryptionContext = Object.fromEntries(Object.entries(context).map(([key, value]) => [key, String(value)]));
      const key = await kms.send(new GenerateDataKeyCommand({ KeyId: kmsKeyId, KeySpec: 'AES_256', EncryptionContext }));
      if (!key.Plaintext || !key.CiphertextBlob) throw new Error('KMS did not return an envelope key.');
      const material = Buffer.from(key.Plaintext);
      try {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', material, iv);
        cipher.setAAD(Buffer.from(canonicalJson(EncryptionContext)));
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        return { algorithm: 'AES-256-GCM+KMS', encryptedKey: Buffer.from(key.CiphertextBlob).toString('base64'), iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
      } finally { material.fill(0); key.Plaintext.fill(0); }
    },
    async decrypt(value, context) {
      if (value?.algorithm !== 'AES-256-GCM+KMS') throw new Error('Unsupported journal ciphertext.');
      const EncryptionContext = Object.fromEntries(Object.entries(context).map(([key, item]) => [key, String(item)]));
      const key = await kms.send(new DecryptCommand({ KeyId: kmsKeyId, CiphertextBlob: Buffer.from(value.encryptedKey, 'base64'), EncryptionContext }));
      if (!key.Plaintext) throw new Error('KMS did not decrypt the envelope key.');
      const material = Buffer.from(key.Plaintext);
      try {
        const decipher = createDecipheriv('aes-256-gcm', material, Buffer.from(value.iv, 'base64'));
        decipher.setAAD(Buffer.from(canonicalJson(EncryptionContext)));
        decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]);
      } finally { material.fill(0); key.Plaintext.fill(0); }
    },
  };

  const planStore = bucket ? {
    async put(scope, plan) {
      if (hashJson(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'planHash'))) !== plan.planHash) throw new Error('Plan hash does not match its contents.');
      const Key = `${prefix}/${scopeKey(scope)}/plans/${plan.planHash}.json`;
      try {
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key, Body: canonicalJson(plan), ContentType: 'application/json', IfNoneMatch: '*', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: kmsKeyId }));
      } catch (error) {
        if (error?.$metadata?.httpStatusCode !== 412) throw error;
        const existing = await this.read(scope, plan.planHash);
        if (canonicalJson(existing) !== canonicalJson(plan)) throw new Error('An immutable plan object already exists with different contents.');
      }
      return { bucket, key: Key, planHash: plan.planHash };
    },
    async read(scope, planHash) {
      const Key = `${prefix}/${scopeKey(scope)}/plans/${planHash}.json`;
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key }));
      const plan = JSON.parse(await result.Body.transformToString());
      if (plan.planHash !== planHash || hashJson(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'planHash'))) !== planHash) throw new Error('Stored plan hash differs from its contents.');
      return plan;
    },
  } : null;

  return { stateStore, journalStore, lockProvider, journalCipher, planStore };
}
