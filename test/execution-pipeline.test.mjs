import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, keccak256, parseTransaction } from 'viem';
import { applyPlan } from '../src/execution/index.mjs';
import { createPlan } from '../src/planning/index.mjs';
import { deployerA, deployerB, fixtureMany, startAnvil } from './execution/chain.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const CHILD = fileURLToPath(new URL('./execution/apply-child.mjs', import.meta.url));

function runChild(config) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, JSON.stringify(config)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
}

async function slowFirstBroadcastProxy(upstream) {
  const sends = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const rpc = JSON.parse(body);
      const nonce = rpc.method === 'eth_sendRawTransaction' ? parseTransaction(rpc.params[0]).nonce : null;
      if (nonce !== null) sends.push(nonce);
      const forwarded = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      const response = await forwarded.text();
      if (nonce === 0) await firstGate;
      res.writeHead(forwarded.status, { 'content-type': 'application/json' });
      res.end(response);
    } catch (error) {
      res.writeHead(500);
      res.end(error.message);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { client: createPublicClient({ transport: http(url) }), sends, releaseFirst,
    close: () => new Promise(resolve => server.close(resolve)) };
}

async function rejectHigherNonceProxy(upstream) {
  const sends = [];
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const rpc = JSON.parse(body);
      if (rpc.method === 'eth_sendRawTransaction') {
        const raw = rpc.params[0];
        const nonce = parseTransaction(raw).nonce;
        sends.push({ nonce, raw });
        if (nonce === 1 && sends.filter(send => send.nonce === 1).length <= 2) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'nonce too high' } }));
          return;
        }
      }
      const forwarded = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      res.writeHead(forwarded.status, { 'content-type': 'application/json' });
      res.end(await forwarded.text());
    } catch (error) {
      res.writeHead(500);
      res.end(error.message);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { client: createPublicClient({ transport: http(`http://127.0.0.1:${server.address().port}`) }), sends,
    close: () => new Promise(resolve => server.close(resolve)) };
}

async function workspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'etherplan-pipeline-'));
  return { dir, stateFile: path.join(dir, 'state.json'), journalFile: path.join(dir, 'journal.jsonl'), planFile: path.join(dir, 'plan.json') };
}

