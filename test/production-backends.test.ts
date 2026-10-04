import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createAwsBackend } from '../src/execution/aws.ts';
import {
  acquireLeases,
  deploymentScope,
  encryptionContext,
  openStoredJournal,
  readStoredJournal,
  scopeKey,
} from '../src/execution/backends.ts';
import { applyPlan } from '../src/execution/index.ts';
import { signEnvelope } from '../src/execution/transactions.ts';
import { createPlan } from '../src/planning/index.ts';
import { deployerA, deployerB, fixture, fixtureMany, startAnvil } from './execution/chain.ts';

const chainIdentity = { id: 31337, genesisHash: `0x${'aa'.repeat(32)}` };
const scope = deploymentScope({ project: 'test', environment: 'dev', label: 'one' }, chainIdentity);
const planHash = `0x${'bb'.repeat(32)}`;

import { memoryBackend as createMemoryBackend } from './execution/memory-backend.ts';
const memoryBackend = () => createMemoryBackend(scope);

test('scope keys change for every deployment identity field', () => {
  const variants = [
    { ...scope, project: 'other' },
    { ...scope, environment: 'prod' },
    { ...scope, chainId: 1 },
    { ...scope, genesisHash: `0x${'cc'.repeat(32)}` },
    { ...scope, label: 'two' },
  ];
  for (const variant of variants) assert.notEqual(scopeKey(scope), scopeKey(variant));
});

test('a signer lease blocks another label and old fencing tokens cannot write', async () => {
  const backend = memoryBackend();
  const addresses = [deployerA.address];
  const first = await acquireLeases({
    lockProvider: backend.lockProvider,
    scope,
    addresses,
    planHash,
    principal: 'runner-a',
  });
  const otherLabel = { ...scope, label: 'two' };
  await assert.rejects(
    acquireLeases({
      lockProvider: backend.lockProvider,
      scope: otherLabel,
      addresses,
      planHash,
      principal: 'runner-b',
    }),
    /Writer lock is held/,
  );
  await first.release();
  const second = await acquireLeases({
    lockProvider: backend.lockProvider,
    scope: otherLabel,
    addresses,
    planHash,
    principal: 'runner-b',
  });
  try {
    assert.ok(second.fence[1].token > first.fence[1].token);
    await assert.rejects(first.assertHeld(), /Writer lease is lost/);
    await assert.rejects(
      backend.stateStore.compareAndSwap(scope, null, { sample: true }, { fence: first.fence }),
      /fence/,
    );
    await assert.rejects(
      backend.journalStore.append(
        scope,
        { sequence: 1, previousHash: null },
        { expectedSequence: 1, expectedPreviousHash: null, fence: first.fence },
      ),
      /fence/,
    );
  } finally {
    await second.release();
  }
});

test('stored journal detects a changed record and a missing tail', async () => {
  const backend = memoryBackend();
  const journal = await openStoredJournal({
    ...backend,
    scope,
    fence: [],
    assertHeld: async () => {},
  });
  const record = await journal
    .append({
      planHash,
      chain: chainIdentity,
      actionId: 'contract:alpha',
      phase: 'intent',
      signer: deployerA.address,
      nonce: '0',
      principal: 'test-runner',
    })
    .catch(() => null);
  assert.equal(record, null, 'the store rejects writes without a fence');

  const original = {
    formatVersion: 2,
    sequence: 1,
    previousHash: null,
    planHash,
    chain: chainIdentity,
    actionId: 'contract:alpha',
    phase: 'intent',
    signer: deployerA.address,
    nonce: '0',
    principal: 'test-runner',
    at: new Date().toISOString(),
  };
  const { hashJson } = await import('../src/identity.ts');
  backend.records.push({ ...original, recordHash: hashJson(original) });
  backend.records[0].nonce = '1';
  await assert.rejects(
    openStoredJournal({ ...backend, scope, fence: [], assertHeld: async () => {} }),
    /Journal integrity failure/,
  );
  backend.records[0].nonce = '0';
  const savedHead = backend.journalStore.head;
  backend.journalStore.head = async () => ({ sequence: 2, recordHash: `0x${'dd'.repeat(32)}` });
  await assert.rejects(
    openStoredJournal({ ...backend, scope, fence: [], assertHeld: async () => {} }),
    /Journal head differs/,
  );
  backend.journalStore.head = savedHead;
});

