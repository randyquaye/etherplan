import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyPlan } from '../src/execution/index.ts';
import { deploymentScope } from '../src/execution/backends.ts';
import { intentForSigned } from '../src/execution/journal.ts';
import { createPlan } from '../src/planning/index.ts';
import { deployerA, fixture, fixtureMany, startAnvil } from './execution/chain.ts';
import { memoryBackend } from './execution/memory-backend.ts';

async function journal(file: string) {
  return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function setup(pipeline = false) {
  const chain = await startAnvil(['--chain-id', '31338']);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'etherplan-orphan-intent-'));
  const input = pipeline ? fixtureMany(3) : fixture({ withCall: false });
  if (!pipeline) {
    input.spec.contracts = input.spec.contracts.filter(contract => contract.id === 'alpha');
    input.artifacts = new Map([['alpha', input.artifacts.get('alpha')]]);
  }
  input.spec.chainId = 31338;
  const plan = await createPlan({ ...input, client: chain.client,
    ...(pipeline ? { pipeline: { deployers: [deployerA.address], parallel: false } } : { signers: { deployers: [deployerA.address] } }),
    maxSpendWei: '100000000000000000000' });
  const journalFile = path.join(dir, 'journal.jsonl');
  let signatures = 0;
  const signer = { address: deployerA.address, async signTransaction(request: Parameters<typeof deployerA.signTransaction>[0]) {
    signatures++;
    return deployerA.signTransaction(request);
  } };
  const options = { ...input, plan, client: chain.client, signers: { deployer: [signer] },
    stateFile: path.join(dir, 'state.json'), journalFile, pipeline, pollIntervalMs: 10 };
  return { chain, options, journalFile, signatures: () => signatures };
}

test('serial retry binds a durable signature to its own intent after an unsigned crash', async () => {
  const run = await setup();
  try {
    await assert.rejects(applyPlan({ ...run.options, hooks: { afterRecord(record) {
      if (record.phase === 'intent') throw new Error('crash after intent');
    } } }), /crash after intent/);
    assert.equal(run.signatures(), 0);
    await assert.rejects(applyPlan({ ...run.options, hooks: { afterRecord(record) {
      if (record.phase === 'signed') throw new Error('crash after signed');
    } } }), /crash after signed/);
    const saved = await journal(run.journalFile);
    assert.deepEqual(saved.filter(record => ['intent', 'signed'].includes(record.phase)).map(record => record.phase), ['intent', 'intent', 'signed']);
    const signed = saved.find(record => record.phase === 'signed');
    assert.equal(intentForSigned(saved, signed).attemptId, signed.attemptId);
    assert.equal(run.signatures(), 1);
    assert.equal(await run.chain.client.getTransactionCount({ address: deployerA.address }), 0);
    const result = await applyPlan(run.options);
    assert.equal(result.status, 'applied');
    assert.equal(run.signatures(), 1);
    assert.equal((await run.chain.client.getTransactionReceipt({ hash: signed.transactionHash })).status, 'success');
    assert.equal((await journal(run.journalFile)).filter(record => record.phase === 'signed').length, 1);
  } finally { await run.chain.stop(); }
});

test('pipeline abandons an unsigned wave and preserves signed nonce offsets on recovery', async () => {
  const run = await setup(true);
  try {
    await assert.rejects(applyPlan({ ...run.options, hooks: { afterRecord(record) {
      if (record.phase === 'intent') throw new Error('crash in unsigned wave');
    } } }), /crash in unsigned wave/);
    await assert.rejects(applyPlan({ ...run.options, hooks: { afterRecord(record) {
      if (record.phase === 'signed') throw new Error('crash in partially signed wave');
    } } }), /crash in partially signed wave/);
    const before = await journal(run.journalFile);
    const saved = before.filter(record => record.phase === 'signed');
    assert.equal(saved.length, 1);
    assert.equal(run.signatures(), 1);
    const result = await applyPlan(run.options);
    assert.equal(result.status, 'applied');
    assert.equal(run.signatures(), 3);
    const after = await journal(run.journalFile);
    assert.deepEqual(after.filter(record => record.phase === 'signed').map(record => record.nonce), ['0', '1', '2']);
    assert.equal(after.filter(record => record.phase === 'signed' && record.actionId === saved[0].actionId).length, 1);
    assert.equal((await run.chain.client.getTransactionReceipt({ hash: saved[0].transactionHash })).status, 'success');
  } finally { await run.chain.stop(); }
});

