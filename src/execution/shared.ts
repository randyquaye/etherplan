import type { PlannedResource, PlannedTransaction, PreparedResource } from '../planning/types.ts';
import type { PreparedAction } from './types.ts';
import { ApplyError } from './errors.ts';

export const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export function transactionFor(item: PreparedAction): PlannedTransaction {
  const transaction = item.planned.tx;
  if (!transaction) throw new ApplyError('plan-format', `Action ${item.planned.id} has no planned transaction.`, { actionId: item.planned.id });
  return transaction;
}

export function roleOf(resource: PlannedResource | PreparedResource): string {
  return ('signerRole' in resource ? resource.signerRole : null) ?? (resource.kind === 'call' ? 'owner' : 'deployer');
}
