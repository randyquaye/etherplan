import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { bytesToHex, hexToBytes } from 'viem';
import { hashJson } from '../identity.mjs';
import { jsonSafe } from './preflight.mjs';
import { validateJournalCreationProof } from '../verification/creation-proof.mjs';

const HASH = /^0x[0-9a-fA-F]{64}$/;
const SCOPE_PART = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function deploymentScope(input, chain) {
  const scope = { project: input?.project, environment: input?.environment, chainId: input?.chainId ?? chain?.id, genesisHash: input?.genesisHash ?? chain?.genesisHash, label: input?.label };
  for (const field of ['project', 'environment', 'label']) {
    if (typeof scope[field] !== 'string' || !SCOPE_PART.test(scope[field])) throw new Error(`Deployment scope needs a safe ${field}.`);
  }
  if (!Number.isSafeInteger(scope.chainId) || scope.chainId < 1 || !HASH.test(scope.genesisHash ?? '')) throw new Error('Deployment scope needs chain ID and genesis hash.');
  if (chain && (scope.chainId !== chain.id || scope.genesisHash.toLowerCase() !== chain.genesisHash.toLowerCase())) throw new Error('Deployment scope differs from the plan chain.');
  scope.genesisHash = scope.genesisHash.toLowerCase();
  return scope;
}

export function scopeKey(scope) {
  return [scope.project, scope.environment, scope.chainId, scope.genesisHash, scope.label].map(encodeURIComponent).join('/');
}

export function lockScopes(scope, addresses) {
  const base = { project: scope.project, environment: scope.environment, chainId: scope.chainId, genesisHash: scope.genesisHash };
  return [
    { ...base, kind: 'deployment', label: scope.label },
    ...[...new Set(addresses.map(address => address.toLowerCase()))].sort().map(address => ({ ...base, kind: 'signer', address })),
  ];
}

export function encryptionContext(record) {
  return { planHash: record.planHash, chainId: record.chain.id, genesisHash: record.chain.genesisHash.toLowerCase(), actionId: record.actionId, signer: record.signer.toLowerCase(), nonce: String(record.nonce) };
}

function recordHash(record) {
  const { recordHash: ignored, ...fields } = record;
  return hashJson(fields);
}

export function validateJournal(records, scope) {
  let previousHash = null;
  for (const [index, record] of records.entries()) {
    if (record.formatVersion !== 2 || record.sequence !== index + 1 || record.previousHash !== previousHash || record.recordHash !== recordHash(record)) throw new Error(`Journal integrity failure at sequence ${index + 1}.`);
    if (typeof record.planHash !== 'string' || !HASH.test(record.planHash) || typeof record.actionId !== 'string' || typeof record.phase !== 'string' || !['intent', 'signed', 'broadcast-attempt', 'broadcast', 'receipt', 'verified', 'failed'].includes(record.phase)) throw new Error(`Journal record ${index + 1} has invalid identity or phase.`);
    if (typeof record.principal !== 'string' || !record.principal || typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at))) throw new Error(`Journal record ${index + 1} lacks audit metadata.`);
    if (record.chain?.id !== scope.chainId || record.chain.genesisHash?.toLowerCase() !== scope.genesisHash) throw new Error(`Journal chain differs from deployment scope at sequence ${index + 1}.`);
    if (Object.hasOwn(record, 'rawTransaction')) throw new Error('Journal contains plaintext signed transaction bytes.');
    if (record.phase === 'signed' && !record.encryptedRawTransaction) throw new Error(`Signed journal record ${index + 1} has no ciphertext.`);
    validateJournalCreationProof(record, `Journal record ${index + 1}`);
    previousHash = record.recordHash;
  }
}

export async function openStoredJournal({ journalStore, journalCipher, scope, fence, assertHeld }) {
  const persisted = [];
  for await (const record of journalStore.read(scope)) persisted.push(record);
  validateJournal(persisted, scope);
  if (typeof journalStore.head === 'function') {
    const head = await journalStore.head(scope);
    if ((head?.sequence ?? 0) !== persisted.length || (head?.recordHash ?? null) !== (persisted.at(-1)?.recordHash ?? null)) throw new Error('Journal head differs from its records.');
  }
  const records = [];
  for (const item of persisted) {
    if (!item.encryptedRawTransaction) { records.push(item); continue; }
    const bytes = await journalCipher.decrypt(item.encryptedRawTransaction, encryptionContext(item));
    records.push({ ...item, rawTransaction: bytesToHex(bytes) });
  }
  let queue = Promise.resolve();
  return {
    file: null,
    tornTail: null,
    records,
    forAction(planHash, actionId) { return records.filter(record => record.planHash === planHash && record.actionId === actionId); },
    append(fields) {
      const task = queue.then(async () => {
        await assertHeld();
        const next = { formatVersion: 2, ...jsonSafe(fields), sequence: persisted.length + 1, previousHash: persisted.at(-1)?.recordHash ?? null, at: new Date().toISOString() };
        if (next.chain?.id !== scope.chainId || next.chain.genesisHash?.toLowerCase() !== scope.genesisHash) throw new Error('Journal append chain differs from deployment scope.');
        const raw = next.rawTransaction;
        delete next.rawTransaction;
        if (next.phase === 'signed') {
          if (typeof raw !== 'string') throw new Error('Signed journal record needs raw transaction bytes.');
          next.encryptedRawTransaction = await journalCipher.encrypt(hexToBytes(raw), encryptionContext(next));
        } else if (raw !== undefined) throw new Error('Only signed journal records may contain raw transaction bytes.');
        next.recordHash = recordHash(next);
        validateJournal([...persisted, next], scope);
        await journalStore.append(scope, next, { expectedSequence: next.sequence, expectedPreviousHash: next.previousHash, fence });
        persisted.push(next);
        const decoded = raw === undefined ? next : { ...next, rawTransaction: raw };
        records.push(decoded);
        return decoded;
      });
      queue = task.catch(() => {});
      return task;
    },
    async close() { await queue; },
  };
}

