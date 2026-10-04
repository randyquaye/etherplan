import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectDeployment } from '../../execution/backends.ts';
import { hashJson } from '../../identity.ts';
import type { Plan } from '../../planning/types.ts';
import { backendFromFile } from '../environment.ts';
import type { CommandContext } from './context.ts';
import { print } from '../shared.ts';

export async function status({ options }: CommandContext): Promise<void> {
  if (!options.backend) throw new Error('status needs --backend file.json.');
  const plan = JSON.parse(
    await readFile(path.resolve(options.plan ?? 'plan.json'), 'utf8'),
  ) as Plan;
  const { planHash, ...fields } = plan;
  if (hashJson(fields) !== planHash) throw new Error('Plan content does not match planHash.');
  const backend = await backendFromFile(options.backend, plan.chain);
  print(await inspectDeployment({ ...backend, chain: plan.chain, planHash: plan.planHash }));
}
