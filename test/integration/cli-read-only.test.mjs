import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectDirectory = fileURLToPath(new URL('../..', import.meta.url));

function runCliFrom(directory, ...arguments_) {
  return spawnSync(process.execPath, [path.join(projectDirectory, 'src/cli.mjs'), ...arguments_], {
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
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

test('graph reports the deployment and binding order', () => {
  const result = runCli('graph', '--spec', 'test/fixtures/state-fixture.json');

  assert.deepEqual(parseSuccess(result), [
    { id: 'contract:stateFixture', deps: [] },
    { id: 'call:bind', deps: ['contract:stateFixture'] },
  ]);
});

test('schema 2 graph and validate show both graphs with edge reasons and creation warnings', () => {
  const warning = 'contract:gamma constructor references contracts.alpha.address without an execution dependency; confirm its constructor does not call the referenced contract.';
  const graph = parseSuccess(runCli('graph', '--spec', 'test/fixtures/split-lab.json'));
  assert.deepEqual(graph.resolution.find(node => node.id === 'contract:gamma').needs, [
    { id: 'contract:alpha', reasons: ['args[0] needs contracts.alpha.address', 'checks.BENEFICIARY needs contracts.alpha.address'] },
  ]);
  assert.deepEqual(graph.execution, ['alpha', 'beta', 'gamma'].map(name => ({ id: `contract:${name}`, after: [] })));
  assert.deepEqual(graph.warnings, [warning]);

  const validation = parseSuccess(runCli('validate', '--spec', 'test/fixtures/split-lab.json'));
  assert.deepEqual(validation.warnings, [warning]);
  assert.equal(parseSuccess(runCli('validate', '--spec', 'test/fixtures/parallel-lab.json')).warnings, undefined);
});

test('commands use spec.json in the working directory unless --spec is supplied', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-cli-spec-'));
  try {
    const missing = runCliFrom(directory, 'graph');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /spec\.json/);

    await copyFile(path.join(projectDirectory, 'test/fixtures/state-fixture.json'), path.join(directory, 'spec.json'));
    assert.deepEqual(parseSuccess(runCliFrom(directory, 'graph')), [
      { id: 'contract:stateFixture', deps: [] },
      { id: 'call:bind', deps: ['contract:stateFixture'] },
    ]);

    const alternate = path.join(projectDirectory, 'test/fixtures/parallel-lab.json');
    assert.deepEqual(parseSuccess(runCliFrom(directory, 'impact', '--value', 'upstream', '--spec', alternate)), ['contract:alpha', 'contract:gamma']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('impact reports constructor-value replacements in dependency order', () => {
  const first = runCli('impact', '--spec', 'test/fixtures/parallel-lab.json', '--value', 'upstream');
  const second = runCli('impact', '--spec', 'test/fixtures/parallel-lab.json', '--value', 'upstream');

  assert.deepEqual(parseSuccess(first), ['contract:alpha', 'contract:gamma']);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stderr, '');
  assert.equal(second.stdout, first.stdout);
});

test('graph rejects a missing resource reference before it reads a chain', () => {
  const result = runCli('graph', '--spec', 'test/fixtures/missing-reference.json');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing graph node contract:missing/);
  assert.equal(result.stdout, '');
});

test('graph rejects a dependency cycle before it reads a chain', () => {
  const result = runCli('graph', '--spec', 'test/fixtures/cycle.json');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Dependency cycle/);
  assert.equal(result.stdout, '');
});

test('the specification rejects signer secrets and unknown fields', () => {
  const result = runCli('graph', '--spec', 'test/fixtures/secret-in-spec.json');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown field privateKey|privateKey/i);
  assert.equal(result.stdout, '');
});
