import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startAnvil, stopAnvil } from './anvil.mjs';

const projectDirectory = fileURLToPath(new URL('../..', import.meta.url));
const primary = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const secondary = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
let anvil;
let rpcUrl;

function runSchedule(deployers) {
  return spawnSync(process.execPath, [
    'src/cli.mjs',
    'schedule',
    '--spec',
    'test/fixtures/parallel-lab.json',
    '--deployers',
    deployers.join(','),
  ], {
    cwd: projectDirectory,
    encoding: 'utf8',
    env: { ...process.env, ETH_RPC_URL: rpcUrl },
  });
}

before(async () => {
  anvil = await startAnvil();
  rpcUrl = anvil.rpcUrl;
});

after(async () => {
  await stopAnvil(anvil);
});

test('two funded deployers share an independent wave and preserve CREATE2 addresses', () => {
  const forward = runSchedule([primary, secondary]);
  const reverse = runSchedule([secondary, primary]);
  assert.equal(forward.status, 0, forward.stderr);
  assert.equal(reverse.status, 0, reverse.stderr);

  const first = JSON.parse(forward.stdout);
  const second = JSON.parse(reverse.stdout);
  const firstWave = first.waves[0].batches.flat();
  assert.deepEqual(firstWave.map(item => item.id), [
    'contract:alpha',
    'contract:beta',
  ]);
  assert.deepEqual(firstWave.map(item => item.deployer), [primary, secondary]);
  assert.deepEqual(first.waves[1].batches.flat().map(item => item.id), ['contract:gamma']);
  assert.deepEqual(first.deferred, []);
  assert.deepEqual(first.ownerActions, []);

  const addresses = schedule => Object.fromEntries(schedule.waves.flatMap(wave => wave.batches.flat()).map(item => [item.id, item.address]));
  assert.deepEqual(addresses(second), addresses(first));
});

test('schedule rejects duplicate or unfunded deployers', () => {
  const duplicate = runSchedule([primary, primary]);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /distinct/i);

  const unfunded = runSchedule([primary, '0x000000000000000000000000000000000000dEaD']);
  assert.equal(unfunded.status, 1);
  assert.match(unfunded.stderr, /nonzero|fund/i);
});
