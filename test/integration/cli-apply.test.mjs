import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startAnvil, stopAnvil } from './anvil.mjs';

const projectDirectory = fileURLToPath(new URL('../..', import.meta.url));
const specFile = path.join(projectDirectory, 'test/fixtures/state-fixture.json');
const artifactFile = path.join(projectDirectory, 'test/fixtures/StateFixture.json');
const ownerKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const owner = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
let anvil;
let directory;
let planFile;
let stateFile;
let journalFile;

function runCli(arguments_, signed = false) {
  return spawnSync(process.execPath, [path.join(projectDirectory, 'src/cli.mjs'), ...arguments_], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      ETH_RPC_URL: anvil.rpcUrl,
      ...(signed ? { DEPLOYER_PRIVATE_KEYS: ownerKey, OWNER_PRIVATE_KEY: ownerKey } : {}),
    },
  });
}

before(async () => {
  anvil = await startAnvil();
  directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-cli-apply-'));
  planFile = path.join(directory, 'plan.json');
  stateFile = path.join(directory, 'state.json');
  journalFile = path.join(directory, 'journal.jsonl');
  await copyFile(specFile, path.join(directory, 'spec.json'));
  await copyFile(artifactFile, path.join(directory, 'StateFixture.json'));
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
  await stopAnvil(anvil);
});

test('apply deploys and binds once, writes durable state, and reruns without a transaction', async () => {
  const planned = runCli([
    'plan', '--out', planFile, '--state', stateFile,
  ]);
  assert.equal(planned.status, 0, `${planned.stderr}\n${planned.stdout}`);
  const plan = JSON.parse(planned.stdout);
  assert.deepEqual(plan.resources.map(resource => resource.action), ['deploy', 'call']);

  const nonceBefore = await anvil.rpc('eth_getTransactionCount', [owner, 'latest']);
  const applied = runCli([
    'apply', '--state', stateFile, '--journal', journalFile,
  ], true);
  assert.equal(applied.status, 0, `${applied.stderr}\n${applied.stdout}`);
  const first = JSON.parse(applied.stdout);
  assert.equal(first.status, 'applied');
  assert.equal(first.transactionsSigned, 2);
  assert.equal(first.transactions.length, 2);
  assert.deepEqual(first.resources.map(resource => [resource.id, resource.outcome]), [
    ['contract:stateFixture', 'applied'],
    ['call:bind', 'applied'],
  ]);
  const nonceAfter = await anvil.rpc('eth_getTransactionCount', [owner, 'latest']);
  assert.equal(BigInt(nonceAfter) - BigInt(nonceBefore), 2n);

  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(state.formatVersion, 1);
  assert.equal(state.chain.id, 31337);
  assert.ok(state.resources['contract:stateFixture']);
  assert.ok(state.resources['call:bind']);
  assert.equal(state.resources['contract:stateFixture'].transactions.length, 1);
  assert.equal(state.resources['call:bind'].transactions.length, 1);
  assert.deepEqual(state.resources['contract:stateFixture'].provenance, { kind: 'apply' });
  assert.deepEqual(state.resources['call:bind'].provenance, { kind: 'apply' });

  const journalText = await readFile(journalFile, 'utf8');
  const journal = journalText.trim().split('\n').map(JSON.parse);
  assert.equal(journal.filter(record => record.phase === 'signed').length, 2);
  assert.equal(journal.filter(record => record.phase === 'verified').length, 2);
  assert.doesNotMatch(journalText, new RegExp(ownerKey.slice(2), 'i'));

  const rerun = runCli([
    'apply', '--state', stateFile, '--journal', journalFile,
  ], true);
  assert.equal(rerun.status, 0, `${rerun.stderr}\n${rerun.stdout}`);
  const second = JSON.parse(rerun.stdout);
  assert.equal(second.transactionsSigned, 0);
  assert.equal(second.transactions.length, 0);
  assert.equal(await anvil.rpc('eth_getTransactionCount', [owner, 'latest']), nonceAfter);

  const verified = runCli(['verify', '--state', stateFile]);
  assert.equal(verified.status, 0, `${verified.stderr}\n${verified.stdout}`);
  assert.equal(JSON.parse(verified.stdout).status, 'verified');
});

test('B1: a rebuilt artifact with the same bytecode is reused and rebaselined without a transaction', async () => {
  const before = JSON.parse(await readFile(stateFile, 'utf8'));
  const prior = before.resources['contract:stateFixture'];
  const raw = JSON.parse(await readFile(artifactFile, 'utf8'));
  // The bytecode is unchanged; only the recorded build settings differ.
  delete raw.rawMetadata;
  raw.metadata.settings.remappings = ['forge-std/=lib/forge-std/src/'];
  await writeFile(path.join(directory, 'StateFixture.json'), JSON.stringify(raw));

  const planned = runCli(['plan', '--out', planFile, '--state', stateFile]);
  assert.equal(planned.status, 0, `${planned.stderr}\n${planned.stdout}`);
  const plan = JSON.parse(planned.stdout);
  assert.deepEqual(plan.resources.map(resource => resource.action), ['reuse', 'reuse']);
  const drift = plan.resources[0].observation.stateComparison.artifactDrift;
  assert.equal(drift.accepted, true);
  assert.equal(drift.previousArtifactHash, prior.artifactHash);
  assert.equal(drift.artifactHash, plan.artifactHashes['contract:stateFixture']);
  assert.notEqual(drift.artifactHash, drift.previousArtifactHash);

  const nonceBefore = await anvil.rpc('eth_getTransactionCount', [owner, 'latest']);
  const applied = runCli(['apply', '--state', stateFile, '--journal', journalFile], true);
  assert.equal(applied.status, 0, `${applied.stderr}\n${applied.stdout}`);
  assert.equal(JSON.parse(applied.stdout).transactionsSigned, 0);
  assert.equal(await anvil.rpc('eth_getTransactionCount', [owner, 'latest']), nonceBefore);

  const record = JSON.parse(await readFile(stateFile, 'utf8')).resources['contract:stateFixture'];
  assert.equal(record.artifactHash, drift.artifactHash);
  assert.deepEqual(record.artifactRevisions, [{ artifactHash: prior.artifactHash, sourceHash: prior.sourceHash, proofHash: prior.proofHash, codeHash: prior.codeHash }]);
  for (const key of ['address', 'priorAddress', 'initcodeHash', 'inputsHash', 'priorInputsHash', 'salt', 'codeHash', 'priorCodeHash', 'priorProofHash', 'transactions', 'provenance']) {
    assert.deepEqual(record[key], prior[key], key);
  }

  const replanned = runCli(['plan', '--out', planFile, '--state', stateFile]);
  assert.equal(replanned.status, 0, `${replanned.stderr}\n${replanned.stdout}`);
  assert.ok(JSON.parse(replanned.stdout).resources.every(resource => resource.action === 'reuse' && resource.observation.stateComparison?.artifactDrift === undefined));
});
