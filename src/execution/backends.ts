import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { bytesToHex, hexToBytes } from 'viem';
import { hashJson } from '../identity.ts';
import { field } from '../json.ts';
import { jsonSafe } from './preflight.ts';
import { validateJournalCreationProof } from '../verification/creation-proof.ts';
import type { Address, ChainIdentity, DecimalString, DistributiveOmit, Hash, Hex, ResourceId } from '../types.ts';
import type { AcquireLeasesInput, DeploymentLockScope, DeploymentScope, DeploymentStatus, EncryptionContext, InspectDeploymentInput, Journal, JournalRecord, Lease, LeaseHolder, Leases, LockScope, OpenStoredJournalInput, SignerLockScope, StoredJournalRecord } from './types.ts';

const HASH = /^0x[0-9a-fA-F]{64}$/;
const SCOPE_PART = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function scopePart(value: unknown, name: string): string {
  if (typeof value !== 'string' || !SCOPE_PART.test(value)) throw new Error(`Deployment scope needs a safe ${name}.`);
  return value;
}

export function deploymentScope(input: unknown, chain?: ChainIdentity | null): DeploymentScope {
  const project = scopePart(field(input, 'project'), 'project');
  const environment = scopePart(field(input, 'environment'), 'environment');
  const label = scopePart(field(input, 'label'), 'label');
  const chainId = field(input, 'chainId') ?? chain?.id;
  const genesisHash = field(input, 'genesisHash') ?? chain?.genesisHash;
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId < 1 || typeof genesisHash !== 'string' || !HASH.test(genesisHash)) throw new Error('Deployment scope needs chain ID and genesis hash.');
  if (chain && (chainId !== chain.id || genesisHash.toLowerCase() !== chain.genesisHash.toLowerCase())) throw new Error('Deployment scope differs from the plan chain.');
  return { project, environment, chainId, genesisHash: genesisHash.toLowerCase() as Hash, label };
}

export function scopeKey(scope: DeploymentScope): string {
  return [scope.project, scope.environment, scope.chainId, scope.genesisHash, scope.label].map(encodeURIComponent).join('/');
}

/** The deployment lease first, then one signer lease per distinct lowercase address. */
export function lockScopes(scope: DeploymentScope, addresses: Address[]): [DeploymentLockScope, ...SignerLockScope[]] {
  const base = { project: scope.project, environment: scope.environment, chainId: scope.chainId, genesisHash: scope.genesisHash };
  return [
    { ...base, kind: 'deployment', label: scope.label },
    ...[...new Set(addresses.map(address => address.toLowerCase() as Address))].sort().map((address): SignerLockScope => ({ ...base, kind: 'signer', address })),
  ];
}

export function encryptionContext(record: { planHash: Hash; chain: ChainIdentity; actionId: ResourceId; signer: Address; nonce: DecimalString | number }): EncryptionContext {
  return { planHash: record.planHash, chainId: record.chain.id, genesisHash: record.chain.genesisHash.toLowerCase() as Hash, actionId: record.actionId, signer: record.signer.toLowerCase() as Address, nonce: String(record.nonce) };
}

function recordHash(record: object): Hash {
  const { recordHash: _current, ...fields } = record as { recordHash?: unknown };
  return hashJson(fields);
}

