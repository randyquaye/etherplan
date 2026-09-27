import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, link, mkdtemp, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { defaultJournalFile } from '../src/cli/commands/apply.ts';
import { openJournal } from '../src/execution/journal.ts';
import { acquireLock, localJournalLockFile } from '../src/execution/lock.ts';
import { createPlan } from '../src/planning/index.ts';
import { accounts, fixture, startAnvil, TEST_KEYS } from './execution/chain.ts';

const childFile = fileURLToPath(new URL('./execution/local-journal-lock-child.ts', import.meta.url));
const lockRaceChildFile = fileURLToPath(new URL('./execution/local-lock-race-child.ts', import.meta.url));
const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
let chain;
let snapshot;

before(async () => { chain = await startAnvil(); });
after(async () => { await chain?.stop(); });
beforeEach(async () => { snapshot = await chain.rpc('evm_snapshot'); });
afterEach(async () => { await chain.rpc('evm_revert', [snapshot]); });

async function workspace() {
  return mkdtemp(path.join(os.tmpdir(), 'etherplan-local-journal-lock-'));
}

async function planned(dir, contractId, signerIndex) {
  const input = fixture({ withCall: false });
  input.spec.contracts = input.spec.contracts.filter(contract => contract.id === contractId);
  input.artifacts = new Map([...input.artifacts].filter(([name]) => name === contractId));
  const plan = await createPlan({ ...input, client: chain.client, signers: { deployers: [accounts[signerIndex].address] }, maxSpendWei: '100000000000000000000' });
  const planFile = path.join(dir, `${contractId}-${signerIndex}.plan.json`);
  await writeFile(planFile, JSON.stringify(plan));
  return { plan, planFile };
}

function startApply(config) {
  const child = spawn(process.execPath, [childFile, JSON.stringify({ ...config, rpcUrl: chain.url })], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let heldSeen = false;
  let heldResolve;
  let heldReject;
  const held = config.holdAtIntent ? new Promise((resolve, reject) => { heldResolve = resolve; heldReject = reject; }) : null;
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (!heldSeen && stdout.includes('HELD\n')) { heldSeen = true; heldResolve?.(); }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (held && !heldSeen) heldReject(new Error(`Child exited before hold: ${stdout}\n${stderr}`));
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, held, exit };
}

function startLockCandidate(file) {
  const child = spawn(process.execPath, [lockRaceChildFile, file], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let readyResolve;
  let outcomeResolve;
  let readySeen = false;
  let outcomeSeen = false;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const outcome = new Promise(resolve => { outcomeResolve = resolve; });
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (!readySeen && stdout.includes('READY\n')) { readySeen = true; readyResolve(); }
    if (!outcomeSeen && stdout.includes('HELD\n')) { outcomeSeen = true; outcomeResolve('HELD'); }
    if (!outcomeSeen && stdout.includes('ERROR ')) { outcomeSeen = true; outcomeResolve('ERROR'); }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, ready, outcome, exit };
}

