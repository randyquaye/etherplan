import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { concatHex, createWalletClient, http, keccak256 } from 'viem';
import { applyPlan } from '../src/execution/index.ts';
import { hashJson } from '../src/identity.ts';
import { createPlan, prepareResources } from '../src/planning/index.ts';
import { graph, parseSpec } from '../src/spec/index.ts';
import { importResource, readState } from '../src/state/index.ts';
import { PROBE_ADDRESS, verifyResource } from '../src/verification/index.ts';
import { readLocalJournal } from '../src/execution/journal.ts';
import { memoryBackend } from './execution/memory-backend.ts';
import { deployerA, deployerB, startAnvil } from './execution/chain.ts';

const FACTORY = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
const SALT = `0x${'93'.repeat(32)}`;
// Stores tx.origin in slot zero, then returns the same two-byte runtime for every origin.
const INITCODE = '0x326000556002601060003960026000f36000';
const RUNTIME = '0x6000';
const artifactFields = {
  abi: [],
  bytecode: { object: INITCODE, linkReferences: {} },
  deployedBytecode: { object: RUNTIME, linkReferences: {}, immutableReferences: {} },
  buildIdentity: { compiler: 'solc', version: '0.8.30', sourceHash: `0x${'11'.repeat(32)}` },
};
const artifact = { ...artifactFields, artifactHash: hashJson(artifactFields) };

async function setup() {
  const chain = await startAnvil();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-creation-provenance-'));
  const factoryCode = await chain.client.getCode({ address: FACTORY });
  assert.ok(factoryCode && factoryCode !== '0x');
  const spec = { schema: 1, chainId: 31337, values: {}, factory: { address: FACTORY, codeHash: keccak256(factoryCode) },
    contracts: [{ id: 'owned', artifact: 'OriginOwned.json', salt: SALT, args: [] }], calls: [] };
  const artifacts = new Map([['owned', artifact]]);
  const resource = prepareResources(spec, graph(parseSpec(spec)), artifacts).resources[0];
  assert.equal(resource.kind, 'contract');
  const input = { spec, artifacts, client: chain.client, signers: { deployers: [deployerA.address] }, maxSpendWei: '1000000000000000000' };
  const stateFile = path.join(directory, 'state.json');
  const journalFile = path.join(directory, 'journal.jsonl');
  const attack = async () => {
    const wallet = createWalletClient({ account: deployerB, transport: http(chain.url) });
    const hash = await wallet.sendTransaction({ to: FACTORY, data: concatHex([SALT, INITCODE]), gas: 200000n });
    const receipt = await chain.client.waitForTransactionReceipt({ hash, pollingInterval: 20 });
    assert.equal(receipt.status, 'success');
    const slot = await chain.client.getStorageAt({ address: resource.address, slot: `0x${'00'.repeat(32)}` });
    assert.equal(`0x${slot?.slice(-40)}`, deployerB.address.toLowerCase());
  };
  const apply = (plan, extra = {}) => applyPlan({ plan, spec, artifacts, client: chain.client, signers: { deployer: [deployerA] },
    stateFile, journalFile, pollIntervalMs: 20, ...extra });
  const close = async () => { await chain.stop(); await rm(directory, { recursive: true, force: true }); };
  return { chain, spec, artifacts, resource, input, stateFile, journalFile, apply, attack, close };
}

