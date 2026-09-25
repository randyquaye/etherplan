import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { startAnvil, stopAnvil } from './anvil.mjs';

const projectDirectory = fileURLToPath(new URL('../..', import.meta.url));
const sourceSpecFile = path.join(projectDirectory, 'test/fixtures/state-fixture.json');
const artifactFile = path.join(projectDirectory, 'test/fixtures/StateFixture.json');
const ownerKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const deployerKey = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const owner = privateKeyToAccount(ownerKey);
const deployer = privateKeyToAccount(deployerKey);
const planArgs = ['--deployers', deployer.address, '--owner', owner.address, '--max-spend-wei', '100000000000000000000'];

function runSync(arguments_, rpcUrl, signed = false) {
  return spawnSync(process.execPath, ['src/cli.mjs', ...arguments_], {
    cwd: projectDirectory,
    encoding: 'utf8',
    env: {
      ...process.env,
      ETH_RPC_URL: rpcUrl,
      ...(signed ? { DEPLOYER_PRIVATE_KEYS: deployerKey, OWNER_PRIVATE_KEY: ownerKey } : {}),
    },
  });
}

async function workspace(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  const spec = JSON.parse(await readFile(sourceSpecFile, 'utf8'));
  spec.contracts[0].artifact = artifactFile;
  const specFile = path.join(directory, 'spec.json');
  await writeFile(specFile, `${JSON.stringify(spec, null, 2)}\n`);
  return {
    directory,
    spec,
    specFile,
    planFile: path.join(directory, 'plan.json'),
    stateFile: path.join(directory, 'state.json'),
    journalFile: path.join(directory, 'journal.jsonl'),
  };
}

