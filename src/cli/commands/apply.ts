import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createPublicClient, http } from 'viem';
import { applyPlan } from '../../execution/index.ts';
import { createPlan } from '../../planning/index.ts';
import { readState, validateState } from '../../state/index.ts';
import type { ReplacementFees } from '../../execution/types.ts';
import type { StateFile } from '../../state/types.ts';
import type { Plan } from '../../planning/types.ts';
import { addressesFromModule, backendFromFile, planningJournal, signerFromModule, signersFromEnvironment, specNeedsOwner } from '../environment.ts';
import type { Backend, SignerModuleSource, SignerSource } from '../environment.ts';
import { approvePlan, defaultJournalFile, print, writeJsonAtomic } from '../shared.ts';
import type { ChainCommandContext } from './context.ts';
import { createApplyProgress } from '../progress.ts';
import { formatApplyReport } from '../reporting.ts';

export { defaultJournalFile } from '../shared.ts';

export async function apply(context: ChainCommandContext): Promise<void> {
  const { options, spec, artifacts, client, stateFile } = context;
  const replacementFlags = ['replace-max-fee-per-gas', 'replace-priority-fee-per-gas', 'replace-max-cost-wei'] as const;
  const replacementFees = replacementFlags.some(flag => options[flag] !== undefined) ? {
    maxFeePerGas: options['replace-max-fee-per-gas'], maxPriorityFeePerGas: options['replace-priority-fee-per-gas'],
    maxCostWei: options['replace-max-cost-wei'],
  } as ReplacementFees : undefined;
  const verificationRpcUrl = process.env.ETH_VERIFICATION_RPC_URL;
  // validateCombination has checked these values and requires the two fee caps together.
  const transactionOptions = {
    ...(options['max-fee-per-gas'] === undefined ? {} : { fees: { maxFeePerGas: options['max-fee-per-gas'], maxPriorityFeePerGas: options['priority-fee-per-gas']! } }),
    ...(options['gas-multiplier'] === undefined ? {} : { gasMultiplier: Number(options['gas-multiplier']) }),
    ...(options['receipt-timeout-ms'] === undefined ? {} : { receiptTimeoutMs: Number(options['receipt-timeout-ms']) }),
    ...(options['verification-timeout-ms'] === undefined ? {} : { verificationTimeoutMs: Number(options['verification-timeout-ms']) }),
    ...(verificationRpcUrl ? { verificationClient: createPublicClient({ transport: http(verificationRpcUrl) }) } : {}),
  };
  if (!options.plan && options.pipeline) throw new Error('A pipeline apply needs an explicit saved plan with --plan.');
  if (options.backend && !options['signer-module']) throw new Error('AWS apply needs --signer-module file.mjs.');
  if (options.plan && options['max-spend-wei']) throw new Error('A saved plan already pins maxSpendWei; omit --max-spend-wei.');
  const signerSource: SignerSource = options['signer-module'] ? await signerFromModule(options['signer-module']) : { signers: signersFromEnvironment() };
  let plan: Plan;
  let planningBackend: Backend | undefined;
  if (options.plan) {
    plan = JSON.parse(await readFile(path.resolve(options.plan), 'utf8')) as Plan;
  } else {
    let state: StateFile | null;
    if (options.backend) {
      const chainId = await client.getChainId();
      const genesis = await client.getBlock({ blockNumber: 0n });
      planningBackend = await backendFromFile(options.backend, { id: chainId, genesisHash: genesis.hash }, { requireBucket: true });
      const stored = (await planningBackend.stateStore.read(planningBackend.scope))?.value;
      state = stored == null ? null : validateState(stored);
    } else state = await readState(stateFile);
    if (!options['max-spend-wei']) throw new Error('Fresh apply needs --max-spend-wei <amount>.');
    const addresses = signerSource.signerProvider ? await addressesFromModule(signerSource as SignerModuleSource, specNeedsOwner(spec)) : {
      deployers: signerSource.signers.deployer.map(account => account.address), owner: signerSource.signers.owner?.address ?? null,
    };
    const journalRecords = await planningJournal(stateFile, options, planningBackend);
    plan = await createPlan({ spec, artifacts, client, state, journalRecords, signers: { ...addresses, parallel: options.parallel ?? false }, maxSpendWei: options['max-spend-wei'] });
    await approvePlan(plan);
    if (planningBackend?.planStore) {
      await planningBackend.planStore.put(planningBackend.scope, plan);
    } else {
      const recoveryPlanFile = path.join(path.dirname(stateFile), 'plans', `${plan.planHash}.json`);
      await writeJsonAtomic(recoveryPlanFile, plan);
      process.stderr.write(`Approved plan saved for recovery: ${recoveryPlanFile}\n`);
    }
  }
  const progress = options.quiet ? null : createApplyProgress(plan, options.json ? process.stderr : process.stdout);
  progress?.start();
  try {
    const common = { plan, spec, artifacts, client, ...signerSource, parallel: options.parallel ?? false,
      pipeline: options.pipeline ?? false, replacementFees, ...transactionOptions,
      ...(progress ? { reporter: progress.reporter } : {}) };
    if (options.backend) {
      const backend = planningBackend ?? await backendFromFile(options.backend, plan.chain, { requireBucket: true });
      if (backend.planStore) await backend.planStore.read(backend.scope, plan.planHash);
      const result = await applyPlan({ ...common, ...backend });
      if (options.json) {
        progress?.complete(result);
        print(result);
      } else process.stdout.write(`${progress ? '\n' : ''}${formatApplyReport(result)}`);
      return;
    }
    const journalFile = path.resolve(options.journal ?? defaultJournalFile(stateFile));
    const result = await applyPlan({ ...common, stateFile, journalFile });
    if (options.json) {
      progress?.complete(result);
      print(result);
    } else process.stdout.write(`${progress ? '\n' : ''}${formatApplyReport(result)}`);
  } finally {
    progress?.stop();
  }
}
