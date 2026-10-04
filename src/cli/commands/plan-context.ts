import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkPlanIdentity } from '../../execution/preflight.ts';
import { createPlan, prepareResources, transactionFor } from '../../planning/index.ts';
import { graph, parseSpec } from '../../spec/index.ts';
import { readState, validateState } from '../../state/index.ts';
import type { StateFile } from '../../state/types.ts';
import type { CreatePlanInput, Plan } from '../../planning/types.ts';
import {
  addressesFromModule,
  backendFromFile,
  planningJournal,
  signerFromModule,
  specNeedsOwner,
} from '../environment.ts';
import type { Backend } from '../environment.ts';
import type { ChainCommandContext } from './context.ts';

export async function planFor(
  command: 'plan' | 'verify' | 'schedule',
  { options, spec, artifacts, client, stateFile }: ChainCommandContext,
  onResourceCheck?: CreatePlanInput['onResourceCheck'],
): Promise<{ plan: Plan; backend: Backend | undefined }> {
  let plan: Plan;
  let backend: Backend | undefined;
  if (command === 'schedule' && options.plan) {
    plan = JSON.parse(await readFile(path.resolve(options.plan), 'utf8')) as Plan;
    await checkPlanIdentity({
      plan,
      spec,
      artifacts,
      client,
      deps: { parseSpec, graph, prepareResources, transactionFor },
    });
  } else {
    let state: StateFile | null;
    if (options.backend) {
      const chainId = await client.getChainId();
      const genesis = await client.getBlock({ blockNumber: 0n });
      backend = await backendFromFile(
        options.backend,
        { id: chainId, genesisHash: genesis.hash },
        { requireBucket: command === 'plan' },
      );
      const stored = (await backend.stateStore.read(backend.scope))?.value;
      state = stored == null ? null : validateState(stored);
    } else state = await readState(stateFile);
    const moduleAddresses =
      command === 'plan' && options['signer-module']
        ? await addressesFromModule(
            await signerFromModule(options['signer-module']),
            specNeedsOwner(spec),
          )
        : null;
    const deployers = moduleAddresses?.deployers ?? options.deployers?.split(',');
    const owner = moduleAddresses?.owner ?? options.owner ?? null;
    const pipeline = options.pipeline
      ? {
          deployers: deployers ?? [],
          owner,
          parallel: options.parallel ?? false,
        }
      : null;
    const signers =
      command === 'plan' && !pipeline && deployers
        ? {
            deployers,
            owner,
            parallel: options.parallel ?? false,
          }
        : null;
    const journalRecords = await planningJournal(stateFile, options, backend);
    plan = await createPlan({
      spec,
      artifacts,
      client,
      state,
      journalRecords,
      ...(onResourceCheck ? { onResourceCheck } : {}),
      pipeline,
      signers,
      maxSpendWei: command === 'plan' ? (options['max-spend-wei'] ?? null) : null,
    });
  }
  return { plan, backend };
}