export async function acquireLeases({ lockProvider, scope, addresses, planHash, principal, ttlMs = 30_000, onRenew, onRenewFailure }) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 3_000) throw new Error('Lock ttlMs must be at least 3000.');
  if (principal !== undefined && (typeof principal !== 'string' || principal.length === 0)) throw new Error('Applying principal must be a nonempty string.');
  const holder = { id: randomUUID(), principal: principal ?? `${os.userInfo().username}@${os.hostname()}`, host: os.hostname(), pid: process.pid, planHash, acquiredAt: new Date().toISOString() };
  const acquired = [];
  try {
    for (const lockScope of lockScopes(scope, addresses)) acquired.push({ scope: lockScope, lease: await lockProvider.acquire(lockScope, holder, ttlMs) });
  } catch (error) {
    await Promise.allSettled(acquired.reverse().map(({ lease }) => lease.release()));
    throw error;
  }
  let lost = null;
  let closed = false;
  let renewing = Promise.resolve();
  const timer = setInterval(() => {
    renewing = renewing.then(async () => {
      if (closed || lost) return;
      try {
        for (const { lease } of acquired) await lease.renew();
        await onRenew?.({ holder, scopes: acquired.map(({ scope }) => scope) });
      } catch (error) {
        lost = error;
        await Promise.resolve().then(() => onRenewFailure?.({ holder, error })).catch(() => {});
      }
    });
  }, Math.floor(ttlMs / 3));
  timer.unref?.();
  const fence = acquired.map(({ scope: lockScope, lease }) => ({ scope: lockScope, token: lease.fencingToken, holderId: holder.id, principal: holder.principal }));
  if (fence.some(entry => !Number.isSafeInteger(entry.token) || entry.token < 1)) {
    clearInterval(timer);
    await Promise.allSettled(acquired.reverse().map(({ lease }) => lease.release()));
    throw new Error('Lock provider must return positive fencingToken values.');
  }
  return {
    holder,
    fence,
    recovered: null,
    async assertHeld() {
      if (lost) throw new Error(`Writer lease renewal failed: ${lost.message}`);
      for (const { lease } of acquired) await lease.assertHeld();
      if (lost) throw new Error(`Writer lease renewal failed: ${lost.message}`);
    },
    async release() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await renewing;
      await Promise.allSettled(acquired.reverse().map(({ lease }) => lease.release()));
    },
  };
}

export async function inspectDeployment({ scope: input, chain, planHash, journalStore, stateStore, lockProvider }) {
  const scope = deploymentScope(input, chain);
  const records = [];
  for await (const record of journalStore.read(scope)) records.push(record);
  validateJournal(records, scope);
  if (typeof journalStore.head === 'function') {
    const head = await journalStore.head(scope);
    if ((head?.sequence ?? 0) !== records.length || (head?.recordHash ?? null) !== (records.at(-1)?.recordHash ?? null)) throw new Error('Journal head differs from its records.');
  }
  const latest = records.at(-1) ?? null;
  const selected = planHash ? records.filter(record => record.planHash === planHash).at(-1) ?? null : latest;
  const [state, lock] = await Promise.all([
    stateStore.read(scope),
    lockProvider.inspect?.(lockScopes(scope, [])[0]) ?? null,
  ]);
  const signerAddresses = [...new Set(records.map(record => record.signer?.toLowerCase()).filter(Boolean))];
  const signerLocks = lockProvider.inspect ? await Promise.all(lockScopes(scope, signerAddresses).slice(1).map(async lockScope => ({ address: lockScope.address, ...await lockProvider.inspect(lockScope) }))) : [];
  return {
    scope, planHash: selected?.planHash ?? planHash ?? null,
    lastJournalPhase: selected?.phase ?? null, lastJournalSequence: selected?.sequence ?? null,
    journalHead: latest ? { sequence: latest.sequence, planHash: latest.planHash, phase: latest.phase, at: latest.at } : null,
    stateVersion: state?.version ?? null, stateUpdatedAt: state?.at ?? null,
    lock: lock ? { holder: lock.holder, expiresAt: lock.expiresAt, active: lock.active, fencingToken: lock.fencingToken } : null,
    signerLocks,
  };
}
