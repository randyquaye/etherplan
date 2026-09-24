import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startAnvil, stopAnvil } from './anvil.mjs';

const projectDirectory = fileURLToPath(new URL('../..', import.meta.url));
const predictedAddress = '0x9b4d20e8136d023abd3f1e51ffb5f33002b30500';
const signer = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
let anvil;

function runVerify() {
  return spawnSync(process.execPath, [
    'src/cli.mjs',
    'verify',
    '--spec',
    'test/fixtures/minimal-create2.json',
  ], {
    cwd: projectDirectory,
    encoding: 'utf8',
    env: { ...process.env, ETH_RPC_URL: anvil.rpcUrl },
  });
}

before(async () => {
  anvil = await startAnvil();
});

after(async () => {
  await stopAnvil(anvil);
});

test('verify fails on absent or wrong runtime and accepts exact runtime without a write', async () => {
  const blockBefore = await anvil.rpc('eth_blockNumber');
  const nonceBefore = await anvil.rpc('eth_getTransactionCount', [signer, 'latest']);

  const absent = runVerify();
  assert.equal(absent.status, 1);
  assert.match(`${absent.stdout}\n${absent.stderr}`, /contract:minimal/);
  assert.match(`${absent.stdout}\n${absent.stderr}`, /absent|no code|deploy|conflict/i);

  await anvil.rpc('anvil_setCode', [predictedAddress, '0x6001']);
  const wrong = runVerify();
  assert.equal(wrong.status, 1);
  assert.match(`${wrong.stdout}\n${wrong.stderr}`, /contract:minimal/);
  assert.match(`${wrong.stdout}\n${wrong.stderr}`, /runtime|conflict|mismatch|differs/i);

  await anvil.rpc('anvil_setCode', [predictedAddress, '0x6000']);
  const exact = runVerify();
  assert.equal(exact.status, 0, exact.stderr);
  assert.match(exact.stdout, /contract:minimal/);
  assert.match(exact.stdout, /verified|reuse|exact/i);

  assert.equal(await anvil.rpc('eth_blockNumber'), blockBefore);
  assert.equal(await anvil.rpc('eth_getTransactionCount', [signer, 'latest']), nonceBefore);
});