async function recordsOf(file) {
  return (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function until(check, description) {
  for (let i = 0; i < 500; i++) {
    const value = await check();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function inputFor(chain, n, maxSpendWei = '100000000000000000000') {
  const { spec, artifacts } = fixtureMany(n);
  return createPlan({ spec, artifacts, client: chain.client,
    pipeline: { deployers: [deployerA.address], parallel: false }, maxSpendWei }).then(plan => ({ plan, spec, artifacts }));
}

function apply(chain, input, ws, options = {}) {
  return applyPlan({ ...input, client: chain.client, signers: { deployer: [deployerA] },
    stateFile: ws.stateFile, journalFile: ws.journalFile, pipeline: true, pollIntervalMs: 20, ...options });
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => error.code === code || (assert.fail(`Expected ${code}, got ${error.code}: ${error.message}`)));
}

test('P-20/P-21/P-30/P-31/P-35: ten signed transactions are durable before any broadcast and all enter the mempool before mining', async () => {
  const chain = await startAnvil(['--no-mining']);
  try {
    const input = await inputFor(chain, 10);
    const ws = await workspace();
    await writeFile(ws.planFile, JSON.stringify(input.plan));
    const planHashBefore = createHash('sha256').update(await readFile(ws.planFile)).digest('hex');
    const ids = input.plan.pipeline.waves[0].signerGroups[0].actions.map(action => action.id);
    assert.deepEqual(ids, input.plan.resources.map(resource => resource.id));
    let firstBroadcastChecked = false;
    const pending = apply(chain, input, ws, { hooks: { async afterRecord(record) {
      if (record.phase !== 'broadcast-attempt' || firstBroadcastChecked) return;
      const durable = await recordsOf(ws.journalFile);
      assert.equal(durable.filter(entry => entry.phase === 'intent').length, 10);
      assert.equal(durable.filter(entry => entry.phase === 'signed').length, 10);
      assert.ok(durable.filter(entry => entry.phase === 'signed').every(entry => entry.sequence < record.sequence));
      assert.deepEqual(durable.filter(entry => entry.phase === 'signed').map(entry => entry.actionId), ids);
      for (const signed of durable.filter(entry => entry.phase === 'signed')) {
        assert.equal(signed.planHash, input.plan.planHash);
        assert.deepEqual(signed.chain, input.plan.chain);
        assert.equal(signed.transactionHash, keccak256(signed.rawTransaction));
        assert.equal(signed.dataHash, keccak256(input.plan.resources.find(resource => resource.id === signed.actionId).tx.data));
        for (const field of ['reservationId', 'nonceOffset', 'signer', 'nonce', 'to', 'value', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas']) {
          assert.notEqual(signed[field], undefined, field);
        }
      }
      firstBroadcastChecked = true;
    } } });
    await until(async () => {
      const pool = await chain.rpc('txpool_content');
      return Object.values(pool.pending ?? {}).reduce((count, txs) => count + Object.keys(txs).length, 0) === 10;
    }, 'all ten pending transactions');
    await until(() => firstBroadcastChecked, 'first durable broadcast attempt');
    assert.equal((await recordsOf(ws.journalFile)).filter(record => record.phase === 'receipt').length, 0);
    await chain.rpc('evm_mine');
    const result = await pending;
    assert.equal(result.status, 'applied');
    assert.equal(result.transactionsSigned, 10);
    assert.ok(result.resources.every(resource => resource.verification.status === 'verified'));
    for (const field of ['submitMs', 'receiptMs', 'verificationMs']) assert.ok(result.timings[field] >= 0);
    const records = await recordsOf(ws.journalFile);
    const signed = records.filter(record => record.phase === 'signed');
    assert.equal((await stat(ws.journalFile)).mode & 0o777, 0o600);
    assert.deepEqual(signed.map(record => Number(record.nonce)), Array.from({ length: 10 }, (_, i) => i));
    assert.deepEqual(signed.map(record => record.nonceOffset), Array.from({ length: 10 }, (_, i) => i));
    assert.equal(records.filter(record => record.phase === 'verified').length, 10);
    assert.equal(createHash('sha256').update(await readFile(ws.planFile)).digest('hex'), planHashBefore);
    const state = JSON.parse(await readFile(ws.stateFile, 'utf8'));
    assert.equal(Object.keys(state.resources).length, 10);
  } finally {
    await chain.stop();
  }
});

test('P-06/P-10/P-11/P-12: plan tampering, group funding, budget, and estimation fail before intent', async () => {
  const chain = await startAnvil();
  try {
    const input = await inputFor(chain, 3);
    const tampered = structuredClone(input.plan);
    tampered.pipeline.waves[0].signerGroups[0].actions[1].nonceOffset = 7;
    const ws = await workspace();
    await rejectsCode(apply(chain, { ...input, plan: tampered }, ws), 'plan-hash');
    assert.equal((await recordsOf(ws.journalFile)).length, 0);

    await chain.rpc('anvil_setBalance', [deployerA.address, '0x3e8']);
    await rejectsCode(apply(chain, input, ws), 'insufficient-funds');
    assert.equal((await recordsOf(ws.journalFile)).filter(record => ['intent', 'signed'].includes(record.phase)).length, 0);
    await chain.rpc('anvil_setBalance', [deployerA.address, '0x8ac7230489e80000']);

    await rejectsCode(apply(chain, await inputFor(chain, 3, '1'), await workspace()), 'budget-exceeded');

    let estimates = 0;
    const client = new Proxy(chain.client, { get(target, property) {
      if (property === 'estimateGas') return async args => {
        if (++estimates === 2) throw new Error('injected estimate failure');
        return target.estimateGas(args);
      };
      return target[property];
    } });
    const estimateWs = await workspace();
    await rejectsCode(apply(chain, input, estimateWs, { client }), 'estimate-failed');
    assert.equal((await recordsOf(estimateWs.journalFile)).filter(record => ['intent', 'signed'].includes(record.phase)).length, 0);
    assert.equal(await chain.client.getTransactionCount({ address: deployerA.address }), 0);
  } finally {
    await chain.stop();
  }
});

test('a partial reservation charges its whole group once on recovery', async () => {
  const chain = await startAnvil();
  try {
    const input = await inputFor(chain, 3);
    const ws = await workspace();
    await writeFile(ws.planFile, JSON.stringify(input.plan));
    const killed = await runChild({ rpcUrl: chain.url, planFile: ws.planFile, stateFile: ws.stateFile,
      journalFile: ws.journalFile, deployers: [0], pipeline: true, fixtureMany: 3,
      crash: { phase: 'signed', occurrence: 1 } });
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    const intents = (await recordsOf(ws.journalFile)).filter(record => record.phase === 'intent');
    const reserved = intents.reduce((sum, record) => sum + BigInt(record.gas) * BigInt(record.maxFeePerGas) + BigInt(record.value), 0n);
    await rejectsCode(apply(chain, input, ws, { budgets: { [deployerA.address]: String(reserved - 1n) } }), 'budget-exceeded');
    assert.equal((await recordsOf(ws.journalFile)).filter(record => record.phase === 'signed').length, 1);

    const result = await apply(chain, input, ws, { budgets: { [deployerA.address]: String(reserved) } });
    assert.equal(result.status, 'applied');
    assert.equal((await recordsOf(ws.journalFile)).filter(record => record.phase === 'signed').length, 3);
  } finally {
    await chain.stop();
  }
});

test('P-60/P-62–P-67: interrupted reservations resume without duplicate signatures or changed nonces', async () => {
  for (const crash of [
    { phase: 'intent', occurrence: 2 }, { phase: 'signed', occurrence: 2 }, { phase: 'signed', occurrence: 4 },
    { phase: 'broadcast', occurrence: 2 }, { phase: 'receipt', occurrence: 1 }, { phase: 'verified', occurrence: 4 },
  ]) {
    const chain = await startAnvil();
    try {
      const input = await inputFor(chain, 4);
      const ws = await workspace();
      await writeFile(ws.planFile, JSON.stringify(input.plan));
      const killed = await runChild({ rpcUrl: chain.url, planFile: ws.planFile, stateFile: ws.stateFile,
        journalFile: ws.journalFile, deployers: [0], pipeline: true, fixtureMany: 4, crash });
      assert.equal(killed.signal, 'SIGKILL', `${crash.phase}/${crash.occurrence}: ${killed.stderr}`);
      const before = await recordsOf(ws.journalFile);
      assert.equal(before.filter(record => record.phase === 'signed').length,
        crash.phase === 'intent' ? 0 : crash.phase === 'signed' ? crash.occurrence : 4);
      if (['intent', 'signed'].includes(crash.phase)) assert.equal(before.filter(record => record.phase === 'broadcast-attempt').length, 0);
      const result = await apply(chain, input, ws);
      assert.equal(result.status, 'applied');
      const records = await recordsOf(ws.journalFile);
      const signed = records.filter(record => record.phase === 'signed');
      assert.equal(signed.length, 4, `${crash.phase}/${crash.occurrence}`);
      assert.equal(new Set(signed.map(record => record.actionId)).size, 4);
      assert.deepEqual(signed.map(record => Number(record.nonce)), [0, 1, 2, 3]);
      assert.equal(await chain.client.getTransactionCount({ address: deployerA.address }), 4);
      assert.equal(records.filter(record => record.phase === 'verified').length, 4, `${crash.phase}/${crash.occurrence}`);
      if (crash.phase === 'intent') {
        assert.notEqual(records.filter(record => record.phase === 'intent')[0].reservationId, signed[0].reservationId);
      } else if (crash.phase === 'signed') {
        assert.deepEqual(signed.slice(0, crash.occurrence), before.filter(record => record.phase === 'signed'));
      } else {
        assert.deepEqual(signed, before.filter(record => record.phase === 'signed'));
      }
    } finally {
      await chain.stop();
    }
  }
});

test('B4: a partially signed two-signer wave resumes its original nonces, including mined legacy work', async () => {
  for (const scenario of ['current', 'legacy-mined', 'legacy-verified']) {
    const chain = await startAnvil();
    try {
      const { spec, artifacts } = fixtureMany(3);
      const plan = await createPlan({ spec, artifacts, client: chain.client,
        pipeline: { deployers: [deployerA.address, deployerB.address], parallel: true }, maxSpendWei: '100000000000000000000' });
      const input = { plan, spec, artifacts };
      const ws = await workspace();
      await writeFile(ws.planFile, JSON.stringify(plan));
      const killed = await runChild({ rpcUrl: chain.url, planFile: ws.planFile, stateFile: ws.stateFile,
        journalFile: ws.journalFile, deployers: [0, 1], parallel: true, pipeline: true, fixtureMany: 3,
        crash: { phase: 'signed', occurrence: 1 } });
      assert.equal(killed.signal, 'SIGKILL', killed.stderr);
      const before = await recordsOf(ws.journalFile);
      assert.equal(before.filter(record => record.phase === 'intent').length, 3);
      assert.equal(before.filter(record => record.phase === 'signed').length, 1);
      assert.equal(new Set(before.filter(record => record.phase === 'intent').map(record => record.waveAttemptId)).size, 1);
      const first = before.find(record => record.phase === 'signed');
      if (scenario !== 'current') {
        for (const record of before) delete record.waveAttemptId;
        await writeFile(ws.journalFile, `${before.map(record => JSON.stringify(record)).join('\n')}\n`);
        await chain.rpc('eth_sendRawTransaction', [first.rawTransaction]);
        const receipt = await chain.client.getTransactionReceipt({ hash: first.transactionHash });
        assert.equal(receipt.status, 'success');
        if (scenario === 'legacy-verified') {
          const common = { formatVersion: 1, planHash: plan.planHash, chain: plan.chain, actionId: first.actionId };
          before.push({ ...common, sequence: before.at(-1).sequence + 1, phase: 'receipt', signer: first.signer,
            nonce: first.nonce, transactionHash: first.transactionHash, receipt: { transactionHash: first.transactionHash,
              status: receipt.status, blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash, gasUsed: String(receipt.gasUsed) } });
          before.push({ ...common, sequence: before.at(-1).sequence + 1, phase: 'verified', outcome: 'applied',
            transactionHash: first.transactionHash });
          await writeFile(ws.journalFile, `${before.map(record => JSON.stringify(record)).join('\n')}\n`);
        }
      }
      const result = await apply(chain, input, ws, { parallel: true, signers: { deployer: [deployerA, deployerB] } });
      assert.equal(result.status, 'applied');
      const records = await recordsOf(ws.journalFile);
      const signed = records.filter(record => record.phase === 'signed');
      assert.equal(signed.length, 3);
      assert.equal(signed.filter(record => record.actionId === first.actionId).length, 1);
      assert.deepEqual(signed.map(record => Number(record.nonce)), [0, 0, 1]);
      assert.equal(records.filter(record => record.phase === 'verified').length, 3);
      assert.equal(await chain.client.getTransactionCount({ address: deployerA.address }), 2);
      assert.equal(await chain.client.getTransactionCount({ address: deployerB.address }), 1);
      assert.equal((await apply(chain, input, ws, { parallel: true, signers: { deployer: [deployerA, deployerB] } })).transactionsSigned, 0);
    } finally {
      await chain.stop();
    }
  }
});

test('B4: a shortfall, nonce conflict, or corrupt second signer intent stops recovery before another broadcast', async () => {
  for (const cause of ['funding', 'nonce', 'pending', 'intent', 'legacy-ambiguous']) {
    const chain = await startAnvil(cause === 'pending' ? ['--no-mining'] : []);
    try {
      const { spec, artifacts } = fixtureMany(2);
      const plan = await createPlan({ spec, artifacts, client: chain.client,
        pipeline: { deployers: [deployerA.address, deployerB.address], parallel: true }, maxSpendWei: '100000000000000000000' });
      const input = { plan, spec, artifacts };
      const ws = await workspace();
      await writeFile(ws.planFile, JSON.stringify(plan));
      const killed = await runChild({ rpcUrl: chain.url, planFile: ws.planFile, stateFile: ws.stateFile,
        journalFile: ws.journalFile, deployers: [0, 1], parallel: true, pipeline: true, fixtureMany: 2,
        crash: { phase: 'signed', occurrence: 1 } });
      assert.equal(killed.signal, 'SIGKILL', killed.stderr);
      if (cause === 'funding') await chain.rpc('anvil_setBalance', [deployerB.address, '0x3e8']);
      else if (cause === 'nonce' || cause === 'pending') {
        const wallet = createWalletClient({ account: deployerB, transport: http(chain.url) });
        await wallet.sendTransaction({ to: deployerB.address, value: 0n, nonce: 0, chain: null });
      } else {
        const records = await recordsOf(ws.journalFile);
        if (cause === 'intent') records.find(record => record.phase === 'intent' && record.signer.toLowerCase() === deployerB.address.toLowerCase()).nonceOffset = 1;
        else {
          for (const record of records) delete record.waveAttemptId;
          records.splice(records.findIndex(record => record.phase === 'intent' && record.signer.toLowerCase() === deployerB.address.toLowerCase()), 1);
        }
        await writeFile(ws.journalFile, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
      }
      const run = () => apply(chain, input, ws, { parallel: true, signers: { deployer: [deployerA, deployerB] } });
      await rejectsCode(run(), cause === 'funding' ? 'insufficient-funds' : ['nonce', 'pending'].includes(cause) ? 'nonce-conflict' : 'journal');
      assert.equal((await recordsOf(ws.journalFile)).filter(record => record.phase === 'broadcast-attempt').length, 0);
      assert.equal(await chain.client.getTransactionCount({ address: deployerA.address }), 0);
      if (cause === 'funding') {
        await chain.rpc('anvil_setBalance', [deployerB.address, '0x8ac7230489e80000']);
        assert.equal((await run()).status, 'applied');
      }
    } finally {
      await chain.stop();
    }
  }
});

test('P-50/P-51: an external transaction consuming a reserved nonce stops repeated apply without shifting the group', async () => {
  const chain = await startAnvil();
  try {
    const input = await inputFor(chain, 4);
    const ws = await workspace();
    await writeFile(ws.planFile, JSON.stringify(input.plan));
    const killed = await runChild({ rpcUrl: chain.url, planFile: ws.planFile, stateFile: ws.stateFile,
      journalFile: ws.journalFile, deployers: [0], pipeline: true, fixtureMany: 4,
      crash: { phase: 'signed', occurrence: 4 } });
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    const wallet = createWalletClient({ account: deployerA, transport: http(chain.url) });
    await wallet.sendTransaction({ to: deployerA.address, value: 0n, nonce: 0, chain: null });
    for (let run = 0; run < 2; run++) {
      await assert.rejects(apply(chain, input, ws, { receiptTimeoutMs: 250 }), error => {
        assert.equal(error.code, 'nonce-conflict');
        assert.equal(error.actionId, 'contract:holder00');
        assert.match(error.message, /nonce 0/);
        return true;
      });
      const records = await recordsOf(ws.journalFile);
      assert.equal(records.filter(record => record.phase === 'signed').length, 4);
      assert.deepEqual(records.filter(record => record.phase === 'signed').map(record => Number(record.nonce)), [0, 1, 2, 3]);
    }
  } finally {
    await chain.stop();
  }
});

test('P-41: a slow response for the lower nonce does not block the next broadcast attempt', async () => {
  const chain = await startAnvil(['--no-mining']);
  const proxy = await slowFirstBroadcastProxy(chain.url);
  try {
    const input = await inputFor(chain, 3);
    const ws = await workspace();
    const pending = apply(chain, input, ws, { client: proxy.client, receiptTimeoutMs: 5_000 });
    await until(() => proxy.sends.length > 0, 'first broadcast');
    await sleep(100);
    const beforeFirstResponse = [...proxy.sends];
    proxy.releaseFirst();
    await until(() => proxy.sends.length === 3, 'all broadcast attempts');
    await chain.rpc('evm_mine');
    assert.equal((await pending).status, 'applied');
    assert.deepEqual(beforeFirstResponse, [0, 1, 2], 'all raw requests must start before nonce 0 receives its response');
  } finally {
    proxy.releaseFirst();
    await proxy.close();
    await chain.stop();
  }
});

test('P-68/P-82: resume rejects altered signed bytes before any broadcast', async () => {
  const chain = await startAnvil();
  try {
    const input = await inputFor(chain, 4);
    const ws = await workspace();
    await writeFile(ws.planFile, JSON.stringify(input.plan));
    const killed = await runChild({ rpcUrl: chain.url, planFile: ws.planFile, stateFile: ws.stateFile,
      journalFile: ws.journalFile, deployers: [0], pipeline: true, fixtureMany: 4,
      crash: { phase: 'signed', occurrence: 4 } });
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    const records = await recordsOf(ws.journalFile);
    const signed = records.find(record => record.phase === 'signed');
    const wrongRaw = await deployerA.signTransaction({ type: 'eip1559', chainId: input.plan.chain.id,
      nonce: Number(signed.nonce), to: signed.to, data: '0x', value: BigInt(signed.value), gas: BigInt(signed.gas),
      maxFeePerGas: BigInt(signed.maxFeePerGas), maxPriorityFeePerGas: BigInt(signed.maxPriorityFeePerGas) });
    signed.rawTransaction = wrongRaw;
    signed.transactionHash = keccak256(wrongRaw);
    await writeFile(ws.journalFile, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
    await rejectsCode(apply(chain, input, ws), 'journal');
    assert.equal((await recordsOf(ws.journalFile)).filter(record => record.phase === 'broadcast-attempt').length, 0);
    assert.equal(await chain.client.getTransactionCount({ address: deployerA.address }), 0);
  } finally {
    await chain.stop();
  }
});

test('P-40: a temporarily rejected higher nonce is retried with identical signed bytes', async () => {
  const chain = await startAnvil();
  const proxy = await rejectHigherNonceProxy(chain.url);
  try {
    const input = await inputFor(chain, 4);
    const ws = await workspace();
    const result = await apply(chain, input, ws, { client: proxy.client, receiptTimeoutMs: 5_000 });
    assert.equal(result.status, 'applied');
    const retryPayloads = proxy.sends.filter(send => send.nonce === 1).map(send => send.raw);
    assert.equal(retryPayloads.length, 3);
    assert.equal(new Set(retryPayloads).size, 1);
    const records = await recordsOf(ws.journalFile);
    assert.equal(records.filter(record => record.phase === 'signed').length, 4);
    assert.deepEqual(records.filter(record => record.phase === 'broadcast-attempt' && record.actionId === 'contract:holder01')
      .map(record => record.accepted), [false, false, true]);
    assert.equal(records.filter(record => record.phase === 'verified').length, 4);
  } finally {
    await proxy.close();
    await chain.stop();
  }
});

test('P-52: a reverted middle nonce does not prevent later signed actions from settling', async () => {
  const chain = await startAnvil();
  try {
    const input = await inputFor(chain, 4);
    const ws = await workspace();
    let estimates = 0;
    const client = new Proxy(chain.client, { get(target, property) {
      if (property === 'estimateGas') return async args => {
        const estimate = await target.estimateGas(args);
        return ++estimates === 3 ? estimate * 60n / 100n : estimate;
      };
      return target[property];
    } });
    let failure;
    try { await apply(chain, input, ws, { client, gasMultiplier: 1, receiptTimeoutMs: 5_000 }); }
    catch (error) { failure = error; }
    assert.equal(failure?.code, 'reverted', failure?.message);
    assert.equal(failure.actionId, 'contract:holder02');
    const records = await recordsOf(ws.journalFile);
    assert.equal(records.filter(record => record.phase === 'signed').length, 4);
    assert.equal(records.filter(record => record.phase === 'receipt').length, 4);
    assert.deepEqual(records.filter(record => record.phase === 'verified').map(record => record.actionId).sort(),
      ['contract:holder00', 'contract:holder01', 'contract:holder03']);
    assert.equal(records.filter(record => record.phase === 'failed' && record.code === 'reverted').length, 1);
    assert.equal(failure.result.resources.find(resource => resource.id === 'contract:holder02').outcome, 'failed');
  } finally {
    await chain.stop();
  }
});

test('P-13: unknown pending signer transaction is rejected before reservation', async () => {
  const chain = await startAnvil(['--no-mining']);
  try {
    const input = await inputFor(chain, 3);
    const ws = await workspace();
    const wallet = createWalletClient({ account: deployerA, transport: http(chain.url) });
    await wallet.sendTransaction({ to: deployerA.address, value: 0n, nonce: 0, chain: null });
    await rejectsCode(apply(chain, input, ws), 'nonce-conflict');
    assert.equal((await recordsOf(ws.journalFile)).filter(record => ['intent', 'signed'].includes(record.phase)).length, 0);
  } finally {
    await chain.stop();
  }
});
