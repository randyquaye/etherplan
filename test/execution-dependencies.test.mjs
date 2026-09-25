import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { normalizeArtifact } from '../src/artifacts.mjs';
import { applyPlan } from '../src/execution/index.mjs';
import { hashJson } from '../src/identity.mjs';
import { createPlan } from '../src/planning/index.mjs';
import { createSchedule } from '../src/scheduling/index.mjs';
import { deployerA, deployerB, fixture, owner, startAnvil } from './execution/chain.mjs';
import { holderArtifact } from './execution/contracts.mjs';

const sample = JSON.parse(await readFile(new URL('./verification-fixtures/sample-build.json', import.meta.url), 'utf8'));
const sampleArtifact = name => normalizeArtifact({ ...sample.contracts[name], ast: sample.ast }, name);
const DOUBLER = `${sample.sourceName}:Doubler`;
const ONE = '0x0000000000000000000000000000000000000001';
const salt = digit => `0x${digit.repeat(64)}`;

async function workspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'etherplan-dependencies-'));
  return { stateFile: path.join(dir, 'state.json'), journalFile: path.join(dir, 'journal.jsonl') };
}

async function journalOf(file) {
  return (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function rehash(plan) {
  const { planHash, ...fields } = plan;
  return { ...fields, planHash: hashJson(fields) };
}

const sequenceOf = (records, phase, actionId) => records.find(record => record.phase === phase && record.actionId === actionId)?.sequence;

async function rejectsWith(promise, code, actionId) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code, error.message);
    if (actionId) assert.equal(error.actionId, actionId);
    return true;
  });
}

// stored keeps the predicted address of target as an immutable and proves it with its UPSTREAM getter.
function storedAddress(extra = {}) {
  const spec = {
    schema: 2,
    chainId: 31337,
    values: { upstream: ONE },
    contracts: [
      { id: 'target', artifact: 'Holder.json', salt: salt('a'), args: [{ ref: 'values.upstream' }], checks: { UPSTREAM: { ref: 'values.upstream' } }, senderIndependent: true },
      { id: 'stored', artifact: 'Holder.json', salt: salt('b'), args: [{ ref: 'contracts.target.address' }], checks: { UPSTREAM: { ref: 'contracts.target.address' } }, senderIndependent: true },
    ],
    executionAssumptions: ['constructor does not call contracts.target'],
    ...extra,
  };
  return { spec, artifacts: new Map([['target', holderArtifact], ['stored', holderArtifact]]) };
}

// The Linked constructor calls the Doubler library, so it needs the library live even though the link is only an address.
function linkedLibrary(linkedExtra = {}) {
  const spec = {
    schema: 2,
    chainId: 31337,
    contracts: [
      { id: 'doubler', artifact: 'Doubler.json', salt: salt('c'), args: [], senderIndependent: true },
      { id: 'linked', artifact: 'Linked.json', salt: salt('d'), args: ['21'], libraries: { [DOUBLER]: { ref: 'contracts.doubler.address' } }, checks: { SEED: '42' }, senderIndependent: true, ...linkedExtra },
    ],
  };
  return { spec, artifacts: new Map([['doubler', sampleArtifact('Doubler')], ['linked', sampleArtifact('Linked')]]) };
}

