import { print } from '../shared.ts';
import { planFor } from './plan-context.ts';
import type { ChainCommandContext } from './context.ts';
import { formatVerifyReport } from '../reporting.ts';

export async function verify(context: ChainCommandContext): Promise<void> {
  if (!context.options.json) process.stdout.write(`Verifying ${context.ordered.length} resources on chain ${context.spec.chainId}...\n`);
  const { plan } = await planFor('verify', context, context.options.json ? undefined : id => process.stdout.write(`  ${id}: checking...\n`));
  const resources = plan.resources.map(resource => Object.assign({ id: resource.id, kind: resource.kind, address: resource.address, action: resource.action }, resource.observation));
  const status = resources.every(resource => resource.status === 'verified' && resource.action === 'reuse') ? 'verified'
    : resources.some(resource => resource.status === 'conflict' || resource.action === 'conflict') ? 'conflict' : 'unverified';
  if (context.options.json) print({ formatVersion: 1, chain: plan.chain, observed: plan.observed, status, resources });
  else process.stdout.write(`\n${formatVerifyReport(plan)}`);
  if (status !== 'verified') process.exitCode = 1;
}
