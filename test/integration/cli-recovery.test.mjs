import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startAnvil, stopAnvil } from './anvil.mjs';

const projectDirectory = fileURLToPath(new URL('../..', import.meta.url));
const specFile = path.join(projectDirectory, 'test/fixtures/state-fixture.json');
const ownerKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const owner = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';

function runSync(arguments_, rpcUrl, signed = false) {
  return spawnSync(process.execPath, ['src/cli.mjs', ...arguments_], {
    cwd: projectDirectory,
    encoding: 'utf8',
    env: {
      ...process.env,
      ETH_RPC_URL: rpcUrl,
      ...(signed ? { DEPLOYER_PRIVATE_KEYS: ownerKey, OWNER_PRIVATE_KEY: ownerKey } : {}),
    },
  });
}

function runAsync(arguments_, rpcUrl) {
  const child = spawn(process.execPath, ['src/cli.mjs', ...arguments_], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      ETH_RPC_URL: rpcUrl,
      DEPLOYER_PRIVATE_KEYS: ownerKey,
      OWNER_PRIVATE_KEY: ownerKey,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return { child, output: () => ({ stdout, stderr }) };
}

async function readJournal(file) {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function waitForPhase(file, child, phase) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const records = await readJournal(file);
    if (records.some(record => record.actionId === 'contract:stateFixture' && record.phase === phase)) return records;
    if (child.exitCode !== null) throw new Error(`Apply exited before ${phase}.`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Apply did not record ${phase} within 10 seconds.`);
}

async function startRpcGate(target, stopAfter) {
  const stalled = new Set();
  let transactionSent = false;
  let receiptReturned = false;
  let pass = false;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const payload = JSON.parse(body);
    const method = Array.isArray(payload) ? null : payload.method;
    const shouldStall = !pass && (
      (stopAfter === 'signed' && method === 'eth_sendRawTransaction') ||
      (stopAfter === 'broadcast' && transactionSent && method === 'eth_getTransactionReceipt') ||
      (stopAfter === 'receipt' && receiptReturned && method === 'eth_getBlockByNumber')
    );
    if (shouldStall) {
      stalled.add(response);
      response.on('close', () => stalled.delete(response));
      return;
    }
    try {
      const upstream = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      const text = await upstream.text();
      if (method === 'eth_sendRawTransaction') transactionSent = true;
      if (method === 'eth_getTransactionReceipt' && JSON.parse(text).result) receiptReturned = true;
      response.writeHead(upstream.status, { 'content-type': 'application/json' });
      response.end(text);
    } catch (error) {
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id ?? null, error: { code: -32000, message: error.message } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    release() {
      pass = true;
      for (const response of stalled) response.destroy();
      stalled.clear();
    },
    async close() {
      this.release();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

for (const phase of ['signed', 'broadcast', 'receipt']) {
  test(`apply resumes after SIGKILL at ${phase} without a duplicate transaction`, async () => {
    const anvil = await startAnvil();
    const directory = await mkdtemp(path.join(os.tmpdir(), `etherplan-cli-${phase}-`));
    const planFile = path.join(directory, 'plan.json');
    const stateFile = path.join(directory, 'state.json');
    const journalFile = path.join(directory, 'journal.jsonl');
    let gate;
    try {
      const planned = runSync(['plan', '--spec', specFile, '--out', planFile, '--state', stateFile], anvil.rpcUrl);
      assert.equal(planned.status, 0, `${planned.stderr}\n${planned.stdout}`);
      gate = await startRpcGate(anvil.rpcUrl, phase);
      const running = runAsync([
        'apply', '--spec', specFile, '--plan', planFile, '--state', stateFile, '--journal', journalFile,
      ], gate.url);
      await waitForPhase(journalFile, running.child, phase);
      assert.equal(running.child.kill('SIGKILL'), true);
      await new Promise(resolve => running.child.once('exit', resolve));
      gate.release();

      const resumed = runSync([
        'apply', '--spec', specFile, '--plan', planFile, '--state', stateFile, '--journal', journalFile,
      ], anvil.rpcUrl, true);
      assert.equal(resumed.status, 0, `${resumed.stderr}\n${resumed.stdout}\n${JSON.stringify(running.output())}`);
      const result = JSON.parse(resumed.stdout);
      assert.equal(result.status, 'applied');
      assert.equal(await anvil.rpc('eth_getTransactionCount', [owner, 'latest']), '0x2');

      const journalText = await readFile(journalFile, 'utf8');
      const journal = journalText.trim().split('\n').map(JSON.parse);
      assert.equal(journal.filter(record => record.actionId === 'contract:stateFixture' && record.phase === 'signed').length, 1);
      assert.equal(journal.filter(record => record.actionId === 'call:bind' && record.phase === 'signed').length, 1);
      assert.equal(new Set(journal.filter(record => record.phase === 'signed').map(record => record.transactionHash)).size, 2);
      assert.doesNotMatch(journalText, new RegExp(ownerKey.slice(2), 'i'));

      const verified = runSync(['verify', '--spec', specFile, '--state', stateFile], anvil.rpcUrl);
      assert.equal(verified.status, 0, `${verified.stderr}\n${verified.stdout}`);
    } finally {
      await gate?.close();
      await rm(directory, { recursive: true, force: true });
      await stopAnvil(anvil);
    }
  });
}
