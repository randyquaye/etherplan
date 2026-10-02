import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyPlan } from '../src/execution/index.ts';
import { readStoredJournal } from '../src/execution/backends.ts';
import { readLocalJournal } from '../src/execution/journal.ts';
import { createPlan } from '../src/planning/index.ts';
import { readState } from '../src/state/index.ts';
import { deployerA, deployerB, fixtureMany, startAnvil } from './execution/chain.ts';
import { memoryBackend } from './execution/memory-backend.ts';

const ceiling = '1000000000000000000';
const fees = { maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n };

for (const [mode, pipeline, count] of [
  ['local', false, 1], ['local', true, 2], ['production', false, 1], ['production', true, 2],
] as const) {
  test(`${mode}${pipeline ? ' pipeline' : ''} replans pending signed deployments without another signature`, async () => {
    const chain = await startAnvil(['--no-mining']);
    const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-replan-recovery-'));
    try {
      const { spec, artifacts } = fixtureMany(count);
      const stateFile = path.join(directory, 'state.json');
      const journalFile = path.join(directory, 'journal.jsonl');
      const genesisHash = (await chain.client.getBlock({ blockNumber: 0n })).hash;
      const scope = { project: 'test', environment: 'dev', label: 'replan', chainId: 31337, genesisHash };
      const backend = mode === 'production' ? memoryBackend(scope) : null;
      const storage = backend ? { ...backend, scope, confirmations: 1 } : { stateFile, journalFile };
      const policy = pipeline ? { pipeline: { deployers: [deployerA.address], parallel: false } }
        : { signers: { deployers: [deployerA.address], parallel: false } };
      const initial = await createPlan({ spec, artifacts, client: chain.client, ...policy, maxSpendWei: ceiling });
      const apply = plan => applyPlan({ plan, spec, artifacts, client: chain.client, signers: { deployer: [deployerA] },
        ...storage, pipeline, pollIntervalMs: 20, receiptTimeoutMs: 80 });
      await assert.rejects(applyPlan({ plan: initial, spec, artifacts, client: chain.client, signers: { deployer: [deployerA] },
        ...storage, pipeline, fees, pollIntervalMs: 20, receiptTimeoutMs: 80 }), (error: { code?: string }) => error.code === 'receipt-timeout');
      const history = backend ? await readStoredJournal(backend.journalStore, scope) : await readLocalJournal(journalFile);
      const signed = history.filter(record => record.phase === 'signed');
      assert.equal(signed.length, count);
      const fresh = await createPlan({ spec, artifacts, client: chain.client, journalRecords: history, ...policy, maxSpendWei: ceiling });
      assert.ok(fresh.resources.every(resource => resource.action === 'recover'));
      assert.ok(fresh.resources.every(resource => resource.observation.recovery?.originPlanHash === initial.planHash));
      await chain.rpc('evm_mine');
      const result = await apply(fresh);
      assert.equal(result.status, 'applied');
      assert.equal(result.transactionsSigned, 0);
      const after = backend ? await readStoredJournal(backend.journalStore, scope) : await readLocalJournal(journalFile);
      assert.equal(after.filter(record => record.phase === 'signed').length, count);
      const state = backend ? (await backend.stateStore.read(scope))?.value : await readState(stateFile);
      for (const resource of fresh.resources) {
        assert.equal(state.resources[resource.id].creationProof.transactionHash,
          signed.find(record => record.actionId === resource.id)?.transactionHash.toLowerCase());
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
      await chain.stop();
    }
  });
}

for (const mode of ['local', 'production'] as const) {
  test(`${mode} replans a partly signed pipeline reservation`, async () => {
    const chain = await startAnvil();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-replan-partial-pipeline-'));
    try {
      const { spec, artifacts } = fixtureMany(3);
      const stateFile = path.join(directory, 'state.json');
      const journalFile = path.join(directory, 'journal.jsonl');
      const genesisHash = (await chain.client.getBlock({ blockNumber: 0n })).hash;
      const scope = { project: 'test', environment: 'dev', label: 'partial-pipeline', chainId: 31337, genesisHash };
      const backend = mode === 'production' ? memoryBackend(scope) : null;
      const storage = backend ? { ...backend, scope, confirmations: 1 } : { stateFile, journalFile };
      const policy = { pipeline: { deployers: [deployerA.address], parallel: false } };
      const initial = await createPlan({ spec, artifacts, client: chain.client, ...policy, maxSpendWei: ceiling });
      const common = { spec, artifacts, client: chain.client, signers: { deployer: [deployerA] }, ...storage, pipeline: true, pollIntervalMs: 20 };
      await assert.rejects(applyPlan({ ...common, plan: initial, hooks: { afterRecord(record: { phase: string }) {
        if (record.phase === 'signed') throw new Error('stop after first signature');
      } } }), /stop after first signature/);
      const history = backend ? await readStoredJournal(backend.journalStore, scope) : await readLocalJournal(journalFile);
      assert.equal(history.filter(record => record.phase === 'signed').length, 1);
      const fresh = await createPlan({ spec, artifacts, client: chain.client, journalRecords: history, ...policy, maxSpendWei: ceiling });
      assert.deepEqual(fresh.resources.map(resource => resource.action), ['recover', 'deploy', 'deploy']);
      const result = await applyPlan({ ...common, plan: fresh });
      assert.equal(result.status, 'applied');
      assert.equal(result.transactionsSigned, 2);
      const after = backend ? await readStoredJournal(backend.journalStore, scope) : await readLocalJournal(journalFile);
      assert.equal(after.filter(record => record.phase === 'signed').length, 3);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await chain.stop();
    }
  });
}

test('a changed deployment payload conflicts with an earlier pending signature', async () => {
  const chain = await startAnvil(['--no-mining']);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-replan-conflict-'));
  try {
    const { spec, artifacts } = fixtureMany(1);
    const stateFile = path.join(directory, 'state.json');
    const journalFile = path.join(directory, 'journal.jsonl');
    const policy = { signers: { deployers: [deployerA.address], parallel: false }, maxSpendWei: ceiling };
    const initial = await createPlan({ spec, artifacts, client: chain.client, ...policy });
    await assert.rejects(applyPlan({ plan: initial, spec, artifacts, client: chain.client,
      signers: { deployer: [deployerA] }, stateFile, journalFile, fees, pollIntervalMs: 20,
      receiptTimeoutMs: 80 }), (error: { code?: string }) => error.code === 'receipt-timeout');
    const changed = structuredClone(spec);
    changed.contracts[0]!.args[0] = `0x${'22'.repeat(20)}`;
    const fresh = await createPlan({ spec: changed, artifacts, client: chain.client,
      journalRecords: await readLocalJournal(journalFile), ...policy });
    assert.equal(fresh.resources[0]?.action, 'conflict');
    await assert.rejects(applyPlan({ plan: fresh, spec: changed, artifacts, client: chain.client,
      signers: { deployer: [deployerA] }, stateFile, journalFile }),
    (error: { code?: string }) => error.code === 'plan-not-applicable');
    assert.equal((await readLocalJournal(journalFile)).filter(record => record.phase === 'signed').length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await chain.stop();
  }
});

test('a fresh recovery plan rejects altered signed bytes before broadcast', async () => {
  const chain = await startAnvil();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-replan-tamper-'));
  try {
    const { spec, artifacts } = fixtureMany(1);
    const stateFile = path.join(directory, 'state.json');
    const journalFile = path.join(directory, 'journal.jsonl');
    const policy = { signers: { deployers: [deployerA.address], parallel: false }, maxSpendWei: ceiling };
    const initial = await createPlan({ spec, artifacts, client: chain.client, ...policy });
    const common = { spec, artifacts, client: chain.client, signers: { deployer: [deployerA] }, stateFile, journalFile };
    await assert.rejects(applyPlan({ ...common, plan: initial, hooks: { afterRecord(record: { phase: string }) {
      if (record.phase === 'signed') throw new Error('stop after signature');
    } } }), /stop after signature/);
    const fresh = await createPlan({ spec, artifacts, client: chain.client,
      journalRecords: await readLocalJournal(journalFile), ...policy });
    assert.equal(fresh.resources[0]?.action, 'recover');
    const history = (await readFile(journalFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    history.find(record => record.phase === 'signed').rawTransaction = '0x1234';
    await writeFile(journalFile, `${history.map(record => JSON.stringify(record)).join('\n')}\n`);
    await assert.rejects(applyPlan({ ...common, plan: fresh }), (error: { code?: string }) => error.code === 'journal');
    assert.equal((await readLocalJournal(journalFile)).filter(record => record.phase === 'broadcast').length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await chain.stop();
  }
});

test('a fresh pipeline validates every inherited signature before resending any of them', async () => {
  const chain = await startAnvil(['--no-mining']);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-replan-pipeline-tamper-'));
  try {
    const { spec, artifacts } = fixtureMany(2);
    const stateFile = path.join(directory, 'state.json');
    const journalFile = path.join(directory, 'journal.jsonl');
    const policy = { pipeline: { deployers: [deployerA.address], parallel: false }, maxSpendWei: ceiling };
    const initial = await createPlan({ spec, artifacts, client: chain.client, ...policy });
    const common = { spec, artifacts, client: chain.client, signers: { deployer: [deployerA] }, stateFile, journalFile,
      pipeline: true, pollIntervalMs: 20, receiptTimeoutMs: 80 };
    await assert.rejects(applyPlan({ ...common, plan: initial, fees }),
      (error: { code?: string }) => error.code === 'receipt-timeout');
    const fresh = await createPlan({ spec, artifacts, client: chain.client,
      journalRecords: await readLocalJournal(journalFile), ...policy });
    assert.deepEqual(fresh.resources.map(resource => resource.action), ['recover', 'recover']);
    const history = (await readFile(journalFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    const attempts = history.filter(record => record.phase === 'broadcast-attempt').length;
    history.filter(record => record.phase === 'signed')[1].rawTransaction = '0x1234';
    await writeFile(journalFile, `${history.map(record => JSON.stringify(record)).join('\n')}\n`);
    await assert.rejects(applyPlan({ ...common, plan: fresh }), (error: { code?: string }) => error.code === 'journal');
    assert.equal((await readLocalJournal(journalFile)).filter(record => record.phase === 'broadcast-attempt').length, attempts);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await chain.stop();
  }
});

test('replanning keeps the original signer available for its pending transaction', async () => {
  const chain = await startAnvil();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-replan-signer-'));
  try {
    const { spec, artifacts } = fixtureMany(1);
    const stateFile = path.join(directory, 'state.json');
    const journalFile = path.join(directory, 'journal.jsonl');
    const initial = await createPlan({ spec, artifacts, client: chain.client,
      signers: { deployers: [deployerA.address] }, maxSpendWei: ceiling });
    await assert.rejects(applyPlan({ plan: initial, spec, artifacts, client: chain.client,
      signers: { deployer: [deployerA] }, stateFile, journalFile,
      hooks: { afterRecord(record: { phase: string }) {
        if (record.phase === 'signed') throw new Error('stop after signature');
      } } }), /stop after signature/);
    const journalRecords = await readLocalJournal(journalFile);
    const wrongSigner = await createPlan({ spec, artifacts, client: chain.client, journalRecords,
      signers: { deployers: [deployerB.address] }, maxSpendWei: ceiling });
    assert.equal(wrongSigner.resources[0]?.action, 'conflict');
    const unpinned = await createPlan({ spec, artifacts, client: chain.client, journalRecords });
    assert.equal(unpinned.resources[0]?.action, 'recover');
    await assert.rejects(applyPlan({ plan: unpinned, spec, artifacts, client: chain.client,
      signers: { deployer: [deployerB] }, stateFile, journalFile }),
    (error: { code?: string }) => error.code === 'signer');
    assert.equal((await readLocalJournal(journalFile)).filter(record => record.phase === 'broadcast-attempt').length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await chain.stop();
  }
});
