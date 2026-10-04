import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeAwsBackend } from '../src/execution/aws-init.ts';
import { init } from '../src/cli/commands/init.ts';
import { assertAwsBackendInitialized } from '../src/cli/environment.ts';

const scope = {
  project: 'sample',
  environment: 'test',
  chainId: 31337,
  genesisHash: `0x${'ab'.repeat(32)}`,
  label: 'blue',
};

function awsFixture({
  journal = false,
  writer = false,
  versioning = 'Enabled',
  pitr = 'ENABLED',
} = {}) {
  let state = null;
  let writes = 0;
  const dynamodb = {
    async send(command) {
      if (command.constructor.name === 'DescribeTableCommand')
        return {
          Table: {
            TableStatus: 'ACTIVE',
            TableArn: 'arn:aws:dynamodb:eu-west-2:123456789012:table/etherplan-test',
            KeySchema: [
              { AttributeName: 'PK', KeyType: 'HASH' },
              { AttributeName: 'SK', KeyType: 'RANGE' },
            ],
            AttributeDefinitions: [
              { AttributeName: 'PK', AttributeType: 'S' },
              { AttributeName: 'SK', AttributeType: 'S' },
            ],
          },
        };
      if (command.constructor.name === 'DescribeContinuousBackupsCommand')
        return {
          ContinuousBackupsDescription: {
            PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: pitr },
          },
        };
      throw new Error(`Unexpected DynamoDB command ${command.constructor.name}`);
    },
  };
  const document = {
    async send(command) {
      if (command.constructor.name === 'GetCommand')
        return { Item: state ? { version: 'test-version', value: state } : undefined };
      if (command.constructor.name === 'QueryCommand')
        return { Items: journal ? [{ SK: 'J#HEAD' }] : [] };
      if (command.constructor.name === 'TransactWriteCommand') {
        writes++;
        const [head, lease, put] = command.input.TransactItems;
        assert.equal(head.ConditionCheck.Key.SK, 'J#HEAD');
        assert.match(lease.ConditionCheck.Key.PK, /\/deployment\/blue$/);
        assert.equal(put.Put.Item.SK, 'STATE');
        if (journal || writer || state)
          throw Object.assign(new Error('condition failed'), {
            name: 'TransactionCanceledException',
          });
        state = put.Put.Item.value;
        return {};
      }
      throw new Error(`Unexpected document command ${command.constructor.name}`);
    },
  };
  const kms = {
    async send(command) {
      assert.equal(command.constructor.name, 'DescribeKeyCommand');
      return {
        KeyMetadata: {
          KeyState: 'Enabled',
          KeyUsage: 'ENCRYPT_DECRYPT',
          KeySpec: 'SYMMETRIC_DEFAULT',
          Arn: 'arn:aws:kms:eu-west-2:123456789012:key/test',
        },
      };
    },
  };
  const s3 = {
    async send(command) {
      if (command.constructor.name === 'HeadBucketCommand') return { BucketRegion: 'eu-west-2' };
      if (command.constructor.name === 'GetBucketVersioningCommand') return { Status: versioning };
      throw new Error(`Unexpected S3 command ${command.constructor.name}`);
    },
  };
  return {
    dynamodb,
    document,
    kms,
    s3,
    get writes() {
      return writes;
    },
    get state() {
      return state;
    },
  };
}

function input(fixture) {
  return {
    tableName: 'etherplan-test',
    kmsKeyId: 'alias/etherplan-test',
    bucket: 'etherplan-test-plans',
    scope,
    dynamodb: fixture.dynamodb,
    document: fixture.document,
    kms: fixture.kms,
    s3: fixture.s3,
  };
}

test('AWS init writes an empty state once and preserves it on repeat', async () => {
  const fixture = awsFixture();
  const first = await initializeAwsBackend(input(fixture));
  assert.equal(first.status, 'initialized');
  assert.deepEqual(first.state, {
    formatVersion: 1,
    chain: { id: scope.chainId, genesisHash: scope.genesisHash },
    resources: {},
  });
  const second = await initializeAwsBackend(input(fixture));
  assert.equal(second.status, 'already-initialized');
  assert.equal(fixture.writes, 1);
  assert.deepEqual(fixture.state, first.state);
});

test('AWS init will not seed state over journal history or an active writer', async () => {
  const journal = awsFixture({ journal: true });
  await assert.rejects(initializeAwsBackend(input(journal)), /journal exists without state/);
  assert.equal(journal.writes, 0);
  const writer = awsFixture({ writer: true });
  await assert.rejects(initializeAwsBackend(input(writer)), /journal or writer already exists/);
  assert.equal(writer.writes, 1);
});