for (const [mode, pipeline, legacy] of [
  ['local', false, false], ['production', false, false], ['production', true, false], ['production', false, true],
] as const) {
  test(`${mode}${pipeline ? ' pipeline' : ''} replans a ${legacy ? 'terminal' : 'provider'} CREATE2 replay failure from the original receipt`, async () => {
    const ws = await setup();
    try {
      const genesisHash = (await ws.chain.client.getBlock({ blockNumber: 0n })).hash;
      const scope = { project: 'test', environment: 'dev', label: 'rpc-replay', chainId: 31337, genesisHash };
      const backend = mode === 'production' ? memoryBackend(scope) : null;
      const storage = backend ? { ...backend, scope, confirmations: 1 } : { stateFile: ws.stateFile, journalFile: ws.journalFile };
      const plan = await createPlan({ ...ws.input, ...(pipeline ? { signers: null, pipeline: { deployers: [deployerA.address], parallel: false } } : {}) });
      const replayError = Object.assign(new Error('https://rpc.example/v2/secret-key'), legacy ? {} : { name: 'InternalRpcError', code: -32603 });
      const failingClient = Object.assign(Object.create(ws.chain.client), {
        call: async request => {
          if (request.to?.toLowerCase() === PROBE_ADDRESS.toLowerCase() && request.blockNumber !== undefined && request.data?.toLowerCase().includes(SALT.slice(2))) throw replayError;
          return ws.chain.client.call(request);
        },
      });
      const apply = client => applyPlan({ plan, spec: ws.spec, artifacts: ws.artifacts, client, signers: { deployer: [deployerA] },
        ...storage, pipeline, pollIntervalMs: 20, verificationTimeoutMs: 0 });
      await assert.rejects(apply(failingClient), error => error.code === 'postcondition' && error.retryable === !legacy && !error.message.includes('secret-key'));
      const history = backend ? backend.records : await readLocalJournal(ws.journalFile);
      const signed = history.filter(record => record.phase === 'signed');
      const receipt = history.find(record => record.phase === 'receipt');
      assert.equal(signed.length, 1);
      assert.equal(receipt?.receipt.status, 'success');
      assert.equal(history.at(-1)?.phase, 'failed');
      assert.equal(await ws.chain.client.getTransactionCount({ address: deployerA.address }), 1);
      if (mode === 'local' && !legacy) {
        await assert.rejects(apply(failingClient), error => error.code === 'postcondition' && error.retryable);
        assert.equal((await readLocalJournal(ws.journalFile)).filter(record => record.phase === 'signed').length, 1);
      }
      const fresh = await createPlan({ ...ws.input, journalRecords: history, client: ws.chain.client,
        ...(pipeline ? { signers: null, pipeline: { deployers: [deployerA.address], parallel: false } } : {}) });
      assert.equal(fresh.resources[0].action, 'recover');
      assert.equal(fresh.resources[0].observation.recovery.transactionHash, signed[0].transactionHash);

      const resumed = await applyPlan({ plan: fresh, spec: ws.spec, artifacts: ws.artifacts, client: ws.chain.client,
        signers: { deployer: [deployerA] }, ...storage, pipeline, pollIntervalMs: 20, verificationTimeoutMs: 0 });
      assert.equal(resumed.status, 'applied');
      assert.equal(resumed.transactionsSigned, 0);
      const after = backend ? backend.records : await readLocalJournal(ws.journalFile);
      assert.equal(after.filter(record => record.phase === 'signed').length, 1);
      assert.equal(after.at(-1)?.phase, 'verified');
      const state = backend ? (await backend.stateStore.read(scope))?.value : await readState(ws.stateFile);
      assert.equal(state.resources['contract:owned'].creationProof.transactionHash, signed[0].transactionHash.toLowerCase());
    } finally { await ws.close(); }
  });
}

test('a transient receipt-block RPC error is retried and the deployment completes in one apply', async () => {
  const ws = await setup();
  try {
    const plan = await createPlan(ws.input);
    let failures = 0;
    const flakyClient = Object.assign(Object.create(ws.chain.client), { call: async request => {
      if (request.to?.toLowerCase() === PROBE_ADDRESS.toLowerCase() && request.blockNumber !== undefined && request.data?.toLowerCase().includes(SALT.slice(2)) && failures < 2) {
        failures++;
        throw Object.assign(new Error('temporary provider fault'), { name: 'InternalRpcError', code: -32603 });
      }
      return ws.chain.client.call(request);
    } });
    const result = await ws.apply(plan, { client: flakyClient, verificationTimeoutMs: 5_000 });
    assert.equal(result.status, 'applied');
    assert.equal(failures, 2);
    const history = await readLocalJournal(ws.journalFile);
    assert.equal(history.filter(record => record.phase === 'signed').length, 1);
    assert.equal(history.filter(record => record.phase === 'failed').length, 0);
    assert.equal((await readState(ws.stateFile)).resources['contract:owned'].creationProof.kind, 'create2');
  } finally { await ws.close(); }
});

