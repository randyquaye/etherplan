import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { keccak256 } from 'viem';
import { normalizeArtifact } from '../src/artifacts.mjs';
import { applyPlan } from '../src/execution/index.mjs';
import { hashJson } from '../src/identity.mjs';
import { createPlan, prepareResources } from '../src/planning/index.mjs';
import { graph, parseSpec } from '../src/spec/index.mjs';
import { importResource, readState, recordResource, validateState, writeStateAtomic } from '../src/state/index.mjs';
import { verifyResource } from '../src/verification/index.mjs';
import { deployerA, fixture, owner, startAnvil } from './execution/chain.mjs';

const planPolicy = { signers: { deployers: [deployerA.address], owner: owner.address }, maxSpendWei: '100000000000000000000' };
import { holderArtifact, registryArtifact } from './execution/contracts.mjs';
import { state as interfaceState } from './interface-fixtures.mjs';

const GENESIS = `0x${'aa'.repeat(32)}`;
const OBSERVED = `0x${'bb'.repeat(32)}`;
const FACTORY = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
const FACTORY_CODE = '0x6001';
const RUNTIME = '0x6000';
const SALT = `0x${'11'.repeat(32)}`;
const DEPLOY_TX = `0x${'66'.repeat(32)}`;
const CREATION_TX = `0x${'88'.repeat(32)}`;
const TWO = '0x0000000000000000000000000000000000000002';
const chainIdentity = { id: 31337, genesisHash: GENESIS };
// Fields that describe the deployment rather than the artifact. A rebaseline leaves them unchanged.
const DEPLOYMENT_FIELDS = ['address', 'priorAddress', 'initcodeHash', 'inputs', 'inputsHash', 'priorInputs', 'priorInputsHash', 'salt', 'codeHash', 'priorCodeHash', 'priorProofHash', 'transactions', 'provenance'];