test('AWS init checks recovery settings before writing state', async () => {
  const bucket = awsFixture({ versioning: 'Suspended' });
  await assert.rejects(initializeAwsBackend(input(bucket)), /Enable versioning/);
  assert.equal(bucket.writes, 0);
  const table = awsFixture({ pitr: 'DISABLED' });
  await assert.rejects(initializeAwsBackend(input(table)), /point-in-time recovery/);
  assert.equal(table.writes, 0);
});

test('AWS init refuses an identity change before touching state', async () => {
  const fixture = awsFixture();
  await assert.rejects(
    initializeAwsBackend({
      ...input(fixture),
      expectedIdentity: {
        tableArn: 'arn:aws:dynamodb:eu-west-2:999999999999:table/etherplan-test',
        kmsKeyArn: 'arn:aws:kms:eu-west-2:123456789012:key/test',
        bucketRegion: 'eu-west-2',
      },
    }),
    /identity changed/,
  );
  assert.equal(fixture.writes, 0);
});

test('CLI init stops on existing local state before contacting AWS', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-init-'));
  const stateFile = path.join(directory, '.etherplan', 'state.json');
  try {
    await mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(stateFile, '{}');
    await assert.rejects(
      init({
        options: { backend: path.join(directory, 'backend.json') },
        specFile: path.join(directory, 'main.ethp'),
        spec: { chainId: 31337 },
        client: {
          getChainId() {
            throw new Error('RPC must not be used');
          },
        },
        stateFile,
      }),
      /Local recovery files exist/,
    );
    assert.equal(await readFile(stateFile, 'utf8'), '{}');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI init records backend identity and requires reconfigure after a target change', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-init-'));
  const configFile = path.join(directory, 'backend.json');
  const stateFile = path.join(directory, '.etherplan', 'state.json');
  const markerFile = path.join(directory, '.etherplan', 'default', 'backend-init.json');
  const config = {
    kind: 'aws',
    tableName: 'etherplan-test',
    kmsKeyId: 'alias/test',
    bucket: 'etherplan-plans',
    confirmations: 12,
    scope: { project: 'sample', environment: 'test', label: 'blue' },
  };
  const client = {
    async getChainId() {
      return 31337;
    },
    async getBlock() {
      return { hash: scope.genesisHash };
    },
  };
  let calls = 0;
  const received = [];
  const initialize = async (options) => {
    calls++;
    received.push(options);
    return {
      status: 'initialized',
      state: {
        formatVersion: 1,
        chain: { id: 31337, genesisHash: scope.genesisHash },
        resources: {},
      },
      identity: {
        tableArn: 'arn:aws:dynamodb:eu-west-2:123456789012:table/etherplan-test',
        kmsKeyArn: 'arn:aws:kms:eu-west-2:123456789012:key/test',
        bucketRegion: 'eu-west-2',
      },
    };
  };
  const reports = [];
  const args = {
    options: { backend: configFile },
    specFile: path.join(directory, 'main.ethp'),
    spec: { chainId: 31337 },
    client,
    stateFile,
    initialize,
    report: (value) => reports.push(value),
  };
  try {
    await writeFile(configFile, JSON.stringify(config));
    await init(args);
    const marker = JSON.parse(await readFile(markerFile, 'utf8'));
    assert.equal(marker.formatVersion, 1);
    assert.equal(
      marker.identity.tableArn,
      'arn:aws:dynamodb:eu-west-2:123456789012:table/etherplan-test',
    );
    assert.equal(calls, 1);
    assert.equal(reports[0].status, 'initialized');
    await init(args);
    assert.equal(calls, 2);
    assert.equal(received[1].expectedIdentity.tableArn, marker.identity.tableArn);
    await writeFile(configFile, JSON.stringify({ ...config, bucket: 'another-bucket' }));
    await assert.rejects(
      assertAwsBackendInitialized(configFile, directory),
      /configuration changed/,
    );
    await assert.rejects(init(args), /--reconfigure/);
    assert.equal(calls, 2);
    await init({ ...args, options: { ...args.options, reconfigure: true } });
    assert.equal(calls, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI init keeps workspace markers and recovery plans separate', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-init-workspace-'));
  const stateFile = path.join(directory, '.etherplan', 'staging', 'state.json');
  const plans = path.join(directory, '.etherplan', 'staging', 'plans');
  try {
    await mkdir(plans, { recursive: true });
    await writeFile(path.join(plans, 'unfinished.json'), '{}');
    await assert.rejects(
      init({
        options: { backend: path.join(directory, 'backend.json') },
        specFile: path.join(directory, 'main.ethp'),
        spec: { chainId: 31337 },
        workspace: 'staging',
        client: {
          getChainId() {
            throw new Error('RPC must not be used');
          },
        },
        stateFile,
      }),
      /Local recovery files exist/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