test('an independent verification RPC completes a deployment when the primary rejects creation replay', async () => {
  const ws = await setup();
  try {
    const plan = await createPlan(ws.input);
    let replayFailures = 0;
    let codeFailures = 0;
    const incompatible = Object.assign(Object.create(ws.chain.client), { getCode: async request => {
      if (request.address.toLowerCase() === ws.resource.address.toLowerCase() && request.blockNumber !== undefined && replayFailures > 0) {
        codeFailures++;
        throw Object.assign(new Error('temporary code read failure'), { name: 'InternalRpcError', code: -32603 });
      }
      return ws.chain.client.getCode(request);
    }, call: async request => {
      if (request.to?.toLowerCase() === PROBE_ADDRESS.toLowerCase() && request.data?.toLowerCase().includes(SALT.slice(2))) {
        replayFailures++;
        throw Object.assign(new Error('internal eth error'), { name: 'InternalRpcError', code: -32603 });
      }
      return ws.chain.client.call(request);
    } });
    const result = await ws.apply(plan, { client: incompatible, verificationClient: ws.chain.client, verificationTimeoutMs: 1_000 });
    assert.equal(result.status, 'applied');
    assert.ok(replayFailures >= 1);
    assert.ok(codeFailures >= 1); // Final desired-state revalidation also uses the backup.
    const history = await readLocalJournal(ws.journalFile);
    assert.equal(history.filter(record => record.phase === 'signed').length, 1);
    assert.equal(history.filter(record => record.phase === 'failed').length, 0);
    assert.equal((await readState(ws.stateFile)).resources['contract:owned'].creationProof.kind, 'create2');
  } finally { await ws.close(); }
});

test('an independent verification RPC can verify when the primary reports a replay revert', async () => {
  const ws = await setup();
  try {
    const plan = await createPlan(ws.input);
    let replayFailures = 0;
    const reverting = Object.assign(Object.create(ws.chain.client), { call: async request => {
      if (request.to?.toLowerCase() === PROBE_ADDRESS.toLowerCase() && request.blockNumber !== undefined && request.data?.toLowerCase().includes(SALT.slice(2))) {
        replayFailures++;
        throw Object.assign(new Error('execution reverted'), { name: 'ExecutionRevertedError', code: 3 });
      }
      return ws.chain.client.call(request);
    } });
    const result = await ws.apply(plan, { client: reverting, verificationClient: ws.chain.client, verificationTimeoutMs: 1_000 });
    assert.equal(result.status, 'applied');
    assert.ok(replayFailures >= 1);
    assert.equal((await readLocalJournal(ws.journalFile)).filter(record => record.phase === 'signed').length, 1);
  } finally { await ws.close(); }
});

test('an independent verification RPC can verify when the primary replays different runtime', async () => {
  const ws = await setup();
  try {
    const plan = await createPlan(ws.input);
    let replayMismatches = 0;
    const differing = Object.assign(Object.create(ws.chain.client), { call: async request => {
      if (request.to?.toLowerCase() === PROBE_ADDRESS.toLowerCase() && request.blockNumber !== undefined && request.data?.toLowerCase().includes(SALT.slice(2))) {
        replayMismatches++;
        return { data: '0x6001' };
      }
      return ws.chain.client.call(request);
    } });
    const result = await ws.apply(plan, { client: differing, verificationClient: ws.chain.client, verificationTimeoutMs: 1_000 });
    assert.equal(result.status, 'applied');
    assert.ok(replayMismatches >= 1);
    assert.equal((await readLocalJournal(ws.journalFile)).filter(record => record.phase === 'signed').length, 1);
  } finally { await ws.close(); }
});

