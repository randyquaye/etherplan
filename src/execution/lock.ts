import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Address, ChainIdentity } from '../types.ts';
import { acquireLocalSignerLocks } from './local-signer.ts';
import type { LocalLock, LocalLockHolder } from './types.ts';

export class LockError extends Error {
  declare code: 'state-locked';
  declare holder: LocalLockHolder | null | undefined;

  constructor(message: string, holder: LocalLockHolder | null | undefined) {
    super(message);
    this.name = 'LockError';
    this.code = 'state-locked';
    this.holder = holder;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The lock file's JSON is trusted as a holder. `undefined` means no file; `null` means an unreadable one. */
async function readHolder(file: string): Promise<LocalLockHolder | null | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return null;
  }
}

function describe(file: string, holder: LocalLockHolder | null | undefined): string {
  if (!holder) return `State lock ${file} exists but is unreadable. Remove it only after you confirm that no apply is running.`;
  return `State lock ${file} is held by pid ${holder.pid} on ${holder.host} for plan ${holder.planHash} since ${holder.acquiredAt}.`;
}

function validHolder(holder: LocalLockHolder | null | undefined): holder is LocalLockHolder {
  return !!holder && typeof holder.id === 'string' && Number.isSafeInteger(holder.pid) && holder.pid > 0 && typeof holder.host === 'string';
}

/** Each immutable entry has a unique name, so deleting a dead entry cannot delete a replacement writer's claim. */
export async function acquireLock(file: string, { planHash }: { planHash: string | null }): Promise<LocalLock> {
  await mkdir(path.dirname(file), { recursive: true });
  const registry = `${file}.holders`;
  await mkdir(registry, { recursive: true, mode: 0o700 });
  const holder: LocalLockHolder = { id: randomUUID(), pid: process.pid, host: os.hostname(), planHash, acquiredAt: new Date().toISOString() };
  const entry = path.join(registry, `${holder.id}.json`);
  const pending = path.join(registry, `.pending-${holder.id}`);
  let recovered: LocalLockHolder | null = null;
  let published = false;
  let markerCreated = false;
  try {
    const pendingHandle = await open(pending, 'wx', 0o600);
    try {
      await pendingHandle.writeFile(JSON.stringify(holder));
      await pendingHandle.sync();
    } finally {
      await pendingHandle.close();
    }
    await link(pending, entry);
    published = true;
    await unlink(pending);

    for (const name of await readdir(registry)) {
      if (name.startsWith('.pending-') || name === `${holder.id}.json`) continue;
      const otherFile = path.join(registry, name);
      const other = await readHolder(otherFile);
      if (other === undefined) continue; // A departing holder removed its own entry.
      if (!validHolder(other) || other.host !== holder.host || alive(other.pid)) throw new LockError(describe(file, other), other);
      try { await unlink(otherFile); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      recovered ??= other;
    }

    // The traditional .lock file remains readable for operators and older holders.
    // Only a process with the sole live registry entry may replace a dead marker.
    let created = false;
    for (let attempt = 0; attempt < 3 && !created; attempt++) {
      let handle: FileHandle;
      try {
        handle = await open(file, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await readHolder(file);
        if (existing === undefined) continue;
        if (!validHolder(existing) || existing.host !== holder.host || alive(existing.pid)) throw new LockError(describe(file, existing), existing);
        try { await unlink(file); }
        catch (unlinkError) { if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError; }
        recovered ??= existing;
        continue;
      }
      markerCreated = true;
      try {
        await handle.writeFile(JSON.stringify(holder));
        await handle.sync();
      } finally {
        await handle.close();
      }
      created = true;
    }
    if (!created) throw new LockError(`Could not acquire state lock ${file}; another process changed it during recovery.`, null);
    let released = false;
    return {
      file,
      holder,
      recovered,
      async assertHeld() {
        const [current, claim] = await Promise.all([readHolder(file), readHolder(entry)]);
        if (current?.id !== holder.id || claim?.id !== holder.id) throw new LockError(`State lock ${file} is no longer held by this process.`, current);
      },
      async release() {
        if (released) return;
        released = true;
        const current = await readHolder(file);
        if (current?.id === holder.id) await unlink(file);
        const claim = await readHolder(entry);
        if (claim?.id === holder.id) await unlink(entry);
      },
    };
  } catch (error) {
    if (markerCreated) {
      const current = await readHolder(file);
      if (current?.id === holder.id) await unlink(file).catch(() => {});
    }
    if (published) await unlink(entry).catch(() => {});
    await unlink(pending).catch(() => {});
    throw error;
  }
}

/** Resolve existing symlinks, including symlinked parent directories of a new file. */
export async function canonicalLocalFile(file: string): Promise<string> {
  const absolute = path.resolve(file);
  let ancestor = absolute;
  const missing: string[] = [];
  while (true) {
    try {
      return path.join(await realpath(ancestor), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        if ((await lstat(ancestor)).isSymbolicLink()) throw new Error(`Cannot lock dangling symbolic link ${ancestor}.`);
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== 'ENOENT') throw probe;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

export async function localJournalLockFile(file: string): Promise<string> {
  return `${await canonicalLocalFile(file)}.lock`;
}

/** Keep both local resources exclusive, in the same order in every process. */
export async function acquireLocalApplyLocks(stateFile: string, journalFile: string, planHash: string | null, chain: ChainIdentity, addresses: Address[]): Promise<{ lock: LocalLock; journalLock: LocalLock }> {
  const stateLockFile = `${await canonicalLocalFile(stateFile)}.lock`;
  const journalLockFile = await localJournalLockFile(journalFile);
  const files = [...new Set([stateLockFile, journalLockFile])].sort();
  const acquired: LocalLock[] = [];
  try {
    for (const file of files) acquired.push(await acquireLock(file, { planHash }));
    acquired.push(...await acquireLocalSignerLocks(chain, addresses, journalFile, planHash));
  } catch (error) {
    for (const held of acquired.reverse()) await held.release();
    throw error;
  }
  const stateLock = acquired.find(held => held.file === stateLockFile)!;
  const journalLock = acquired.find(held => held.file === journalLockFile)!;
  let released = false;
  return {
    journalLock,
    lock: {
      file: stateLock.file,
      holder: stateLock.holder,
      recovered: stateLock.recovered ?? journalLock.recovered,
      async assertHeld() { for (const held of acquired) await held.assertHeld(); },
      async release() {
        if (released) return;
        released = true;
        for (const held of [...acquired].reverse()) await held.release();
      },
    },
  };
}