test('AWS journal rejects an invalid first predecessor before any write', async () => {
  let writes = 0;
  const backend = createAwsBackend({
    tableName: 'test',
    kmsKeyId: 'test',
    dynamodb: {
      async send() {
        writes++;
      },
    },
    kms: {},
    s3: {},
  });
  const record = { sequence: 1, previousHash: planHash };
  await assert.rejects(
    backend.journalStore.append(scope, record, {
      expectedSequence: 1,
      expectedPreviousHash: planHash,
      fence: [],
    }),
    /exact expected sequence/,
  );
  assert.equal(writes, 0);
});

test('AWS state and journal writes check both leases transactionally', async () => {
  const commands = [];
  const backend = createAwsBackend({
    tableName: 'test',
    kmsKeyId: 'test',
    dynamodb: {
      async send(command) {
        commands.push(command);
      },
    },
    kms: {},
    s3: {},
  });
  const fence = [
    {
      scope: { ...scope, kind: 'deployment' },
      token: 4,
      holderId: 'runner',
      principal: 'test-runner',
    },
    {
      scope: { ...scope, kind: 'signer', address: deployerA.address },
      token: 9,
      holderId: 'runner',
      principal: 'test-runner',
    },
  ];
  await backend.stateStore.compareAndSwap(scope, null, { sample: true }, { fence });
  await backend.journalStore.append(
    scope,
    { sequence: 1, previousHash: null, recordHash: planHash, at: new Date().toISOString() },
    { expectedSequence: 1, expectedPreviousHash: null, fence },
  );
  assert.equal(commands.length, 2);
  for (const [index, command] of commands.entries()) {
    assert.equal(command.constructor.name, 'TransactWriteCommand');
    const items = command.input.TransactItems;
    assert.equal(items.length, index === 0 ? 3 : 4);
    assert.deepEqual(
      items.slice(0, 2).map((item) => item.ConditionCheck.ExpressionAttributeValues[':token']),
      [4, 9],
    );
    for (const item of items.slice(0, 2))
      assert.match(
        item.ConditionCheck.ConditionExpression,
        /#token = :token AND #holderId = :holderId AND #expiresAt > :now/,
      );
  }
});

test('AWS saves the signer index in the same fenced transaction as a signature', async () => {
  const commands = [];
  const backend = createAwsBackend({
    tableName: 'test',
    kmsKeyId: 'test',
    dynamodb: {
      async send(command) {
        commands.push(command);
        return { Items: [] };
      },
    },
    kms: {},
    s3: {},
  });
  const fence = [
    { scope: { ...scope, kind: 'deployment' }, token: 4, holderId: 'runner' },
    {
      scope: { ...scope, kind: 'signer', address: deployerA.address },
      token: 9,
      holderId: 'runner',
    },
  ];
  const transactionHash = `0x${'34'.repeat(32)}`;
  await backend.journalStore.append(
    scope,
    {
      phase: 'signed',
      sequence: 1,
      previousHash: null,
      recordHash: planHash,
      at: new Date().toISOString(),
      planHash,
      actionId: 'contract:alpha',
      signer: deployerA.address,
      nonce: '0',
      transactionHash,
    },
    { expectedSequence: 1, expectedPreviousHash: null, fence },
  );
  const items = commands[0].input.TransactItems;
  assert.equal(items.length, 5);
  assert.equal(items[4].Put.Item.SK, `TX#${transactionHash}`);
  assert.equal(items[4].Put.Item.signed.label, scope.label);
  for await (const _ of backend.journalStore.signedForSigner(scope, deployerA.address)) {
  }
  assert.equal(commands[1].input.ConsistentRead, true);
  assert.equal(commands[1].input.ExpressionAttributeValues[':pk'], items[4].Put.Item.PK);
});

