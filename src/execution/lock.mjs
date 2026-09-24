import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class LockError extends Error {
  constructor(message, holder) {
    super(message);
    this.name = 'LockError';
    this.code = 'state-locked';
    this.holder = holder;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function readHolder(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    return null;
  }
}

function describe(file, holder) {
  if (!holder) return `State lock ${file} exists but is unreadable. Remove it only after you confirm that no apply is running.`;
  return `State lock ${file} is held by pid ${holder.pid} on ${holder.host} for plan ${holder.planHash} since ${holder.acquiredAt}.`;
}

// Moves a dead holder's lock aside. If the moved file is not that holder's lock, another process replaced it first, so restore it and stop.
async function removeStale(file, holder) {
  const aside = `${file}.stale-${randomUUID()}`;
  try {
    await rename(file, aside);
  } catch (error) {
    if (error.code === 'ENOENT') return;
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

export async function acquireLock(file, { planHash }) {
  await mkdir(path.dirname(file), { recursive: true });
  const holder = { id: randomUUID(), pid: process.pid, host: os.hostname(), planHash, acquiredAt: new Date().toISOString() };
  let recovered = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let handle;
    try {
      handle = await open(file, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
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
