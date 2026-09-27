import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAwsBackend } from '../src/execution/aws.ts';
import { acquireLeases, deploymentScope, lockScopes } from '../src/execution/backends.ts';
import { createPlan } from '../src/planning/index.ts';
import { deployerA, deployerB, fixture, startAnvil } from './execution/chain.ts';

const childFile = fileURLToPath(new URL('./execution/local-journal-lock-child.ts', import.meta.url));
const hash = digit => `0x${digit.repeat(64)}`;
const chain = { id: 31339, genesisHash: hash('a') };
const scope = deploymentScope({ project: 'a', environment: 'x', label: 'same' }, chain);

test('a signer lease spans projects and environments while other signers and chains remain independent', async () => {
  const held = new Map();
  const lockProvider = { async acquire(lockScope) {
    const key = JSON.stringify(lockScope);
    if (held.has(key)) throw new Error('Writer lock is held.');
    held.set(key, true);
    return { fencingToken: 1, async renew() {}, async assertHeld() {}, async release() { held.delete(key); } };
  } };
  const first = await acquireLeases({ lockProvider, scope, addresses: [deployerA.address], planHash: hash('b') });
  try {
    for (const other of [{ ...scope, project: 'b' }, { ...scope, environment: 'y' }]) {
      await assert.rejects(acquireLeases({ lockProvider, scope: other, addresses: [deployerA.address], planHash: hash('b') }), /Writer lock is held/);
    }
    const otherSigner = await acquireLeases({ lockProvider, scope: { ...scope, project: 'b' }, addresses: [deployerB.address], planHash: hash('b') });
    const otherChain = await acquireLeases({ lockProvider, scope: { ...scope, project: 'b', chainId: 31340 }, addresses: [deployerA.address], planHash: hash('b') });
    await otherSigner.release();
    await otherChain.release();
  } finally { await first.release(); }
  assert.deepEqual(lockScopes(scope, [deployerA.address])[1], lockScopes({ ...scope, project: 'b', environment: 'y' }, [deployerA.address])[1]);
});

test('AWS signer index and lease keys use only chain and address while source identity stays complete', async () => {
  const commands = [];
  const backend = createAwsBackend({ tableName: 'test', kmsKeyId: 'test', dynamodb: { async send(command) {
    commands.push(command);
    return { Item: null };
  } }, kms: {}, s3: {} });
  const other = { ...scope, project: 'b', environment: 'y' };
  await backend.lockProvider.inspect(lockScopes(scope, [deployerA.address])[1]);
  await backend.lockProvider.inspect(lockScopes(other, [deployerA.address])[1]);
  assert.deepEqual(commands[0].input.Key, commands[1].input.Key);
  const signed = { phase: 'signed', sequence: 1, previousHash: null, recordHash: hash('f'), at: new Date().toISOString(),
    planHash: hash('b'), actionId: 'contract:alpha', signer: deployerA.address, nonce: '0', transactionHash: hash('c') };
  const fence = [
    { scope: lockScopes(scope, [deployerA.address])[0], token: 1, holderId: 'runner', principal: 'test' },
    { scope: lockScopes(scope, [deployerA.address])[1], token: 1, holderId: 'runner', principal: 'test' },
  ];
  await backend.journalStore.append(scope, signed, { expectedSequence: 1, expectedPreviousHash: null, fence });
  await backend.journalStore.append(other, { ...signed, transactionHash: hash('d') }, { expectedSequence: 1, expectedPreviousHash: null, fence });
  const rows = commands.slice(2).map(command => command.input.TransactItems.at(-1).Put.Item);
  assert.equal(rows[0].PK, rows[1].PK);
  assert.deepEqual([rows[0].signed.project, rows[0].signed.environment, rows[0].signed.label], ['a', 'x', 'same']);
  assert.deepEqual([rows[1].signed.project, rows[1].signed.environment, rows[1].signed.label], ['b', 'y', 'same']);
});

function runChild(config, waitForHold = false) {
  const child = spawn(process.execPath, [childFile, JSON.stringify(config)], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  let heldResolve;
  const held = waitForHold ? new Promise(resolve => { heldResolve = resolve; }) : null;
  child.stdout.on('data', chunk => {
    output += chunk;
    if (output.includes('HELD\n')) heldResolve?.();
  });
  child.stderr.on('data', chunk => { errors += chunk; });
  const exit = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal, output, errors })));
  return { child, held, exit };
}

test('separate local processes cannot reuse a signer after a holder dies with durable signed bytes', async () => {
  const localChain = await startAnvil(['--chain-id', '31339']);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'etherplan-cross-scope-signer-'));
  let first;
  try {
    const config = async (name, prefix) => {
      const input = fixture({ withCall: false });
      input.spec.chainId = 31339;
      input.spec.contracts = input.spec.contracts.filter(contract => contract.id === name);
      input.artifacts = new Map([[name, input.artifacts.get(name)]]);
      const plan = await createPlan({ ...input, client: localChain.client, signers: { deployers: [deployerA.address] }, maxSpendWei: '100000000000000000000' });
      const planFile = path.join(dir, `${prefix}.plan.json`);
      await writeFile(planFile, JSON.stringify(plan));
      return { contractId: name, signerIndex: 0, planFile, stateFile: path.join(dir, `${prefix}.state.json`), journalFile: path.join(dir, `${prefix}.journal.jsonl`), rpcUrl: localChain.url };
    };
    const a = await config('alpha', 'a');
    const b = await config('beta', 'b');
    first = runChild({ ...a, holdAtSigned: true }, true);
    await first.held;
    const blockedLive = await runChild(b).exit;
    assert.equal(blockedLive.code, 2, blockedLive.errors);
    assert.match(blockedLive.output, /state-locked/);
    assert.equal((await readFile(b.journalFile, 'utf8').catch(() => '')).includes('"phase":"intent"'), false);
    first.child.kill('SIGKILL');
    await first.exit;
    const blockedDead = await runChild(b).exit;
    assert.equal(blockedDead.code, 2, blockedDead.errors);
    assert.match(blockedDead.output, /foreign-outstanding/);
    assert.equal((await readFile(b.journalFile, 'utf8').catch(() => '')).includes('"phase":"signed"'), false);
    const recovered = await runChild(a).exit;
    assert.equal(recovered.code, 0, `${recovered.output}\n${recovered.errors}`);
    const completed = await runChild(b).exit;
    assert.equal(completed.code, 0, `${completed.output}\n${completed.errors}`);
    assert.equal(await localChain.client.getTransactionCount({ address: deployerA.address }), 2);
  } finally { first?.child.kill('SIGKILL'); await localChain.stop(); }
});