test('encrypted production journal survives both crash boundaries and blocks another scope until recovered', async () => {
  const chain = await startAnvil(['--chain-id', '31338']);
  try {
    const backend = memoryBackend(deploymentScope({ project: 'a', environment: 'x', label: 'same' },
      { id: 31338, genesisHash: (await chain.client.getBlock({ blockNumber: 0n })).hash }));
    const prepare = async (name: string, project: string) => {
      const input = fixture({ withCall: false });
      input.spec.chainId = 31338;
      input.spec.contracts = input.spec.contracts.filter(contract => contract.id === name);
      input.artifacts = new Map([[name, input.artifacts.get(name)!]]);
      const plan = await createPlan({ ...input, client: chain.client, signers: { deployers: [deployerA.address] }, maxSpendWei: '100000000000000000000' });
      const scope = deploymentScope({ project, environment: 'x', label: 'same' }, plan.chain);
      return { input, plan, scope };
    };
    const a = await prepare('alpha', 'a');
    const b = await prepare('beta', 'b');
    let signatures = 0;
    const signerProvider = { async address() { return deployerA.address; }, async signTransaction(_role: string, request: Parameters<typeof deployerA.signTransaction>[0]) {
      signatures++;
      return deployerA.signTransaction(request);
    } };
    const options = (item: typeof a) => ({ ...item.input, plan: item.plan, scope: item.scope, client: chain.client,
      ...backend, signerProvider, confirmations: 1, pollIntervalMs: 10 });
    await assert.rejects(applyPlan({ ...options(a), hooks: { afterRecord(record) {
      if (record.phase === 'intent') throw new Error('crash after encrypted intent');
    } } }), /crash after encrypted intent/);
    await assert.rejects(applyPlan({ ...options(a), hooks: { afterRecord(record) {
      if (record.phase === 'signed') throw new Error('crash after encrypted signed record');
    } } }), /crash after encrypted signed record/);
    const saved = backend.recordsFor(a.scope).find(record => record.phase === 'signed');
    assert.ok(saved.encryptedRawTransaction);
    assert.equal(Object.hasOwn(saved, 'rawTransaction'), false);
    assert.equal(signatures, 1);
    await assert.rejects(applyPlan(options(b)), error => error.code === 'foreign-outstanding');
    assert.equal(signatures, 1);
    assert.equal((await applyPlan(options(a))).status, 'applied');
    assert.equal(signatures, 1);
    assert.equal((await applyPlan(options(b))).status, 'applied');
    assert.equal(signatures, 2);
    assert.equal((await chain.client.getTransactionReceipt({ hash: saved.transactionHash })).status, 'success');
  } finally { await chain.stop(); }
});

test('an unidentified intervening intent still stops recovery', () => {
  const chain = { id: 31338, genesisHash: `0x${'a'.repeat(64)}` };
  const base = { formatVersion: 1, planHash: `0x${'b'.repeat(64)}`, chain, actionId: 'contract:alpha' };
  const records = [
    { ...base, sequence: 1, phase: 'intent', attemptId: 'first' },
    { ...base, sequence: 2, phase: 'intent' },
    { ...base, sequence: 3, phase: 'intent', attemptId: 'second' },
    { ...base, sequence: 4, phase: 'signed', attemptId: 'second' },
  ];
  assert.throws(() => intentForSigned(records, records[3]), /ambiguous/);
});