test('AWS planning reads verified creation evidence without decrypting journal signatures', async () => {
  const { hashJson } = await import('../src/identity.ts');
  const hash = (digit) => `0x${digit.repeat(64)}`;
  const proof = {
    kind: 'create2',
    chain: chainIdentity,
    transactionHash: hash('1'),
    creator: deployerA.address,
    blockNumber: '7',
    blockHash: hash('2'),
    address: deployerA.address,
    initcodeHash: hash('3'),
    codeHash: hash('4'),
    factory: { address: deployerB.address, codeHash: hash('5') },
    salt: hash('6'),
  };
  const fields = {
    formatVersion: 2,
    sequence: 1,
    previousHash: null,
    planHash,
    chain: chainIdentity,
    actionId: 'contract:alpha',
    phase: 'verified',
    address: proof.address,
    codeHash: proof.codeHash,
    proofHash: hash('7'),
    verification: { status: 'verified' },
    creationProof: proof,
    outcome: 'applied',
    transactionHash: proof.transactionHash,
    principal: 'planner-test',
    at: new Date().toISOString(),
  };
  const record = { ...fields, recordHash: hashJson(fields) };
  const commands = [];
  const backend = createAwsBackend({
    tableName: 'test',
    kmsKeyId: 'test',
    dynamodb: {
      async send(command) {
        commands.push(command);
        if (command.constructor.name === 'QueryCommand')
          return { Items: [{ SK: 'J#HEAD' }, { SK: 'J#000000000001', record }] };
        if (command.constructor.name === 'GetCommand')
          return { Item: { sequence: 1, recordHash: record.recordHash } };
        throw new Error('Unexpected DynamoDB command.');
      },
    },
    kms: {
      async send() {
        throw new Error('Planning must not decrypt journal bytes.');
      },
    },
    s3: {},
  });
  assert.deepEqual(await readStoredJournal(backend.journalStore, scope), [record]);
  assert.deepEqual(
    commands.map((command) => command.constructor.name),
    ['QueryCommand', 'GetCommand'],
  );
  assert.ok(commands.every((command) => command.input.ConsistentRead === true));
});

test('AWS envelope encryption binds every signed transaction identity field', async () => {
  const key = randomBytes(32);
  const kms = {
    async send(command) {
      if (command.constructor.name === 'GenerateDataKeyCommand')
        return { Plaintext: Buffer.from(key), CiphertextBlob: Buffer.from('wrapped-key') };
      if (command.constructor.name === 'DecryptCommand') {
        if (
          JSON.stringify(command.input.EncryptionContext) !==
          JSON.stringify(
            Object.fromEntries(
              Object.entries(context).map(([name, value]) => [name, String(value)]),
            ),
          )
        )
          throw new Error('KMS encryption context mismatch.');
        return { Plaintext: Buffer.from(key) };
      }
      throw new Error('Unexpected KMS command.');
    },
  };
  const backend = createAwsBackend({
    tableName: 'test',
    kmsKeyId: 'test',
    dynamodb: {},
    kms,
    s3: {},
  });
  const context = encryptionContext({
    planHash,
    chain: chainIdentity,
    actionId: 'contract:alpha',
    signer: deployerA.address,
    nonce: '7',
  });
  const raw = Buffer.from('signed transaction bytes');
  const encrypted = await backend.journalCipher.encrypt(raw, context);
  assert.deepEqual(await backend.journalCipher.decrypt(encrypted, context), raw);
  assert.ok(!JSON.stringify(encrypted).includes(raw.toString()));
  for (const field of Object.keys(context)) {
    await assert.rejects(
      backend.journalCipher.decrypt(encrypted, {
        ...context,
        [field]: `${context[field]}-changed`,
      }),
      /KMS encryption context mismatch/,
    );
  }
  const changed = { ...encrypted, ciphertext: Buffer.from('changed').toString('base64') };
  await assert.rejects(backend.journalCipher.decrypt(changed, context));
});

