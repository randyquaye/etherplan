import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const hash = `0x${'11'.repeat(32)}`;
const registry = '0x0000000000000000000000000000000000000001';
const token = '0x0000000000000000000000000000000000000002';
const state = {
  formatVersion: 1,
  chain: { id: 31337, genesisHash: hash },
  resources: {
    'external:token': { address: token, transactions: [] },
    'call:configure': { address: registry, transactions: [] },
    'contract:registry': {
      address: registry, artifactHash: hash, initcodeHash: null, inputs: [], inputsHash: hash,
      priorInputs: null, priorInputsHash: null, salt: null, codeHash: hash, proofHash: hash, transactions: [],
    },
  },
};

function cli(directory: string, ...args: string[]) {
  return spawnSync(process.execPath, [path.join(root, 'dist/cli.js'), ...args], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, ETH_RPC_URL: '' },
  });
}

test('output reads validated local state without an RPC and prints JSON for all or one address', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-output-'));
  try {
    await writeFile(path.join(directory, 'spec.json'), '{}\n');
    await mkdir(path.join(directory, '.etherplan/default'), { recursive: true });
    const stateFile = path.join(directory, '.etherplan/default/state.json');
    await writeFile(stateFile, JSON.stringify(state));

    const all = cli(directory, 'output');
    assert.equal(all.status, 0, all.stderr);
    assert.deepEqual(JSON.parse(all.stdout), {
      formatVersion: 1,
      chain: state.chain,
      addresses: { 'contract:registry': registry, 'external:token': token },
    });
    assert.ok(all.stdout.indexOf('contract:registry') < all.stdout.indexOf('external:token'));

    const one = cli(directory, 'output', '--id', 'contract:registry');
    assert.equal(one.status, 0, one.stderr);
    assert.deepEqual(JSON.parse(one.stdout), {
      formatVersion: 1,
      chain: state.chain,
      addresses: { 'contract:registry': registry },
    });
    assert.equal(one.stderr, '');

    const blue = structuredClone(state);
    blue.resources['contract:registry'].address = token;
    await mkdir(path.join(directory, '.etherplan/blue'));
    await writeFile(path.join(directory, '.etherplan/blue/state.json'), JSON.stringify(blue));
    const workspace = cli(directory, 'output', '--workspace', 'blue', '--id', 'contract:registry');
    assert.equal(workspace.status, 0, workspace.stderr);
    assert.deepEqual(JSON.parse(workspace.stdout).addresses, { 'contract:registry': token });

    await writeFile(path.join(directory, 'main.ethp'), '');
    await writeFile(path.join(directory, 'main.ethpconfig'), 'defaults {\n  state = "deploy/state.json"\n}\n');
    await mkdir(path.join(directory, 'deploy/blue'), { recursive: true });
    await writeFile(path.join(directory, 'deploy/blue/state.json'), JSON.stringify(blue));
    const configured = cli(directory, 'output', '--spec', 'main.ethp', '--workspace', 'blue');
    assert.equal(configured.status, 0, configured.stderr);
    assert.deepEqual(JSON.parse(configured.stdout).addresses, { 'contract:registry': token, 'external:token': token });

    await rm(path.join(directory, 'spec.json'));
    const defaultEthp = cli(directory, 'output', '--workspace', 'blue');
    assert.equal(defaultEthp.status, 0, defaultEthp.stderr);
    assert.deepEqual(JSON.parse(defaultEthp.stdout).addresses, JSON.parse(configured.stdout).addresses);
    const withoutSpec = cli(directory, 'output', '--state', stateFile, '--id', 'external:token');
    assert.equal(withoutSpec.status, 0, withoutSpec.stderr);
    assert.deepEqual(JSON.parse(withoutSpec.stdout), {
      formatVersion: 1,
      chain: state.chain,
      addresses: { 'external:token': token },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('output reports absent or invalid state and unknown addresses without printing a value', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-output-failure-'));
  const stateFile = path.join(directory, 'state.json');
  try {
    const missing = cli(directory, 'output', '--state', stateFile);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /No state found/);
    assert.equal(missing.stdout, '');

    const noSpec = cli(directory, 'output');
    assert.equal(noSpec.status, 1);
    assert.match(noSpec.stderr, /spec\.json/);

    const backend = cli(directory, 'output', '--backend', 'backend.json');
    assert.equal(backend.status, 1);
    assert.match(backend.stderr, /Set ETH_RPC_URL for output --backend/);

    await writeFile(stateFile, JSON.stringify(state));
    const unknown = cli(directory, 'output', '--state', stateFile, '--id', 'contract:missing');
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /no address for contract:missing/);
    assert.equal(unknown.stdout, '');

    const call = cli(directory, 'output', '--state', stateFile, '--id', 'call:configure');
    assert.equal(call.status, 2);
    assert.match(call.stderr, /contract:<name> or external:<name>/);

    const out = cli(directory, 'output', '--state', stateFile, '--out', 'addresses.json');
    assert.equal(out.status, 2);
    assert.match(out.stderr, /--out is not an option for output/);

    await writeFile(stateFile, '{"formatVersion":1,"resources":{}}');
    const invalid = cli(directory, 'output', '--state', stateFile);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /State chain must be an object/);
    assert.equal(invalid.stdout, '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
