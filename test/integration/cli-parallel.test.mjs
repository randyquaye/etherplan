import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startAnvil, stopAnvil } from './anvil.mjs';

const projectDirectory = fileURLToPath(new URL('../..', import.meta.url));
const specFile = path.join(projectDirectory, 'test/fixtures/parallel-lab.json');
const primaryKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const secondaryKey = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const primary = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const secondary = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

function runCli(arguments_, rpcUrl, signed = false) {
  return spawnSync(process.execPath, ['src/cli.mjs', ...arguments_], {
    cwd: projectDirectory,
    encoding: 'utf8',
    env: {
      ...process.env,
      ETH_RPC_URL: rpcUrl,
      ...(signed ? {
        DEPLOYER_PRIVATE_KEYS: `${primaryKey},${secondaryKey}`,
        OWNER_PRIVATE_KEY: primaryKey,
      } : {}),
    },
  });
}

async function runScenario(parallel) {
  const anvil = await startAnvil(['--block-time', '1']);
  const directory = await mkdtemp(path.join(os.tmpdir(), `etherplan-cli-${parallel ? 'parallel' : 'sequential'}-`));
  const planFile = path.join(directory, 'plan.json');
  const stateFile = path.join(directory, 'state.json');
  const journalFile = path.join(directory, 'journal.jsonl');
  try {
    const planned = runCli(['plan', '--spec', specFile, '--out', planFile, '--state', stateFile], anvil.rpcUrl);
    assert.equal(planned.status, 0, `${planned.stderr}\n${planned.stdout}`);
    const started = performance.now();
    const applied = runCli([
      'apply', '--spec', specFile, '--plan', planFile, '--state', stateFile, '--journal', journalFile,
      ...(parallel ? ['--parallel'] : []),
    ], anvil.rpcUrl, true);
    const elapsedMs = performance.now() - started;
    assert.equal(applied.status, 0, `${applied.stderr}\n${applied.stdout}`);
    const result = JSON.parse(applied.stdout);
    const journal = (await readFile(journalFile, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
    const receiptBlocks = Object.fromEntries(journal
      .filter(record => record.phase === 'receipt')
      .map(record => [record.actionId, BigInt(record.receipt.blockNumber)]));
    return {
      elapsedMs,
      plan: JSON.parse(planned.stdout),
      result,
      receiptBlocks,
      primaryNonce: BigInt(await anvil.rpc('eth_getTransactionCount', [primary, 'latest'])),
      secondaryNonce: BigInt(await anvil.rpc('eth_getTransactionCount', [secondary, 'latest'])),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
    await stopAnvil(anvil);
  }
}

test('parallel CLI apply shares an independent timed block and preserves predicted addresses', async t => {
  const sequential = await runScenario(false);
  const parallel = await runScenario(true);

  const addresses = plan => Object.fromEntries(plan.resources.filter(resource => resource.kind === 'contract').map(resource => [resource.id, resource.address]));
  assert.deepEqual(addresses(parallel.plan), addresses(sequential.plan));
  assert.equal(sequential.result.transactionsSigned, 3);
  assert.equal(parallel.result.transactionsSigned, 3);
  assert.equal(sequential.primaryNonce, 3n);
  assert.equal(sequential.secondaryNonce, 0n);
  assert.equal(parallel.primaryNonce, 2n);
  assert.equal(parallel.secondaryNonce, 1n);
  assert.equal(parallel.receiptBlocks['contract:alpha'], parallel.receiptBlocks['contract:beta']);
  assert.ok(parallel.receiptBlocks['contract:gamma'] > parallel.receiptBlocks['contract:alpha']);

  const speedup = sequential.elapsedMs / parallel.elapsedMs;
  t.diagnostic(JSON.stringify({
    sequentialMs: Math.round(sequential.elapsedMs),
    parallelMs: Math.round(parallel.elapsedMs),
    sequentialTransactions: sequential.result.transactionsSigned,
    parallelTransactions: parallel.result.transactionsSigned,
    speedup: Number(speedup.toFixed(2)),
  }));
});