async function records(file) {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function waitForSigned(file, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const journal = await records(file);
    if (journal.some(record => record.actionId === 'contract:stateFixture' && record.phase === 'signed')) return;
    if (child.exitCode !== null) throw new Error('Apply exited before it wrote the signed record.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Apply did not write the signed record within 10 seconds.');
}

async function signedGate(target) {
  const stalled = new Set();
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    if (JSON.parse(body).method === 'eth_sendRawTransaction') {
      stalled.add(response);
      response.on('close', () => stalled.delete(response));
      return;
    }
    const upstream = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    response.writeHead(upstream.status, { 'content-type': 'application/json' });
    response.end(await upstream.text());
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      for (const response of stalled) response.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

test('apply rejects a spec changed after planning before any signature', async () => {
  const anvil = await startAnvil();
  const ws = await workspace('etherplan-cli-stale-');
  try {
    const planned = runSync(['plan', '--spec', ws.specFile, '--out', ws.planFile, '--state', ws.stateFile, ...planArgs], anvil.rpcUrl);
    assert.equal(planned.status, 0, `${planned.stderr}\n${planned.stdout}`);
    ws.spec.values.beneficiary = '0x0000000000000000000000000000000000000002';
    await writeFile(ws.specFile, `${JSON.stringify(ws.spec, null, 2)}\n`);

    const applied = runSync([
      'apply', '--spec', ws.specFile, '--plan', ws.planFile, '--state', ws.stateFile, '--journal', ws.journalFile,
    ], anvil.rpcUrl, true);
    assert.equal(applied.status, 1);
    assert.match(applied.stderr, /stale-spec/i);
    assert.equal(await anvil.rpc('eth_getTransactionCount', [deployer.address, 'latest']), '0x0');
    assert.equal((await records(ws.journalFile)).some(record => record.phase === 'signed'), false);
  } finally {
    await rm(ws.directory, { recursive: true, force: true });
    await stopAnvil(anvil);
  }
});

test('an insufficient deployer balance stops before signing and resumes after funding', async () => {
  const anvil = await startAnvil();
  const ws = await workspace('etherplan-cli-funding-');
  try {
    const planned = runSync(['plan', '--spec', ws.specFile, '--out', ws.planFile, '--state', ws.stateFile, ...planArgs], anvil.rpcUrl);
    assert.equal(planned.status, 0, `${planned.stderr}\n${planned.stdout}`);
    await anvil.rpc('anvil_setBalance', [deployer.address, '0x3e8']);

    const stopped = runSync([
      'apply', '--spec', ws.specFile, '--plan', ws.planFile, '--state', ws.stateFile, '--journal', ws.journalFile,
    ], anvil.rpcUrl, true);
    assert.equal(stopped.status, 1);
    assert.match(stopped.stderr, /insufficient-funds/i);
    assert.equal((await records(ws.journalFile)).some(record => record.phase === 'signed'), false);

    await anvil.rpc('anvil_setBalance', [deployer.address, '0x3635c9adc5dea00000']);
    const resumed = runSync([
      'apply', '--spec', ws.specFile, '--plan', ws.planFile, '--state', ws.stateFile, '--journal', ws.journalFile,
    ], anvil.rpcUrl, true);
    assert.equal(resumed.status, 0, `${resumed.stderr}\n${resumed.stdout}`);
    assert.equal(await anvil.rpc('eth_getTransactionCount', [deployer.address, 'latest']), '0x1');
    assert.equal(await anvil.rpc('eth_getTransactionCount', [owner.address, 'latest']), '0x1');
  } finally {
    await rm(ws.directory, { recursive: true, force: true });
    await stopAnvil(anvil);
  }
});

test('a consumed signed nonce stops safely and a later run deploys once', async () => {
  const anvil = await startAnvil();
  const ws = await workspace('etherplan-cli-nonce-');
  let gate;
  try {
    const planned = runSync(['plan', '--spec', ws.specFile, '--out', ws.planFile, '--state', ws.stateFile, ...planArgs], anvil.rpcUrl);
    assert.equal(planned.status, 0, `${planned.stderr}\n${planned.stdout}`);
    gate = await signedGate(anvil.rpcUrl);
    const child = spawn(process.execPath, [
      'src/cli.mjs', 'apply', '--spec', ws.specFile, '--plan', ws.planFile, '--state', ws.stateFile, '--journal', ws.journalFile,
    ], {
      cwd: projectDirectory,
      env: { ...process.env, ETH_RPC_URL: gate.url, DEPLOYER_PRIVATE_KEYS: deployerKey, OWNER_PRIVATE_KEY: ownerKey },
      stdio: 'ignore',
    });
    await waitForSigned(ws.journalFile, child);
    assert.equal(child.kill('SIGKILL'), true);
    await new Promise(resolve => child.once('exit', resolve));
    await gate.close();
    gate = null;

    const publicClient = createPublicClient({ transport: http(anvil.rpcUrl) });
    const walletClient = createWalletClient({ account: deployer, transport: http(anvil.rpcUrl) });
    const outsideHash = await walletClient.sendTransaction({ to: owner.address, value: 0n });
    assert.equal((await publicClient.waitForTransactionReceipt({ hash: outsideHash })).status, 'success');

    const stopped = runSync([
      'apply', '--spec', ws.specFile, '--plan', ws.planFile, '--state', ws.stateFile, '--journal', ws.journalFile,
    ], anvil.rpcUrl, true);
    assert.equal(stopped.status, 1);
    assert.match(stopped.stderr, /nonce-race/i);
    assert.ok((await records(ws.journalFile)).some(record => record.phase === 'failed' && record.code === 'nonce-race'));

    const resumed = runSync([
      'apply', '--spec', ws.specFile, '--plan', ws.planFile, '--state', ws.stateFile, '--journal', ws.journalFile,
    ], anvil.rpcUrl, true);
    assert.equal(resumed.status, 0, `${resumed.stderr}\n${resumed.stdout}`);
    assert.equal(await anvil.rpc('eth_getTransactionCount', [deployer.address, 'latest']), '0x2');
    assert.equal(await anvil.rpc('eth_getTransactionCount', [owner.address, 'latest']), '0x1');
  } finally {
    await gate?.close();
    await rm(ws.directory, { recursive: true, force: true });
    await stopAnvil(anvil);
  }
});
