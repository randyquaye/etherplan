import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPublicClient, http } from 'viem';
import { loadArtifacts } from '../src/artifacts.ts';
import { main } from '../src/cli/main.ts';
import { deploymentScope, openStoredJournal } from '../src/execution/backends.ts';
import { applyPlan } from '../src/execution/index.ts';
import { broadcast } from '../src/execution/transactions.ts';
import { createPlan } from '../src/planning/index.ts';
import { loadSpec } from '../src/input/project.ts';
import { TEST_KEYS, deployerA, fixtureMany, startAnvil } from './execution/chain.ts';
import { memoryBackend } from './execution/memory-backend.ts';
import { prepareJsonProject } from './project-cli.mjs';

const sentinel = 'rpc-secret-sentinel-7349';

async function rejectingRpc(upstream, method = 'eth_sendRawTransaction') {
  let rejected = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    if (rpc.method === method) {
      rejected++;
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          error: { code: -32000, message: `Rejected with credential ${sentinel}` },
        }),
      );
      return;
    }
    const response = await fetch(upstream, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    res.statusCode = response.status;
    res.end(await response.text());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/?api_key=${sentinel}`;
  return {
    url,
    client: createPublicClient({ transport: http(url) }),
    get rejected() {
      return rejected;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function localFiles() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-rpc-redaction-'));
  return {
    directory,
    stateFile: path.join(directory, 'state.json'),
    journalFile: path.join(directory, 'journal.jsonl'),
  };
}

async function records(file) {
  return (await readFile(file, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function clean(value) {
  assert.ok(
    !JSON.stringify(value).includes(sentinel),
    'RPC credential entered a durable or visible value',
  );
}

async function planned(chain, pipeline = false) {
  const input = fixtureMany(1);
  const plan = await createPlan({
    ...input,
    client: chain.client,
    ...(pipeline
      ? { pipeline: { deployers: [deployerA.address], parallel: false } }
      : { signers: { deployers: [deployerA.address], parallel: false } }),
    maxSpendWei: '100000000000000000000',
  });
  return { ...input, plan };
}

test('serial and pipeline broadcast rejections retain recoverable signatures without exposing RPC credentials', async () => {
  for (const pipeline of [false, true]) {
    const chain = await startAnvil();
    const proxy = await rejectingRpc(chain.url);
    const files = await localFiles();
    try {
      const input = await planned(chain, pipeline);
      const events = [];
      const failure = await applyPlan({
        ...input,
        client: proxy.client,
        signers: { deployer: [deployerA] },
        stateFile: files.stateFile,
        journalFile: files.journalFile,
        pipeline,
        pollIntervalMs: 20,
        receiptTimeoutMs: 180,
        reporter: (event) => {
          events.push(event);
        },
      }).then(
        () => null,
        (error) => error,
      );
      assert.equal(failure?.code, 'broadcast-failed');
      assert.equal(failure.retryable, true);
      clean(failure.message);
      clean(failure.result);
      clean(events);
      const journal = await records(files.journalFile);
      clean(journal);
      assert.equal(journal.filter((record) => record.phase === 'signed').length, 1);
      assert.equal(journal.filter((record) => record.phase === 'intent').length, 1);
      assert.ok(journal.some((record) => record.phase === 'broadcast-attempt'));
      assert.equal(
        journal.some((record) => record.phase === 'receipt'),
        false,
      );
      assert.ok(proxy.rejected >= (pipeline ? 2 : 1));
      if (pipeline) {
        const attempts = journal.filter((record) => record.phase === 'broadcast-attempt');
        assert.ok(
          attempts.every(
            (record) =>
              record.error === 'RPC broadcast request failed.' &&
              record.transactionHash ===
                journal.find((item) => item.phase === 'signed').transactionHash,
          ),
        );
      }
    } finally {
      await proxy.close();
      await chain.stop();
      await rm(files.directory, { recursive: true, force: true });
    }
  }
});

test('encrypted production journal stores no credential in clear fields or decoded records', async () => {
  const chain = await startAnvil();
  const proxy = await rejectingRpc(chain.url);
  try {
    const input = await planned(chain);
    const scope = deploymentScope(
      { project: 'redaction', environment: 'test', label: 'remote' },
      input.plan.chain,
    );
    const backend = memoryBackend(scope);
    const events = [];
    const failure = await applyPlan({
      ...input,
      client: proxy.client,
      ...backend,
      scope,
      confirmations: 1,
      signers: { deployer: [deployerA] },
      principal: 'test-runner',
      reporter: (event) => {
        events.push(event);
      },
    }).then(
      () => null,
      (error) => error,
    );
    assert.equal(failure?.code, 'broadcast-failed');
    clean(failure.message);
    clean(failure.result);
    clean(backend.records);
    clean(events);
    const journal = await openStoredJournal({
      ...backend,
      scope,
      fence: [],
      assertHeld: async () => {},
    });
    clean(journal.records);
    assert.equal(journal.records.filter((record) => record.phase === 'signed').length, 1);
    assert.ok(backend.records.find((record) => record.phase === 'signed').encryptedRawTransaction);
  } finally {
    await proxy.close();
    await chain.stop();
  }
});

test('estimation errors with arbitrary response text stay out of journal, summary and CLI output', async () => {
  const chain = await startAnvil();
  const proxy = await rejectingRpc(chain.url, 'eth_estimateGas');
  const files = await localFiles();
  try {
    const input = await planned(chain);
    const failure = await applyPlan({
      ...input,
      client: proxy.client,
      signers: { deployer: [deployerA] },
      stateFile: files.stateFile,
      journalFile: files.journalFile,
    }).then(
      () => null,
      (error) => error,
    );
    assert.equal(failure?.code, 'estimate-failed');
    clean(failure.message);
    clean(failure.result);
    const journal = await records(files.journalFile);
    clean(journal);
    assert.equal(
      journal.some((record) => record.phase === 'intent'),
      false,
    );
    assert.equal(
      journal.find((record) => record.phase === 'failed')?.reason,
      'RPC gas estimation failed.',
    );

    const specFile = path.join(files.directory, 'spec.json');
    const artifactFile = path.join(files.directory, 'Holder.json');
    const cliSpec = structuredClone(input.spec);
    await writeFile(artifactFile, JSON.stringify(input.artifacts.get('holder00')));
    await writeFile(specFile, JSON.stringify(cliSpec));
    prepareJsonProject(specFile);
    const mainFile = path.join(files.directory, 'main.ethp');
    const compiledSpec = await loadSpec(mainFile);
    const cliArtifacts = await loadArtifacts(compiledSpec, mainFile);
    const cliPlan = await createPlan({
      spec: compiledSpec,
      artifacts: cliArtifacts,
      client: chain.client,
      signers: { deployers: [deployerA.address], parallel: false },
      maxSpendWei: '100000000000000000000',
    });
    const planFile = path.join(files.directory, 'plan.json');
    await writeFile(planFile, JSON.stringify(cliPlan));
    const oldArgv = process.argv;
    const oldCwd = process.cwd();
    const oldUrl = process.env.ETH_RPC_URL;
    const oldKey = process.env.DEPLOYER_PRIVATE_KEYS;
    const oldLog = console.log;
    const oldError = console.error;
    const output = [];
    const planProxy = await rejectingRpc(chain.url, 'eth_chainId');
    const broadcastProxy = await rejectingRpc(chain.url);
    try {
      process.chdir(files.directory);
      process.argv = [
        'node',
        'etherplan',
        'apply',
        '--plan',
        planFile,
        '--state',
        path.join(files.directory, 'cli-state.json'),
        '--journal',
        path.join(files.directory, 'cli-journal.jsonl'),
      ];
      process.env.ETH_RPC_URL = proxy.url;
      process.env.DEPLOYER_PRIVATE_KEYS = TEST_KEYS[0];
      console.log = (...values) => {
        output.push(values.join(' '));
      };
      console.error = (...values) => {
        output.push(values.join(' '));
      };
      await main();
      clean(output);
      clean(await records(path.join(files.directory, 'cli-journal.jsonl')));
      assert.equal(process.exitCode, 1);

      output.length = 0;
      const broadcastJournal = path.join(files.directory, 'cli-broadcast.jsonl');
      process.argv = [
        'node',
        'etherplan',
        'apply',
        '--plan',
        planFile,
        '--state',
        path.join(files.directory, 'cli-broadcast-state.json'),
        '--journal',
        broadcastJournal,
      ];
      process.env.ETH_RPC_URL = broadcastProxy.url;
      await main();
      assert.equal(process.exitCode, 1);
      clean(output);
      const broadcastRecords = await records(broadcastJournal);
      clean(broadcastRecords);
      assert.equal(broadcastRecords.filter((record) => record.phase === 'signed').length, 1);

      output.length = 0;
      process.argv = [
        'node',
        'etherplan',
        'plan',
        '--out',
        '-',
        '--deployers',
        deployerA.address,
        '--max-spend-wei',
        '100000000000000000000',
      ];
      process.env.ETH_RPC_URL = planProxy.url;
      await main();
      assert.equal(process.exitCode, 1);
      assert.ok(output.some((line) => line.includes('RPC request failed.')));
      clean(output);
    } finally {
      await planProxy.close();
      await broadcastProxy.close();
      process.argv = oldArgv;
      process.chdir(oldCwd);
      if (oldUrl === undefined) delete process.env.ETH_RPC_URL;
      else process.env.ETH_RPC_URL = oldUrl;
      if (oldKey === undefined) delete process.env.DEPLOYER_PRIVATE_KEYS;
      else process.env.DEPLOYER_PRIVATE_KEYS = oldKey;
      console.log = oldLog;
      console.error = oldError;
      process.exitCode = 0;
    }
  } finally {
    await proxy.close();
    await chain.stop();
    await rm(files.directory, { recursive: true, force: true });
  }
});

test('known, nonce-too-low, underpriced and arbitrary nested RPC errors keep their recovery branches', async () => {
  const cases = [
    ['already known', { accepted: true, known: true }],
    ['transaction already imported', { accepted: true, known: true }],
    [
      'nonce too low',
      { accepted: false, nonceTooLow: true, error: 'Transaction nonce is too low.' },
    ],
    [
      'replacement transaction underpriced',
      {
        accepted: false,
        replacementUnderpriced: true,
        error: 'Replacement transaction is underpriced.',
      },
    ],
    ['other rejection', { accepted: false, error: 'RPC broadcast request failed.' }],
  ];
  for (const [message, expected] of cases) {
    const client = {
      async request() {
        throw {
          details: sentinel,
          shortMessage: message,
          cause: { message: `header ${sentinel}` },
        };
      },
    };
    const outcome = await broadcast(client, '0x02');
    assert.deepEqual(outcome, expected);
    clean(outcome);
  }
  const unrelated = await broadcast(
    {
      async request() {
        throw {
          shortMessage: 'RPC request failed.',
          details: 'https://rpc.example/?api_key=alreadyknown-secret',
        };
      },
    },
    '0x02',
  );
  assert.deepEqual(unrelated, { accepted: false, error: 'RPC broadcast request failed.' });
});
