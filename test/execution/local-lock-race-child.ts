import { acquireLock } from '../../src/execution/lock.ts';

process.stdout.write('READY\n');
await new Promise((resolve) => process.stdin.once('data', resolve));
try {
  await acquireLock(process.argv[2]!, { planHash: 'race-test' });
  process.stdout.write('HELD\n');
  process.stdin.resume(); // The parent kills the holder to leave a stale entry.
  await new Promise(() => {});
} catch (error) {
  process.stdout.write(`ERROR ${error instanceof Error ? error.message : String(error)}\n`);
  process.stdin.pause();
}