test('signed envelopes reject changed chain, sender, nonce, payload, gas, and fees', async () => {
  const envelope = {
    chainId: 31337,
    nonce: 0,
    to: '0x0000000000000000000000000000000000000001',
    data: '0x',
    value: 0n,
    gas: 21_000n,
    maxFeePerGas: 100n,
    maxPriorityFeePerGas: 1n,
  };
  const changes = [
    ['chainId', 1],
    ['nonce', 1],
    ['to', '0x0000000000000000000000000000000000000002'],
    ['data', '0x01'],
    ['value', 1n],
    ['gas', 21_001n],
    ['maxFeePerGas', 101n],
    ['maxPriorityFeePerGas', 2n],
  ];
  for (const [field, value] of changes) {
    await assert.rejects(
      signEnvelope(
        {
          address: deployerA.address,
          signTransaction: (request) => deployerA.signTransaction({ ...request, [field]: value }),
        },
        envelope,
      ),
      /Signed transaction differs/,
      field,
    );
  }
  await assert.rejects(
    signEnvelope(
      {
        address: deployerA.address,
        signTransaction: (request) => deployerB.signTransaction(request),
      },
      envelope,
    ),
    /sender/,
    'sender',
  );
});

let chain;
before(async () => {
  chain = await startAnvil();
});
after(async () => chain?.stop());

test('a new runner recovers encrypted signed bytes without a file or a second signature', async () => {
  const input = fixture({ withCall: false });
  input.spec.contracts = input.spec.contracts.slice(0, 1);
  input.artifacts = new Map([['alpha', input.artifacts.get('alpha')]]);
  const plan = await createPlan({
    ...input,
    client: chain.client,
    signers: { deployers: [deployerA.address] },
    maxSpendWei: '100000000000000000000',
  });
  const genesisHash = (await chain.client.getBlock({ blockNumber: 0n })).hash;
  const deployment = deploymentScope(
    { project: 'test', environment: 'dev', label: 'recover' },
    { id: 31337, genesisHash },
  );
  const backend = memoryBackend();
  let signatures = 0;
  const signerProvider = {
    async address() {
      return deployerA.address;
    },
    async signTransaction(_role, transaction) {
      signatures++;
      return deployerA.signTransaction(transaction);
    },
  };
  const options = {
    plan,
    ...input,
    client: chain.client,
    ...backend,
    scope: deployment,
    signerProvider,
    confirmations: 1,
    pollIntervalMs: 10,
  };
  let stopped = false;
  await assert.rejects(
    applyPlan({
      ...options,
      hooks: {
        afterRecord(record) {
          if (!stopped && record.phase === 'signed') {
            stopped = true;
            throw new Error('simulate runner loss');
          }
        },
      },
    }),
    /simulate runner loss/,
  );
  assert.equal(signatures, 1);
  const saved = backend.recordsFor(deployment).find((record) => record.phase === 'signed');
  assert.ok(saved.encryptedRawTransaction);
  assert.equal(Object.hasOwn(saved, 'rawTransaction'), false);
  assert.equal(await chain.client.getTransactionCount({ address: deployerA.address }), 0);

  const events = [];
  const result = await applyPlan({ ...options, reporter: (event) => events.push(event) });
  assert.equal(result.status, 'applied');
  assert.equal(signatures, 1);
  assert.equal(result.rebroadcasts.length, 1);
  assert.equal(await chain.client.getTransactionCount({ address: deployerA.address }), 1);
  assert.equal(
    backend.recordsFor(deployment).filter((record) => record.phase === 'signed').length,
    1,
  );
  assert.ok(
    backend
      .recordsFor(deployment)
      .every((record) => record.principal && Number.isFinite(Date.parse(record.at))),
  );
  assert.ok((await backend.stateStore.read(deployment)).value.resources['contract:alpha']);
  assert.ok(events.some((event) => event.type === 'recovery'));
  assert.ok(events.some((event) => event.type === 'verification' || event.type === 'verified'));
  assert.ok(events.every((event) => !JSON.stringify(event).includes('rawTransaction')));
});

