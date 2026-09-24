import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectDirectory = fileURLToPath(new URL('../..', import.meta.url));

function runCli(...arguments_) {
  return spawnSync(process.execPath, ['src/cli.mjs', ...arguments_], {
    cwd: projectDirectory,
    encoding: 'utf8',
    env: { ...process.env, ETH_RPC_URL: '' },
  });
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
