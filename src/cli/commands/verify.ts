import { print } from '../shared.ts';
import { planFor } from './plan-context.ts';
import type { ChainCommandContext } from './context.ts';

export async function verify(context: ChainCommandContext): Promise<void> {
  const { plan } = await planFor('verify', context);
    const resources = plan.resources.map(resource => Object.assign({ id: resource.id, kind: resource.kind, address: resource.address, action: resource.action }, resource.observation));
    const status = resources.every(resource => resource.status === 'verified' && resource.action === 'reuse') ? 'verified'
      : resources.some(resource => resource.status === 'conflict' || resource.action === 'conflict') ? 'conflict' : 'unverified';
    print({ formatVersion: 1, chain: plan.chain, observed: plan.observed, status, resources });
    if (status !== 'verified') process.exitCode = 1;
    return;
}
