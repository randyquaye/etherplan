import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { labProject } from '../ethp-fixtures.mjs';
import { startAnvil, stopAnvil } from './anvil.mjs';

const projectDirectory = fileURLToPath(new URL('../..', import.meta.url));
const ownerKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const owner = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const maxSpend = '100000000000000000000';
let anvil;
let directory;

function runCli(arguments_, signed = false) {
  return spawnSync(process.execPath, [path.join(projectDirectory, 'src/cli.mjs'), ...arguments_], {
    cwd: projectDirectory,
    encoding: 'utf8',
    env: {
      ...process.env,
      ETH_RPC_URL: anvil.rpcUrl,
      ...(signed ? { DEPLOYER_PRIVATE_KEYS: ownerKey, OWNER_PRIVATE_KEY: ownerKey } : {}),
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
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
  await stopAnvil(anvil);
});

test('an .ethp spec and its JSON lowering compile, validate, and plan identically on one chain snapshot', () => {
  assert.deepEqual(succeeded(runCli(['compile', '--spec', file('lab.ethp')])), succeeded(runCli(['compile', '--spec', file('lab.json')])));
  assert.deepEqual(succeeded(runCli(['validate', '--spec', file('lab.ethp')])), succeeded(runCli(['validate', '--spec', file('lab.json')])));

  const planFor = name => succeeded(runCli(['plan', '--spec', file(name), '--out', '-', '--deployers', owner, '--owner', owner, '--max-spend-wei', maxSpend]));
  const ethp = planFor('lab.ethp');
  assert.deepEqual(ethp, planFor('lab.json'));
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
  succeeded(runCli(['plan', '--spec', file('lab.ethp'), '--out', planFile, '--state', file('stale-state.json'),
    '--deployers', owner, '--owner', owner, '--max-spend-wei', maxSpend]));
  const vars = await readFile(file('lab.ethpvars'), 'utf8');
  await writeFile(file('lab.ethpvars'), vars.replace('0x70997970C51812dc3A010C7d01b50e0d17dc79C8', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'));
  try {
    const nonceBefore = await nonce();
    const stale = runCli(['apply', '--spec', file('lab.ethp'), '--plan', planFile, '--state', file('stale-state.json')], true);
    assert.equal(stale.status, 1, stale.stdout);
    assert.match(stale.stderr, /stale-spec: The spec changed after the plan was created/);
    assert.equal(await nonce(), nonceBefore);
  } finally {
    await writeFile(file('lab.ethpvars'), vars);
  }
});

test('.ethpconfig supplies plan options, and apply sends the compiled call and verifies its check', async () => {
  await writeFile(file('lab.ethpconfig'), `defaults {
  state = "deploy/state.json"
}

command "plan" {
  out       = "deploy/plan.json"
  deployers = ["${owner}"]
  owner     = "${owner}"
}
`);
  const planned = runCli(['plan', '--spec', file('lab.ethp'), '--max-spend-wei', maxSpend]);
  const plan = succeeded(planned);
  assert.match(planned.stderr, /Using --deployers, --out, --owner, --state from .*lab\.ethpconfig\./);
  assert.deepEqual(JSON.parse(await readFile(file('deploy/plan.json'), 'utf8')), plan);

  const nonceBefore = await nonce();
  const applied = succeeded(runCli(['apply', '--spec', file('lab.ethp'), '--plan', file('deploy/plan.json')], true));
  assert.equal(applied.status, 'applied');
  assert.equal(applied.transactionsSigned, 6);
  assert.equal(BigInt(await nonce()) - BigInt(nonceBefore), 6n);
  const state = JSON.parse(await readFile(file('deploy/state.json'), 'utf8'));
  assert.ok(state.resources['call:bind']);

  const verified = succeeded(runCli(['verify', '--spec', file('lab.ethp')]));
  assert.equal(verified.status, 'verified');
  assert.deepEqual(verified.resources.find(resource => resource.id === 'call:bind').action, 'reuse');
});
