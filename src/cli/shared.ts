import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Plan } from '../planning/types.ts';

export function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function defaultJournalFile(stateFile: string): string {
  return `${path.resolve(stateFile)}.journal.jsonl`;
}

export async function approvePlan(plan: Plan): Promise<void> {
  process.stderr.write(`Proposed plan:\n${JSON.stringify(plan, null, 2)}\n\n`);
  const blocked = plan.resources.filter(
    (resource) => !['reuse', 'deploy', 'call'].includes(resource.action),
  );
  if (blocked.length)
    throw new Error(
      `Plan cannot be applied: ${blocked.map((resource) => `${resource.id} (${resource.action})`).join(', ')}.`,
    );
  process.stderr.write("Apply this plan? Only 'yes' will be accepted: ");
  const answer = await new Promise<string | null>((resolve) => {
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    input.once('line', (line) => {
      resolve(line);
      input.close();
    });
    input.once('close', () => resolve(null));
  });
  if (answer !== 'yes') throw new Error('Apply cancelled; no transactions were signed.');
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
    const directoryHandle = await open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
