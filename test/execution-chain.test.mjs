import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createWalletClient, http, keccak256, pad } from 'viem';
import { acquireLock, applyPlan } from '../src/execution/index.mjs';
import { estimateGasLimit } from '../src/execution/transactions.mjs';
import { hashJson } from '../src/identity.mjs';
import { createPlan } from '../src/planning/index.mjs';
import { deployerA, deployerB, fixture, owner, outsider, startAnvil, TEST_KEYS } from './execution/chain.mjs';

const CHILD = fileURLToPath(new URL('./execution/apply-child.mjs', import.meta.url));

async function workspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'etherplan-apply-'));
  return { dir, stateFile: path.join(dir, 'state.json'), journalFile: path.join(dir, 'journal.jsonl'), planFile: path.join(dir, 'plan.json') };
}

function rehash(plan) {
  const { planHash, ...fields } = plan;
  return { ...fields, planHash: hashJson(fields) };
}

async function journalOf(file) {
  return (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
}

const count = (records, phase, actionId) => records.filter(record => record.phase === phase && (!actionId || record.actionId === actionId)).length;

function runChild(config) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, JSON.stringify(config)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
}

async function rejectsWith(promise, code, actionId) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code, error.message);
    if (actionId) assert.equal(error.actionId, actionId);
    return true;
  });
}

