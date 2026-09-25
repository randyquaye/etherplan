import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createWalletClient, http } from 'viem';
import { normalizeArtifact } from '../src/artifacts.mjs';
import { applyPlan } from '../src/execution/index.mjs';
import { createPlan, prepareResources } from '../src/planning/index.mjs';
import { graph, parseSpec } from '../src/spec/index.mjs';
import { importResource, readState } from '../src/state/index.mjs';
import { verifyResource } from '../src/verification/index.mjs';
import { deployerA, startAnvil } from './execution/chain.mjs';

const planPolicy = { signers: { deployers: [deployerA.address] }, maxSpendWei: '100000000000000000000' };

const here = path.dirname(fileURLToPath(import.meta.url));
const build = JSON.parse(await readFile(path.join(here, 'verification-fixtures/sample-build.json'), 'utf8'));
const stamped = normalizeArtifact({ ...build.contracts.Stamped, ast: build.ast }, 'Stamped');

function inputs(dependent = true) {
  const contracts = [{ id: 'stamp', artifact: 'Stamped.json', salt: `0x${'11'.repeat(32)}`, args: ['9'] }];
  if (dependent) contracts.push({ id: 'later', artifact: 'Stamped.json', salt: `0x${'22'.repeat(32)}`, args: ['10'], after: ['contract:stamp'] });
  return { spec: { schema: 2, chainId: 31337, values: {}, contracts, calls: [] }, artifacts: new Map(contracts.map(item => [item.id, stamped])) };
}

async function setup() {
  const chain = await startAnvil();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'etherplan-block-proof-'));
  return { chain, stateFile: path.join(dir, 'state.json'), journalFile: path.join(dir, 'journal.jsonl'), async close() {
    await chain.stop();
    await rm(dir, { recursive: true, force: true });
  } };
}

function apply({ chain, stateFile, journalFile }, input, extra = {}) {
  return applyPlan({ ...input, client: chain.client, signers: { deployer: [deployerA] }, stateFile, journalFile, pollIntervalMs: 20, ...extra });
}

test('a timestamp immutable remains verified across dependency waves and later plans', async () => {
  const ws = await setup();
  try {
    const input = inputs();
    input.plan = await createPlan({ ...input, client: ws.chain.client, ...planPolicy });
    assert.deepEqual(input.plan.resources.map(item => item.action), ['deploy', 'deploy']);
    const first = await apply(ws, input);
    assert.equal(first.transactionsSigned, 2);
    const state = await readState(ws.stateFile);
    for (const record of Object.values(state.resources)) assert.equal(record.creationProof.kind, 'create2');
    const journal = (await readFile(ws.journalFile, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(journal.filter(record => record.phase === 'verified' && record.creationProof).length, 2);

    await ws.chain.rpc('evm_increaseTime', [3600]);
    await ws.chain.rpc('evm_mine', []);
    const replanned = await createPlan({ ...input, client: ws.chain.client, state, ...planPolicy });
    assert.deepEqual(replanned.resources.map(item => item.action), ['reuse', 'reuse']);
    const legacy = structuredClone(state);
    for (const record of Object.values(legacy.resources)) delete record.creationProof;
    const reconstructed = await createPlan({ ...input, client: ws.chain.client, state: legacy, ...planPolicy });
    assert.deepEqual(reconstructed.resources.map(item => item.action), ['reuse', 'reuse']);
    const reused = await apply(ws, { ...input, plan: replanned });
    assert.equal(reused.transactionsSigned, 0);
    assert.ok(reused.resources.every(item => item.verification.status === 'verified'));
  } finally { await ws.close(); }
});

test('a verified journal anchor survives interruption before state persistence', async () => {
  const ws = await setup();
  try {
    const input = inputs(false);
    input.plan = await createPlan({ ...input, client: ws.chain.client, ...planPolicy });
    await assert.rejects(apply(ws, input, { hooks: { afterRecord(record) {
      if (record.phase === 'verified') throw new Error('interrupted after durable verification');
    } } }), /interrupted after durable verification/);
    const journal = (await readFile(ws.journalFile, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(journal.find(record => record.phase === 'verified')?.creationProof);
    assert.equal(await readState(ws.stateFile), null);
    await ws.chain.rpc('evm_increaseTime', [3600]);
    await ws.chain.rpc('evm_mine', []);
    const resumed = await apply(ws, input);
    assert.equal(resumed.transactionsSigned, 0);
    assert.equal(resumed.resources[0].verification.status, 'verified');
    assert.ok((await readState(ws.stateFile)).resources['contract:stamp'].creationProof);
  } finally { await ws.close(); }
});

test('an imported direct CREATE uses its validated creation transaction in later plans', async () => {
  const ws = await setup();
  try {
    const wallet = createWalletClient({ account: deployerA, transport: http(ws.chain.url) });
    const transactionHash = await wallet.deployContract({ abi: stamped.abi, bytecode: stamped.bytecode.object, args: [12n] });
    const receipt = await ws.chain.client.waitForTransactionReceipt({ hash: transactionHash, pollingInterval: 20 });
    const spec = { schema: 1, chainId: 31337, values: {}, contracts: [{ id: 'stamp', artifact: 'Stamped.json', address: receipt.contractAddress, args: ['12'] }], calls: [] };
    const artifacts = new Map([['stamp', stamped]]);
    const resource = prepareResources(spec, graph(parseSpec(spec)), artifacts).resources[0];
    const verification = await verifyResource(resource, ws.chain.client, { transactionHash });
    assert.equal(verification.status, 'verified');
    const chain = { id: 31337, genesisHash: (await ws.chain.client.getBlock({ blockNumber: 0n })).hash };
    const state = importResource({ resource, verification, state: null, chain, creationTransactionHash: transactionHash });
    assert.equal(state.resources['contract:stamp'].initcodeHash, null);
    assert.equal(state.resources['contract:stamp'].creationProof.kind, 'create');
    await ws.chain.rpc('evm_increaseTime', [3600]);
    await ws.chain.rpc('evm_mine', []);
    const plan = await createPlan({ spec, artifacts, client: ws.chain.client, state });
    assert.equal(plan.resources[0].action, 'reuse');
    assert.equal(plan.resources[0].observation.status, 'verified');
  } finally { await ws.close(); }
});
