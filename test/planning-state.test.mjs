import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { keccak256 } from 'viem';
import { exampleSpec, normalizedArtifact, preparedResource, state as interfaceState, verificationResult } from './interface-fixtures.mjs';
import { hashJson } from '../src/identity.mjs';
import { createPlan, prepareResources, transactionFor } from '../src/planning/index.mjs';
import { graph, impact, parseSpec } from '../src/spec/index.mjs';
import { importResource, readState, recordResource, writeStateAtomic } from '../src/state/index.mjs';

const ONE = '0x0000000000000000000000000000000000000001';
const TWO = '0x0000000000000000000000000000000000000002';
const GENESIS = `0x${'aa'.repeat(32)}`;
const SALT_A = `0x${'11'.repeat(32)}`;
const SALT_B = `0x${'22'.repeat(32)}`;
const FACTORY_CODE = '0x6001';
const OBSERVED_HASH = `0x${'bb'.repeat(32)}`;

function artifact(abi) {
  const fields = {
    abi,
    bytecode: { object: '0x6000', linkReferences: {} },
    deployedBytecode: { object: '0x6000', linkReferences: {}, immutableReferences: {} },
    buildIdentity: { compiler: 'solc', version: '0.8.30', sourceHash: `0x${'33'.repeat(32)}` },
  };
  return { ...fields, artifactHash: hashJson(fields) };
}

const vaultArtifact = artifact([
  { type: 'constructor', stateMutability: 'nonpayable', inputs: [{ name: 'destination', type: 'bytes32' }] },
]);
const routerArtifact = artifact([
  { type: 'constructor', stateMutability: 'nonpayable', inputs: [{ name: 'vault', type: 'address' }] },
]);

function deploymentSpec(destination = `0x${'01'.repeat(32)}`) {
  return {
    schema: 1,
    chainId: 31337,
    values: { destination },
    contracts: [
      { id: 'vault', artifact: 'Vault.json', salt: SALT_A, args: [{ ref: 'values.destination' }], senderIndependent: true },
      { id: 'router', artifact: 'Router.json', salt: SALT_B, args: [{ ref: 'contracts.vault.address' }] },
    ],
  };
}

function planningSpec(destination = `0x${'01'.repeat(32)}`) {
  return {
    ...deploymentSpec(destination),
    factory: {
      address: '0x4e59b44847b379578588920cA78FbF26c0B4956C',
      codeHash: keccak256(FACTORY_CODE),
    },
  };
}

function planningClient({ chainId = 31337, code = new Map(), binding = null } = {}) {
  const reads = [];
  return {
    reads,
    async getChainId() {
      reads.push(['chain']);
      return chainId;
    },
    async getBlock(request) {
      reads.push(['block', request]);
      if (request.blockNumber === 0n) return { number: 0n, hash: GENESIS };
      return { number: 7n, hash: OBSERVED_HASH };
    },
    async getCode({ address, blockNumber }) {
      reads.push(['code', address, blockNumber]);
      if (address.toLowerCase() === '0x4e59b44847b379578588920ca78fbf26c0b4956c') return FACTORY_CODE;
      return code.get(address.toLowerCase()) ?? '0x';
    },
    async readContract(request) {
      reads.push(['read', request.address, request.functionName, request.blockNumber]);
      if (binding === null) throw new Error('No binding result was configured.');
      return binding;
    },
  };
}

test('prepared resources and imported state match the frozen interface fixtures', () => {
  const spec = parseSpec(exampleSpec);
  assert.deepEqual(spec, exampleSpec);
  const prepared = prepareResources(spec, graph(spec), new Map([['example', normalizedArtifact]])).resources[0];
  assert.deepEqual(prepared, preparedResource);
  assert.deepEqual(importResource({ resource: prepared, verification: verificationResult, state: null, chain: interfaceState.chain }), interfaceState);
});

test('spec validation is strict, nonmutating, and rejects bad references', () => {
  const raw = deploymentSpec();
  const parsed = parseSpec(raw);
  assert.equal(raw.factory, undefined);
  assert.equal(parsed.factory.address, '0x4e59b44847b379578588920cA78FbF26c0B4956C');
  assert.throws(() => parseSpec({ ...deploymentSpec(), surprise: true }), /unknown field surprise/);

  const missing = deploymentSpec();
  missing.contracts[0].args = [{ ref: 'values.missing' }];
  assert.throws(() => parseSpec(missing), /Missing value missing/);

  const malformed = deploymentSpec();
  malformed.contracts[0].args = [{ ref: 'contracts.router' }];
  assert.throws(() => parseSpec(malformed), /invalid reference contracts\.router/);

  const secret = deploymentSpec();
  secret.values.privateKey = `0x${'99'.repeat(32)}`;
  assert.throws(() => parseSpec(secret), /forbidden signer secret field privateKey/);
});

