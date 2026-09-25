import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { keccak256, toHex } from 'viem';
import { startAnvil, stopAnvil } from './anvil.mjs';

const projectDirectory = fileURLToPath(new URL('../..', import.meta.url));
const planArgs = ['--deployers', '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', '--max-spend-wei', '100000000000000000000'];
let anvil;
let rpcUrl;
let rpc;

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function runCli(...arguments_) {
  return spawnSync(process.execPath, ['src/cli.mjs', ...arguments_], {
    cwd: projectDirectory,
    encoding: 'utf8',
    env: { ...process.env, ETH_RPC_URL: rpcUrl },
  });
}

before(async () => {
  anvil = await startAnvil();
  ({ rpc, rpcUrl } = anvil);
});

after(async () => {
  await stopAnvil(anvil);
});

test('plan is read-only, complete, and deterministic at one observation block', async () => {
  const blockBefore = await rpc('eth_blockNumber');
  const nonceBefore = await rpc('eth_getTransactionCount', ['0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', 'latest']);
  const first = runCli('plan', '--spec', 'test/fixtures/minimal-create2.json', ...planArgs);
  const second = runCli('plan', '--spec', 'test/fixtures/minimal-create2.json', ...planArgs);
  const blockAfter = await rpc('eth_blockNumber');
  const nonceAfter = await rpc('eth_getTransactionCount', ['0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', 'latest']);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stderr, '');
  assert.equal(second.stdout, first.stdout);
  assert.equal(blockAfter, blockBefore);
  assert.equal(nonceAfter, nonceBefore);

  const plan = JSON.parse(first.stdout);
  assert.equal(plan.formatVersion, 1);
  assert.equal(plan.chain.id, 31337);
  assert.match(plan.chain.genesisHash, /^0x[0-9a-f]{64}$/);
  assert.equal(typeof plan.observed.blockNumber, 'string');
  assert.match(plan.observed.blockHash, /^0x[0-9a-f]{64}$/);
  assert.match(plan.specHash, /^0x[0-9a-f]{64}$/);
  assert.match(plan.artifactHashes['contract:minimal'], /^0x[0-9a-f]{64}$/);
  assert.match(plan.planHash, /^0x[0-9a-f]{64}$/);
  assert.equal(plan.resources.length, 1);
  assert.equal(plan.resources[0].id, 'contract:minimal');
  assert.equal(plan.resources[0].action, 'deploy');
  assert.deepEqual(Object.keys(plan.resources[0].tx).sort(), ['data', 'to', 'value']);
  const { planHash, ...hashedFields } = plan;
  assert.equal(planHash, keccak256(toHex(canonicalJson(hashedFields))));
  assert.doesNotMatch(first.stdout, /private.?key|secret|ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80/i);
});

test('plan fails closed on the wrong chain', () => {
  const result = runCli('plan', '--spec', 'test/fixtures/minimal-wrong-chain.json');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /chain 31337.*requires 1/i);
  assert.equal(result.stdout, '');
});

test('plan fails closed when the canonical CREATE2 proxy has wrong code', async () => {
  const factory = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
  const originalCode = await rpc('eth_getCode', [factory, 'latest']);
  try {
    await rpc('anvil_setCode', [factory, '0x6000']);
    assert.equal(await rpc('eth_getCode', [factory, 'latest']), '0x6000');
    const result = runCli('plan', '--spec', 'test/fixtures/minimal-create2.json');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /factory|CREATE2|proxy/i);
    assert.equal(result.stdout, '');
  } finally {
    await rpc('anvil_setCode', [factory, originalCode]);
  }
});

test('plan reports an absent external and blocks its dependent contract', () => {
  const result = runCli('plan', '--spec', 'test/fixtures/minimal-absent-external.json');
  const report = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(report, /external:required/);
  assert.match(report, /contract:minimal/);
  assert.match(report, /absent|no code|conflict/i);
  assert.match(report, /blocked|dependency/i);
});
