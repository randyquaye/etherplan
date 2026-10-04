import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { main } from '../src/cli/main.ts';
import { acquireLeases, deploymentScope } from '../src/execution/backends.ts';
import { applyPlan } from '../src/execution/index.ts';
import { safeExternalError } from '../src/execution/rpc-error.ts';
import { createSignerServiceProvider } from '../src/execution/signer-service.ts';
import { createPlan } from '../src/planning/index.ts';
import { deployerA, fixtureMany, startAnvil } from './execution/chain.ts';
import { memoryBackend } from './execution/memory-backend.ts';
import { prepareJsonProject } from './project-cli.mjs';

const urlSecret = 'SENTINEL_SIGNER_URL_SECRET';
const responseSecret = 'SENTINEL_SIGNER_RESPONSE_SECRET';

test('signer service rejects credential URLs without echoing them to the CLI', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-signer-url-'));
  const oldArgv = process.argv;
  const oldCwd = process.cwd();
  const oldRpcUrl = process.env.ETH_RPC_URL;
  const oldError = console.error;
  const output: string[] = [];
  try {
    assert.throws(
      () => createSignerServiceProvider({ url: `https://user:${urlSecret}@example.invalid/` }),
      (error) =>
        error instanceof Error &&
        !error.message.includes(urlSecret) &&
        /cannot contain credentials/.test(error.message),
    );
    const signerModule = path.join(directory, 'signer.mjs');
    const source = pathToFileURL(path.resolve('src/execution/signer-service.ts')).href;
    await writeFile(
      signerModule,
      `import { createSignerServiceProvider } from ${JSON.stringify(source)};\nexport default createSignerServiceProvider({ url: ${JSON.stringify(`https://user:${urlSecret}@example.invalid/`)} });\n`,
    );
    const specFile = path.resolve('test/fixtures/minimal-create2.json');
    process.chdir(prepareJsonProject(specFile));
    process.argv = [
      'node',
      'etherplan',
      'plan',
      '--signer-module',
      signerModule,
      '--state',
      path.join(directory, 'state.json'),
      '--max-spend-wei',
      '1000000',
      '--out',
      '-',
    ];
    process.env.ETH_RPC_URL = 'http://127.0.0.1:1';
    console.error = (...values) => {
      output.push(values.join(' '));
    };
    await main();
    assert.equal(process.exitCode, 1);
    assert.ok(
      output.some((line) => line.includes('Signer service URL cannot contain credentials')),
    );
    assert.ok(!JSON.stringify(output).includes(urlSecret));

    output.length = 0;
    const customModule = path.join(directory, 'custom-signer.mjs');
    await writeFile(
      customModule,
      `export default { address() { throw new Error(${JSON.stringify(urlSecret)}); }, signTransaction() {} };\n`,
    );
    process.argv = process.argv.map((value) => (value === signerModule ? customModule : value));
    await main();
    assert.equal(process.exitCode, 1);
    assert.ok(
      output.some((line) =>
        line.includes('Signer address request failed: External operation failed.'),
      ),
    );
    assert.ok(!JSON.stringify(output).includes(urlSecret));
  } finally {
    process.argv = oldArgv;
    process.chdir(oldCwd);
    if (oldRpcUrl === undefined) delete process.env.ETH_RPC_URL;
    else process.env.ETH_RPC_URL = oldRpcUrl;
    console.error = oldError;
    process.exitCode = 0;
    await rm(directory, { recursive: true, force: true });
  }
});

test('malformed signer response cannot enter production journal, result, or reporter events', async () => {
  const chain = await startAnvil();
  try {
    const input = fixtureMany(1);
    const plan = await createPlan({
      ...input,
      client: chain.client,
      signers: { deployers: [deployerA.address], parallel: false },
      maxSpendWei: '100000000000000000000',
    });
    const scope = deploymentScope(
      { project: 'signer-redaction', environment: 'test', label: 'remote' },
      plan.chain,
    );
    const backend = memoryBackend(scope);
    const addressFailure = await applyPlan({
      ...input,
      plan,
      client: chain.client,
      ...backend,
      scope,
      confirmations: 1,
      signerProvider: {
        address() {
          throw new Error(responseSecret);
        },
        signTransaction() {
          throw new Error('unreachable');
        },
      },
    }).then(
      () => null,
      (error) => error,
    );
    assert.equal(addressFailure?.code, 'signer');
    assert.ok(!addressFailure.message.includes(responseSecret));
    assert.equal(backend.records.length, 0);
    const signerProvider = createSignerServiceProvider({
      url: 'https://signer.example.invalid/',
      fetchImpl: async (request) =>
        new Response(
          request.toString().includes('/address?')
            ? JSON.stringify({ address: deployerA.address })
            : responseSecret,
          { status: 200 },
        ),
    });
    const events: unknown[] = [];
    const failure = await applyPlan({
      ...input,
      plan,
      client: chain.client,
      ...backend,
      scope,
      confirmations: 1,
      signerProvider,
      reporter: (event) => {
        events.push(event);
      },
    }).then(
      () => null,
      (error) => error,
    );
    assert.equal(failure?.code, 'signer');
    assert.equal(failure?.message, 'contract:holder00: External operation failed.');
    assert.deepEqual(
      backend.records.map((record) => record.phase),
      ['intent', 'failed'],
    );
    assert.equal(backend.records[1].reason, 'External operation failed.');
    assert.equal(await chain.client.getTransactionCount({ address: deployerA.address }), 0);
    for (const visible of [failure.message, failure.result, backend.records, events]) {
      assert.ok(
        !JSON.stringify(visible).includes(responseSecret),
        'Signer response escaped into durable or visible output',
      );
    }
  } finally {
    await chain.stop();
  }
});

test('lease renewal errors cannot expose provider text through apply diagnostics', async () => {
  const scope = deploymentScope(
    { project: 'signer-redaction', environment: 'test', label: 'lease' },
    { id: 31337, genesisHash: `0x${'aa'.repeat(32)}` },
  );
  const reports: string[] = [];
  const leases = await acquireLeases({
    scope,
    addresses: [deployerA.address],
    planHash: `0x${'bb'.repeat(32)}`,
    ttlMs: 3_000,
    lockProvider: {
      async acquire() {
        return {
          fencingToken: 1,
          async renew() {
            throw new Error(responseSecret);
          },
          async assertHeld() {},
          async release() {},
        };
      },
    },
    onRenewFailure: (event) => {
      reports.push(safeExternalError(event.error));
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await assert.rejects(
      leases.assertHeld(),
      (error) =>
        error instanceof Error &&
        error.message === 'Writer lease renewal failed.' &&
        !error.message.includes(responseSecret),
    );
    assert.deepEqual(reports, ['External operation failed.']);
  } finally {
    await leases.release();
  }
});