test('a transient alternate replay revert does not end retries while the primary RPC is unavailable', async () => {
  const ws = await setup();
  try {
    const plan = await createPlan(ws.input);
    let primaryFailures = 0;
    let alternateAttempts = 0;
    const replayRequest = request => request.to?.toLowerCase() === PROBE_ADDRESS.toLowerCase() &&
      request.blockNumber !== undefined && request.data?.toLowerCase().includes(SALT.slice(2));
    const primary = Object.assign(Object.create(ws.chain.client), { call: async request => {
      if (replayRequest(request)) {
        primaryFailures++;
        throw Object.assign(new Error('internal eth error'), { name: 'InternalRpcError', code: -32603 });
      }
      return ws.chain.client.call(request);
    } });
    const alternate = Object.assign(Object.create(ws.chain.client), { call: async request => {
      if (replayRequest(request) && ++alternateAttempts === 1) {
        throw Object.assign(new Error('execution reverted'), { name: 'ExecutionRevertedError', code: 3 });
      }
      return ws.chain.client.call(request);
    } });
    const result = await ws.apply(plan, { client: primary, verificationClient: alternate, verificationTimeoutMs: 5_000 });
    assert.equal(result.status, 'applied');
    assert.ok(primaryFailures >= 2);
    assert.ok(alternateAttempts >= 2);
    assert.equal((await readLocalJournal(ws.journalFile)).filter(record => record.phase === 'signed').length, 1);
  } finally { await ws.close(); }
});

test('disagreeing RPC replay failures remain retryable when the deadline expires', async () => {
  const ws = await setup();
  try {
    const plan = await createPlan(ws.input);
    const replayRequest = request => request.to?.toLowerCase() === PROBE_ADDRESS.toLowerCase() &&
      request.blockNumber !== undefined && request.data?.toLowerCase().includes(SALT.slice(2));
    const primary = Object.assign(Object.create(ws.chain.client), { call: async request => {
      if (replayRequest(request)) throw Object.assign(new Error('internal eth error'), { name: 'InternalRpcError', code: -32603 });
      return ws.chain.client.call(request);
    } });
    const alternate = Object.assign(Object.create(ws.chain.client), { call: async request => {
      if (replayRequest(request)) throw Object.assign(new Error('execution reverted'), { name: 'ExecutionRevertedError', code: 3 });
      return ws.chain.client.call(request);
    } });
    await assert.rejects(ws.apply(plan, { client: primary, verificationClient: alternate, verificationTimeoutMs: 0 }),
      error => error.code === 'postcondition' && error.retryable === true);
    assert.equal((await readLocalJournal(ws.journalFile)).filter(record => record.phase === 'signed').length, 1);
  } finally { await ws.close(); }
});

test('a verification RPC on another chain is rejected before signing', async () => {
  const ws = await setup();
  try {
    const plan = await createPlan(ws.input);
    const otherChain = Object.assign(Object.create(ws.chain.client), { getChainId: async () => 1 });
    await assert.rejects(ws.apply(plan, { verificationClient: otherChain }), error => error.code === 'wrong-chain');
    assert.equal(await ws.chain.client.getTransactionCount({ address: deployerA.address }), 0);
    assert.equal((await readLocalJournal(ws.journalFile)).filter(record => record.phase === 'signed').length, 0);
  } finally { await ws.close(); }
});

test('an incompatible production RPC stops before a signature', async () => {
  const ws = await setup();
  try {
    const plan = await createPlan(ws.input);
    const scope = { project: 'test', environment: 'dev', label: 'override-preflight', chainId: 31337,
      genesisHash: (await ws.chain.client.getBlock({ blockNumber: 0n })).hash };
    const backend = memoryBackend(scope);
    const incompatible = Object.assign(Object.create(ws.chain.client), { call: async request => {
      if (request.to?.toLowerCase() === PROBE_ADDRESS.toLowerCase() && request.stateOverride?.some(override => override.nonce === 0)) {
        throw Object.assign(new Error('internal eth error'), { name: 'InternalRpcError', code: -32603 });
      }
      return ws.chain.client.call(request);
    } });
    await assert.rejects(applyPlan({ plan, spec: ws.spec, artifacts: ws.artifacts, client: incompatible, signers: { deployer: [deployerA] },
      ...backend, scope, confirmations: 1, pollIntervalMs: 20 }), error => error.code === 'rpc-capability' && error.retryable);
    assert.equal(backend.records.filter(record => record.phase === 'signed').length, 0);
    assert.equal(await ws.chain.client.getTransactionCount({ address: deployerA.address }), 0);
  } finally { await ws.close(); }
});

