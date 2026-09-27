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
import { verifyResource } from '../src/verification/index.ts';
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
  return { chain, spec, artifacts, resource, input, stateFile, apply, attack, close };
}

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
