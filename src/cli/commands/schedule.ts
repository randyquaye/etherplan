import { hashJson } from '../../identity.ts';
import { createSchedule } from '../../scheduling/index.ts';
import type { Address } from '../../types.ts';
import { print } from '../shared.ts';
import { planFor } from './plan-context.ts';
import type { ChainCommandContext } from './context.ts';

export async function schedule(context: ChainCommandContext): Promise<void> {
  const { options, client } = context;
  const { plan } = await planFor('schedule', context);
  const blocked = plan.resources.filter(resource => !['reuse', 'deploy', 'call'].includes(resource.action));
  if (options.plan && blocked.length) {
    print({ chain: plan.chain, observed: plan.observed, applicable: false, snapshot: 'plan-observed',
      resources: plan.resources.map(({ id, kind, address, action, observation }) => ({ id, kind, address, action, observation })) });
    return;
  }
  const pinned = plan.pipeline ?? plan.signers;
  const deployers = options.deployers?.split(',') ?? pinned?.deployers;
  if (!deployers) throw new Error('schedule needs --deployers <address,address>.');
  if (plan.pipeline && options.parallel && !plan.pipeline.parallel) throw new Error('The saved pipeline plan pins serial scheduling; omit --parallel.');
  if (pinned && (hashJson(deployers.map(address => address.toLowerCase())) !== hashJson(pinned.deployers) ||
    (options.owner?.toLowerCase() ?? pinned.owner) !== pinned.owner || (options.parallel ?? pinned.parallel) !== pinned.parallel)) {
    throw new Error('The requested signers or parallel setting differ from the saved plan.');
  }
  const schedule = createSchedule(plan, deployers, { owner: options.owner ?? pinned?.owner ?? null, parallel: options.parallel ?? pinned?.parallel ?? false, pipeline: options.pipeline ?? Boolean(plan.pipeline) });
  if (plan.pipeline && hashJson(schedule.waves) !== hashJson(plan.pipeline.waves)) throw new Error('The requested schedule differs from the saved pipeline plan.');
  const funding = await Promise.all(deployers.map(async address => ({ address, balanceWei: (await client.getBalance({ address: address as Address })).toString() })));
  if (funding.some(account => account.balanceWei === '0')) throw new Error('Every supplied deployer must have a nonzero native-token balance.');
  const requested = new Map(deployers.map(address => [address.toLowerCase(), address]));
  const waves = schedule.waves.map(wave => ({ ...wave, batches: wave.batches.map(batch => batch.map(entry => ({
    ...entry,
    ...(entry.kind === 'contract' ? { deployer: requested.get(entry.signer) ?? entry.signer } : {}),
  }))) }));
  print({ chain: plan.chain, observed: plan.observed, applicable: true, snapshot: 'plan-observed', deployers: funding, ...schedule, waves });
}