test('another label cannot spend a signer nonce while its saved signature is unresolved', async () => {
  const localChain = await startAnvil();
  try {
    const backend = memoryBackend();
    const genesisHash = (await localChain.client.getBlock({ blockNumber: 0n })).hash;
    const makeInput = async (name, label) => {
      const input = fixture({ withCall: false });
      input.spec.contracts = input.spec.contracts.filter((contract) => contract.id === name);
      input.artifacts = new Map([[name, input.artifacts.get(name)]]);
      const plan = await createPlan({
        ...input,
        client: localChain.client,
        signers: { deployers: [deployerA.address] },
        maxSpendWei: '100000000000000000000',
      });
      return {
        ...input,
        plan,
        client: localChain.client,
        ...backend,
        scope: deploymentScope({ project: 'test', environment: 'dev', label }, plan.chain),
        signers: { deployer: [deployerA] },
        confirmations: 1,
        pollIntervalMs: 10,
      };
    };
    const first = await makeInput('alpha', 'alpha');
    const second = await makeInput('beta', 'beta');
    await assert.rejects(
      applyPlan({
        ...first,
        hooks: {
          afterRecord(record) {
            if (record.phase === 'signed') throw new Error('runner stopped after signature');
          },
        },
      }),
      /runner stopped after signature/,
    );
    assert.equal(await localChain.client.getTransactionCount({ address: deployerA.address }), 0);
    await assert.rejects(applyPlan(second), (error) => error.code === 'foreign-outstanding');
    assert.equal(
      backend.recordsFor(second.scope).filter((record) => record.phase === 'signed').length,
      0,
    );
    assert.equal(await localChain.client.getTransactionCount({ address: deployerA.address }), 0);
    await applyPlan(first);
    await applyPlan(second);
    assert.equal(await localChain.client.getTransactionCount({ address: deployerA.address }), 2);
  } finally {
    await localChain.stop();
  }
});

test('an external signer cannot change the destination before journal persistence', async () => {
  const localChain = await startAnvil();
  try {
    const input = fixture({ withCall: false });
    input.spec.contracts = input.spec.contracts.slice(0, 1);
    input.artifacts = new Map([['alpha', input.artifacts.get('alpha')]]);
    const plan = await createPlan({
      ...input,
      client: localChain.client,
      signers: { deployers: [deployerA.address] },
      maxSpendWei: '100000000000000000000',
    });
    const genesisHash = (await localChain.client.getBlock({ blockNumber: 0n })).hash;
    const deployment = deploymentScope(
      { project: 'test', environment: 'dev', label: 'bad-signer' },
      { id: 31337, genesisHash },
    );
    const backend = memoryBackend();
    const signerProvider = {
      async address() {
        return deployerA.address;
      },
      async signTransaction(_role, request) {
        return deployerA.signTransaction({
          ...request,
          to: '0x0000000000000000000000000000000000000001',
        });
      },
    };
    await assert.rejects(
      applyPlan({
        plan,
        ...input,
        client: localChain.client,
        ...backend,
        scope: deployment,
        signerProvider,
        confirmations: 1,
      }),
      (error) => error.code === 'signer',
    );
    assert.equal(
      backend.recordsFor(deployment).filter((record) => record.phase === 'signed').length,
      0,
    );
    assert.equal(await localChain.client.getTransactionCount({ address: deployerA.address }), 0);
  } finally {
    await localChain.stop();
  }
});