test('graph rejects cycles and explicit missing dependencies', () => {
  const cyclic = parseSpec(deploymentSpec());
  cyclic.contracts[0].args = [{ ref: 'contracts.router.address' }];
  assert.throws(() => graph(cyclic), /Dependency cycle/);

  const missing = parseSpec(deploymentSpec());
  missing.contracts[1].after = ['call:missing'];
  assert.throws(() => graph(missing), /Missing graph node call:missing/);
});

test('destination replacement changes the vault, router, and downstream impact', () => {
  const artifacts = new Map([['vault', vaultArtifact], ['router', routerArtifact]]);
  const beforeSpec = parseSpec(deploymentSpec());
  const afterSpec = parseSpec(deploymentSpec(`0x${'02'.repeat(32)}`));
  const before = prepareResources(beforeSpec, graph(beforeSpec), artifacts);
  const afterOrder = graph(afterSpec);
  const after = prepareResources(afterSpec, afterOrder, artifacts);

  assert.deepEqual(after.resources.map(resource => resource.id), ['contract:vault', 'contract:router']);
  assert.notEqual(before.addresses.vault, after.addresses.vault);
  assert.notEqual(before.addresses.router, after.addresses.router);
  assert.deepEqual(impact(afterSpec, afterOrder, 'values.destination'), ['contract:vault', 'contract:router']);
  assert.equal(after.resources[0].senderIndependent, true);
  assert.equal(after.resources[1].senderIndependent, false);
  assert.deepEqual(after.resources[1].dependencies, ['contract:vault']);
});

test('prepared calls lock resolved before and after predicates with the owner role', () => {
  const raw = deploymentSpec();
  raw.values.before = ONE;
  raw.calls = [{
    id: 'bindRouter',
    target: 'router',
    method: 'setVault',
    args: [{ ref: 'contracts.vault.address' }],
    check: { function: 'vault', args: [{ ref: 'values.before' }], equals: { ref: 'contracts.vault.address' } },
    before: { equals: { ref: 'values.before' } },
  }];
  const callableRouterArtifact = artifact([
    ...routerArtifact.abi,
    { type: 'function', name: 'setVault', stateMutability: 'nonpayable', inputs: [{ name: 'vault', type: 'address' }], outputs: [] },
    { type: 'function', name: 'vault', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'address' }] },
  ]);
  const spec = parseSpec(raw);
  const prepared = prepareResources(spec, graph(spec), new Map([['vault', vaultArtifact], ['router', callableRouterArtifact]]));
  const call = prepared.resources.at(-1);
  assert.equal(call.id, 'call:bindRouter');
  assert.equal(call.signerRole, 'owner');
  assert.deepEqual(call.check, { functionName: 'vault', args: [ONE] });
  assert.deepEqual(call.before.args, [ONE]);
  assert.deepEqual(call.after.args, [ONE]);
  assert.equal(call.before.expected, ONE);
  assert.equal(call.after.expected, prepared.addresses.vault);
  assert.deepEqual(call.dependencies, ['contract:router', 'contract:vault']);
});

test('plans are deterministic, read-only, anchored, and fail on chain or factory mismatch', async () => {
  const spec = planningSpec();
  const artifacts = new Map([['vault', vaultArtifact], ['router', routerArtifact]]);
  const client = planningClient();
  const first = await createPlan({ spec, artifacts, client });
  const second = await createPlan({ spec, artifacts, client });
  const prepared = prepareResources(parseSpec(spec), graph(parseSpec(spec)), artifacts);

  assert.deepEqual(second, first);
  assert.equal(first.planHash, hashJson(Object.fromEntries(Object.entries(first).filter(([key]) => key !== 'planHash'))));
  assert.deepEqual(first.chain, { id: 31337, genesisHash: GENESIS });
  assert.deepEqual(first.observed, { blockNumber: '7', blockHash: OBSERVED_HASH });
  assert.deepEqual(first.resources.map(resource => resource.action), ['deploy', 'deploy']);
  assert(first.resources.every(resource => Object.keys(resource.tx).sort().join(',') === 'data,to,value'));
  assert.deepEqual(first.resources[0].tx, transactionFor(prepared.resources[0]));
  assert.throws(() => transactionFor({ id: 'external:none', kind: 'external' }), /has no transaction payload/);
  assert(client.reads.every(read => !['sendTransaction', 'writeContract'].includes(read[0])));

  await assert.rejects(createPlan({ spec, artifacts, client: planningClient({ chainId: 1 }) }), /spec requires 31337/);
  const wrongFactory = planningClient();
  wrongFactory.getCode = async () => '0x6002';
  await assert.rejects(createPlan({ spec, artifacts, client: wrongFactory }), /factory code differs or is absent/);
});

