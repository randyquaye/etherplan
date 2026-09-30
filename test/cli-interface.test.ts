import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

function cli(...args) {
  return spawnSync(process.execPath, ['dist/cli.js', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ETH_RPC_URL: '' },
  });
}

test('the CLI exposes its version and command help without a spec or RPC', () => {
  const version = cli('--version');
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), packageVersion);

  const overview = cli('--help');
  assert.equal(overview.status, 0, overview.stderr);
  for (const command of ['init', 'validate', 'compile', 'graph', 'impact', 'plan', 'apply', 'verify', 'schedule', 'import', 'output', 'adapters', 'status']) {
    assert.match(overview.stdout, new RegExp(`\\b${command}\\b`));
    const help = cli(command, '--help');
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, new RegExp(`Usage: etherplan ${command}`));
  }
  assert.match(cli('help', 'plan').stdout, /--out.*plan\.json/);
  assert.match(cli('import', '--help').stdout, /--rebaseline/);
  assert.match(cli('apply', '--help').stdout, /--signer-module/);
  assert.match(cli('status', '--help').stdout, /--backend/);
  assert.match(cli('init', '--help').stdout, /--reconfigure/);
  assert.doesNotMatch(cli('plan', '--help').stdout, /--spec/);
  assert.match(cli('plan', '--help').stdout, /main\.ethp/);
});

test('the built bin is executable through its shebang', { skip: process.platform === 'win32' }, () => {
  const version = spawnSync(fileURLToPath(new URL('../dist/cli.js', import.meta.url)), ['--version'], { cwd: root, encoding: 'utf8' });
  assert.equal(version.status, 0, version.error?.message ?? version.stderr);
  assert.equal(version.stdout.trim(), packageVersion);
});

test('invalid and unrelated options fail before a spec or RPC is opened', () => {
  for (const args of [
    [], ['missing'], ['graph', '--value', 'owner'], ['compile', '--out', 'spec.json'], ['impact'],
    ['import'], ['import', '--id', 'external:registry'],
    ['validate', '--spec'], ['validate', '--spec', 'a'],
  ]) {
    const result = cli(...args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Usage: etherplan/);
  }
});

test('spec commands require main.ethp in the current directory', () => {
  const result = cli('compile');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No main\.ethp/);
});
