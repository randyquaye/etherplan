import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { labProject } from '../ethp-fixtures.ts';
import { parseSpec } from '../../src/spec/index.ts';
import { startAnvil, stopAnvil } from './anvil.ts';

const projectDirectory = fileURLToPath(new URL('../..', import.meta.url));
const ownerKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const owner = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const maxSpend = '100000000000000000000';
let anvil;
let directory;

function runCli(arguments_, signed = false, extraEnv = {}, cwd = directory) {
  return spawnSync(process.execPath, [path.join(projectDirectory, 'dist/cli.js'), ...arguments_], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ETH_RPC_URL: anvil.rpcUrl,
      ...(signed ? { DEPLOYER_PRIVATE_KEYS: ownerKey, OWNER_PRIVATE_KEY: ownerKey } : {}),
      ...extraEnv,
    },
  });
}

function succeeded(result) {
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

const file = name => path.join(directory, name);
const nonce = () => anvil.rpc('eth_getTransactionCount', [owner, 'latest']);

before(async () => {
  anvil = await startAnvil();
  directory = await labProject('etherplan-cli-ethp-');
  await Promise.all([
    rename(file('lab.ethp'), file('main.ethp')),
    rename(file('lab.ethpvars'), file('main.ethpvars')),
  ]);
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
  await stopAnvil(anvil);
});

test('the project compiles to its JSON lowering and plans its resources', async () => {
  assert.deepEqual(succeeded(runCli(['compile'])), parseSpec(JSON.parse(await readFile(file('lab.json'), 'utf8'))));
  succeeded(runCli(['validate']));

  const ethp = succeeded(runCli(['plan', '--out', '-', '--deployers', owner, '--owner', owner, '--max-spend-wei', maxSpend]));
  assert.deepEqual(ethp.resources.map(resource => [resource.id, resource.action]), [
    ['external:create2Factory', 'reuse'],
    ['contract:alpha', 'deploy'],
    ['contract:beta', 'deploy'],
    ['contract:doubler', 'deploy'],
    ['contract:gamma', 'deploy'],
    ['contract:linked', 'deploy'],
    ['call:bind', 'call'],
  ]);
  assert.deepEqual(ethp.warnings, []);
});

test('editing .ethpvars after planning stops a saved-plan apply at stale-spec before signing', async () => {
  const planFile = file('stale-plan.json');
  succeeded(runCli(['plan', '--out', planFile, '--state', file('stale-state.json'),
    '--deployers', owner, '--owner', owner, '--max-spend-wei', maxSpend]));
  const vars = await readFile(file('main.ethpvars'), 'utf8');
  await writeFile(file('main.ethpvars'), vars.replace('0x70997970C51812dc3A010C7d01b50e0d17dc79C8', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'));
  try {
    const nonceBefore = await nonce();
    const stale = runCli(['apply', '--plan', planFile, '--state', file('stale-state.json')], true);
    assert.equal(stale.status, 1, stale.stdout);
    assert.match(stale.stderr, /stale-spec: The spec changed after the plan was created/);
    assert.equal(await nonce(), nonceBefore);
  } finally {
    await writeFile(file('main.ethpvars'), vars);
  }
});

test('plan bundles split files and saved-plan apply rejects an edit to a split file', async () => {
  const main = await readFile(file('main.ethp'), 'utf8');
  const external = main.match(/\nresource "external" "create2Factory" \{[\s\S]*?\n\}\n?/);
  assert.ok(external);
  const before = succeeded(runCli(['compile']));
  const splitFile = file('externals.ethp');
  await writeFile(file('main.ethp'), main.replace(external[0], '\n'));
  await writeFile(splitFile, external[0]);
  try {
    assert.deepEqual(succeeded(runCli(['compile'])), before);
    const planFile = file('split-plan.json');
    const plan = succeeded(runCli(['plan', '--out', planFile, '--state', file('split-state.json'),
      '--deployers', owner, '--owner', owner, '--max-spend-wei', maxSpend]));
    assert.ok(plan.resources.some(resource => resource.id === 'external:create2Factory'));
    await writeFile(splitFile, external[0].replace('0x4e59b44847b379578588920cA78FbF26c0B4956C', '0x0000000000000000000000000000000000000001'));
    const nonceBefore = await nonce();
    const stale = runCli(['apply', '--plan', planFile, '--state', file('split-state.json')], true);
    assert.equal(stale.status, 1, stale.stdout);
    assert.match(stale.stderr, /stale-spec: The spec changed after the plan was created/);
    assert.equal(await nonce(), nonceBefore);
  } finally {
    await writeFile(file('main.ethp'), main);
    await rm(splitFile, { force: true });
  }
});

test('.ethpconfig supplies plan options, and apply sends the compiled call and verifies its check', async () => {
  await writeFile(file('main.ethpconfig'), `defaults {
  state = "deploy/state.json"
}

command "plan" {
  out       = "deploy/plan.json"
  deployers = ["${owner}"]
  owner     = "${owner}"
}
`);
  const planned = runCli(['plan', '--max-spend-wei', maxSpend]);
  const plan = succeeded(planned);
  assert.match(planned.stderr, /Using --deployers, --out, --owner, --state from .*main\.ethpconfig\./);
  assert.deepEqual(JSON.parse(await readFile(file('deploy/plan.json'), 'utf8')), plan);

  const nonceBefore = await nonce();
  const applied = succeeded(runCli(['apply', '--plan', file('deploy/plan.json')], true));
  assert.equal(applied.status, 'applied');
  assert.equal(applied.transactionsSigned, 6);
  assert.equal(BigInt(await nonce()) - BigInt(nonceBefore), 6n);
  const state = JSON.parse(await readFile(file('deploy/default/state.json'), 'utf8'));
  assert.ok(state.resources['call:bind']);

  const verified = succeeded(runCli(['verify']));
  assert.equal(verified.status, 'verified');
  assert.deepEqual(verified.resources.find(resource => resource.id === 'call:bind').action, 'reuse');
});

test('a workspace reads its vars overlay from main.ethp and keeps separate state', async () => {
  const project = file('world');
  await mkdir(project);
  await copyFile(file('Doubler.json'), path.join(project, 'Doubler.json'));
  const blue = `0x${'b1'.repeat(32)}`;
  const green = `0x${'9e'.repeat(32)}`;
  await writeFile(path.join(project, 'main.ethp'), `variable "salt" {
  type = bytes32
}

chain_id = 31337

resource "contract" "doubler" {
  artifact = "Doubler.json"
  salt     = var.salt
  args     = []
}
`);
  await writeFile(path.join(project, 'main.blue.ethpvars'), `salt = "${blue}"\n`);
  const planFile = path.join(project, 'blue-plan.json');
  const write = ['--deployers', owner, '--max-spend-wei', maxSpend];
  const run = (args, signed = false, env = {}) => runCli(args, signed, env, project);
  const planned = run(['plan', '--workspace', 'blue', '--out', planFile, ...write]);
  assert.deepEqual(succeeded(planned).resources.map(resource => [resource.id, resource.action]), [['contract:doubler', 'deploy']]);
  assert.match(planned.stderr, /Using workspace blue\./);
  assert.match(planned.stderr, /main\.blue\.ethpvars/);

  const nonceBefore = await nonce();
  const drifted = run(['apply', '--workspace', 'blue', '--plan', planFile, '--var', `salt=${green}`], true);
  assert.equal(drifted.status, 1, drifted.stdout);
  assert.match(drifted.stderr, /stale-spec: The spec changed after the plan was created/);
  assert.equal(await nonce(), nonceBefore);

  assert.equal(succeeded(run(['apply', '--workspace', 'blue', '--plan', planFile], true)).status, 'applied');
  assert.ok(JSON.parse(await readFile(path.join(project, '.etherplan/blue/state.json'), 'utf8')).resources['contract:doubler']);
  await assert.rejects(readFile(path.join(project, '.etherplan/default/state.json')), { code: 'ENOENT' });
  assert.equal(succeeded(run(['verify'], false, { ETHP_WORKSPACE: 'blue' })).status, 'verified');

  const other = succeeded(run(['plan', '--out', '-', ...write], false, { ETHP_VAR_salt: green }));
  assert.deepEqual(other.resources.map(resource => [resource.id, resource.action]), [['contract:doubler', 'deploy']]);
  assert.notEqual(other.specHash, JSON.parse(await readFile(planFile, 'utf8')).specHash);
});
