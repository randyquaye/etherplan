import { mkdir, open, readFile, truncate } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '../identity.mjs';
import { validateJournalCreationProof } from '../verification/creation-proof.mjs';

export const JOURNAL_FORMAT_VERSION = 1;
export const PHASES = ['intent', 'signed', 'broadcast-attempt', 'broadcast', 'receipt', 'verified', 'failed'];
// A transaction in one of these phases may still change the chain or hold its signer's next nonce.
export const LIVE_PHASES = new Set(['signed', 'broadcast-attempt', 'broadcast', 'receipt']);
const SECRET_KEY = /^(private[_-]?key|secret[_-]?key|mnemonic|seed[_-]?phrase|passphrase)$/i;

function validateFields(value, where = 'record', decoded = false, topLevel = true) {
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

function validate(record, line) {
  const where = line === undefined ? 'record' : `line ${line}`;
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`Journal ${where} is not an object.`);
  if (record.formatVersion !== JOURNAL_FORMAT_VERSION) throw new Error(`Journal ${where} has an unsupported formatVersion.`);
  if (typeof record.planHash !== 'string' || typeof record.actionId !== 'string') throw new Error(`Journal ${where} needs planHash and actionId.`);
  if (!record.chain || !Number.isSafeInteger(record.chain.id) || typeof record.chain.genesisHash !== 'string') throw new Error(`Journal ${where} needs chain identity.`);
  if (!Number.isSafeInteger(record.sequence) || record.sequence < 1) throw new Error(`Journal ${where} needs a positive sequence.`);
  if (!PHASES.includes(record.phase)) throw new Error(`Journal ${where} has an unknown phase ${record.phase}.`);
  validateJournalCreationProof(record, `Journal ${where}`);
  validateFields(record, where);
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

// An unterminated last line is a write that never finished its sync, so no broadcast followed it. Recovery removes it.
export async function openJournal(file) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let text = '';
  let created = false;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    created = true;
  }
  let tornTail = null;
  if (text && !text.endsWith('\n')) {
    const end = text.lastIndexOf('\n') + 1;
    tornTail = text.slice(end);
    text = text.slice(0, end);
    await truncate(file, Buffer.byteLength(text));
  }
  const records = text.split('\n').filter(Boolean).map((line, index) => {
    let record;
    try { record = JSON.parse(line); } catch { throw new Error(`Journal ${file} line ${index + 1} is not valid JSON.`); }
    validate(record, index + 1);
    return record;
  });
  records.forEach((record, index) => {
    if (index > 0 && record.sequence <= records[index - 1].sequence) throw new Error(`Journal ${file} sequence is not increasing at line ${index + 1}.`);
  });

  const handle = await open(file, 'a', 0o600);
  await handle.chmod(0o600);
  await handle.sync();
  if (created) await syncDirectory(path.dirname(file));
  let queue = Promise.resolve();
  let closed = false;

  async function write(fields) {
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

export function latestRecord(records) {
  return records.at(-1) ?? null;
}

// The newest signed transaction for an action, with its latest phase. Only one transaction per action is live at a time.
export function currentTransaction(records) {
  const signed = records.filter(record => record.phase === 'signed').at(-1);
  if (!signed) return null;
  const later = records.filter(record => record.sequence > signed.sequence && record.transactionHash === signed.transactionHash);
  return { signed, phase: later.at(-1)?.phase ?? 'signed', receipt: later.filter(record => record.phase === 'receipt').at(-1) ?? null };
}

// A retry starts a new attempt after a signed or terminal record. An unsigned
// attempt may have failed, but two intents in one attempt are ambiguous.
export function intentForSigned(records, signed) {
  const sameAction = records.filter(record => record.planHash === signed.planHash && record.actionId === signed.actionId &&
    record.chain.id === signed.chain.id && record.chain.genesisHash.toLowerCase() === signed.chain.genesisHash.toLowerCase() &&
    record.sequence < signed.sequence);
  const boundary = sameAction.filter(record => ['signed', 'failed', 'verified'].includes(record.phase)).at(-1)?.sequence ?? 0;
  const intents = sameAction.filter(record => record.phase === 'intent' && record.sequence > boundary);
  if (intents.length !== 1) throw new Error(`Signed transaction needs one preceding intent in its attempt; found ${intents.length}.`);
  return intents[0];
}

// Groups records by plan and action, and returns each action whose newest record is a live transaction phase.
export function liveTransactions(records) {
  const groups = new Map();
  for (const record of records) {
    const key = `${record.planHash}\u0000${record.actionId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const live = [];
  for (const list of groups.values()) {
    const latest = latestRecord(list);
    const tx = currentTransaction(list);
    if (LIVE_PHASES.has(latest.phase) && tx) live.push({ latest, signed: tx.signed });
  }
  return live;
}
