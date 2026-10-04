import assert from 'node:assert/strict';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { spawnSync } from '../project-cli.mjs';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectDirectory = fileURLToPath(new URL('../..', import.meta.url));

function runCliFrom(directory, ...arguments_) {
  return spawnSync(process.execPath, [path.join(projectDirectory, 'dist/cli.js'), ...arguments_], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, ETH_RPC_URL: '' },
  });
}

function runCli(...arguments_) {
  return runCliFrom(projectDirectory, ...arguments_);
}

function parseSuccess(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stderr === '' || result.stderr.startsWith('Variables:\n'));
  return JSON.parse(result.stdout);
}

test('graph reports the deployment and binding order', () => {
  const result = runCli('graph', '--fixture', 'test/fixtures/state-fixture.json');

  const graph = parseSuccess(result);
  assert.deepEqual(
    graph.resolution.map((node) => [node.id, node.needs.map((edge) => edge.id)]),
    [
      ['contract:stateFixture', []],
      ['call:bind', ['contract:stateFixture']],
    ],
  );
});

test('schema 2 graph and validate show both graphs with edge reasons and creation warnings', () => {
  const warning =
    'contract:gamma constructor references contracts.alpha.address without an execution dependency; confirm its constructor does not call the referenced contract.';
  const graph = parseSuccess(runCli('graph', '--fixture', 'test/fixtures/split-lab.json'));
  assert.deepEqual(graph.resolution.find((node) => node.id === 'contract:gamma').needs, [
    {
      id: 'contract:alpha',
      reasons: [
        'args[0] needs contracts.alpha.address',
        'checks.BENEFICIARY needs contracts.alpha.address',
      ],
    },
  ]);
  assert.deepEqual(
    graph.execution,
    ['alpha', 'beta', 'gamma'].map((name) => ({ id: `contract:${name}`, after: [] })),
  );
  assert.deepEqual(graph.warnings, [warning]);

  const validation = parseSuccess(runCli('validate', '--fixture', 'test/fixtures/split-lab.json'));
  assert.deepEqual(validation.warnings, [warning]);
  assert.deepEqual(
    parseSuccess(runCli('validate', '--fixture', 'test/fixtures/parallel-lab.json')).warnings,
    [],
  );
});

test('commands require main.ethp and bundle other .ethp files in the working directory', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-cli-spec-'));
  const run = (...args) =>
    nodeSpawnSync(process.execPath, [path.join(projectDirectory, 'dist/cli.js'), ...args], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, ETH_RPC_URL: '' },
    });
  try {
    const missing = run('graph');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /main\.ethp/);

    await copyFile(
      path.join(projectDirectory, 'test/fixtures/state-fixture.json'),
      path.join(directory, 'spec.json'),
    );
    assert.match(run('graph').stderr, /main\.ethp/);
    await rm(path.join(directory, 'spec.json'));
    await writeFile(
      path.join(directory, 'main.ethp'),
      'chain_id = 31337\nresource "contract" "alpha" {\n artifact = "Minimal.json"\n salt = "0x1111111111111111111111111111111111111111111111111111111111111111"\n args = []\n}\n',
    );
    await writeFile(
      path.join(directory, 'other.ethp'),
      'resource "external" "registry" {\n address = "0x0000000000000000000000000000000000000001"\n}\n',
    );
    assert.deepEqual(
      parseSuccess(run('graph')).resolution.map((node) => node.id),
      ['external:registry', 'contract:alpha'],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('impact reports constructor-value replacements in dependency order', () => {
  const first = runCli(
    'impact',
    '--fixture',
    'test/fixtures/parallel-lab.json',
    '--value',
    'upstream',
  );
  const second = runCli(
    'impact',
    '--fixture',
    'test/fixtures/parallel-lab.json',
    '--value',
    'upstream',
  );

  assert.deepEqual(parseSuccess(first), ['contract:alpha', 'contract:gamma']);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stderr, first.stderr);
  assert.equal(second.stdout, first.stdout);
});

test('graph rejects a missing resource reference before it reads a chain', () => {
  const result = runCli('graph', '--fixture', 'test/fixtures/missing-reference.json');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /references unknown contracts\.missing/);
  assert.equal(result.stdout, '');
});

test('graph rejects a dependency cycle before it reads a chain', () => {
  const result = runCli('graph', '--fixture', 'test/fixtures/cycle.json');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /dependency cycle/i);
  assert.equal(result.stdout, '');
});

test('the specification rejects signer secrets and unknown fields', () => {
  const result = runCli('graph', '--fixture', 'test/fixtures/secret-in-spec.json');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown field privateKey|privateKey/i);
  assert.equal(result.stdout, '');
});
