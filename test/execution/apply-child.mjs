// Runs one apply in a separate process and kills it with SIGKILL right after a chosen journal record is durable.
import { readFile } from 'node:fs/promises';
import { createPublicClient, http } from 'viem';
import { applyPlan } from '../../src/execution/index.mjs';
import { accounts, fixture } from './chain.mjs';

const config = JSON.parse(process.argv[2]);
const { spec, artifacts } = fixture(config.fixture);
const plan = JSON.parse(await readFile(config.planFile, 'utf8'));
const client = createPublicClient({ transport: http(config.rpcUrl) });

await applyPlan({
  plan,
  spec,
  artifacts,
  client,
  signers: { deployer: config.deployers.map(index => accounts[index]), owner: accounts[config.owner] },
  stateFile: config.stateFile,
  journalFile: config.journalFile,
  parallel: config.parallel ?? false,
  pollIntervalMs: 50,
  hooks: {
    afterRecord(record) {
      if (record.phase === config.crash.phase && record.actionId === config.crash.actionId) process.kill(process.pid, 'SIGKILL');
    },
  },
});
