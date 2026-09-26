import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startAnvil, stopAnvil } from './anvil.mjs';

const project = fileURLToPath(new URL('../..', import.meta.url));
const spec = path.join(project, 'test/fixtures/parallel-lab.json');
const moduleFile = path.join(project, 'test/fixtures/multi-signer-module.mjs');
const keys = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
];
const addresses = [
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
];

test('CLI plans and applies parallel deployers through a signer module with local recovery', async () => {
  const anvil = await startAnvil();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-signer-module-'));
  const planFile = path.join(directory, 'plan.json');
  const stateFile = path.join(directory, 'state.json');
  const journalFile = path.join(directory, 'journal.jsonl');
  function cli(...args) {
    return spawnSync(process.execPath, [path.join(project, 'src/cli.mjs'), ...args], {
      cwd: project, encoding: 'utf8',
      env: {
        ...process.env, ETH_RPC_URL: anvil.rpcUrl, TEST_DEPLOYER_KEYS: keys.join(','),
        DEPLOYER_PRIVATE_KEY: '', DEPLOYER_PRIVATE_KEYS: '', OWNER_PRIVATE_KEY: '',
      },
    });
  }
  try {
    const planned = cli('plan', '--spec', spec, '--out', planFile, '--state', stateFile,
      '--signer-module', moduleFile, '--parallel', '--max-spend-wei', '100000000000000000000');
    assert.equal(planned.status, 0, `${planned.stderr}\n${planned.stdout}`);
    assert.deepEqual(JSON.parse(planned.stdout).signers.deployers, addresses);
    const applied = cli('apply', '--spec', spec, '--plan', planFile, '--state', stateFile,
      '--journal', journalFile, '--signer-module', moduleFile, '--parallel');
    assert.equal(applied.status, 0, `${applied.stderr}\n${applied.stdout}`);
    assert.equal(JSON.parse(applied.stdout).transactionsSigned, 3);
    assert.equal(BigInt(await anvil.rpc('eth_getTransactionCount', [addresses[0], 'latest'])), 2n);
    assert.equal(BigInt(await anvil.rpc('eth_getTransactionCount', [addresses[1], 'latest'])), 1n);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await stopAnvil(anvil);
  }
});