describe('apply on a private automining chain', () => {
  let chain;
  let snapshot;
  let callPlanned;

  const nonce = account => chain.client.getTransactionCount({ address: account.address });
  const planFor = (options = {}) => {
    const { spec, artifacts } = fixture({ withCall: callPlanned, ...options });
    return createPlan({ spec, artifacts, client: chain.client }).then(plan => ({ plan, spec, artifacts }));
  };
  const apply = ({ plan, spec, artifacts }, ws, extra = {}) => applyPlan({
    plan, spec, artifacts, client: chain.client, signers: { deployer: [deployerA], owner }, stateFile: ws.stateFile, journalFile: ws.journalFile, pollIntervalMs: 20, ...extra,
  });

  before(async () => {
    chain = await startAnvil();
    const probe = await createPlan({ ...fixture(), client: chain.client });
    callPlanned = probe.resources.find(resource => resource.kind === 'call').action === 'call';
  });
  after(async () => chain?.stop());
  beforeEach(async () => { snapshot = await chain.rpc('evm_snapshot'); });
  afterEach(async () => { await chain.rpc('evm_revert', [snapshot]); });

  test('sequential apply deploys each resource once, and a rerun or a new plan sends nothing', async t => {
    if (!callPlanned) t.diagnostic('Builder B does not yet plan a call on a same-plan deploy target (coordinator decision 7); this run omits the call.');
    const input = await planFor();
    const ws = await workspace();
    const actions = input.plan.resources.filter(resource => resource.action !== 'reuse').length;
    const result = await apply(input, ws);
    assert.equal(result.status, 'applied');
    assert.equal(result.transactionsSigned, actions);
    assert.ok(result.resources.every(resource => resource.outcome === 'applied' && resource.verification.status === 'verified'));
    assert.equal(await nonce(deployerA), 4);
    assert.equal(await nonce(owner), callPlanned ? 1 : 0);

    const rerun = await apply(input, ws);
    assert.equal(rerun.transactionsSigned, 0);
    assert.ok(rerun.resources.every(resource => resource.resumed));
    const replanned = await planFor();
    assert.ok(replanned.plan.resources.every(resource => resource.action === 'reuse'));
    const fresh = await apply(replanned, ws);
    assert.equal(fresh.transactionsSigned, 0);
    assert.ok(fresh.resources.every(resource => resource.outcome === 'reused'));
    assert.equal(await nonce(deployerA), 4);

    const records = await journalOf(ws.journalFile);
    const state = JSON.parse(await readFile(ws.stateFile, 'utf8'));
    assert.deepEqual(Object.keys(state.resources).sort(), input.plan.resources.map(resource => resource.id).sort());
    for (const verified of records.filter(record => record.phase === 'verified' && record.outcome === 'applied')) {
      assert.deepEqual(state.resources[verified.actionId].transactions, [verified.transactionHash]);
    }
    const text = await readFile(ws.journalFile, 'utf8');
    for (const key of TEST_KEYS) assert.ok(!text.includes(key.slice(2)), 'journal contains no signer key');
    for (const signed of records.filter(record => record.phase === 'signed')) {
      const sent = records.find(record => record.phase === 'broadcast' && record.transactionHash === signed.transactionHash);
      assert.ok(sent.sequence > signed.sequence, 'the signed record is durable before broadcast');
    }
    if (callPlanned) {
      const callRecord = records.find(record => record.phase === 'verified' && record.actionId === 'call:bindGamma');
      const tx = await chain.client.getTransaction({ hash: callRecord.transactionHash });
      assert.equal(tx.from.toLowerCase(), owner.address.toLowerCase());
    }
  });

  test('rerun uses creation evidence for immutables without getters', async () => {
    const input = fixture({ withCall: false });
    for (const contract of input.spec.contracts) delete contract.checks;
    input.plan = await createPlan({ ...input, client: chain.client });
    const ws = await workspace();
    const first = await apply(input, ws);
    assert.equal(first.transactionsSigned, 4);

    const rerun = await apply(input, ws);
    assert.equal(rerun.transactionsSigned, 0);
    assert.ok(rerun.resources.every(resource => resource.verification.status === 'verified'));

    const state = JSON.parse(await readFile(ws.stateFile, 'utf8'));
    const replanned = await createPlan({ spec: input.spec, artifacts: input.artifacts, client: chain.client, state });
    assert.ok(replanned.resources.every(resource => resource.action === 'reuse'));
    const reused = await apply({ ...input, plan: replanned }, ws);
    assert.equal(reused.transactionsSigned, 0);
  });

  test('a SIGKILL after signing, after broadcast, or after receipt resumes without a duplicate transaction', async () => {
    const cases = [['signed', 'contract:alpha'], ['broadcast', 'contract:beta'], ['receipt', 'contract:gamma']];
    if (callPlanned) cases.push(['signed', 'call:bindGamma']);
    for (const [phase, actionId] of cases) {
      const inner = await chain.rpc('evm_snapshot');
      const input = await planFor();
      const ws = await workspace();
      await writeFile(ws.planFile, JSON.stringify(input.plan));
      const killed = await runChild({ rpcUrl: chain.url, planFile: ws.planFile, stateFile: ws.stateFile, journalFile: ws.journalFile, deployers: [0], owner: 3, fixture: { withCall: callPlanned }, crash: { phase, actionId } });
      assert.equal(killed.signal, 'SIGKILL', `${phase}/${actionId}: ${killed.stderr}`);
      const before = await journalOf(ws.journalFile);
      assert.equal(before.at(-1).phase, phase);

      const result = await apply(input, ws);
      assert.equal(result.status, 'applied', `${phase}/${actionId}`);
      assert.ok(result.lockRecovered, 'the killed apply left a lock that the resume recovered');
      const records = await journalOf(ws.journalFile);
      assert.equal(count(records, 'signed', actionId), 1, `${phase}/${actionId} was signed once`);
      assert.equal(count(records, 'verified'), input.plan.resources.length);
      assert.equal(await nonce(deployerA), 4, `${phase}/${actionId} sent no duplicate deployment`);
      assert.equal(await nonce(owner), callPlanned ? 1 : 0, `${phase}/${actionId} sent no duplicate call`);
      assert.deepEqual(result.rebroadcasts.map(entry => entry.actionId), phase === 'signed' ? [actionId] : []);
      await chain.rpc('evm_revert', [inner]);
    }
  });

  test('recovery rejects a substituted valid signature before any chain action', async () => {
    for (const phase of ['signed', 'broadcast', 'receipt']) {
      const inner = await chain.rpc('evm_snapshot');
      const input = await planFor();
      const ws = await workspace();
      await writeFile(ws.planFile, JSON.stringify(input.plan));
      const killed = await runChild({ rpcUrl: chain.url, planFile: ws.planFile, stateFile: ws.stateFile,
        journalFile: ws.journalFile, deployers: [0], owner: 3, fixture: { withCall: callPlanned },
        crash: { phase, actionId: 'contract:alpha' } });
      assert.equal(killed.signal, 'SIGKILL', `${phase}: ${killed.stderr}`);
      const records = await journalOf(ws.journalFile);
      const intent = records.find(record => record.phase === 'intent' && record.actionId === 'contract:alpha');
      const signed = records.find(record => record.phase === 'signed' && record.actionId === 'contract:alpha');
      const rawTransaction = await deployerA.signTransaction({ type: 'eip1559', chainId: input.plan.chain.id,
        nonce: Number(intent.nonce), to: outsider.address, data: '0x', value: 100n,
        gas: BigInt(intent.gas), maxFeePerGas: BigInt(intent.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(intent.maxPriorityFeePerGas) });
      const substitutedHash = keccak256(rawTransaction);
      signed.rawTransaction = rawTransaction;
      for (const record of records.filter(record => record.actionId === 'contract:alpha' && record.transactionHash)) {
        record.transactionHash = substitutedHash;
        if (record.receipt) record.receipt.transactionHash = substitutedHash;
      }
      await writeFile(ws.journalFile, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
      let sends = 0;
      const client = new Proxy(chain.client, { get(target, property) {
        if (property === 'request') return async args => {
          if (args.method === 'eth_sendRawTransaction') sends++;
          return target.request(args);
        };
        return target[property];
      } });
      const beforeBalance = await chain.client.getBalance({ address: outsider.address });
      await assert.rejects(apply(input, ws, { client }), error => {
        assert.equal(error.code, 'journal');
        assert.equal(error.actionId, 'contract:alpha');
        assert.ok(!error.message.includes(rawTransaction));
        return true;
      });
      assert.equal(sends, 0, `${phase} sent a transaction`);
      assert.equal(await chain.client.getBalance({ address: outsider.address }), beforeBalance);
      assert.equal(count(await journalOf(ws.journalFile), 'verified', 'contract:alpha'), 0);
      await chain.rpc('evm_revert', [inner]);
    }
  });

  test('a saved broadcast attempt resumes with the same signature', async () => {
    const input = await planFor();
    const ws = await workspace();
    await writeFile(ws.planFile, JSON.stringify(input.plan));
    const killed = await runChild({ rpcUrl: chain.url, planFile: ws.planFile, stateFile: ws.stateFile,
      journalFile: ws.journalFile, deployers: [0], owner: 3, fixture: { withCall: callPlanned },
      crash: { phase: 'signed', actionId: 'contract:alpha' } });
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    const records = await journalOf(ws.journalFile);
    const signed = records.find(record => record.phase === 'signed' && record.actionId === 'contract:alpha');
    records.push({ formatVersion: 1, planHash: signed.planHash, chain: signed.chain, actionId: signed.actionId,
      phase: 'broadcast-attempt', sequence: signed.sequence + 1, signer: signed.signer,
      nonce: signed.nonce, transactionHash: signed.transactionHash });
    await writeFile(ws.journalFile, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
    assert.equal((await apply(input, ws)).status, 'applied');
    assert.equal(count(await journalOf(ws.journalFile), 'signed', 'contract:alpha'), 1);
  });

  test('a SIGKILL inside a parallel batch resumes both signed transactions with their original signers', async () => {
    const input = await planFor();
    const ws = await workspace();
    await writeFile(ws.planFile, JSON.stringify(input.plan));
    const killed = await runChild({ rpcUrl: chain.url, planFile: ws.planFile, stateFile: ws.stateFile, journalFile: ws.journalFile, deployers: [0, 1], owner: 3, parallel: true, fixture: { withCall: callPlanned }, crash: { phase: 'signed', actionId: 'contract:beta' } });
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    assert.deepEqual((await journalOf(ws.journalFile)).filter(record => record.phase === 'signed').map(record => record.actionId), ['contract:alpha', 'contract:beta']);

    const result = await apply(input, ws, { parallel: true, signers: { deployer: [deployerA, deployerB], owner } });
    assert.equal(result.status, 'applied');
    assert.deepEqual(result.rebroadcasts.map(entry => entry.actionId).sort(), ['contract:alpha', 'contract:beta']);
    assert.equal(await nonce(deployerA), 3);
    assert.equal(await nonce(deployerB), 1);
  });

  test('a tampered, stale, or wrong-chain plan fails before any signature', async () => {
    const input = await planFor();
    const ws = await workspace();
    const deploy = input.plan.resources.findIndex(resource => resource.id === 'contract:alpha');
    const edit = (change, hashed = true) => {
      const plan = structuredClone(input.plan);
      change(plan);
      return hashed ? rehash(plan) : plan;
    };

    await rejectsWith(apply({ ...input, plan: edit(plan => { plan.resources[deploy].tx.data += '00'; }, false) }, ws), 'plan-hash');
    await rejectsWith(apply({ ...input, plan: edit(plan => { plan.resources[deploy].tx.data += '00'; }) }, ws), 'stale-resource', 'contract:alpha');
    await rejectsWith(apply({ ...input, plan: edit(plan => { plan.resources[deploy].address = outsider.address; }) }, ws), 'stale-resource', 'contract:alpha');
    await rejectsWith(apply({ ...input, plan: edit(plan => { plan.resources[deploy].action = 'conflict'; }) }, ws), 'plan-not-applicable');
    await rejectsWith(apply({ ...input, plan: edit(plan => { plan.chain.id = 1; }) }, ws), 'wrong-chain');
    await rejectsWith(apply({ ...input, plan: edit(plan => { plan.chain.genesisHash = `0x${'12'.repeat(32)}`; }) }, ws), 'wrong-chain');
    await rejectsWith(apply({ ...input, plan: edit(plan => { plan.observed.blockHash = `0x${'34'.repeat(32)}`; }) }, ws), 'stale-observation');
    await rejectsWith(apply({ ...input, spec: fixture({ withCall: callPlanned, upstream: outsider.address }).spec }, ws), 'stale-spec');
    const changed = new Map(input.artifacts);
    changed.set('alpha', { ...changed.get('alpha'), artifactHash: `0x${'56'.repeat(32)}` });
    await rejectsWith(apply({ ...input, artifacts: changed }, ws), 'stale-artifact', 'contract:alpha');

    assert.equal(await nonce(deployerA), 0);
    assert.equal(count(await journalOf(ws.journalFile), 'signed'), 0);
  });

  test('a reorg of the observed block makes the plan stale', async () => {
    const fork = await chain.rpc('evm_snapshot');
    await chain.rpc('evm_mine');
    const input = await planFor();
    await chain.rpc('evm_revert', [fork]);
    const { timestamp } = await chain.client.getBlock();
    await chain.rpc('evm_setNextBlockTimestamp', [Number(timestamp) + 1000]);
    await chain.rpc('evm_mine');
    await rejectsWith(apply(input, await workspace()), 'stale-observation');
    assert.equal(await nonce(deployerA), 0);
  });

  test('an address occupied by other code is a conflict, and that plan cannot be retried', async () => {
    const input = await planFor();
    const ws = await workspace();
    const alpha = input.plan.resources.find(resource => resource.id === 'contract:alpha');
    await chain.rpc('anvil_setCode', [alpha.address, '0x60016000f3']);
    await rejectsWith(apply(input, ws), 'conflict', 'contract:alpha');
    assert.equal(await nonce(deployerA), 0);
    const failed = (await journalOf(ws.journalFile)).find(record => record.phase === 'failed');
    assert.equal(failed.retryable, false);
    assert.equal(failed.evidence.status, 'conflict');
    await rejectsWith(apply(input, ws), 'previous-failure', 'contract:alpha');
  });

  test('another account can deploy the same CREATE2 plan; apply then records it without a transaction', async () => {
    const input = await planFor({ withCall: false });
    const other = await apply(input, await workspace(), { signers: { deployer: [outsider] } });
    assert.equal(other.transactionsSigned, 4);
    const result = await apply(input, await workspace());
    assert.equal(result.transactionsSigned, 0);
    assert.ok(result.resources.every(resource => resource.outcome === 'already-satisfied'));
    assert.equal(await nonce(deployerA), 0);
  });

  test('an insufficiently funded deployer stops the batch before signing; a rerun after funding continues', async () => {
    const input = await planFor();
    const ws = await workspace();
    const signers = { deployer: [deployerA, deployerB], owner };
    await chain.rpc('anvil_setBalance', [deployerB.address, '0x3e8']);
    await rejectsWith(apply(input, ws, { parallel: true, signers }), 'insufficient-funds', 'contract:beta');
    const records = await journalOf(ws.journalFile);
    assert.equal(count(records, 'signed'), 0);
    assert.equal(records.find(record => record.phase === 'failed').retryable, true);
    assert.equal(await nonce(deployerA), 0);

    await chain.rpc('anvil_setBalance', [deployerB.address, '0x8ac7230489e80000']);
    const result = await apply(input, ws, { parallel: true, signers });
    assert.equal(result.status, 'applied');
    assert.equal(await nonce(deployerB), 1);
  });

  test('a spend budget per signer is enforced before signing', async () => {
    const input = await planFor();
    await rejectsWith(apply(input, await workspace(), { budgets: { [deployerA.address]: '1' } }), 'budget-exceeded', 'contract:alpha');
    assert.equal(await nonce(deployerA), 0);

    const alpha = input.plan.resources.find(resource => resource.id === 'contract:alpha');
    const fees = await chain.client.estimateFeesPerGas();
    const gas = await estimateGasLimit(chain.client, { from: deployerA.address, tx: alpha.tx, gasMultiplier: 1.2 });
    const cap = gas * fees.maxFeePerGas + BigInt(alpha.tx.value);
    const ws = await workspace();
    await rejectsWith(apply(input, ws, { fees, budgets: { [deployerA.address]: String(cap) } }), 'budget-exceeded', 'contract:beta');
    assert.equal(count(await journalOf(ws.journalFile), 'signed'), 1);
    assert.equal(await nonce(deployerA), 1);
  });

  test('a serial spend budget still counts a verified signature after restart', async () => {
    const input = await planFor();
    const ws = await workspace();
    await writeFile(ws.planFile, JSON.stringify(input.plan));
    const killed = await runChild({ rpcUrl: chain.url, planFile: ws.planFile, stateFile: ws.stateFile,
      journalFile: ws.journalFile, deployers: [0], owner: 3, fixture: { withCall: callPlanned },
      crash: { phase: 'signed', actionId: 'contract:alpha' } });
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    const intent = (await journalOf(ws.journalFile)).find(record => record.phase === 'intent');
    const cap = (BigInt(intent.gas) * BigInt(intent.maxFeePerGas) + BigInt(intent.value)).toString();
    const budget = { [deployerA.address]: cap };

    for (let attempt = 0; attempt < 2; attempt++) {
      await rejectsWith(apply(input, ws, { budgets: budget }), 'budget-exceeded', 'contract:beta');
      const records = await journalOf(ws.journalFile);
      assert.equal(count(records, 'signed'), 1);
      assert.equal(await nonce(deployerA), 1);
      assert.match(records.at(-1).reason, new RegExp(`${cap} wei committed`));
    }
  });

  test('a changed serial intent cost fails journal validation before rebroadcast', async () => {
    const input = await planFor();
    const ws = await workspace();
    await writeFile(ws.planFile, JSON.stringify(input.plan));
    const killed = await runChild({ rpcUrl: chain.url, planFile: ws.planFile, stateFile: ws.stateFile,
      journalFile: ws.journalFile, deployers: [0], owner: 3, fixture: { withCall: callPlanned },
      crash: { phase: 'signed', actionId: 'contract:alpha' } });
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    const records = await journalOf(ws.journalFile);
    records.find(record => record.phase === 'intent').gas = '1';
    await writeFile(ws.journalFile, records.map(record => JSON.stringify(record)).join('\n') + '\n');

    await rejectsWith(apply(input, ws), 'journal', 'contract:alpha');
    assert.equal(count(await journalOf(ws.journalFile), 'broadcast'), 0);
    assert.equal(await nonce(deployerA), 0);
  });

  test('a nonce used by another writer stops safely, and the next run deploys once', async () => {
    const input = await planFor();
    const ws = await workspace();
    await writeFile(ws.planFile, JSON.stringify(input.plan));
    const killed = await runChild({ rpcUrl: chain.url, planFile: ws.planFile, stateFile: ws.stateFile, journalFile: ws.journalFile, deployers: [0], owner: 3, fixture: { withCall: callPlanned }, crash: { phase: 'signed', actionId: 'contract:alpha' } });
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    const wallet = createWalletClient({ account: deployerA, transport: http(chain.url) });
    await wallet.sendTransaction({ to: deployerA.address, value: 0n, nonce: 0, chain: null });

    await rejectsWith(apply(input, ws), 'nonce-race', 'contract:alpha');
    const failed = (await journalOf(ws.journalFile)).filter(record => record.phase === 'failed');
    assert.equal(failed.at(-1).retryable, true);

    const result = await apply(input, ws);
    assert.equal(result.status, 'applied');
    const records = await journalOf(ws.journalFile);
    assert.equal(count(records, 'signed', 'contract:alpha'), 2);
    assert.equal(count(records, 'receipt', 'contract:alpha'), 1);
    assert.equal(await nonce(deployerA), 5);
  });

  test('an unsent transaction from an older plan blocks a newer plan until the older plan resumes', async () => {
    const older = await planFor();
    const ws = await workspace();
    await writeFile(ws.planFile, JSON.stringify(older.plan));
    const killed = await runChild({ rpcUrl: chain.url, planFile: ws.planFile, stateFile: ws.stateFile, journalFile: ws.journalFile, deployers: [0], owner: 3, fixture: { withCall: callPlanned }, crash: { phase: 'signed', actionId: 'contract:alpha' } });
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    await chain.rpc('evm_mine');
    const newer = await planFor();
    assert.notEqual(newer.plan.planHash, older.plan.planHash);
    await rejectsWith(apply(newer, ws), 'foreign-outstanding', 'contract:alpha');
    assert.equal(await nonce(deployerA), 0);
    assert.equal((await apply(older, ws)).status, 'applied');
    assert.equal(await nonce(deployerA), 4);
  });

  test('a live writer lock blocks a second apply', async () => {
    const input = await planFor();
    const ws = await workspace();
    const lock = await acquireLock(`${ws.stateFile}.lock`, { planHash: input.plan.planHash });
    try {
      await rejectsWith(apply(input, ws), 'state-locked');
    } finally {
      await lock.release();
    }
    assert.equal(await nonce(deployerA), 0);
  });

  test('a binding changed after the plan is a conflict, and the owner call is never sent', async t => {
    if (!callPlanned) return t.skip('Builder B does not yet plan a call on a same-plan deploy target (coordinator decision 7).');
    const input = await planFor();
    const registry = input.plan.resources.find(resource => resource.id === 'contract:registry');
    const hooks = {
      async afterRecord(record) {
        if (record.phase === 'verified' && record.actionId === 'contract:gamma') await chain.rpc('anvil_setStorageAt', [registry.address, pad('0x0'), pad(outsider.address)]);
      },
    };
    await rejectsWith(apply(input, await workspace(), { hooks }), 'conflict', 'call:bindGamma');
    assert.equal(await nonce(owner), 0);
  });
});

describe('parallel apply on a manually mined chain', () => {
  let chain;
  before(async () => { chain = await startAnvil(['--no-mining']); });
  after(async () => chain?.stop());

  test('two funded deployers share a wave, the dependent wave waits, and owner calls stay on the owner', async () => {
    const probe = await createPlan({ ...fixture(), client: chain.client });
    const withCall = probe.resources.find(resource => resource.kind === 'call').action === 'call';
    const { spec, artifacts } = fixture({ withCall });
    const plan = await createPlan({ spec, artifacts, client: chain.client });
    const ws = await workspace();
    let signed = 0;
    let sent = 0;
    // Mine one block only after every transaction of the current batch is broadcast.
    const hooks = {
      async afterRecord(record) {
        if (record.phase === 'signed') signed += 1;
        if (record.phase === 'broadcast' && ++sent === signed) await chain.rpc('evm_mine');
      },
    };
    const result = await applyPlan({ plan, spec, artifacts, client: chain.client, signers: { deployer: [deployerA, deployerB], owner }, stateFile: ws.stateFile, journalFile: ws.journalFile, parallel: true, pollIntervalMs: 20, hooks });
    assert.equal(result.status, 'applied');
    const receipts = new Map((await journalOf(ws.journalFile)).filter(record => record.phase === 'receipt').map(record => [record.actionId, BigInt(record.receipt.blockNumber)]));
    const signers = new Map(result.transactions.map(entry => [entry.actionId, entry.signer]));
    assert.equal(receipts.get('contract:alpha'), receipts.get('contract:beta'), 'independent deploys share one block');
    assert.notEqual(signers.get('contract:alpha'), signers.get('contract:beta'));
    assert.ok(receipts.get('contract:registry') > receipts.get('contract:alpha'), 'a third independent deploy waits for a free signer');
    assert.ok(receipts.get('contract:gamma') > receipts.get('contract:registry'), 'the dependent wave starts after wave 1 verifies');
    assert.equal(await chain.client.getTransactionCount({ address: deployerA.address }), 3);
    assert.equal(await chain.client.getTransactionCount({ address: deployerB.address }), 1);
    if (withCall) {
      assert.ok(receipts.get('call:bindGamma') > receipts.get('contract:gamma'));
      assert.equal(signers.get('call:bindGamma'), owner.address.toLowerCase());
    }
    for (const resource of plan.resources.filter(item => item.kind === 'contract')) {
      assert.equal(result.resources.find(item => item.id === resource.id).address, resource.address.toLowerCase());
    }
  });
});
