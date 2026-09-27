import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Address, ChainIdentity } from '../types.ts';
import { acquireLock, canonicalLocalFile } from './lock.ts';
import type { LocalLock } from './types.ts';

// This is deliberately host-local. All local applies by one OS user share it,
// even when their state and journal files live in unrelated projects.
const root = () => process.env.ETHERPLAN_TEST_SIGNER_COORDINATION_ROOT ?? path.join(os.homedir(), '.etherplan', 'local-signers');

function registry(chain: ChainIdentity, address: Address): string {
  const identity = `${chain.id}/${chain.genesisHash.toLowerCase()}/${address.toLowerCase()}`;
  return path.join(root(), `${createHash('sha256').update(identity).digest('hex')}.json`);
}

async function paths(file: string): Promise<string[]> {
  let raw: string;
  try { raw = await readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error(`Local signer registry ${file} is unreadable; inspect it before applying again.`); }
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !path.isAbsolute(item)) ||
    new Set(value).size !== value.length) throw new Error(`Local signer registry ${file} is invalid.`);
  return value;
}

async function save(file: string, value: string[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
    const directory = await open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

export async function acquireLocalSignerLocks(chain: ChainIdentity, addresses: Address[], journalFile: string, planHash: string | null): Promise<LocalLock[]> {
  const canonicalJournal = await canonicalLocalFile(journalFile);
  await mkdir(root(), { recursive: true, mode: 0o700 });
  // Publish an empty durable journal before registering its path. A crash
  // between registration and openJournal must not leave an ambiguous missing
  // file, while deletion after registration remains a fail-closed error.
  await mkdir(path.dirname(canonicalJournal), { recursive: true, mode: 0o700 });
  const journal = await open(canonicalJournal, 'a', 0o600);
  try { await journal.sync(); } finally { await journal.close(); }
  const journalDirectory = await open(path.dirname(canonicalJournal), 'r');
  try { await journalDirectory.sync(); } finally { await journalDirectory.close(); }
  const files = [...new Set(addresses.map(address => registry(chain, address)))].sort();
  const locks: LocalLock[] = [];
  try {
    for (const file of files) locks.push(await acquireLock(`${file}.lock`, { planHash }));
    for (const file of files) {
      const known = await paths(file);
      if (!known.includes(canonicalJournal)) await save(file, [...known, canonicalJournal]);
    }
    return locks;
  } catch (error) {
    for (const lock of locks.reverse()) await lock.release();
    throw error;
  }
}

export async function localSignerJournals(chain: ChainIdentity, address: Address): Promise<string[]> {
  return paths(registry(chain, address));
}
