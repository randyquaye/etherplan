import assert from 'node:assert/strict';
import test from 'node:test';
import { createSchedule } from '../src/scheduling/index.mjs';

const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';
const OWNER = '0x00000000000000000000000000000000000000c3';
const FACTORY = { codeHash: '0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989' };

function deploy(index, dependencies = [], extra = {}) {
  return { id: `contract:${index}`, kind: 'contract', action: 'deploy', dependencies,
    signerRole: 'deployer', senderIndependent: true, factory: FACTORY, address: A, ...extra };
}

function schedule(resources, deployers = [A], owner = OWNER) {
  return createSchedule({ resources }, deployers, { owner, parallel: deployers.length > 1, pipeline: true });
}

test('P-01/P-05: one signer gets consecutive saved offsets; dependent and reused resources do not consume them', () => {
  const resources = [deploy('a'), { ...deploy('reused'), action: 'reuse' }, deploy('b'),
    deploy('c', ['contract:a']), deploy('d', ['contract:reused'])];
  const result = schedule(resources);
  assert.deepEqual(result.waves.map(wave => wave.signerGroups[0].actions), [
    [{ id: 'contract:a', nonceOffset: 0 }, { id: 'contract:b', nonceOffset: 1 }, { id: 'contract:d', nonceOffset: 2 }],
    [{ id: 'contract:c', nonceOffset: 0 }],
  ]);
  assert.ok(result.waves.every(wave => wave.receiptBarrier));
});

test('P-03/P-04: each signer has its own offsets, including when owner and deployer are the same address', () => {
  const resources = [deploy('a'), deploy('b'), deploy('c'),
    deploy('pinned', [], { senderIndependent: false }),
    { id: 'call:bind', kind: 'call', action: 'call', dependencies: [], signerRole: 'owner', address: A }];
  const split = schedule(resources, [A, B]);
  assert.deepEqual(split.waves[0].signerGroups.map(group => [group.signer, group.actions.map(action => action.nonceOffset)]),
    [[A, [0, 1, 2]], [B, [0]], [OWNER, [0]]]);
  assert.equal(split.waves[0].batches[0].find(entry => entry.id === 'contract:pinned').signer, A);

  const shared = schedule(resources, [A], A);
  assert.deepEqual(shared.waves[0].signerGroups.map(group => [group.signer, group.actions.map(action => action.nonceOffset)]),
    [[A, [0, 1, 2, 3, 4]]]);
});

test('P-02: object key insertion order and signer casing do not change action offsets', () => {
  const resources = [deploy('a'), deploy('b'), deploy('c')];
  const expected = schedule(resources, [A.toUpperCase().replace('0X', '0x')], null).waves;
  for (let i = 0; i < 20; i++) {
    const reordered = resources.map(resource => Object.fromEntries(Object.entries(resource).reverse()));
    assert.deepEqual(schedule(reordered, [A], null).waves, expected);
  }
});
