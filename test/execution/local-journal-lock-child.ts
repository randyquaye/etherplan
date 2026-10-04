import { readFile } from 'node:fs/promises';
import { createPublicClient, http } from 'viem';
import { applyPlan } from '../../src/execution/index.ts';
import { accounts, fixture } from './chain.ts';

const config = JSON.parse(process.argv[2]!);
const input = fixture({ withCall: false });
input.spec.contracts = input.spec.contracts.filter((contract) => contract.id === config.contractId);
input.artifacts = new Map([...input.artifacts].filter(([name]) => name === config.contractId));
const plan = JSON.parse(await readFile(config.planFile, 'utf8'));
input.spec.chainId = plan.chain.id;
const client = createPublicClient({ transport: http(config.rpcUrl) });

try {
  const result = await applyPlan({
    ...input,
    plan,
    client,
    signers: { deployer: [accounts[config.signerIndex]] },
    stateFile: config.stateFile,
    journalFile: config.journalFile,
    pollIntervalMs: 20,
    hooks: {
      async afterRecord(record) {
        if (
          (config.holdAtIntent && record.phase === 'intent') ||
          (config.holdAtSigned && record.phase === 'signed')
        ) {
          process.stdout.write('HELD\n');
          await new Promise((resolve) => process.stdin.once('data', resolve));
        }
      },
    },
  });
  process.stdout.write(
    `RESULT ${JSON.stringify({ status: result.status, transactionsSigned: result.transactionsSigned })}\n`,
  );
} catch (error) {
  const failure = error as Error & { code?: string };
  process.stdout.write(
    `ERROR ${JSON.stringify({ code: failure.code, message: failure.message })}\n`,
  );
  process.exitCode = 2;
}
