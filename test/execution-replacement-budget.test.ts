import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyPlan } from '../src/execution/index.ts';
import { createPlan } from '../src/planning/index.ts';
import { deployerA, fixtureMany, startAnvil } from './execution/chain.ts';

const originalFees = { maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n };
const replacementFees = {
  maxFeePerGas: '20000000000',
  maxPriorityFeePerGas: '4000000000',
  maxCostWei: '5000000000000000',
};

async function workspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'etherplan-replacement-budget-'));
  return { stateFile: path.join(dir, 'state.json'), journalFile: path.join(dir, 'journal.jsonl') };
}

async function recordsOf(file: string) {
  return (await readFile(file, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function rejectsCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.message);
    return true;
  });
}

async function stuckPlan(
  chain: Awaited<ReturnType<typeof startAnvil>>,
  count: number,
  maxSpendWei: string,
) {
  const { spec, artifacts } = fixtureMany(count);
  const plan = await createPlan({
    spec,
    artifacts,
    client: chain.client,
    pipeline: { deployers: [deployerA.address], parallel: false },
    maxSpendWei,
  });
  const ws = await workspace();
  const input = { plan, spec, artifacts };
  await rejectsCode(
    apply(chain, input, ws, { fees: originalFees, receiptTimeoutMs: 80 }),
    'receipt-timeout',
  );
  const records = await recordsOf(ws.journalFile);
  assert.equal(records.filter((record) => record.phase === 'signed').length, count);
  return { input, ws, records };
}

function apply(
  chain: Awaited<ReturnType<typeof startAnvil>>,
  input: Awaited<ReturnType<typeof stuckPlan>>['input'],
  ws: Awaited<ReturnType<typeof workspace>>,
  options: Record<string, unknown> = {},
) {
  return applyPlan({
    ...input,
    client: chain.client,
    signers: { deployer: [deployerA] },
    stateFile: ws.stateFile,
    journalFile: ws.journalFile,
    pipeline: true,
    pollIntervalMs: 20,
    receiptTimeoutMs: 80,
    ...options,
  });
}

function cost(intent: { gas: string; maxFeePerGas: string; value: string }): bigint {
  return BigInt(intent.gas) * BigInt(intent.maxFeePerGas) + BigInt(intent.value);
}

test('a CLI-equivalent replacement cannot exceed the saved plan ceiling', async () => {
  const chain = await startAnvil(['--no-mining']);
  try {
    const { input, ws, records } = await stuckPlan(chain, 1, '1000000000000000');
    const original = records.find((record) => record.phase === 'intent');
    const proposed =
      BigInt(original.gas) * BigInt(replacementFees.maxFeePerGas) + BigInt(original.value);
    assert.equal(cost(original), 747_400_000_000_000n);
    assert.equal(proposed, 1_494_800_000_000_000n);
    assert.ok(cost(original) < BigInt(input.plan.maxSpendWei));
    assert.ok(proposed > BigInt(input.plan.maxSpendWei));
    assert.ok(proposed < BigInt(replacementFees.maxCostWei));

    await rejectsCode(apply(chain, input, ws, { replacementFees }), 'budget-exceeded');
    const after = await recordsOf(ws.journalFile);
    assert.equal(after.filter((record) => record.phase === 'signed').length, 1);
    assert.equal(
      after.filter((record) => record.phase === 'intent' && record.replacement).length,
      0,
    );
  } finally {
    await chain.stop();
  }
});

test('a fitting replacement settles and variants at its nonce commit only the larger cost', async () => {
  const chain = await startAnvil(['--no-mining']);
  try {
    const { input, ws, records: before } = await stuckPlan(chain, 1, '1600000000000000');
    const original = before.find((record) => record.phase === 'signed');
    const result = await apply(chain, input, ws, {
      replacementFees,
      hooks: {
        async afterRecord(record) {
          if (record.phase === 'broadcast' && record.transactionHash !== original.transactionHash)
            await chain.rpc('evm_mine');
        },
      },
    });
    assert.equal(result.status, 'applied');
    const records = await recordsOf(ws.journalFile);
    const variants = records.filter((record) => record.phase === 'signed');
    assert.equal(variants.length, 2);
    assert.equal(variants[0].nonce, variants[1].nonce);
    assert.equal(variants[1].replacesTransactionHash, variants[0].transactionHash);
    assert.equal(
      records.find((record) => record.phase === 'verified').transactionHash,
      variants[1].transactionHash,
    );
    assert.ok(
      cost(variants[0]) + cost(variants[1]) > BigInt(input.plan.maxSpendWei),
      'the variants would exceed the ceiling if counted separately',
    );
    assert.ok(cost(variants[1]) <= BigInt(input.plan.maxSpendWei));
  } finally {
    await chain.stop();
  }
});

test('another signed nonce makes the aggregate exceed the saved ceiling', async () => {
  const chain = await startAnvil(['--no-mining']);
  try {
    const { input, ws, records } = await stuckPlan(chain, 2, '2000000000000000');
    const intents = records.filter((record) => record.phase === 'intent');
    const originalTotal = intents.reduce((sum, intent) => sum + cost(intent), 0n);
    const replacementCost =
      BigInt(intents[0].gas) * BigInt(replacementFees.maxFeePerGas) + BigInt(intents[0].value);
    assert.ok(originalTotal <= BigInt(input.plan.maxSpendWei));
    assert.ok(replacementCost <= BigInt(input.plan.maxSpendWei));
    assert.ok(replacementCost + cost(intents[1]) > BigInt(input.plan.maxSpendWei));

    await rejectsCode(apply(chain, input, ws, { replacementFees }), 'budget-exceeded');
    const after = await recordsOf(ws.journalFile);
    assert.equal(after.filter((record) => record.phase === 'signed').length, 2);
    assert.equal(
      after.filter((record) => record.phase === 'intent' && record.replacement).length,
      0,
    );
  } finally {
    await chain.stop();
  }
});

test('a tighter programmatic budget rejects an orphaned replacement intent before signing', async () => {
  const chain = await startAnvil(['--no-mining']);
  try {
    const { input, ws } = await stuckPlan(chain, 1, '2000000000000000');
    await assert.rejects(
      apply(chain, input, ws, {
        replacementFees,
        hooks: {
          afterRecord(record) {
            if (record.phase === 'intent' && record.replacement)
              throw new Error('stop after replacement intent');
          },
        },
      }),
      /stop after replacement intent/,
    );
    assert.equal(
      (await recordsOf(ws.journalFile)).filter(
        (record) => record.phase === 'intent' && record.replacement,
      ).length,
      1,
    );

    await rejectsCode(
      apply(chain, input, ws, { budgets: { [deployerA.address]: '1000000000000000' } }),
      'budget-exceeded',
    );
    const after = await recordsOf(ws.journalFile);
    assert.equal(after.filter((record) => record.phase === 'signed').length, 1);
    assert.equal(
      after.filter((record) => record.phase === 'intent' && record.replacement).length,
      1,
    );
  } finally {
    await chain.stop();
  }
});
