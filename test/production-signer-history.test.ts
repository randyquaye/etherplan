import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSignerHistory } from '../src/execution/settlement.ts';
import { hashJson } from '../src/identity.ts';
import { deployerA } from './execution/chain.ts';
import type { ApplyContext, SignedIndexEntry } from '../src/execution/types.ts';
import type { Hash } from '../src/types.ts';

const hash = (digit: string) => `0x${digit.repeat(64)}` as Hash;
const original = hash('1');
const replacement = hash('2');
const otherAction = hash('3');
const blockHash = hash('a');
const priorPlan = hash('b');
const currentPlan = hash('c');
const signer = deployerA.address.toLowerCase();

function indexEntry(transactionHash: Hash, actionId = 'contract:alpha'): SignedIndexEntry {
  return { project: 'test', environment: 'dev', label: 'previous', planHash: priorPlan, actionId, signer, nonce: '7', transactionHash };
}

function history(rows: SignedIndexEntry[], mined: Hash[], confirmations = 1, latestBlock = 12n, linked = true) {
  const scope = { project: 'test', environment: 'dev', chainId: 31337, genesisHash: hash('d'), label: 'next' };
  const indexed: { label: string; address: string }[] = [];
  const journalReads: string[] = [];
  const receiptLookups: string[] = [];
  const receipts = new Set(mined);
  const ordered = [original, replacement, otherAction].flatMap(transactionHash => rows.filter(row => row.transactionHash === transactionHash));
  const journal = ordered.reduce((records, row, index) => {
    const fields = { formatVersion: 2, sequence: index + 1, previousHash: records.at(-1)?.recordHash ?? null,
      planHash: row.planHash, chain: { id: scope.chainId, genesisHash: scope.genesisHash }, actionId: row.actionId,
      phase: 'signed', signer: row.signer, nonce: row.nonce, transactionHash: row.transactionHash,
      ...(row.transactionHash === replacement && linked ? { replacement: true, replacesTransactionHash: original } : {}),
      encryptedRawTransaction: { ciphertext: 'test' }, principal: 'test-runner', at: new Date().toISOString() };
    records.push({ ...fields, recordHash: hashJson(fields) });
    return records;
  }, [] as { recordHash: Hash }[]);
  const ctx = {
    remote: true, scope, plan: { planHash: currentPlan }, config: { confirmations, receiptTimeoutMs: 20 },
    journalStore: {
      async *signedForSigner(requestedScope: typeof scope, address: string) {
        indexed.push({ label: requestedScope.label, address });
        for (const row of rows) yield row;
      },
      async *read(requestedScope: typeof scope) {
        journalReads.push(requestedScope);
        for (const record of journal) yield record;
      },
    },
    client: {
      async getTransactionReceipt({ hash: transactionHash }: { hash: Hash }) {
        receiptLookups.push(transactionHash);
        if (!receipts.has(transactionHash)) throw Object.assign(new Error('no receipt'), { name: 'TransactionReceiptNotFoundError' });
        return { transactionHash, blockNumber: 12n, blockHash };
      },
      async getBlock({ blockNumber }: { blockNumber?: bigint }) {
        return blockNumber === undefined ? { number: latestBlock, hash: blockHash } : { number: blockNumber, hash: blockHash };
      },
    },
  } as unknown as ApplyContext;
  return { ctx, indexed, journalReads, receiptLookups };
}

async function rejectsCode(ctx: ApplyContext, code: string, actionId = 'contract:alpha') {
  await assert.rejects(assertSignerHistory(ctx, [deployerA.address]), error => {
    assert.equal(error.code, code, error.message);
    assert.equal(error.actionId, actionId);
    return true;
  });
}

test('a mined replacement settles the original index row across deployment labels', async () => {
  const rows = [indexEntry(original), indexEntry(replacement)];
  const { ctx, indexed, journalReads, receiptLookups } = history(rows, [replacement]);
  await assertSignerHistory(ctx, [deployerA.address]);
  assert.deepEqual(indexed, [{ label: 'next', address: signer }]);
  assert.deepEqual(journalReads, [{ ...ctx.scope, label: 'previous' }]);
  assert.ok(receiptLookups.includes(original));
  assert.ok(receiptLookups.includes(replacement));
});

test('the original receipt also settles a signer nonce with a replacement index row', async () => {
  const rows = [indexEntry(replacement), indexEntry(original)];
  const { ctx } = history(rows, [original]);
  await assertSignerHistory(ctx, [deployerA.address]);
});

test('missing receipts and insufficient confirmations stop signer reuse', async () => {
  const rows = [indexEntry(original), indexEntry(replacement)];
  await rejectsCode(history(rows, []).ctx, 'foreign-outstanding');
  await rejectsCode(history(rows, [replacement], 2).ctx, 'finality');
  await assertSignerHistory(history(rows, [replacement], 2, 13n).ctx, [deployerA.address]);
});

test('a receipt for one action cannot settle another indexed action at the same nonce', async () => {
  const rows = [indexEntry(original), indexEntry(replacement), indexEntry(otherAction, 'contract:beta')];
  await rejectsCode(history(rows, [replacement]).ctx, 'foreign-outstanding', 'contract:beta');
});

test('an unlinked signed transaction at the same action and nonce is not a replacement variant', async () => {
  const rows = [indexEntry(original), indexEntry(replacement)];
  await rejectsCode(history(rows, [replacement], 1, 12n, false).ctx, 'journal');
});

test('same label and plan hash in another project still reads its source journal', async () => {
  const row = { ...indexEntry(original), project: 'source', environment: 'prod', label: 'same', planHash: currentPlan };
  const { ctx, journalReads } = history([row], []);
  ctx.scope = { ...ctx.scope!, project: 'current', environment: 'dev', label: 'same' };
  await rejectsCode(ctx, 'foreign-outstanding');
  assert.deepEqual(journalReads, [{ ...ctx.scope, project: 'source', environment: 'prod' }]);
});

test('a current-plan signature without a canonical receipt blocks a fresh nonce', async () => {
  const row = { ...indexEntry(original), label: 'next', planHash: currentPlan };
  await rejectsCode(history([row], []).ctx, 'foreign-outstanding');
  await assertSignerHistory(history([row], []).ctx, [deployerA.address], new Set([original]));
});
