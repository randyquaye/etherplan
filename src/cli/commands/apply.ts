import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { applyPlan } from '../../execution/index.ts';
import { createPlan } from '../../planning/index.ts';
import { readState, validateState } from '../../state/index.ts';
import type { ReplacementFees } from '../../execution/types.ts';
import type { StateFile } from '../../state/types.ts';
import type { Plan } from '../../planning/types.ts';
import { addressesFromModule, backendFromFile, signerFromModule, signersFromEnvironment } from '../environment.ts';
import type { Backend, SignerModuleSource, SignerSource } from '../environment.ts';
import { approvePlan, print, writeJsonAtomic } from '../shared.ts';
import type { ChainCommandContext } from './context.ts';

export async function apply(context: ChainCommandContext): Promise<void> {
  const { options, spec, artifacts, client, stateFile } = context;
  const replacementFlags = ['replace-max-fee-per-gas', 'replace-priority-fee-per-gas', 'replace-max-cost-wei'] as const;
  const replacementFees = replacementFlags.some(flag => options[flag] !== undefined) ? {
    maxFeePerGas: options['replace-max-fee-per-gas'], maxPriorityFeePerGas: options['replace-priority-fee-per-gas'],
    maxCostWei: options['replace-max-cost-wei'],
  } as ReplacementFees : undefined;
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
    const addresses = signerSource.signerProvider ? await addressesFromModule(signerSource as SignerModuleSource, spec.calls.length > 0) : {
      deployers: signerSource.signers.deployer.map(account => account.address), owner: signerSource.signers.owner?.address ?? null,
    };
    plan = await createPlan({ spec, artifacts, client, state, signers: { ...addresses, parallel: options.parallel ?? false }, maxSpendWei: options['max-spend-wei'] });
    await approvePlan(plan);
    if (planningBackend?.planStore) {
      await planningBackend.planStore.put(planningBackend.scope, plan);
    } else {
      const recoveryPlanFile = path.join(path.dirname(stateFile), 'plans', `${plan.planHash}.json`);
      await writeJsonAtomic(recoveryPlanFile, plan);
      process.stderr.write(`Approved plan saved for recovery: ${recoveryPlanFile}\n`);
    }
  }
  if (options.backend) {
    const backend = planningBackend ?? await backendFromFile(options.backend, plan.chain, { requireBucket: true });
    if (backend.planStore) await backend.planStore.read(backend.scope, plan.planHash);
    print(await applyPlan({ plan, spec, artifacts, client, ...backend, ...signerSource, parallel: options.parallel ?? false, pipeline: options.pipeline ?? false, replacementFees }));
    return;
  }
  const journalFile = path.resolve(options.journal ?? path.join(path.dirname(stateFile), 'journal.jsonl'));
  print(await applyPlan({ plan, spec, artifacts, client, ...signerSource, stateFile, journalFile, parallel: options.parallel ?? false, pipeline: options.pipeline ?? false, replacementFees }));
  return;
}