export function validateJournal(records: StoredJournalRecord[], scope: DeploymentScope): void {
  let previousHash: Hash | null = null;
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

export async function openStoredJournal({ journalStore, journalCipher, scope, fence, assertHeld }: OpenStoredJournalInput): Promise<Journal> {
  const persisted: StoredJournalRecord[] = [];
  for await (const record of journalStore.read(scope)) persisted.push(record);
  validateJournal(persisted, scope);
  if (typeof journalStore.head === 'function') {
    const head = await journalStore.head(scope);
    if ((head?.sequence ?? 0) !== persisted.length || (head?.recordHash ?? null) !== (persisted.at(-1)?.recordHash ?? null)) throw new Error('Journal head differs from its records.');
  }
  const records: JournalRecord[] = [];
  for (const item of persisted) {
    if (item.phase !== 'signed') { records.push(item); continue; }
    const bytes = await journalCipher.decrypt(item.encryptedRawTransaction, encryptionContext(item));
    records.push({ ...item, rawTransaction: bytesToHex(bytes) });
  }
  let queue: Promise<unknown> = Promise.resolve();
  return {
    file: null,
    tornTail: null,
    records,
    forAction(planHash, actionId) { return records.filter(record => record.planHash === planHash && record.actionId === actionId); },
    append(fields) {
      const task = queue.then(async () => {
        await assertHeld();
        // The plaintext bytes leave the record before it is hashed and stored; only signed records may carry them.
        const { rawTransaction: raw, ...safe } = jsonSafe(fields) as JsonSafeInput;
        const envelope = { formatVersion: 2 as const, ...safe, sequence: persisted.length + 1, previousHash: persisted.at(-1)?.recordHash ?? null, at: new Date().toISOString() };
        if (envelope.chain?.id !== scope.chainId || envelope.chain.genesisHash?.toLowerCase() !== scope.genesisHash) throw new Error('Journal append chain differs from deployment scope.');
        let draft: DistributiveOmit<StoredJournalRecord, 'recordHash'>;
        if (envelope.phase === 'signed') {
          if (typeof raw !== 'string') throw new Error('Signed journal record needs raw transaction bytes.');
          const encryptedRawTransaction = await journalCipher.encrypt(hexToBytes(raw), encryptionContext(envelope));
          draft = { ...envelope, encryptedRawTransaction } as StoredJournalRecord;
        } else {
          if (raw !== undefined) throw new Error('Only signed journal records may contain raw transaction bytes.');
          draft = envelope as StoredJournalRecord;
        }
        // validateJournal is the runtime check of the shape the casts above claim.
        const next = { ...draft, recordHash: recordHash(draft) } as StoredJournalRecord;
        validateJournal([...persisted, next], scope);
        await journalStore.append(scope, next, { expectedSequence: next.sequence, expectedPreviousHash: next.previousHash, fence });
        persisted.push(next);
        const decoded = (raw === undefined ? next : { ...next, rawTransaction: raw }) as JournalRecord;
        records.push(decoded);
        return decoded;
      });
      queue = task.catch(() => {});
      return task;
    },
    async close() { await queue; },
  };
}

/** A journal append input after jsonSafe: every member may name the plaintext bytes so they can be split off. */
type JsonSafeInput = ReturnType<typeof jsonSafe<Parameters<Journal['append']>[0]>> & { rawTransaction?: Hex };

export async function acquireLeases({ lockProvider, scope, addresses, planHash, principal, ttlMs = 30_000, onRenew, onRenewFailure }: AcquireLeasesInput): Promise<Leases> {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 3_000) throw new Error('Lock ttlMs must be at least 3000.');
  if (principal !== undefined && (typeof principal !== 'string' || principal.length === 0)) throw new Error('Applying principal must be a nonempty string.');
  const holder: LeaseHolder = { id: randomUUID(), principal: principal ?? `${os.userInfo().username}@${os.hostname()}`, host: os.hostname(), pid: process.pid, planHash, acquiredAt: new Date().toISOString() };
  const acquired: { scope: LockScope; lease: Lease }[] = [];
  try {
    for (const lockScope of lockScopes(scope, addresses)) acquired.push({ scope: lockScope, lease: await lockProvider.acquire(lockScope, holder, ttlMs) });
  } catch (error) {
    await Promise.allSettled(acquired.reverse().map(({ lease }) => lease.release()));
    throw error;
  }
  let lost = null as Error | null;
  let closed = false;
  let renewing: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    renewing = renewing.then(async () => {
      if (closed || lost) return;
      try {
        for (const { lease } of acquired) await lease.renew();
        await onRenew?.({ holder, scopes: acquired.map(({ scope }) => scope) });
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        lost = failure;
        await Promise.resolve().then(() => onRenewFailure?.({ holder, error: failure })).catch(() => {});
      }
    });
  }, Math.floor(ttlMs / 3));
  timer.unref?.();
  function assertRenewed(): void {
    if (lost) throw new Error(`Writer lease renewal failed: ${lost.message}`);
  }
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
      assertRenewed();
      for (const { lease } of acquired) await lease.assertHeld();
      assertRenewed();
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

export async function inspectDeployment({ scope: input, chain, planHash, journalStore, stateStore, lockProvider }: InspectDeploymentInput): Promise<DeploymentStatus> {
  const scope = deploymentScope(input, chain);
  const records: StoredJournalRecord[] = [];
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
  const signerAddresses = [...new Set(records.flatMap(record => 'signer' in record && record.signer ? [record.signer.toLowerCase() as Address] : []))];
  const [, ...signerScopes] = lockScopes(scope, signerAddresses);
  const signerLocks = lockProvider.inspect ? await Promise.all(signerScopes.map(async lockScope => ({ address: lockScope.address, ...await lockProvider.inspect?.(lockScope) }))) : [];
  return {
    scope, planHash: selected?.planHash ?? planHash ?? null,
    lastJournalPhase: selected?.phase ?? null, lastJournalSequence: selected?.sequence ?? null,
    journalHead: latest ? { sequence: latest.sequence, planHash: latest.planHash, phase: latest.phase, at: latest.at } : null,
    stateVersion: state?.version ?? null, stateUpdatedAt: state?.at ?? null,
    lock: lock ? { holder: lock.holder, expiresAt: lock.expiresAt, active: lock.active, fencingToken: lock.fencingToken } : null,
    signerLocks,
  };
}
