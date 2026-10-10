import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApplyProgress } from '../src/cli/progress.ts';
import { createAwsBackend } from '../src/execution/aws.ts';
import { acquireLeases, deploymentScope } from '../src/execution/backends.ts';
import { classifyLeaseFailure, safeLeaseMessage } from '../src/execution/rpc-error.ts';

const chainIdentity = { id: 31337, genesisHash: `0x${'aa'.repeat(32)}` };
const scope = deploymentScope(
  { project: 'lease', environment: 'test', label: 'renewal' },
  chainIdentity,
);
const planHash = `0x${'bb'.repeat(32)}`;
const address = `0x${'11'.repeat(20)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Two leases (deployment and signer) share one renew implementation; `attempt` counts calls. */
function fakeProvider(renew) {
  let renewals = 0;
  return {
    renewals: () => renewals,
    lockProvider: {
      async acquire() {
        return {
          fencingToken: 1,
          async renew() {
            renewals++;
            await renew(renewals);
          },
          async assertHeld() {},
          async release() {},
        };
      },
    },
  };
}

test('a transient renewal failure is retried and the lease stays valid', async () => {
  const fake = fakeProvider(async (attempt) => {
    if (attempt === 1) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  });
  const events = [];
  const leases = await acquireLeases({
    lockProvider: fake.lockProvider,
    scope,
    addresses: [address],
    planHash,
    ttlMs: 3_000,
    onRenew: () => events.push('renewed'),
    onRenewFailure: (event) => events.push(`${event.failure}:${event.fatal}`),
  });
  try {
    await sleep(2_300);
    await leases.assertHeld();
    assert.deepEqual(events, ['network:false', 'renewed']);
    // Past the original deadline, but the renewal at two seconds extended the lease.
    await sleep(1_200);
    await leases.assertHeld();
  } finally {
    await leases.release();
  }
});

test('a lost lease stops renewal at once with a fixed message', async () => {
  const fake = fakeProvider(async () => {
    throw Object.assign(new Error('token mismatch at table secret-name'), { code: 'lease-lost' });
  });
  const events = [];
  const leases = await acquireLeases({
    lockProvider: fake.lockProvider,
    scope,
    addresses: [address],
    planHash,
    ttlMs: 3_000,
    onRenewFailure: (event) => events.push(`${event.failure}:${event.fatal}`),
  });
  try {
    await sleep(1_200);
    await assert.rejects(
      leases.assertHeld(),
      (error) =>
        error instanceof Error &&
        error.message === 'Writer lease is no longer held.' &&
        error.code === 'lease-lost',
    );
    const renewals = fake.renewals();
    await sleep(1_100);
    assert.equal(fake.renewals(), renewals, 'renewal stops after a lost lease');
    assert.deepEqual(events, ['lease-lost:true']);
  } finally {
    await leases.release();
  }
});

test('an expired lease fails locally even before the next renewal tick', async () => {
  const fake = fakeProvider(async () => {
    throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  });
  const events = [];
  const leases = await acquireLeases({
    lockProvider: fake.lockProvider,
    scope,
    addresses: [address],
    planHash,
    ttlMs: 3_000,
    onRenewFailure: (event) => events.push(`${event.failure}:${event.fatal}`),
  });
  try {
    await sleep(1_200);
    await leases.assertHeld();
    assert.deepEqual(events, ['timeout:false']);
    await sleep(2_300);
    await assert.rejects(
      leases.assertHeld(),
      (error) =>
        error instanceof Error &&
        error.message === 'Writer lease expired before a renewal succeeded.' &&
        error.code === 'lease-expired',
    );
    assert.equal(events.at(-1), 'lease-expired:true');
  } finally {
    await leases.release();
  }
});

test('renewal failures classify into fixed diagnostics without provider text', () => {
  const secret = 'https://user:password@dynamodb.example/table';
  assert.equal(
    classifyLeaseFailure(Object.assign(new Error(secret), { name: 'TimeoutError' })),
    'timeout',
  );
  assert.equal(
    classifyLeaseFailure(
      new Error(secret, { cause: Object.assign(new Error(secret), { code: 'ECONNRESET' }) }),
    ),
    'network',
  );
  assert.equal(
    classifyLeaseFailure(
      Object.assign(new Error(secret), { name: 'ProvisionedThroughputExceededException' }),
    ),
    'throttled',
  );
  assert.equal(classifyLeaseFailure(new Error(secret)), 'request-failed');
  assert.equal(classifyLeaseFailure(secret), 'request-failed');
  for (const failure of [
    'lease-lost',
    'lease-expired',
    'timeout',
    'network',
    'throttled',
    'request-failed',
  ])
    assert.ok(!safeLeaseMessage(failure).includes(secret));
});

test('the AWS lock provider marks only a conditional renewal failure as lost', async () => {
  let renewals = 0;
  const backend = createAwsBackend({
    tableName: 'test',
    kmsKeyId: 'test',
    kms: {},
    s3: {},
    dynamodb: {
      async send(command) {
        assert.equal(command.constructor.name, 'UpdateCommand');
        if (command.input.UpdateExpression.includes('if_not_exists'))
          return { Attributes: { token: 7 } };
        renewals++;
        if (renewals === 1)
          throw Object.assign(new Error('The conditional request failed'), {
            name: 'ConditionalCheckFailedException',
          });
        throw Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
      },
    },
  });
  const lease = await backend.lockProvider.acquire(
    { ...scope, kind: 'deployment' },
    {
      id: 'holder',
      principal: 'runner',
      host: 'host',
      pid: 1,
      planHash,
      acquiredAt: new Date().toISOString(),
    },
    3_000,
  );
  assert.equal(lease.fencingToken, 7);
  await assert.rejects(
    lease.renew(),
    (error) => error.code === 'lease-lost' && error.message === 'Writer lease is no longer held.',
  );
  await assert.rejects(
    lease.renew(),
    (error) => error.code === undefined && error.name === 'TimeoutError',
  );
});

test('CLI progress reports lease renewal problems and recovery', () => {
  const lines = [];
  const output = {
    write(chunk) {
      lines.push(String(chunk).trimEnd());
      return true;
    },
  };
  const progress = createApplyProgress({ planHash, chain: chainIdentity, resources: [] }, output);
  const base = { at: new Date().toISOString(), planHash, chain: chainIdentity, scope };
  progress.reporter({ ...base, type: 'lock-renewal' });
  progress.reporter({ ...base, type: 'lock-renewal-failure', reason: 'timeout', fatal: false });
  progress.reporter({ ...base, type: 'lock-renewal' });
  progress.reporter({ ...base, type: 'lock-renewal-failure', reason: 'lease-lost', fatal: true });
  assert.deepEqual(lines, [
    'Writer lease renewal failed (timeout); retrying while the lease is valid...',
    'Writer lease renewed.',
    'Writer lease is no longer held. Stopping before the next write.',
  ]);
});