test('planner chooses call only at the allowed before value and locks encoded call data', async () => {
  const spec = planningSpec();
  spec.values.before = ONE;
  spec.calls = [{
    id: 'bindRouter',
    target: 'router',
    method: 'setVault',
    args: [{ ref: 'contracts.vault.address' }],
    check: { function: 'vault', equals: { ref: 'contracts.vault.address' } },
    before: { equals: { ref: 'values.before' } },
  }];
  const callableRouterArtifact = artifact([
    ...routerArtifact.abi,
    { type: 'function', name: 'setVault', stateMutability: 'nonpayable', inputs: [{ name: 'vault', type: 'address' }], outputs: [] },
    { type: 'function', name: 'vault', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  ]);
  const parsed = parseSpec(spec);
  const artifacts = new Map([['vault', vaultArtifact], ['router', callableRouterArtifact]]);
  const prepared = prepareResources(parsed, graph(parsed), artifacts);
  const live = new Map(Object.values(prepared.addresses).map(address => [address.toLowerCase(), '0x6000']));
  const plan = await createPlan({ spec, artifacts, client: planningClient({ code: live, binding: ONE }) });
  const call = plan.resources.at(-1);
  assert.equal(call.action, 'call');
  assert.equal(call.observation.bindingChecks[0].observed, 'before');
  assert.equal(call.tx.to, prepared.addresses.router);
  assert.match(call.tx.data, /^0x[0-9a-f]+$/);
  assert.equal(call.tx.value, '0');

  const pending = await createPlan({ spec, artifacts, client: planningClient() });
  assert.deepEqual(pending.resources.map(resource => resource.action), ['deploy', 'deploy', 'call']);
  assert.equal(pending.resources.at(-1).observation.bindingChecks[0].observed, 'read-failed');
  assert.equal(pending.resources.at(-1).observation.pending.targetId, 'contract:router');
});

test('state evidence distinguishes contract replacement from incompatible identity drift', async () => {
  const artifacts = new Map([['vault', vaultArtifact], ['router', routerArtifact]]);
  const oldSpec = parseSpec(planningSpec());
  const oldPrepared = prepareResources(oldSpec, graph(oldSpec), artifacts);
  const chain = { id: 31337, genesisHash: GENESIS };
  let state = null;
  for (const resource of oldPrepared.resources) {
    const verification = {
      id: resource.id,
      address: resource.address,
      codeHash: `0x${'44'.repeat(32)}`,
      codeComparison: { mode: 'exact', matched: true },
      proofs: [],
      missingProofs: [],
      bindingChecks: [],
      status: 'verified',
    };
    state = importResource({ resource, verification, state, chain });
  }

  const newSpec = planningSpec(`0x${'02'.repeat(32)}`);
  const replacement = await createPlan({ spec: newSpec, artifacts, client: planningClient(), state });
  assert.deepEqual(replacement.resources.map(resource => resource.observation.stateComparison.replacement), [true, true]);
  assert.deepEqual(replacement.resources.map(resource => resource.action), ['deploy', 'deploy']);
  assert.equal(replacement.resources[0].observation.stateComparison.previousAddress, oldPrepared.addresses.vault);
  assert.equal(replacement.resources[1].observation.stateComparison.previousAddress, oldPrepared.addresses.router);

  const corrupt = structuredClone(state);
  corrupt.resources['contract:vault'].address = TWO;
  const conflict = await createPlan({ spec: oldSpec, artifacts, client: planningClient(), state: corrupt });
  assert.equal(conflict.resources[0].action, 'conflict');
  assert.equal(conflict.resources[0].observation.stateComparison.conflict, true);
});

test('state snapshots round-trip atomically and absent state returns null', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-b-'));
  const file = path.join(directory, 'nested', 'state.json');
  try {
    assert.equal(await readState(file), null);
    const state = {
      formatVersion: 1,
      chain: { id: 31337, genesisHash: GENESIS },
      resources: {
        'contract:imported': {
          address: ONE,
          artifactHash: vaultArtifact.artifactHash,
          sourceHash: vaultArtifact.buildIdentity.sourceHash,
          initcodeHash: null,
          inputs: [],
          inputsHash: hashJson([]),
          priorInputs: null,
          priorInputsHash: null,
          salt: null,
          codeHash: `0x${'44'.repeat(32)}`,
          proofHash: `0x${'55'.repeat(32)}`,
          transactions: [],
        },
      },
    };
    await writeStateAtomic(file, state);
    assert.deepEqual(await readState(file), state);
    assert.match(await readFile(file, 'utf8'), /"formatVersion": 1/);
    const files = await import('node:fs/promises').then(fs => fs.readdir(path.dirname(file)));
    assert.deepEqual(files, ['state.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('import requires verified evidence and compatible state identity', () => {
  const resource = {
    id: 'contract:imported',
    kind: 'contract',
    address: ONE,
    artifact: vaultArtifact,
    artifactHash: vaultArtifact.artifactHash,
    inputs: [],
    inputsHash: hashJson([]),
  };
  const verification = {
    id: resource.id,
    address: ONE,
    codeHash: `0x${'44'.repeat(32)}`,
    codeComparison: { mode: 'exact', matched: true },
    proofs: [],
    missingProofs: [],
    bindingChecks: [],
    status: 'verified',
  };
  const chain = { id: 31337, genesisHash: GENESIS };
  const state = importResource({ resource, verification, state: null, chain });
  assert.equal(state.resources[resource.id].proofHash, hashJson(verification));
  assert.deepEqual(state.resources[resource.id].transactions, []);

  assert.throws(() => importResource({ resource, verification: { ...verification, status: 'unverified' }, state: null, chain }), /without verified live evidence/);
  assert.throws(() => importResource({ resource, verification: { ...verification, address: TWO }, state: null, chain }), /identity does not match/);
  assert.throws(() => importResource({ resource, verification, state, chain: { id: 1, genesisHash: GENESIS } }), /different chain/);
});

test('recordResource persists verified postconditions, transactions, and prior desired inputs', () => {
  const artifacts = new Map([['vault', vaultArtifact], ['router', routerArtifact]]);
  const oldSpec = parseSpec(planningSpec());
  const oldResource = prepareResources(oldSpec, graph(oldSpec), artifacts).resources[0];
  const chain = { id: 31337, genesisHash: GENESIS };
  const oldVerification = {
    id: oldResource.id,
    address: oldResource.address,
    codeHash: `0x${'44'.repeat(32)}`,
    codeComparison: { mode: 'exact', matched: true },
    proofs: [],
    missingProofs: [],
    bindingChecks: [],
    status: 'verified',
  };
  const firstTransaction = `0x${'66'.repeat(32)}`;
  let state = recordResource({ resource: oldResource, verification: oldVerification, state: null, chain, transactions: [firstTransaction] });
  assert.deepEqual(state.resources[oldResource.id].transactions, [firstTransaction]);
  assert.equal(state.resources[oldResource.id].priorInputs, null);

  const newSpec = parseSpec(planningSpec(`0x${'02'.repeat(32)}`));
  const newResource = prepareResources(newSpec, graph(newSpec), artifacts).resources[0];
  const newVerification = { ...oldVerification, address: newResource.address, codeHash: `0x${'55'.repeat(32)}` };
  const secondTransaction = `0x${'77'.repeat(32)}`;
  state = recordResource({ resource: newResource, verification: newVerification, state, chain, transactions: [secondTransaction, firstTransaction] });
  assert.deepEqual(state.resources[newResource.id].priorInputs, oldResource.inputs);
  assert.equal(state.resources[newResource.id].priorInputsHash, oldResource.inputsHash);
  assert.deepEqual(state.resources[newResource.id].transactions, [firstTransaction, secondTransaction]);

  const call = {
    id: 'call:bind',
    kind: 'call',
    address: ONE,
    targetArtifact: routerArtifact,
    method: 'bind',
    args: [TWO],
    check: { functionName: 'binding', args: [] },
    before: { functionName: 'binding', expected: ONE },
    after: { functionName: 'binding', expected: TWO },
    signerRole: 'owner',
  };
  const callVerification = { ...oldVerification, id: call.id, address: call.address, bindingChecks: [{ observed: 'after' }] };
  state = recordResource({ resource: call, verification: callVerification, state, chain, transactions: [secondTransaction] });
  assert.equal(state.resources[call.id].inputs.method, 'bind');
  assert.throws(() => recordResource({ resource: call, verification: { ...callVerification, status: 'unverified', bindingChecks: [{ observed: 'before' }] }, state, chain }), /without a verified postcondition/);
});
