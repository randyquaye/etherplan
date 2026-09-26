import { mkdir, open, readFile, truncate } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '../identity.ts';
import { isRecord } from '../json.ts';
import { validateJournalCreationProof } from '../verification/creation-proof.ts';
import type { Hash } from '../types.ts';
import type { CurrentTransaction, IntentRecord, Journal, JournalPhase, JournalRecord, JournalRecordInput, LiveTransaction, ReceiptFields, SignedRecord } from './types.ts';

export const JOURNAL_FORMAT_VERSION = 1;
export const PHASES: JournalPhase[] = ['intent', 'signed', 'broadcast-attempt', 'broadcast', 'receipt', 'verified', 'failed'];
// A transaction in one of these phases may still change the chain or hold its signer's next nonce.
export const LIVE_PHASES: Set<JournalPhase> = new Set(['signed', 'broadcast-attempt', 'broadcast', 'receipt']);
const SECRET_KEY = /^(private[_-]?key|secret[_-]?key|mnemonic|seed[_-]?phrase|passphrase)$/i;

function validateFields(value: unknown, where = 'record', decoded = false, topLevel = true): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))) return;
  if (Array.isArray(value)) return value.forEach((item, index) => validateFields(item, `${where}[${index}]`, decoded, false));
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    for (const [key, item] of Object.entries(value)) {
      if (!decoded && SECRET_KEY.test(key)) throw new Error(`Journal ${where} has a forbidden key ${key}.`);
      validateFields(item, `${where}.${key}`, decoded || (topLevel && (key === 'verification' || key === 'evidence')), false);
    }
    return;
  }
  throw new Error(`Journal ${where} must contain only JSON values.`);
}

/** The runtime half of JournalRecord: a line from disk, or a record about to be written. */
function validate(record: unknown, line?: number): asserts record is JournalRecord {
  const where = line === undefined ? 'record' : `line ${line}`;
  if (!isRecord(record)) throw new Error(`Journal ${where} is not an object.`);
  if (record.formatVersion !== JOURNAL_FORMAT_VERSION) throw new Error(`Journal ${where} has an unsupported formatVersion.`);
  if (typeof record.planHash !== 'string' || typeof record.actionId !== 'string') throw new Error(`Journal ${where} needs planHash and actionId.`);
  const chain = record.chain;
  if (!isRecord(chain) || !Number.isSafeInteger(chain.id) || typeof chain.genesisHash !== 'string') throw new Error(`Journal ${where} needs chain identity.`);
  if (typeof record.sequence !== 'number' || !Number.isSafeInteger(record.sequence) || record.sequence < 1) throw new Error(`Journal ${where} needs a positive sequence.`);
  if (!PHASES.some(phase => phase === record.phase)) throw new Error(`Journal ${where} has an unknown phase ${record.phase}.`);
  validateJournalCreationProof(record as unknown as JournalRecord, `Journal ${where}`);
  validateFields(record, where);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** The transaction a record refers to; intents have none yet. */
function transactionHashOf(record: JournalRecord): Hash | undefined {
  return 'transactionHash' in record ? record.transactionHash : undefined;
}

// An unterminated last line is a write that never finished its sync, so no broadcast followed it. Recovery removes it.
export async function openJournal(file: string): Promise<Journal> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let text = '';
  let created = false;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    created = true;
  }
  let tornTail: string | null = null;
  if (text && !text.endsWith('\n')) {
    const end = text.lastIndexOf('\n') + 1;
    tornTail = text.slice(end);
    text = text.slice(0, end);
    await truncate(file, Buffer.byteLength(text));
  }
  const records = text.split('\n').filter(Boolean).map((line, index): JournalRecord => {
    let record: unknown;
    try { record = JSON.parse(line); } catch { throw new Error(`Journal ${file} line ${index + 1} is not valid JSON.`); }
    validate(record, index + 1);
    return record;
  });
  records.forEach((record, index) => {
    const previous = records[index - 1];
    if (previous && record.sequence <= previous.sequence) throw new Error(`Journal ${file} sequence is not increasing at line ${index + 1}.`);
  });

  const handle = await open(file, 'a', 0o600);
  await handle.chmod(0o600);
  await handle.sync();
  if (created) await syncDirectory(path.dirname(file));
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;

  async function write(fields: JournalRecordInput): Promise<JournalRecord> {
    if (closed) throw new Error('Journal is closed.');
    const record = { formatVersion: JOURNAL_FORMAT_VERSION, ...fields, sequence: (records.at(-1)?.sequence ?? 0) + 1, at: new Date().toISOString() };
    validate(record);
    await handle.write(`${canonicalJson(record)}\n`);
    await handle.sync();
    records.push(record);
    return record;
  }

  return {
    file,
    tornTail,
    records,
    // Appends are serialized; the promise resolves only after the record is durable.
    append(fields) {
      const result = queue.then(() => write(fields));
      queue = result.catch(() => {});
      return result;
    },
    forAction(planHash, actionId) {
      return records.filter(record => record.planHash === planHash && record.actionId === actionId);
    },
    async close() {
      if (closed) return;
      await queue;
      closed = true;
      await handle.close();
    },
  };
}