test('a fresh CREATE2 plan rejects a matching runtime deployed by another origin', async () => {
  const ws = await setup();
  try {
    const plan = await createPlan(ws.input);
    assert.equal(plan.resources[0].action, 'deploy');
    await ws.attack();
    const later = await createPlan(ws.input);
    assert.equal(later.resources[0].action, 'unverified');
    assert.match(later.resources[0].observation.missingProofs.at(-1), /no verified creation transaction/);
    await assert.rejects(ws.apply(plan), error => error.code === 'conflict');
    assert.equal(await ws.chain.client.getTransactionCount({ address: deployerA.address }), 0);
    assert.equal(await readState(ws.stateFile), null);

    // An explicit import remains available when the user deliberately accepts an existing deployment.
    const verification = await verifyResource(ws.resource, ws.chain.client);
    const chain = plan.chain;
    const imported = importResource({ resource: ws.resource, verification, state: null, chain });
    const adopted = await createPlan({ ...ws.input, state: imported });
    assert.equal(adopted.resources[0].action, 'reuse');
  } finally { await ws.close(); }
});

test('a CREATE2 transaction that loses the race cannot become already satisfied', async () => {
  const ws = await setup();
  try {
    const plan = await createPlan(ws.input);
    let attacked = false;
    await assert.rejects(ws.apply(plan, { hooks: { async afterRecord(record) {
      if (record.phase === 'signed' && !attacked) { attacked = true; await ws.attack(); }
    } } }), error => error.code === 'reverted');
    assert.equal(attacked, true);
    assert.equal(await readState(ws.stateFile), null);
  } finally { await ws.close(); }
});

test('an unavailable or changed saved creation transaction cannot downgrade to runtime-only proof', async () => {
  const ws = await setup();
  try {
    const plan = await createPlan(ws.input);
    const applied = await ws.apply(plan);
    assert.equal(applied.status, 'applied');
    const state = await readState(ws.stateFile);
    const proof = state.resources['contract:owned'].creationProof;
    assert.equal(proof.creator, deployerA.address.toLowerCase());

    const unavailable = Object.assign(Object.create(ws.chain.client), {
      getTransactionReceipt: async () => { throw new Error('receipt unavailable'); },
    });
    const unverified = await createPlan({ ...ws.input, client: unavailable, state });
    assert.equal(unverified.resources[0].action, 'unverified');
    assert.equal(unverified.resources[0].observation.status, 'unverified');

    const changedSender = Object.assign(Object.create(ws.chain.client), {
      getTransaction: async request => ({ ...(await ws.chain.client.getTransaction(request)), from: deployerB.address }),
    });
    const conflict = await createPlan({ ...ws.input, client: changedSender, state });
    assert.equal(conflict.resources[0].action, 'conflict');
    assert.match(conflict.resources[0].observation.reasons.join(' '), /sender differs from the saved proof/);
  } finally { await ws.close(); }
});

test('apply rejects a custom CREATE2 factory before signing', async () => {
  const ws = await setup();
  try {
    const address = '0x000000000000000000000000000000000000beef';
    const code = '0x6000';
    await ws.chain.rpc('anvil_setCode', [address, code]);
    const spec = { ...ws.spec, factory: { address, codeHash: keccak256(code) } };
    const plan = await createPlan({ ...ws.input, spec });
    assert.equal(plan.resources[0].action, 'deploy');
    await assert.rejects(ws.apply(plan, { spec }), error => error.code === 'factory');
    assert.equal(await ws.chain.client.getTransactionCount({ address: deployerA.address }), 0);
    assert.equal(await readState(ws.stateFile), null);
  } finally { await ws.close(); }
});
