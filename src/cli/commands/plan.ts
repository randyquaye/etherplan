import path from 'node:path';
import { writeJsonAtomic, print } from '../shared.ts';
import { planFor } from './plan-context.ts';
import type { ChainCommandContext } from './context.ts';

export async function plan(context: ChainCommandContext): Promise<void> {
  const { options } = context;
  const { plan, backend } = await planFor('plan', context);
  if (plan.resources.some(resource => ['deploy', 'call'].includes(resource.action)) &&
    ((!options.deployers && !options['signer-module']) || !options['max-spend-wei'])) {
    throw new Error('A write plan needs --deployers <address,address> or --signer-module, and --max-spend-wei <amount>.');
  }
  if (backend?.planStore) await backend.planStore.put(backend.scope, plan);
  if (options.out !== '-') await writeJsonAtomic(path.resolve(options.out ?? 'plan.json'), plan);
  print(plan);
  if (plan.resources.some(resource => resource.action === 'conflict' || resource.action === 'unverified')) process.exitCode = 1;
  return;
}
