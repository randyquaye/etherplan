import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hashJson } from '../../src/identity.mjs';
import { startAnvil, stopAnvil } from './anvil.mjs';

const projectDirectory = fileURLToPath(new URL('../..', import.meta.url));
const primary = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const secondary = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
let anvil;
let rpcUrl;

function runSchedule(deployers, spec = 'test/fixtures/parallel-lab.json', parallel = false) {
  return spawnSync(process.execPath, [
    'src/cli.mjs',
    'schedule',
    '--spec',
    spec,
    '--deployers',
    deployers.join(','),
    ...(parallel ? ['--parallel'] : []),
  ], {
    cwd: projectDirectory,
    encoding: 'utf8',
    env: { ...process.env, ETH_RPC_URL: rpcUrl },
  });
}

function runCli(...arguments_) {
  return spawnSync(process.execPath, ['src/cli.mjs', ...arguments_], {
    cwd: projectDirectory, encoding: 'utf8', env: { ...process.env, ETH_RPC_URL: rpcUrl },
  });
}

before(async () => {
  anvil = await startAnvil();
  rpcUrl = anvil.rpcUrl;
});

after(async () => {
  await stopAnvil(anvil);
});

test('schedule defaults to the primary deployer and uses both only with --parallel', () => {
  const serial = runSchedule([primary, secondary]);
  const forward = runSchedule([primary, secondary], undefined, true);
  const reverse = runSchedule([secondary, primary], undefined, true);
  assert.equal(serial.status, 0, serial.stderr);
  assert.equal(forward.status, 0, forward.stderr);
  assert.equal(reverse.status, 0, reverse.stderr);

  const defaultSchedule = JSON.parse(serial.stdout);
  const first = JSON.parse(forward.stdout);
  const second = JSON.parse(reverse.stdout);
  assert.equal(defaultSchedule.parallel, false);
  assert.deepEqual(defaultSchedule.waves[0].batches.flat().map(item => item.deployer), [primary, primary]);
  assert.equal(first.parallel, true);
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
  assert.match(runCli('schedule', '--help').stdout, /default: serial/);
});

test('schema 2 schedules a stored address in the same wave and explains each execution edge', () => {
  const result = runSchedule([primary, secondary], 'test/fixtures/split-lab.json');
  assert.equal(result.status, 0, result.stderr);
  const schedule = JSON.parse(result.stdout);
  assert.equal(schedule.waves.length, 1);
  const entries = schedule.waves[0].batches.flat();
  assert.deepEqual(entries.map(item => item.id).sort(), ['contract:alpha', 'contract:beta', 'contract:gamma']);
  assert.ok(entries.every(item => Array.isArray(item.after) && item.after.length === 0));
  assert.deepEqual(schedule.graphs.resolution.find(node => node.id === 'contract:gamma').needs.map(edge => edge.id), ['contract:alpha']);
  assert.equal(schedule.warnings.length, 1);
});

test('schedule rejects duplicate or unfunded deployers', () => {
  const duplicate = runSchedule([primary, primary]);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /distinct/i);

  const unfunded = runSchedule([primary, '0x000000000000000000000000000000000000dEaD']);
  assert.equal(unfunded.status, 1);
  assert.match(unfunded.stderr, /nonzero|fund/i);
});

test('saved schedules validate identity before funding and keep blocked plans inspectable', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-schedule-'));
  const specFile = path.join(directory, 'spec.json');
  const artifactFile = path.join(directory, 'Minimal.json');
  const planFile = path.join(directory, 'plan.json');
  const source = path.join(projectDirectory, 'test/fixtures');
  const schedule = (...args) => runCli('schedule', '--spec', specFile, '--plan', planFile, ...args);
  const save = async plan => writeFile(planFile, JSON.stringify(plan));
  const rehash = plan => {
    const { planHash, ...fields } = plan;
    return { ...fields, planHash: hashJson(fields) };
  };
  try {
    await copyFile(path.join(source, 'minimal-create2.json'), specFile);
    await copyFile(path.join(source, 'Minimal.json'), artifactFile);
    const planned = runCli('plan', '--spec', specFile, '--out', planFile, '--deployers', primary, '--max-spend-wei', '100000000000000000000');
    assert.equal(planned.status, 0, planned.stderr);
    const original = JSON.parse(planned.stdout);
    const valid = schedule('--deployers', primary);
    assert.equal(valid.status, 0, valid.stderr);
    const preview = JSON.parse(valid.stdout);
    assert.equal(preview.applicable, true);
    assert.equal(preview.snapshot, 'plan-observed');
    assert.equal(preview.waves[0].batches[0][0].id, 'contract:minimal');
    assert.equal(preview.deployers[0].address, primary);

    const pipelineArgs = ['plan', '--spec', specFile, '--out', planFile, '--pipeline', '--deployers', `${primary},${secondary}`, '--max-spend-wei', '100000000000000000000'];
    assert.equal(runCli(...pipelineArgs).status, 0);
    const pinnedSerial = schedule();
    assert.equal(pinnedSerial.status, 0, pinnedSerial.stderr);
    assert.equal(JSON.parse(pinnedSerial.stdout).parallel, false);
    const incompatible = schedule('--parallel');
    assert.equal(incompatible.status, 1);
    assert.match(incompatible.stderr, /pins serial scheduling/);
    assert.equal(runCli(...pipelineArgs, '--parallel').status, 0);
    const pinnedParallel = schedule();
    assert.equal(pinnedParallel.status, 0, pinnedParallel.stderr);
    assert.equal(JSON.parse(pinnedParallel.stdout).parallel, true);
    await save(original);

    const expectStale = (code) => {
      const result = schedule('--deployers', '0x000000000000000000000000000000000000dEaD');
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(code));
      assert.equal(result.stdout, '');
    };
    const changedSpec = JSON.parse(await readFile(specFile, 'utf8'));
    changedSpec.contracts[0].salt = `0x${'22'.repeat(32)}`;
    await writeFile(specFile, JSON.stringify(changedSpec));
    expectStale('stale-spec');
    await copyFile(path.join(source, 'minimal-create2.json'), specFile);

    const artifact = JSON.parse(await readFile(artifactFile, 'utf8'));
    artifact.metadata = artifact.metadata.replace('0.8.30', '0.8.31');
    await writeFile(artifactFile, JSON.stringify(artifact));
    expectStale('stale-artifact');
    await copyFile(path.join(source, 'Minimal.json'), artifactFile);

    await save(rehash({ ...original, artifactHashes: { ...original.artifactHashes, 'contract:extra': `0x${'11'.repeat(32)}` } }));
    expectStale('stale-artifact');
    await save(rehash({ ...original, chain: { ...original.chain, id: 1 } }));
    expectStale('wrong-chain');
    await save(rehash({ ...original, observed: { ...original.observed, blockHash: `0x${'33'.repeat(32)}` } }));
    expectStale('stale-observation');

    await copyFile(path.join(source, 'minimal-absent-external.json'), specFile);
    const blockedPlan = runCli('plan', '--spec', specFile, '--out', planFile, '--deployers', primary, '--max-spend-wei', '100000000000000000000');
    assert.equal(blockedPlan.status, 1);
    const blocked = schedule();
    assert.equal(blocked.status, 0, blocked.stderr);
    const blockedPreview = JSON.parse(blocked.stdout);
    assert.equal(blockedPreview.applicable, false);
    assert.equal(blockedPreview.snapshot, 'plan-observed');
    assert.ok(blockedPreview.resources.some(resource => resource.action === 'conflict' && resource.observation));
    assert.equal(blockedPreview.deployers, undefined);
    assert.equal(blockedPreview.waves, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
