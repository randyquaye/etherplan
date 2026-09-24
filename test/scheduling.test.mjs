import assert from 'node:assert/strict';
import test from 'node:test';
import { createSchedule } from '../src/scheduling/index.mjs';

const D0 = '0x00000000000000000000000000000000000000d0';
const D1 = '0x00000000000000000000000000000000000000d1';
const OWNER = '0x00000000000000000000000000000000000000ee';
const PROXY = { address: '0x4e59b44847b379578588920cA78FbF26c0B4956C', codeHash: '0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989' };

function deploy(id, dependencies = [], extra = {}) {
  return { id: `contract:${id}`, kind: 'contract', dependencies, address: `0x${id.padStart(40, '0')}`, action: 'deploy', signerRole: 'deployer', senderIndependent: true, factory: PROXY, ...extra };
}

function call(id, dependencies, extra = {}) {
  return { id: `call:${id}`, kind: 'call', dependencies, address: '0x0000000000000000000000000000000000000abc', action: 'call', signerRole: 'owner', ...extra };
}

const lanes = schedule => schedule.waves.map(wave => wave.batches.map(batch => batch.map(entry => [entry.id, entry.signer])));

test('independent pooled deploys share a wave, one transaction per signer per batch, and dependents wait', () => {
  const plan = { resources: [deploy('a'), deploy('b'), deploy('c'), deploy('d', ['contract:a']), call('bind', ['contract:c', 'contract:d'])] };
  const schedule = createSchedule(plan, [D0, D1], { owner: OWNER });
  assert.deepEqual(lanes(schedule), [
    [[['contract:a', D0], ['contract:b', D1]], [['contract:c', D0]]],
    [[['contract:d', D0]]],
    [[['call:bind', OWNER]]],
  ]);
  assert.deepEqual(schedule.ownerActions, [{ id: 'call:bind', action: 'call', wave: 3, signer: OWNER }]);
  assert.deepEqual(schedule.deferred, []);
  assert.deepEqual(schedule.lanes.map(lane => [lane.address, lane.roles, lane.actions]), [[D0, ['deployer'], 3], [D1, ['deployer'], 1], [OWNER, ['owner'], 1]]);
});

test('sender-dependent deploys and non-permissionless factories stay on the primary deployer', () => {
  const plan = { resources: [
    deploy('a', [], { senderIndependent: false }),
    deploy('b', [], { factory: { ...PROXY, codeHash: `0x${'12'.repeat(32)}` } }),
    deploy('c'),
  ] };
  const schedule = createSchedule(plan, [D0, D1], { owner: OWNER });
  assert.deepEqual(lanes(schedule), [[[['contract:a', D0], ['contract:c', D1]], [['contract:b', D0]]]]);
  assert.equal(schedule.waves[0].batches.flat().find(entry => entry.id === 'contract:c').pooled, true);
  assert.equal(schedule.waves[0].batches.flat().find(entry => entry.id === 'contract:a').pooled, false);
});

test('sequential scheduling puts one action in each batch on the primary deployer', () => {
  const plan = { resources: [deploy('a'), deploy('b'), call('bind', ['contract:a'])] };
  const schedule = createSchedule(plan, [D0, D1], { owner: OWNER, parallel: false });
  assert.deepEqual(lanes(schedule), [[[['contract:a', D0]], [['contract:b', D0]]], [[['call:bind', OWNER]]]]);
});

test('an owner who is also a deployer never gets two transactions in one batch', () => {
  const plan = { resources: [deploy('a'), deploy('b', [], { senderIndependent: false }), call('bind', [])] };
  const schedule = createSchedule(plan, [D0], { owner: D0 });
  for (const batch of schedule.waves.flatMap(wave => wave.batches)) assert.equal(new Set(batch.map(entry => entry.signer)).size, batch.length);
  assert.equal(schedule.waves[0].batches.length, 3);
});

test('reused resources satisfy dependencies and unsatisfiable dependencies are deferred', () => {
  const plan = { resources: [
    { ...deploy('a'), action: 'reuse' },
    deploy('b', ['contract:a']),
    deploy('c', ['contract:missing']),
  ] };
  const schedule = createSchedule(plan, [D0]);
  assert.deepEqual(lanes(schedule), [[[['contract:b', D0]]]]);
  assert.deepEqual(schedule.deferred, [{ id: 'contract:c', waitingFor: ['contract:missing'] }]);
});

test('schedule input errors fail before any assignment', () => {
  const plan = { resources: [deploy('a')] };
  assert.throws(() => createSchedule(plan, [D0, D0.toUpperCase().replace('0X', '0x')]), /distinct/);
  assert.throws(() => createSchedule(plan, []), /at least one deployer/);
  assert.throws(() => createSchedule(plan, ['0x1234']), /Ethereum address/);
  assert.throws(() => createSchedule({ resources: [{ ...deploy('a'), action: 'conflict' }] }, [D0]), /conflict or unverified/);
  assert.throws(() => createSchedule({ resources: [{ ...deploy('a'), action: 'unverified' }] }, [D0]), /conflict or unverified/);
  assert.throws(() => createSchedule({ resources: [deploy('a', [], { signerRole: 'guardian' })] }, [D0]), /no lane/);
});
