import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyPlan } from '../src/execution/index.mjs';
import { createPlan } from '../src/planning/index.mjs';
import { deployerA, fixture, startAnvil } from './execution/chain.mjs';

async function setup(chain) {
  const input = fixture({ withCall: false });
  input.spec.contracts = input.spec.contracts.filter(contract => ['alpha', 'gamma'].includes(contract.id));
  input.artifacts = new Map([...input.artifacts].filter(([name]) => ['alpha', 'gamma'].includes(name)));
  const plan = await createPlan({ ...input, client: chain.client });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'etherplan-finality-'));
  const journalFile = path.join(dir, 'journal.jsonl');
  return { ...input, plan, client: chain.client, signers: { deployer: [deployerA] },
    stateFile: path.join(dir, 'state.json'), journalFile, pollIntervalMs: 10, receiptTimeoutMs: 2_000 };
}

async function records(file) {
  return (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
}

test('a dependent wave waits for the configured confirmation depth', async () => {
  const chain = await startAnvil();
  try {
    const input = await setup(chain);
    let receiptSeen;
    const observed = new Promise(resolve => { receiptSeen = resolve; });
    const applying = applyPlan({ ...input, confirmations: 2, hooks: { async afterRecord(record) {
      if (record.phase === 'receipt' && record.actionId === 'contract:alpha') receiptSeen();
      if (record.phase === 'receipt' && record.actionId === 'contract:gamma') await chain.rpc('evm_mine');
    } } });
    await observed;
    await new Promise(resolve => setTimeout(resolve, 30));
    const before = await records(input.journalFile);
    assert.equal(before.filter(record => record.phase === 'verified').length, 0);
    assert.equal(before.filter(record => record.phase === 'signed' && record.actionId === 'contract:gamma').length, 0);
    await chain.rpc('evm_mine');
    assert.equal((await applying).status, 'applied');
  } finally { await chain.stop(); }
});

for (const phase of ['receipt', 'verified']) {
  test(`an orphaned receipt at ${phase} stops before its dependent is signed`, async () => {
    const chain = await startAnvil();
    try {
      const input = await setup(chain);
      const snapshot = await chain.rpc('evm_snapshot');
      let reverted = false;
      await assert.rejects(applyPlan({ ...input, confirmations: phase === 'receipt' ? 2 : 1, hooks: { async afterRecord(record) {
        if (!reverted && record.phase === phase && record.actionId === 'contract:alpha') {
          reverted = true;
          await chain.rpc('evm_revert', [snapshot]);
          await chain.rpc('evm_mine');
        }
      } } }), error => error.code === 'reorg');
      const saved = await records(input.journalFile);
      assert.equal(saved.filter(record => record.phase === 'signed' && record.actionId === 'contract:gamma').length, 0);
      assert.equal(saved.filter(record => record.phase === 'verified' && record.actionId === 'contract:gamma').length, 0);
    } finally { await chain.stop(); }
  });
}

test('restart rejects an earlier verified action whose receipt was orphaned', async () => {
  const chain = await startAnvil();
  try {
    const input = await setup(chain);
    const snapshot = await chain.rpc('evm_snapshot');
    assert.equal((await applyPlan(input)).status, 'applied');
    await chain.rpc('evm_revert', [snapshot]);
    await chain.rpc('evm_mine');
    await assert.rejects(applyPlan(input), error => error.code === 'reorg');
    assert.equal((await records(input.journalFile)).filter(record => record.phase === 'signed').length, 2);
  } finally { await chain.stop(); }
});