// A rebuild changes build identity, so the artifact hash changes while the creation and runtime bytecode stay the same.
function vaultArtifact({ sourceHash = `0x${'33'.repeat(32)}`, runtime = RUNTIME, immutableReferences = {} } = {}) {
  const fields = {
    abi: [
      { type: 'constructor', stateMutability: 'nonpayable', inputs: [{ name: 'destination', type: 'bytes32' }] },
      { type: 'function', name: 'value', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
    ],
    bytecode: { object: RUNTIME, linkReferences: {} },
    deployedBytecode: { object: runtime, linkReferences: {}, immutableReferences },
    buildIdentity: { compiler: 'solc', version: '0.8.30', sourceHash },
  };
  return { ...fields, artifactHash: hashJson(fields) };
}

const original = vaultArtifact();
const rebuilt = vaultArtifact({ sourceHash: `0x${'44'.repeat(32)}` });

function rebuild(artifact, sourceHash) {
  const fields = { ...artifact, buildIdentity: { ...artifact.buildIdentity, sourceHash } };
  delete fields.artifactHash;
  return { ...fields, artifactHash: hashJson(fields) };
}

function vaultSpec({ destination = `0x${'01'.repeat(32)}`, salt = SALT, address, checks } = {}) {
  return {
    schema: 1,
    chainId: 31337,
    values: { destination },
    ...(address ? {} : { factory: { address: FACTORY, codeHash: keccak256(FACTORY_CODE) } }),
    contracts: [{ id: 'vault', artifact: 'Vault.json', ...(address ? { address } : { salt }), args: [{ ref: 'values.destination' }], ...(checks ? { checks } : {}) }],
  };
}

function prepared(spec, artifact) {
  const parsed = parseSpec(spec);
  return prepareResources(parsed, graph(parsed), new Map([['vault', artifact]])).resources[0];
}

const vaultAddress = prepared(vaultSpec(), original).address;
const importSpec = (options = {}) => vaultSpec({ address: vaultAddress, ...options });

// A read-only chain with the vault runtime at its CREATE2 address. Its value() getter returns 1.
function mockChain() {
  return {
    async getChainId() { return 31337; },
    async getBlock({ blockNumber }) { return blockNumber === 0n ? { number: 0n, hash: GENESIS } : { number: 7n, hash: OBSERVED }; },
    async getCode({ address }) {
      if (address.toLowerCase() === FACTORY.toLowerCase()) return FACTORY_CODE;
      return address.toLowerCase() === vaultAddress.toLowerCase() ? RUNTIME : '0x';
    },
    async readContract() { return 1n; },
  };
}

async function appliedState(client) {
  const resource = prepared(vaultSpec(), original);
  return recordResource({ resource, verification: await verifyResource(resource, client), state: null, chain: chainIdentity, transactions: [DEPLOY_TX] });
}

async function importedState(client) {
  const resource = prepared(importSpec(), original);
  const verification = { ...(await verifyResource(resource, client)), evidence: { creation: { status: 'verified', transactionHash: CREATION_TX } } };
  return importResource({ resource, verification, state: null, chain: chainIdentity, creationTransactionHash: CREATION_TX });
}

async function planVault({ spec = vaultSpec(), artifact = rebuilt, client, state }) {
  return (await createPlan({ spec, artifacts: new Map([['vault', artifact]]), client, state })).resources[0];
}

test('an artifact-only rebuild of an unchanged CREATE2 deployment is reused, with its drift in the plan', async () => {
  const client = mockChain();
  const state = await appliedState(client);
  const record = state.resources['contract:vault'];
  const plan = await createPlan({ spec: vaultSpec(), artifacts: new Map([['vault', rebuilt]]), client, state });
  const [vault] = plan.resources;
  assert.equal(vault.action, 'reuse');
  assert.equal(vault.tx, undefined);
  assert.equal(vault.observation.status, 'verified');
  assert.equal(plan.artifactHashes['contract:vault'], rebuilt.artifactHash);
  assert.equal(vault.artifactHash, rebuilt.artifactHash);
  const { stateComparison } = vault.observation;
  assert.deepEqual([stateComparison.addressMatches, stateComparison.identityMatches, stateComparison.artifactMatches, stateComparison.conflict], [true, true, false, false]);
  assert.deepEqual(stateComparison.artifactDrift, {
    accepted: true,
    previousArtifactHash: original.artifactHash,
    artifactHash: rebuilt.artifactHash,
    previousSourceHash: original.buildIdentity.sourceHash,
    sourceHash: rebuilt.buildIdentity.sourceHash,
    baseline: { address: record.address, initcodeHash: record.initcodeHash, inputsHash: record.inputsHash, salt: SALT, codeHash: keccak256(RUNTIME) },
    reasons: [],
  });

  const unchanged = await planVault({ artifact: original, client, state });
  assert.equal(unchanged.action, 'reuse');
  assert.equal(unchanged.observation.stateComparison.artifactDrift, undefined);
});

test('a saved deployment does not drift when only top-level ABI order changes', async () => {
  const raw = {
    abi: [
      { type: 'constructor', stateMutability: 'nonpayable', inputs: [{ name: 'destination', type: 'bytes32' }] },
      { type: 'function', name: 'value', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
      { type: 'function', name: 'ping', stateMutability: 'view', inputs: [], outputs: [] },
    ],
    bytecode: { object: RUNTIME },
    deployedBytecode: { object: RUNTIME, immutableReferences: {} },
  };
  const first = normalizeArtifact(raw, 'Vault');
  const reordered = normalizeArtifact({ ...raw, abi: [...raw.abi].reverse() }, 'Vault reordered');
  const client = mockChain();
  const resource = prepared(vaultSpec(), first);
  const state = recordResource({ resource, verification: await verifyResource(resource, client), state: null, chain: chainIdentity, transactions: [DEPLOY_TX] });
  const plan = await createPlan({ spec: vaultSpec(), artifacts: new Map([['vault', reordered]]), client, state });
  assert.equal(plan.resources[0].action, 'reuse');
  assert.equal(plan.resources[0].observation.stateComparison.artifactMatches, true);
  assert.equal(plan.resources[0].observation.stateComparison.artifactDrift, undefined);
});

test('artifact drift stays blocked for changed live code, runtime, checks, missing proof, or an import', async () => {
  const client = mockChain();
  const state = await appliedState(client);
  async function blocked(options, reason) {
    const entry = await planVault({ client, state, ...options });
    assert.equal(entry.action, 'conflict');
    assert.equal(entry.observation.stateComparison.artifactDrift.accepted, false);
    assert.match(entry.observation.stateComparison.artifactDrift.reasons.join(' '), reason);
  }
  const moved = structuredClone(state);
  moved.resources['contract:vault'].codeHash = `0x${'77'.repeat(32)}`;
  await blocked({ state: moved }, /Live code hash 0x[0-9a-f]{64} differs from the saved code hash/);
  const unknown = structuredClone(state);
  unknown.resources['contract:vault'].codeHash = null;
  await blocked({ state: unknown }, /State has no code hash/);
  await blocked({ artifact: vaultArtifact({ sourceHash: `0x${'45'.repeat(32)}`, runtime: '0x6001' }) }, /leaves the live contract conflict/);
  await blocked({ spec: vaultSpec({ checks: { value: '2' } }) }, /leaves the live contract conflict/);
  await blocked({ artifact: vaultArtifact({ sourceHash: `0x${'46'.repeat(32)}`, immutableReferences: { 1: [{ start: 1, length: 1 }] } }) }, /leaves the live contract unverified/);
  const imported = await importedState(client);
  await blocked({ spec: importSpec(), state: imported }, /etherplan import --id contract:vault --rebaseline/);

  // A changed address or deployment identity is a replacement or a conflict, not artifact drift.
  const replaced = await planVault({ spec: vaultSpec({ destination: `0x${'02'.repeat(32)}` }), client, state });
  assert.equal(replaced.action, 'deploy');
  assert.equal(replaced.observation.stateComparison.replacement, true);
  assert.equal(replaced.observation.stateComparison.artifactDrift, undefined);
  const resalted = await planVault({ spec: vaultSpec({ salt: `0x${'12'.repeat(32)}` }), client, state });
  assert.equal(resalted.action, 'conflict');
  assert.equal(resalted.observation.stateComparison.artifactDrift, undefined);
  const reinput = await planVault({ spec: importSpec({ destination: `0x${'02'.repeat(32)}` }), client, state: imported });
  assert.equal(reinput.action, 'conflict');
  assert.equal(reinput.observation.stateComparison.artifactDrift, undefined);
});

test('recording a rebuilt artifact keeps deployment provenance and appends an artifact revision', async () => {
  const client = mockChain();
  const state = await appliedState(client);
  const before = state.resources['contract:vault'];
  const resource = prepared(vaultSpec(), rebuilt);
  const verification = await verifyResource(resource, client);
  const rebaselined = recordResource({ resource, verification, state, chain: chainIdentity });
  const record = rebaselined.resources['contract:vault'];
  assert.equal(record.artifactHash, rebuilt.artifactHash);
  assert.equal(record.sourceHash, rebuilt.buildIdentity.sourceHash);
  assert.equal(record.proofHash, hashJson(verification));
  assert.deepEqual(record.artifactRevisions, [{ artifactHash: original.artifactHash, sourceHash: original.buildIdentity.sourceHash, proofHash: before.proofHash, codeHash: before.codeHash }]);
  for (const key of DEPLOYMENT_FIELDS) assert.deepEqual(record[key], before[key], key);
  assert.deepEqual(record.provenance, { kind: 'apply' });

  const third = vaultArtifact({ sourceHash: `0x${'55'.repeat(32)}` });
  const thirdResource = prepared(vaultSpec(), third);
  const twice = recordResource({ resource: thirdResource, verification, state: rebaselined, chain: chainIdentity });
  assert.deepEqual(twice.resources['contract:vault'].artifactRevisions.map(revision => revision.artifactHash), [original.artifactHash, rebuilt.artifactHash]);
  const again = recordResource({ resource: thirdResource, verification, state: twice, chain: chainIdentity });
  assert.equal(again.resources['contract:vault'].artifactRevisions.length, 2);

  // A replacement is a new deployment, so its revision trail starts over.
  const replacement = prepared(vaultSpec({ destination: `0x${'02'.repeat(32)}` }), third);
  const replaced = recordResource({ resource: replacement, verification: { ...verification, address: replacement.address }, state: twice, chain: chainIdentity, transactions: [`0x${'67'.repeat(32)}`] }).resources['contract:vault'];
  assert.equal(replaced.artifactRevisions, undefined);
  assert.equal(replaced.priorAddress, before.address);

  const moved = structuredClone(state);
  moved.resources['contract:vault'].codeHash = `0x${'77'.repeat(32)}`;
  assert.throws(() => recordResource({ resource, verification, state: moved, chain: chainIdentity }), /live code hash differs from the saved code hash/);
  const importedResource = prepared(importSpec(), rebuilt);
  const imported = await importedState(client);
  const importedVerification = await verifyResource(importedResource, client);
  assert.throws(() => recordResource({ resource: importedResource, verification: importedVerification, state: imported, chain: chainIdentity }), /Accept its new artifact with import --rebaseline/);

  // A call follows its target's artifact without a deployment identity change.
  const call = {
    id: 'call:bind', kind: 'call', address: vaultAddress, targetArtifact: original, method: 'bind', args: [TWO],
    check: { functionName: 'value', args: [] }, before: { functionName: 'value', expected: '0' }, after: { functionName: 'value', expected: '1' }, signerRole: 'owner',
  };
  const callVerification = { ...verification, id: call.id, bindingChecks: [{ observed: 'after' }] };
  const bound = recordResource({ resource: call, verification: callVerification, state: null, chain: chainIdentity, transactions: [DEPLOY_TX] });
  const retargeted = recordResource({ resource: { ...call, targetArtifact: rebuilt }, verification: callVerification, state: bound, chain: chainIdentity }).resources['call:bind'];
  assert.equal(retargeted.artifactHash, rebuilt.artifactHash);
  assert.deepEqual(retargeted.provenance, { kind: 'apply' });
  assert.equal(retargeted.priorAddress, null);
});

test('state files without artifact revisions stay valid, and malformed revisions are rejected', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-revisions-'));
  try {
    const file = path.join(directory, 'state.json');
    await writeStateAtomic(file, interfaceState);
    assert.deepEqual(await readState(file), interfaceState);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const revision = { artifactHash: `0x${'01'.repeat(32)}`, proofHash: `0x${'02'.repeat(32)}`, codeHash: `0x${'03'.repeat(32)}` };
  const withRevisions = revisions => {
    const state = structuredClone(interfaceState);
    state.resources['contract:example'].artifactRevisions = revisions;
    return state;
  };
  assert.deepEqual(validateState(withRevisions([revision, { ...revision, sourceHash: `0x${'04'.repeat(32)}` }])).resources['contract:example'].artifactRevisions.length, 2);
  assert.throws(() => validateState(withRevisions({})), /artifactRevisions must be an array/);
  assert.throws(() => validateState(withRevisions([{ ...revision, note: 'x' }])), /artifactRevisions\[0\] has unknown fields/);
  assert.throws(() => validateState(withRevisions([{ ...revision, codeHash: null }])), /artifactRevisions\[0\] codeHash must be a 32-byte hex value/);
  assert.throws(() => validateState(withRevisions([{ artifactHash: revision.artifactHash, codeHash: revision.codeHash }])), /artifactRevisions\[0\] proofHash/);
});

test('import --rebaseline accepts a rebuilt artifact for an imported contract and keeps its provenance', async () => {
  const client = mockChain();
  const state = await importedState(client);
  const before = state.resources['contract:vault'];
  const resource = prepared(importSpec(), rebuilt);
  const verification = await verifyResource(resource, client);
  assert.throws(() => importResource({ resource, verification, state, chain: chainIdentity }), /different artifact identity\. Use import --rebaseline/);

  const rebaselined = importResource({ resource, verification, state, chain: chainIdentity, rebaseline: true });
  const record = rebaselined.resources['contract:vault'];
  assert.equal(record.artifactHash, rebuilt.artifactHash);
  assert.equal(record.sourceHash, rebuilt.buildIdentity.sourceHash);
  assert.equal(record.proofHash, hashJson(verification));
  assert.deepEqual(record.provenance, { kind: 'import', creationTransactionHash: CREATION_TX });
  assert.deepEqual(record.artifactRevisions, [{ artifactHash: original.artifactHash, sourceHash: original.buildIdentity.sourceHash, proofHash: before.proofHash, codeHash: before.codeHash }]);
  for (const key of DEPLOYMENT_FIELDS) assert.deepEqual(record[key], before[key], key);
  const replanned = await planVault({ spec: importSpec(), client, state: rebaselined });
  assert.equal(replanned.action, 'reuse');
  assert.equal(replanned.observation.stateComparison.artifactDrift, undefined);
  const third = prepared(importSpec(), vaultArtifact({ sourceHash: `0x${'55'.repeat(32)}` }));
  const twice = importResource({ resource: third, verification, state: rebaselined, chain: chainIdentity, rebaseline: true });
  assert.deepEqual(twice.resources['contract:vault'].artifactRevisions.map(revision => revision.artifactHash), [original.artifactHash, rebuilt.artifactHash]);

  const refuses = (options, pattern) => assert.throws(() => importResource({ resource, verification, state, chain: chainIdentity, rebaseline: true, ...options }), pattern);
  refuses({ state: null }, /has no state record to rebaseline/);
  const applied = structuredClone(state);
  applied.resources['contract:vault'].provenance = { kind: 'apply' };
  refuses({ state: applied }, /was not imported/);
  const otherInputs = prepared(importSpec({ destination: `0x${'02'.repeat(32)}` }), rebuilt);
  refuses({ resource: otherInputs, verification: { ...verification, id: otherInputs.id } }, /constructor inputs differ/);
  const otherAddress = prepared(importSpec({ address: TWO }), rebuilt);
  refuses({ resource: otherAddress, verification: { ...verification, address: TWO } }, /different state address/);
  const moved = structuredClone(state);
  moved.resources['contract:vault'].codeHash = `0x${'77'.repeat(32)}`;
  refuses({ state: moved }, /live code hash differs/);
  const unknown = structuredClone(state);
  unknown.resources['contract:vault'].codeHash = null;
  refuses({ state: unknown }, /state has no code hash/);
  refuses({ resource: prepared(importSpec(), original) }, /nothing to rebaseline/);
  refuses({ verification: { ...verification, status: 'unverified' } }, /without verified live evidence/);
  const otherCreation = `0x${'89'.repeat(32)}`;
  refuses({ creationTransactionHash: otherCreation, verification: { ...verification, evidence: { creation: { status: 'verified', transactionHash: otherCreation } } } }, /records a different creation transaction/);
});

describe('artifact drift on a private chain', () => {
  let chain;
  let baseline;
  const directories = [];
  const rebuiltHolder = rebuild(holderArtifact, `0x${'5a'.repeat(32)}`);
  const rebuiltRegistry = rebuild(registryArtifact, `0x${'5b'.repeat(32)}`);
  const nonces = () => Promise.all([deployerA, owner].map(account => chain.client.getTransactionCount({ address: account.address })));

  function rebuiltInput() {
    const { spec, artifacts } = fixture();
    artifacts.set('alpha', rebuiltHolder);
    artifacts.set('registry', rebuiltRegistry);
    return { spec, artifacts };
  }

  async function workspace(state = baseline) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-drift-'));
    directories.push(directory);
    const files = { stateFile: path.join(directory, 'state.json'), journalFile: path.join(directory, 'journal.jsonl') };
    if (state) await writeStateAtomic(files.stateFile, state);
    return files;
  }

  const apply = (input, files, extra = {}) => applyPlan({
    ...input, client: chain.client, signers: { deployer: [deployerA], owner }, ...files, pollIntervalMs: 20, ...extra,
  });

  async function rejectsWith(promise, code, actionId) {
    await assert.rejects(promise, error => {
      assert.equal(error.code, code, error.message);
      assert.equal(error.actionId, actionId, `${error.code}: ${error.message}`);
      return true;
    });
  }

  function rehash(plan) {
    const { planHash, ...fields } = plan;
    return { ...fields, planHash: hashJson(fields) };
  }

  before(async () => {
    chain = await startAnvil();
    const input = fixture();
    const files = await workspace(null);
    const result = await apply({ ...input, plan: await createPlan({ ...input, client: chain.client, ...planPolicy }) }, files);
    assert.equal(result.status, 'applied');
    baseline = await readState(files.stateFile);
  });
  after(async () => {
    await chain?.stop();
    await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })));
  });

  test('B1: a rebuilt artifact reuses an unchanged deployment and rebaselines state without a transaction', async () => {
    const input = rebuiltInput();
    const plan = await createPlan({ ...input, client: chain.client, state: baseline, ...planPolicy });
    assert.ok(plan.resources.every(resource => resource.action === 'reuse'));
    assert.deepEqual(Object.fromEntries(plan.resources.map(resource => [resource.id, resource.observation.stateComparison?.artifactDrift?.accepted ?? null])), {
      'contract:alpha': true, 'contract:beta': null, 'contract:registry': true, 'contract:gamma': null, 'call:bindGamma': null,
    });
    const files = await workspace();
    const before = await nonces();
    const result = await apply({ ...input, plan }, files);
    assert.equal(result.status, 'applied');
    assert.equal(result.transactionsSigned, 0);
    assert.ok(result.resources.every(resource => resource.outcome === 'reused'));
    assert.deepEqual(result.resources.find(resource => resource.id === 'contract:alpha').artifactDrift, { previousArtifactHash: holderArtifact.artifactHash, artifactHash: rebuiltHolder.artifactHash });
    assert.deepEqual(await nonces(), before);

    const state = await readState(files.stateFile);
    for (const [id, previous, next] of [['contract:alpha', holderArtifact, rebuiltHolder], ['contract:registry', registryArtifact, rebuiltRegistry]]) {
      const record = state.resources[id];
      const prior = baseline.resources[id];
      assert.equal(record.artifactHash, next.artifactHash);
      assert.equal(record.sourceHash, next.buildIdentity.sourceHash);
      assert.deepEqual(record.artifactRevisions, [{ artifactHash: previous.artifactHash, proofHash: prior.proofHash, codeHash: prior.codeHash }]);
      for (const key of DEPLOYMENT_FIELDS) assert.deepEqual(record[key], prior[key], `${id} ${key}`);
      assert.deepEqual(record.provenance, { kind: 'apply' });
      assert.equal(record.transactions.length, 1);
    }
    const call = state.resources['call:bindGamma'];
    assert.equal(call.artifactHash, rebuiltRegistry.artifactHash);
    for (const key of DEPLOYMENT_FIELDS) assert.deepEqual(call[key], baseline.resources['call:bindGamma'][key], `call ${key}`);

    const rerun = await apply({ ...input, plan }, files);
    assert.equal(rerun.transactionsSigned, 0);
    assert.equal((await readState(files.stateFile)).resources['contract:alpha'].artifactRevisions.length, 1);
    const replanned = await createPlan({ ...input, client: chain.client, state: await readState(files.stateFile), ...planPolicy });
    assert.ok(replanned.resources.every(resource => resource.action === 'reuse' && resource.observation.stateComparison?.artifactDrift === undefined));
  });

  test('apply rejects accepted drift when the artifact, saved state, or live code changes after planning', async () => {
    const input = rebuiltInput();
    const plan = await createPlan({ ...input, client: chain.client, state: baseline, ...planPolicy });
    const before = await nonces();

    const again = rebuiltInput();
    again.artifacts.set('alpha', rebuild(holderArtifact, `0x${'5c'.repeat(32)}`));
    await rejectsWith(apply({ ...again, plan }, await workspace()), 'stale-artifact', 'contract:alpha');

    for (const change of [{ artifactHash: `0x${'5d'.repeat(32)}` }, { codeHash: `0x${'5e'.repeat(32)}` }, { salt: `0x${'5f'.repeat(32)}` }]) {
      const state = structuredClone(baseline);
      Object.assign(state.resources['contract:alpha'], change);
      if (change.codeHash || change.salt) delete state.resources['contract:alpha'].creationProof;
      const files = await workspace(state);
      await rejectsWith(apply({ ...input, plan }, files), 'stale-state');
      assert.deepEqual(await readState(files.stateFile), state);
    }

    const moved = `0x${'60'.repeat(32)}`;
    const verifyMoved = async (resource, client, options) => {
      const verification = await verifyResource(resource, client, options);
      return resource.id === 'contract:alpha' ? { ...verification, codeHash: moved } : verification;
    };
    await rejectsWith(apply({ ...input, plan }, await workspace(), { dependencies: { verifyResource: verifyMoved } }), 'drift', 'contract:alpha');

    // Rehashing a plan cannot turn rejected drift into reuse.
    const rejectedState = structuredClone(baseline);
    rejectedState.resources['contract:alpha'].codeHash = moved;
    delete rejectedState.resources['contract:alpha'].creationProof;
    const blocked = await createPlan({ ...input, client: chain.client, state: rejectedState, ...planPolicy });
    assert.equal(blocked.resources.find(resource => resource.id === 'contract:alpha').action, 'conflict');
    const forged = rehash({ ...blocked, resources: blocked.resources.map(resource => resource.action === 'conflict' ? { ...resource, action: 'reuse' } : resource) });
    await rejectsWith(apply({ ...input, plan: forged }, await workspace(rejectedState)), 'plan-not-applicable', 'contract:alpha');
    assert.deepEqual(await nonces(), before);
  });
});