async function pipelineRun(localChain, label) {
  const input = fixtureMany(3);
  const plan = await createPlan({
    ...input,
    client: localChain.client,
    pipeline: { deployers: [deployerA.address], parallel: false },
    maxSpendWei: '100000000000000000000',
  });
  const genesisHash = (await localChain.client.getBlock({ blockNumber: 0n })).hash;
  const deployment = deploymentScope(
    { project: 'test', environment: 'dev', label },
    { id: 31337, genesisHash },
  );
  const backend = memoryBackend();
  const signer = { signatures: 0 };
  const signerProvider = {
    async address() {
      return deployerA.address;
    },
    async signTransaction(_role, transaction) {
      signer.signatures++;
      return deployerA.signTransaction(transaction);
    },
  };
  const options = {
    plan,
    ...input,
    client: localChain.client,
    ...backend,
    scope: deployment,
    signerProvider,
    pipeline: true,
    confirmations: 1,
    pollIntervalMs: 10,
  };
  return { plan, backend, signer, options };
}

test('a new runner resumes an encrypted pipeline reservation without a second signature', async () => {
  const localChain = await startAnvil();
  try {
    const { plan, backend, signer, options } = await pipelineRun(localChain, 'pipeline-recover');
    const lastId = plan.resources.at(-1).id;
    await assert.rejects(
      applyPlan({
        ...options,
        hooks: {
          afterRecord(record) {
            if (record.phase === 'signed' && record.actionId === lastId)
              throw new Error('simulate runner loss');
          },
        },
      }),
      /simulate runner loss/,
    );
    const saved = backend.recordsFor(options.scope).filter((record) => record.phase === 'signed');
    assert.equal(signer.signatures, 3);
    assert.equal(new Set(saved.map((record) => record.reservationId)).size, 1);
    assert.ok(
      saved.every(
        (record) => record.encryptedRawTransaction && !Object.hasOwn(record, 'rawTransaction'),
      ),
    );
    assert.equal(
      await localChain.client.getTransactionCount({
        address: deployerA.address,
        blockTag: 'pending',
      }),
      0,
    );

    const events = [];
    const result = await applyPlan({ ...options, reporter: (event) => events.push(event) });
    assert.equal(result.status, 'applied');
    assert.equal(signer.signatures, 3);
    assert.deepEqual(
      result.rebroadcasts.map((entry) => entry.transactionHash).sort(),
      saved.map((record) => record.transactionHash).sort(),
    );
    assert.equal(await localChain.client.getTransactionCount({ address: deployerA.address }), 3);
    assert.equal(
      Object.keys((await backend.stateStore.read(options.scope)).value.resources).length,
      3,
    );
    for (const type of ['recovery', 'broadcast-result', 'receipt-observed'])
      assert.equal(events.filter((event) => event.type === type).length, 3, type);
    assert.ok(events.every((event) => !JSON.stringify(event).includes('rawTransaction')));
  } finally {
    await localChain.stop();
  }
});

test('a lost lease stops a pipelined group before its first broadcast', async () => {
  const localChain = await startAnvil();
  try {
    const { plan, backend, signer, options } = await pipelineRun(localChain, 'pipeline-lease');
    let lost = false;
    const lockProvider = {
      async acquire(...args) {
        const lease = await backend.lockProvider.acquire(...args);
        return {
          ...lease,
          async assertHeld() {
            if (lost) throw new Error('Writer lease is lost.');
            return lease.assertHeld();
          },
        };
      },
    };
    const lastId = plan.resources.at(-1).id;
    await assert.rejects(
      applyPlan({
        ...options,
        lockProvider,
        hooks: {
          afterRecord(record) {
            if (record.phase === 'signed' && record.actionId === lastId) lost = true;
          },
        },
      }),
      /Writer lease is lost/,
    );
    assert.equal(signer.signatures, 3);
    assert.equal(
      backend.recordsFor(options.scope).filter((record) => record.phase === 'broadcast-attempt')
        .length,
      0,
    );
    assert.equal(
      await localChain.client.getTransactionCount({
        address: deployerA.address,
        blockTag: 'pending',
      }),
      0,
    );
  } finally {
    await localChain.stop();
  }
});
