import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

// Moves a dead holder's lock aside. If the moved file is not that holder's lock, another process replaced it first, so restore it and stop.
async function removeStale(file: string, holder: LocalLockHolder): Promise<void> {
  const aside = `${file}.stale-${randomUUID()}`;
  try {
    await rename(file, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const moved = await readHolder(aside);
  if (moved?.id !== holder.id) {
    try {
      await link(aside, file);
      await unlink(aside);
    } catch {}
    throw new LockError(describe(file, moved), moved);
  }
  await unlink(aside);
}

export async function acquireLock(file: string, { planHash }: { planHash: string | null }): Promise<LocalLock> {
  await mkdir(path.dirname(file), { recursive: true });
  const holder: LocalLockHolder = { id: randomUUID(), pid: process.pid, host: os.hostname(), planHash, acquiredAt: new Date().toISOString() };
  let recovered: LocalLockHolder | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let handle: FileHandle;
    try {
      handle = await open(file, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readHolder(file);
      if (existing === undefined) continue;
      if (!existing || existing.host !== holder.host || alive(existing.pid)) throw new LockError(describe(file, existing), existing);
      await removeStale(file, existing);
      recovered = existing;
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify(holder));
      await handle.sync();
    } finally {
      await handle.close();
    }
    let released = false;
    return {
      file,
      holder,
      recovered,
      async assertHeld() {
        const current = await readHolder(file);
        if (current?.id !== holder.id) throw new LockError(`State lock ${file} is no longer held by this process.`, current);
      },
      async release() {
        if (released) return;
        released = true;
        const current = await readHolder(file);
        if (current?.id === holder.id) await unlink(file);
      },
    };
  }
  throw new LockError(`Could not acquire state lock ${file}; another process changed it during recovery.`, null);
}
