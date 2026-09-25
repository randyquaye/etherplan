import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { currentTransaction, intentForSigned, liveTransactions, openJournal } from '../src/execution/journal.mjs';
import { acquireLock, LockError } from '../src/execution/lock.mjs';

const chain = { id: 31337, genesisHash: `0x${'aa'.repeat(32)}` };
const base = { planHash: `0x${'bb'.repeat(32)}`, chain };
const signer = '0x00000000000000000000000000000000000000d0';

async function directory() {
  return mkdtemp(path.join(os.tmpdir(), 'etherplan-journal-'));
}

test('journal appends durable records with increasing sequence and reads them back', async () => {
  const file = path.join(await directory(), 'nested', 'journal.jsonl');
  const journal = await openJournal(file);
  const [first, second] = await Promise.all([
    journal.append({ ...base, actionId: 'contract:a', phase: 'intent', signer, nonce: '0' }),
    journal.append({ ...base, actionId: 'contract:a', phase: 'signed', signer, nonce: '0', rawTransaction: '0x02c0', transactionHash: `0x${'cc'.repeat(32)}` }),
  ]);
  assert.deepEqual([first.sequence, second.sequence], [1, 2]);
  await journal.close();
  const lines = (await readFile(file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  const reopened = await openJournal(file);
  assert.deepEqual(reopened.records.map(record => record.phase), ['intent', 'signed']);
  assert.equal(reopened.tornTail, null);
  assert.equal((await reopened.append({ ...base, actionId: 'contract:a', phase: 'broadcast', signer, nonce: '0', transactionHash: `0x${'cc'.repeat(32)}` })).sequence, 3);
  await reopened.close();
});

test('an unterminated last line is removed on open, and earlier records survive', async () => {
  const file = path.join(await directory(), 'journal.jsonl');
  const journal = await openJournal(file);
  await journal.append({ ...base, actionId: 'contract:a', phase: 'intent', signer, nonce: '0' });
  await journal.close();
  await appendFile(file, '{"formatVersion":1,"phase":"sig');
  const recovered = await openJournal(file);
  assert.equal(recovered.tornTail, '{"formatVersion":1,"phase":"sig');
  assert.equal(recovered.records.length, 1);
  await recovered.append({ ...base, actionId: 'contract:a', phase: 'failed', code: 'test', retryable: true });
  await recovered.close();
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(lines.map(line => line.phase), ['intent', 'failed']);
});

test('a corrupt complete line, a sequence regression, or a secret-like field fails closed', async () => {
  const dir = await directory();
  const corrupt = path.join(dir, 'corrupt.jsonl');
  await writeFile(corrupt, 'not json\n');
  await assert.rejects(openJournal(corrupt), /line 1 is not valid JSON/);

  const record = { formatVersion: 1, ...base, actionId: 'contract:a', phase: 'intent', sequence: 2 };
  const regressed = path.join(dir, 'regressed.jsonl');
  await writeFile(regressed, `${JSON.stringify(record)}\n${JSON.stringify({ ...record, sequence: 1 })}\n`);
  await assert.rejects(openJournal(regressed), /sequence is not increasing/);

  const journal = await openJournal(path.join(dir, 'secret.jsonl'));
  await assert.rejects(journal.append({ ...base, actionId: 'contract:a', phase: 'intent', evidence: { privateKey: '0x01' } }), /forbidden key privateKey/);
  await assert.rejects(journal.append({ ...base, actionId: 'contract:a', phase: 'unknown' }), /unknown phase/);
  assert.equal(journal.records.length, 0);
  await journal.close();
});

test('live transactions are signed, broadcast, or receipt records without a later outcome', () => {
  let sequence = 0;
  const record = (actionId, phase, extra = {}) => ({ formatVersion: 1, ...base, actionId, phase, sequence: ++sequence, ...extra });
  const tx = (hash, nonce) => ({ signer, nonce, transactionHash: hash, rawTransaction: '0x02c0' });
  const h1 = `0x${'01'.repeat(32)}`;
  const h2 = `0x${'02'.repeat(32)}`;
  const h3 = `0x${'03'.repeat(32)}`;
  const records = [
    record('contract:a', 'signed', tx(h1, '0')),
    record('contract:a', 'broadcast', tx(h1, '0')),
    record('contract:b', 'signed', tx(h2, '1')),
    record('contract:b', 'failed', { code: 'nonce-race', retryable: true }),
    record('contract:c', 'signed', tx(h3, '2')),
    record('contract:c', 'receipt', { transactionHash: h3 }),
    record('contract:d', 'signed', tx(`0x${'04'.repeat(32)}`, '3')),
    record('contract:d', 'verified', { transactionHash: `0x${'04'.repeat(32)}` }),
  ];
  assert.deepEqual(liveTransactions(records).map(item => [item.latest.phase, item.signed.transactionHash]), [['broadcast', h1], ['receipt', h3]]);
  assert.equal(currentTransaction(records.filter(item => item.actionId === 'contract:c')).phase, 'receipt');
  assert.equal(currentTransaction(records.filter(item => item.actionId === 'contract:a')).phase, 'broadcast');
});

test('a live signature uses exactly one intent from its own action and attempt', () => {
  let sequence = 0;
  const record = (actionId, phase, extra = {}) => ({ formatVersion: 1, ...base, actionId, phase, sequence: ++sequence, ...extra });
  const old = record('contract:a', 'intent');
  const foreign = record('contract:b', 'intent');
  const first = record('contract:a', 'signed');
  const failed = record('contract:a', 'failed');
  const current = record('contract:a', 'intent');
  const duplicate = record('contract:a', 'intent');
  const signed = record('contract:a', 'signed');
  assert.equal(intentForSigned([old, foreign, first, failed, current, signed], signed), current);
  assert.throws(() => intentForSigned([old, foreign, first, failed, signed], signed), /found 0/);
  assert.throws(() => intentForSigned([old, foreign, first, failed, current, duplicate, signed], signed), /found 2/);
  const otherChain = { ...current, chain: { ...chain, genesisHash: `0x${'cc'.repeat(32)}` } };
  assert.throws(() => intentForSigned([old, foreign, first, failed, otherChain, signed], signed), /found 0/);
});

test('the writer lock excludes a live holder and recovers only a dead holder on this host', async () => {
  const dir = await directory();
  const file = path.join(dir, 'state.json.lock');
  const lock = await acquireLock(file, { planHash: base.planHash });
  await assert.rejects(acquireLock(file, { planHash: base.planHash }), error => error instanceof LockError && error.holder.pid === process.pid);
  await lock.release();

  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const deadPid = Number(dead.stdout);
  await writeFile(file, JSON.stringify({ id: 'stale', pid: deadPid, host: os.hostname(), planHash: base.planHash, acquiredAt: 'then' }));
  const recovered = await acquireLock(file, { planHash: base.planHash });
  assert.equal(recovered.recovered.pid, deadPid);
  await recovered.release();

  await writeFile(file, JSON.stringify({ id: 'remote', pid: deadPid, host: 'another-host', planHash: base.planHash, acquiredAt: 'then' }));
  await assert.rejects(acquireLock(file, { planHash: base.planHash }), /held by pid .* on another-host/);
  await writeFile(file, '');
  await assert.rejects(acquireLock(file, { planHash: base.planHash }), /unreadable/);
});

test('a lock release removes only its own lock file', async () => {
  const file = path.join(await directory(), 'state.json.lock');
  const lock = await acquireLock(file, { planHash: base.planHash });
  await writeFile(file, JSON.stringify({ id: 'someone-else', pid: process.pid, host: os.hostname() }));
  await lock.release();
  assert.equal(JSON.parse(await readFile(file, 'utf8')).id, 'someone-else');
});
