import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { keccak256, toBytes } from 'viem';
import { normalizeArtifact } from '../src/artifacts.ts';
import { applyPlan } from '../src/execution/index.ts';
import { createPlan } from '../src/planning/index.ts';
import { deployerA, owner, startAnvil } from './execution/chain.ts';

const ADDRESS = '0x00000000000000000000000000000000000000a1';
const selector = (signature) => keccak256(toBytes(signature)).slice(2, 10);

// Two independent setters; setB also resets a. setBKeep is the compatible control.
function dualRuntime() {
  const methods = [
    ['a()', '5060005460005260206000f3'],
    ['b()', '5060015460005260206000f3'],
    ['setA(uint256)', '5060043560005500'],
    ['setB(uint256)', '50600435600155600060005500'],
    ['setBKeep(uint256)', '5060043560015500'],
  ];
  const prefix = '60003560e01c';
  const dispatch = methods.map(([signature]) => `8063${selector(signature)}1460xx57`).join('');
  const fallback = '600080fd';
  let offset = (prefix.length + dispatch.length + fallback.length) / 2;
  const destinations = methods.map(([, body]) => {
    const destination = offset;
    offset += (2 + body.length) / 2;
    return destination.toString(16).padStart(2, '0');
  });
  let index = 0;
  const resolved = dispatch.replaceAll('xx', () => destinations[index++]);
  return `0x${prefix}${resolved}${fallback}${methods.map(([, body]) => `5b${body}`).join('')}`;
}

const ABI = [
  ...['a', 'b'].map((name) => ({
    type: 'function',
    name,
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  })),
  ...['setA', 'setB', 'setBKeep'].map((name) => ({
    type: 'function',
    name,
    stateMutability: 'nonpayable',
    inputs: [{ name: 'value', type: 'uint256' }],
    outputs: [],
  })),
];

async function setup(chain, { second = 'setB', external = false } = {}) {
  const runtime = dualRuntime();
  await chain.rpc('anvil_setCode', [ADDRESS, runtime]);
  const artifact = normalizeArtifact(
    {
      abi: ABI,
      bytecode: { object: '0x00', linkReferences: {} },
      deployedBytecode: { object: runtime, linkReferences: {}, immutableReferences: {} },
    },
    'Dual',
  );
  const spec = {
    schema: 2,
    chainId: 31337,
    contracts: [
      { id: 'dual', artifact: 'Dual.json', address: ADDRESS, codeHash: keccak256(runtime) },
    ],
    ...(external
      ? {
          externals: {
            baseline: {
              address: ADDRESS,
              codeHash: keccak256(runtime),
              abi: ABI,
              checks: { a: '0' },
            },
          },
        }
      : {}),
    calls: [
      {
        id: 'setA',
        target: 'dual',
        method: 'setA',
        args: ['1'],
        check: { function: 'a', equals: '1' },
        before: { equals: '0' },
      },
      ...(!external
        ? [
            {
              id: 'setB',
              target: 'dual',
              method: second,
              args: ['1'],
              check: { function: 'b', equals: '1' },
              before: { equals: '0' },
            },
          ]
        : []),
    ],
  };
  const artifacts = new Map([['dual', artifact]]);
  const plan = await createPlan({
    spec,
    artifacts,
    client: chain.client,
    signers: { deployers: [deployerA.address], owner: owner.address },
    maxSpendWei: '100000000000000000000',
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'etherplan-postconditions-'));
  return {
    plan,
    spec,
    artifacts,
    client: chain.client,
    signers: { deployer: [deployerA], owner },
    stateFile: path.join(dir, 'state.json'),
    journalFile: path.join(dir, 'journal.jsonl'),
    pollIntervalMs: 10,
  };
}

async function records(file) {
  return (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
}

test('a later setter invalidating an earlier getter prevents success and stale state', async () => {
  const chain = await startAnvil();
  try {
    const input = await setup(chain);
    assert.deepEqual(input.plan.executionWaves.waves, [['call:setA', 'call:setB']]);
    await assert.rejects(applyPlan(input), (error) => {
      assert.equal(error.code, 'postcondition');
      assert.equal(error.actionId, 'call:setA');
      assert.equal(error.result?.status, 'stopped');
      return true;
    });
    assert.equal(
      await chain.client.readContract({ address: ADDRESS, abi: ABI, functionName: 'a' }),
      0n,
    );
    assert.equal(
      await chain.client.readContract({ address: ADDRESS, abi: ABI, functionName: 'b' }),
      1n,
    );
    assert.equal(
      (await records(input.journalFile)).filter((record) => record.phase === 'verified').length,
      2,
    );
    await assert.rejects(readFile(input.stateFile, 'utf8'), { code: 'ENOENT' });
  } finally {
    await chain.stop();
  }
});

test('compatible setters pass final verification and persist both values', async () => {
  const chain = await startAnvil();
  try {
    const input = await setup(chain, { second: 'setBKeep' });
    const result = await applyPlan(input);
    assert.equal(result.status, 'applied');
    const state = JSON.parse(await readFile(input.stateFile, 'utf8'));
    assert.ok(state.resources['call:setA']);
    assert.ok(state.resources['call:setB']);
    assert.equal(
      await chain.client.readContract({ address: ADDRESS, abi: ABI, functionName: 'a' }),
      1n,
    );
    assert.equal(
      await chain.client.readContract({ address: ADDRESS, abi: ABI, functionName: 'b' }),
      1n,
    );
  } finally {
    await chain.stop();
  }
});

test('final verification includes a reused external getter changed by a planned call', async () => {
  const chain = await startAnvil();
  try {
    const input = await setup(chain, { external: true });
    await assert.rejects(applyPlan(input), (error) => {
      assert.equal(error.code, 'postcondition');
      assert.equal(error.actionId, 'external:baseline');
      return true;
    });
    await assert.rejects(readFile(input.stateFile, 'utf8'), { code: 'ENOENT' });
  } finally {
    await chain.stop();
  }
});