function expectResult(outcome) {
  assert.equal(outcome.code, 0, `${outcome.stdout}\n${outcome.stderr}`);
  assert.match(outcome.stdout, /RESULT \{"status":"applied"/);
}

async function validatedRecords(file) {
  const journal = await openJournal(file);
  try {
    assert.deepEqual(journal.records.map(record => record.sequence), journal.records.map((_, index) => index + 1));
    return journal.records;
  } finally { await journal.close(); }
}

test('two processes with different states and signers cannot append to one journal together', async () => {
  const dir = await workspace();
  const journalFile = path.join(dir, 'shared.jsonl');
  const first = await planned(dir, 'alpha', 0);
  const second = await planned(dir, 'beta', 1);
  const a = startApply({ contractId: 'alpha', signerIndex: 0, planFile: first.planFile, stateFile: path.join(dir, 'a-state.json'), journalFile, holdAtIntent: true });
  try {
    await a.held;
    const bConfig = { contractId: 'beta', signerIndex: 1, planFile: second.planFile, stateFile: path.join(dir, 'b-state.json'), journalFile };
    const blocked = await startApply(bConfig).exit;
    assert.equal(blocked.code, 2, blocked.stderr);
    assert.match(blocked.stdout, /"code":"state-locked"/);
    const alias = path.join(dir, 'journal-alias.jsonl');
    await symlink(journalFile, alias);
    const aliasBlocked = await startApply({ ...bConfig, journalFile: alias }).exit;
    assert.equal(aliasBlocked.code, 2, aliasBlocked.stderr);
    assert.match(aliasBlocked.stdout, /"code":"state-locked"/);
    assert.equal((await durableRecordsWhileHeld(journalFile)).filter(record => record.phase === 'signed').length, 0);
    a.child.stdin.end('\n');
    expectResult(await a.exit);
    expectResult(await startApply(bConfig).exit);
    const records = await validatedRecords(journalFile);
    assert.ok(records.some(record => record.planHash === first.plan.planHash && record.phase === 'verified'));
    assert.ok(records.some(record => record.planHash === second.plan.planHash && record.phase === 'verified'));
  } finally { a.child.kill('SIGKILL'); }
});

// A holder keeps the journal lock, so inspect its durable lines without opening a second writer.
async function durableRecordsWhileHeld(file) {
  return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('one state path cannot be written through two different journals', async () => {
  const dir = await workspace();
  const stateFile = path.join(dir, 'shared-state.json');
  const first = await planned(dir, 'alpha', 0);
  const second = await planned(dir, 'beta', 1);
  const a = startApply({ contractId: 'alpha', signerIndex: 0, planFile: first.planFile, stateFile, journalFile: path.join(dir, 'a.jsonl'), holdAtIntent: true });
  try {
    await a.held;
    const alternateJournal = path.join(dir, 'b.jsonl');
    const blocked = await startApply({ contractId: 'beta', signerIndex: 1, planFile: second.planFile, stateFile, journalFile: alternateJournal }).exit;
    assert.equal(blocked.code, 2, blocked.stderr);
    assert.match(blocked.stdout, /"code":"state-locked"/);
    const journal = await openJournal(alternateJournal); // Partial acquisition released this lock.
    assert.equal(journal.records.length, 0);
    await journal.close();
    a.child.stdin.end('\n');
    expectResult(await a.exit);
  } finally { a.child.kill('SIGKILL'); }
});

test('CLI defaults derive separate journals from two state filenames in one directory', async () => {
  const dir = await workspace();
  await copyFile(path.join(projectDirectory, 'test/fixtures/Minimal.json'), path.join(dir, 'Minimal.json'));
  const template = JSON.parse(await readFile(path.join(projectDirectory, 'test/fixtures/minimal-create2.json'), 'utf8'));
  const paths = [];
  for (const [index, label] of ['first', 'second'].entries()) {
    const specFile = path.join(dir, `${label}.spec.json`);
    const stateFile = path.join(dir, `${label}.state.json`);
    const planFile = path.join(dir, `${label}.plan.json`);
    const spec = structuredClone(template);
    spec.contracts[0].id = label;
    spec.contracts[0].salt = `0x${String(index + 1).repeat(64)}`;
    await writeFile(specFile, JSON.stringify(spec));
    const env = { ...process.env, ETH_RPC_URL: chain.url, DEPLOYER_PRIVATE_KEYS: TEST_KEYS[0] };
    const plan = spawnSync(process.execPath, ['dist/cli.js', 'plan', '--spec', specFile, '--out', planFile, '--state', stateFile,
      '--deployers', accounts[0].address, '--max-spend-wei', '100000000000000000000'], { cwd: projectDirectory, encoding: 'utf8', env });
    assert.equal(plan.status, 0, `${plan.stdout}\n${plan.stderr}`);
    const applied = spawnSync(process.execPath, ['dist/cli.js', 'apply', '--spec', specFile, '--plan', planFile, '--state', stateFile],
      { cwd: projectDirectory, encoding: 'utf8', env });
    assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
    const journalFile = defaultJournalFile(stateFile);
    assert.equal(JSON.parse(applied.stdout).journal.file, journalFile);
    assert.ok((await validatedRecords(journalFile)).some(record => record.phase === 'verified'));
    paths.push(journalFile);
  }
  assert.notEqual(paths[0], paths[1]);
});

test('a killed journal holder is recovered without allowing an overlapping writer', async () => {
  const dir = await workspace();
  const journalFile = path.join(dir, 'shared.jsonl');
  const alpha = await planned(dir, 'alpha', 0);
  const beta = await planned(dir, 'beta', 1);
  const contenderPlan = await planned(dir, 'beta', 2);
  const killed = startApply({ contractId: 'alpha', signerIndex: 0, planFile: alpha.planFile, stateFile: path.join(dir, 'alpha-state.json'), journalFile, holdAtIntent: true });
  await killed.held;
  killed.child.kill('SIGKILL');
  assert.equal((await killed.exit).signal, 'SIGKILL');

  const recovered = startApply({ contractId: 'beta', signerIndex: 1, planFile: beta.planFile, stateFile: path.join(dir, 'beta-state.json'), journalFile, holdAtIntent: true });
  try {
    await recovered.held;
    const contender = await startApply({ contractId: 'beta', signerIndex: 2, planFile: contenderPlan.planFile, stateFile: path.join(dir, 'contender-state.json'), journalFile }).exit;
    assert.equal(contender.code, 2, contender.stderr);
    assert.match(contender.stdout, /"code":"state-locked"/);
    recovered.child.stdin.end('\n');
    expectResult(await recovered.exit);
    const records = await validatedRecords(journalFile);
    assert.ok(records.some(record => record.planHash === beta.plan.planHash && record.phase === 'verified'));
    assert.equal(records.filter(record => record.planHash === contenderPlan.plan.planHash).length, 0);
  } finally { recovered.child.kill('SIGKILL'); }
});

test('journal validation errors and hard-linked aliases release a self-acquired lock', async () => {
  const dir = await workspace();
  const journalFile = path.join(dir, 'journal.jsonl');
  const alias = path.join(dir, 'alias.jsonl');
  await writeFile(journalFile, 'not json\n');
  await assert.rejects(openJournal(journalFile), /line 1 is not valid JSON/);
  await writeFile(journalFile, '');
  const initial = await openJournal(journalFile);
  await initial.close();
  await link(journalFile, alias);
  await assert.rejects(openJournal(alias), /multiple hard links/);
  await unlink(alias);
  const recovered = await openJournal(journalFile);
  await recovered.close();
});

test('two cross-process stale-lock recoverers cannot both become journal writers', async () => {
  const dir = await workspace();
  const lockFile = await localJournalLockFile(path.join(dir, 'shared.jsonl'));
  const original = startLockCandidate(lockFile);
  await original.ready;
  original.child.stdin.write('GO\n');
  assert.equal(await original.outcome, 'HELD');
  original.child.kill('SIGKILL');
  assert.equal((await original.exit).signal, 'SIGKILL');

  const contenders = [startLockCandidate(lockFile), startLockCandidate(lockFile)];
  try {
    await Promise.all(contenders.map(candidate => candidate.ready));
    for (const candidate of contenders) candidate.child.stdin.write('GO\n');
    const outcomes = await Promise.all(contenders.map(candidate => candidate.outcome));
    assert.ok(outcomes.filter(value => value === 'HELD').length <= 1, `overlapping holders: ${outcomes}`);
    const winner = contenders[outcomes.indexOf('HELD')];
    if (winner) {
      await assert.rejects(acquireLock(lockFile, { planHash: 'race-test' }), /held by pid/);
      winner.child.kill('SIGKILL');
      await winner.exit;
    }
    const resumed = await acquireLock(lockFile, { planHash: 'race-test' });
    assert.ok(resumed.recovered);
    await resumed.release();
  } finally {
    for (const candidate of contenders) candidate.child.kill('SIGKILL');
  }
});