export function latestRecord(records: JournalRecord[]): JournalRecord | null {
  return records.at(-1) ?? null;
}

// The newest signed transaction for an action, with its latest phase. Only one transaction per action is live at a time.
export function currentTransaction(records: JournalRecord[]): CurrentTransaction | null {
  const signed = records.filter((record): record is SignedRecord => record.phase === 'signed').at(-1);
  if (!signed) return null;
  const later = records.filter(record => record.sequence > signed.sequence && transactionHashOf(record) === signed.transactionHash);
  const receipt = later.filter((record): record is JournalRecord & ReceiptFields => record.phase === 'receipt').at(-1) ?? null;
  return { signed, phase: later.at(-1)?.phase ?? 'signed', receipt };
}

// Follow durable replacement links back to the original signature for this nonce.
export function signedVariants(records: JournalRecord[], signed: SignedRecord): SignedRecord[] {
  const variants = [signed];
  const seen = new Set([signed.transactionHash.toLowerCase()]);
  let current = signed;
  while (current.replacesTransactionHash !== undefined) {
    const replaces = current.replacesTransactionHash;
    const previous = records.find((record): record is SignedRecord => record.phase === 'signed' && record.sequence < current.sequence &&
      record.transactionHash.toLowerCase() === replaces.toLowerCase() &&
      record.planHash === current.planHash && record.actionId === current.actionId);
    if (!current.replacement || !previous || seen.has(previous.transactionHash.toLowerCase()) || previous.signer.toLowerCase() !== current.signer.toLowerCase() ||
      previous.nonce !== current.nonce || previous.chain.id !== current.chain.id ||
      previous.chain.genesisHash.toLowerCase() !== current.chain.genesisHash.toLowerCase()) {
      throw new Error('Signed replacement has an invalid predecessor.');
    }
    seen.add(previous.transactionHash.toLowerCase());
    variants.unshift(previous);
    current = previous;
  }
  return variants;
}

// A retry starts a new attempt after a signed or terminal record. An unsigned
// attempt may have failed, but two intents in one attempt are ambiguous.
export function intentForSigned(records: JournalRecord[], signed: SignedRecord): IntentRecord {
  const sameAction = records.filter(record => record.planHash === signed.planHash && record.actionId === signed.actionId &&
    record.chain.id === signed.chain.id && record.chain.genesisHash.toLowerCase() === signed.chain.genesisHash.toLowerCase() &&
    record.sequence < signed.sequence);
  const boundary = sameAction.filter(record => ['signed', 'failed', 'verified'].includes(record.phase)).at(-1)?.sequence ?? 0;
  const intents = sameAction.filter((record): record is IntentRecord => record.phase === 'intent' && record.sequence > boundary);
  const [intent, ...extra] = intents;
  if (intent === undefined || extra.length > 0) throw new Error(`Signed transaction needs one preceding intent in its attempt; found ${intents.length}.`);
  return intent;
}

// Groups records by plan and action, including unresolved replacement attempts after a nonce race.
export function liveTransactions(records: JournalRecord[]): LiveTransaction[] {
  const groups = new Map<string, JournalRecord[]>();
  for (const record of records) {
    const key = `${record.planHash}\u0000${record.actionId}`;
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }
  const live: LiveTransaction[] = [];
  for (const list of groups.values()) {
    const latest = latestRecord(list);
    const tx = currentTransaction(list);
    if (!latest || !tx) continue;
    if (LIVE_PHASES.has(latest.phase) || (latest.phase === 'intent' && latest.replacement) ||
      (latest.phase === 'failed' && latest.code === 'nonce-race' && tx.signed.replacement)) live.push({ latest, signed: tx.signed });
  }
  return live;
}