describe('split execution dependencies on a private chain', () => {
  let chain;
  let snapshot;

  const nonce = account => chain.client.getTransactionCount({ address: account.address });
  const planFor = (input, parallel = false) => createPlan({ ...input, client: chain.client,
    signers: { deployers: parallel ? [deployerA.address, deployerB.address] : [deployerA.address], owner: owner.address, parallel },
    maxSpendWei: '100000000000000000000' }).then(plan => ({ ...input, plan }));
  const apply = (input, ws, extra = {}) => applyPlan({
    ...input, client: chain.client, signers: { deployer: [deployerA, deployerB], owner }, stateFile: ws.stateFile, journalFile: ws.journalFile, pollIntervalMs: 20, ...extra,
  });

  before(async () => { chain = await startAnvil(); });
  after(async () => chain?.stop());
  beforeEach(async () => { snapshot = await chain.rpc('evm_snapshot'); });
  afterEach(async () => { await chain.rpc('evm_revert', [snapshot]); });

  test('a stored predicted address shares a wave with its contract and is signed before that receipt', async () => {
    const compatibility = await planFor(storedAddress({ dependencyMode: 'compatibility' }));
    assert.deepEqual(compatibility.plan.executionWaves.waves, [['contract:target'], ['contract:stored']]);

    const input = await planFor(storedAddress(), true);
    assert.deepEqual(input.plan.executionWaves, { waves: [['contract:target', 'contract:stored']], deferred: [] });
    assert.deepEqual(input.plan.warnings, []);
    const ws = await workspace();
    const result = await apply(input, ws, { parallel: true });
    assert.equal(result.status, 'applied');
    assert.equal(result.schedule.waves.length, 1);

    const records = await journalOf(ws.journalFile);
    assert.ok(sequenceOf(records, 'signed', 'contract:stored') < sequenceOf(records, 'receipt', 'contract:target'), 'stored is signed without waiting for the target receipt');
    const [target, stored] = input.plan.resources;
    assert.ok(result.resources.every(resource => resource.outcome === 'applied' && resource.verification.status === 'verified'));
    assert.equal((await chain.client.readContract({ address: stored.address, abi: holderArtifact.abi, functionName: 'UPSTREAM' })).toLowerCase(), target.address.toLowerCase());
  });

  test('a call waits only for its live target, and schedule explains each execution edge', async () => {
    const input = fixture();
    input.spec.schema = 2;
    const planned = await planFor(input);
    assert.deepEqual(planned.plan.executionWaves.waves, [['contract:alpha', 'contract:beta', 'contract:registry', 'contract:gamma'], ['call:bindGamma']]);
    assert.deepEqual(planned.plan.warnings, ['contract:gamma constructor references contracts.alpha.address without an execution dependency; confirm its constructor does not call the referenced contract.']);

    const schedule = createSchedule(planned.plan, [deployerA.address], { owner: owner.address });
    const entries = schedule.waves.flatMap(wave => wave.batches.flat());
    assert.deepEqual(entries.find(entry => entry.id === 'call:bindGamma').after, [{ id: 'contract:registry', reasons: ['live call target'] }]);
    assert.ok(entries.filter(entry => entry.kind === 'contract').every(entry => Array.isArray(entry.after) && entry.after.length === 0));
    assert.deepEqual(schedule.graphs, planned.plan.graphs);

    const ws = await workspace();
    assert.equal((await apply(planned, ws)).status, 'applied');
    const records = await journalOf(ws.journalFile);
    assert.ok(sequenceOf(records, 'verified', 'contract:registry') < sequenceOf(records, 'intent', 'call:bindGamma'));
  });

  test('a constructor that calls its library fails before signing without an edge and deploys after one', async () => {
    const unsafe = await planFor(linkedLibrary(), true);
    assert.deepEqual(unsafe.plan.executionWaves.waves, [['contract:doubler', 'contract:linked']]);
    assert.match(unsafe.plan.warnings[0], /^contract:linked links library contracts\.doubler\.address without an execution dependency/);
    const failed = await workspace();
    await rejectsWith(apply(unsafe, failed, { parallel: true }), 'estimate-failed', 'contract:linked');
    const failedRecords = await journalOf(failed.journalFile);
    assert.equal(failedRecords.filter(record => record.phase === 'signed').length, 0);
    assert.equal(failedRecords.filter(record => record.phase === 'verified').length, 0);
    assert.equal(await nonce(deployerA) + await nonce(deployerB), 0);

    const ordered = await planFor(linkedLibrary({ after: ['contract:doubler'] }), true);
    assert.deepEqual(ordered.plan.executionWaves.waves, [['contract:doubler'], ['contract:linked']]);
    assert.deepEqual(ordered.plan.warnings, []);
    const ws = await workspace();
    assert.equal((await apply(ordered, ws, { parallel: true })).status, 'applied');
    const records = await journalOf(ws.journalFile);
    assert.ok(sequenceOf(records, 'verified', 'contract:doubler') < sequenceOf(records, 'intent', 'contract:linked'));
    const linked = ordered.plan.resources.find(resource => resource.id === 'contract:linked');
    assert.equal(await chain.client.readContract({ address: linked.address, abi: sampleArtifact('Linked').abi, functionName: 'SEED' }), 42n);
  });

  test('apply rechecks a completed dependency on chain before it signs the dependent', async () => {
    const ordered = storedAddress();
    delete ordered.spec.executionAssumptions;
    ordered.spec.contracts[1].after = ['contract:target'];
    const input = await planFor(ordered);
    const [target] = input.plan.resources;
    const ws = await workspace();
    const hooks = {
      afterRecord: async record => {
        if (record.phase === 'verified' && record.actionId === 'contract:target') await chain.rpc('anvil_setCode', [target.address, '0x00']);
      },
    };
    await rejectsWith(apply(input, ws, { hooks }), 'dependency', 'contract:stored');
    const records = await journalOf(ws.journalFile);
    assert.equal(sequenceOf(records, 'intent', 'contract:stored'), undefined);
    assert.equal(await nonce(deployerA), 1);
  });

  test('a pipeline plan reserves consecutive nonces for contracts that share a split-mode wave', async () => {
    const input = storedAddress();
    const plan = await createPlan({ ...input, client: chain.client, pipeline: { deployers: [deployerA.address], parallel: false }, maxSpendWei: '100000000000000000000' });
    assert.deepEqual(plan.pipeline.waves.map(wave => wave.batches.flat().map(entry => [entry.id, entry.nonceOffset])), [[['contract:target', 0], ['contract:stored', 1]]]);
    const ws = await workspace();
    const result = await apply({ ...input, plan }, ws, { pipeline: true, signers: { deployer: [deployerA] } });
    assert.equal(result.status, 'applied');
    const records = await journalOf(ws.journalFile);
    assert.ok(sequenceOf(records, 'signed', 'contract:stored') < sequenceOf(records, 'broadcast-attempt', 'contract:target'), 'both nonces are signed before the first broadcast');
    assert.equal(await nonce(deployerA), 2);
  });

  test('a pipeline apply rechecks a completed dependency before it reserves or resends the dependent', async () => {
    const ordered = storedAddress();
    delete ordered.spec.executionAssumptions;
    ordered.spec.contracts[1].after = ['contract:target'];
    const plan = await createPlan({ ...ordered, client: chain.client, pipeline: { deployers: [deployerA.address], parallel: false }, maxSpendWei: '100000000000000000000' });
    assert.deepEqual(plan.pipeline.waves.map(wave => wave.batches.flat().map(entry => entry.id)), [['contract:target'], ['contract:stored']]);
    const [target] = plan.resources;
    const input = { ...ordered, plan };
    const pipelined = { pipeline: true, signers: { deployer: [deployerA] } };

    const changed = await workspace();
    const breakTarget = { afterRecord: async record => {
      if (record.phase === 'verified' && record.actionId === 'contract:target') await chain.rpc('anvil_setCode', [target.address, '0x00']);
    } };
    await rejectsWith(apply(input, changed, { ...pipelined, hooks: breakTarget }), 'dependency', 'contract:stored');
    assert.equal(sequenceOf(await journalOf(changed.journalFile), 'intent', 'contract:stored'), undefined);
    assert.equal(await nonce(deployerA), 1);
    await chain.rpc('evm_revert', [snapshot]);
    snapshot = await chain.rpc('evm_snapshot');

    // Stop after the dependent is signed, then change its dependency before the resume.
    const ws = await workspace();
    const stopAfterSigning = { afterRecord: async record => {
      if (record.phase === 'signed' && record.actionId === 'contract:stored') throw new Error('stop after signing');
    } };
    await assert.rejects(apply(input, ws, { ...pipelined, hooks: stopAfterSigning }), /stop after signing/);
    const signed = (await journalOf(ws.journalFile)).find(record => record.phase === 'signed' && record.actionId === 'contract:stored');
    const beforeChange = await chain.rpc('evm_snapshot');
    await chain.rpc('anvil_setCode', [target.address, '0x00']);
    await rejectsWith(apply(input, ws, pipelined), 'dependency', 'contract:stored');
    assert.equal(sequenceOf(await journalOf(ws.journalFile), 'broadcast-attempt', 'contract:stored'), undefined);
    assert.equal(await nonce(deployerA), 1);

    await chain.rpc('evm_revert', [beforeChange]);
    const resumed = await apply(input, ws, pipelined);
    assert.equal(resumed.status, 'applied');
    assert.deepEqual(resumed.rebroadcasts, [{ actionId: 'contract:stored', transactionHash: signed.transactionHash }]);
    assert.equal((await journalOf(ws.journalFile)).filter(record => record.phase === 'signed' && record.actionId === 'contract:stored').length, 1);
  });

  test('the plan hash covers both graphs and assumptions, and apply rejects an edited graph', async () => {
    const base = await planFor(storedAddress());
    const { plan } = base;
    assert.equal(plan.formatVersion, 2);
    assert.equal(plan.dependencyMode, 'split');
    assert.deepEqual(plan.executionAssumptions, ['constructor does not call contracts.target']);
    assert.deepEqual(plan.graphs.resolution.find(node => node.id === 'contract:stored').needs, [
      { id: 'contract:target', reasons: ['args[0] needs contracts.target.address', 'checks.UPSTREAM needs contracts.target.address'] },
    ]);
    assert.deepEqual(plan.resources[1].executionEdges, []);

    const reordered = value => Array.isArray(value) ? value.map(reordered)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reordered(item)])) : value;
    const hashOf = async spec => (await createPlan({ ...storedAddress(), spec, client: chain.client,
      signers: { deployers: [deployerA.address] }, maxSpendWei: '100000000000000000000' })).planHash;
    assert.equal(await hashOf(reordered(storedAddress().spec)), plan.planHash);
    assert.notEqual(await hashOf(storedAddress({ executionAssumptions: ['constructor does not call contracts.target (reviewed)'] }).spec), plan.planHash);

    const edited = structuredClone(plan);
    edited.graphs.execution.find(node => node.id === 'contract:stored').after = [{ id: 'contract:target', reasons: ['explicit after'] }];
    const ws = await workspace();
    await rejectsWith(apply({ ...base, plan: rehash(edited) }, ws), 'stale-resource');
    await rejectsWith(apply({ ...base, plan: rehash({ ...plan, formatVersion: 1 }) }, ws), 'stale-spec');
    assert.equal(await nonce(deployerA), 0);
    assert.deepEqual(await journalOf(ws.journalFile), []);
  });
});
