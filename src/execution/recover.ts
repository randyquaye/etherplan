import { pendingRecovery } from '../recovery.ts';
import { ApplyError } from './errors.ts';
import { intentForSigned, signedVariants } from './journal.ts';
import { decide } from './outcome.ts';
import { settle } from './settlement.ts';
import { validateSignedTransaction } from './transactions.ts';
import type { Hash, ResourceId } from '../types.ts';
import type { ApplyContext } from './context.ts';
import type { PreparedAction, SignedRecord } from './types.ts';

/** Settle earlier signed bytes under their original journal identity before this plan can sign. */
export async function recoverEarlierActions(ctx: ApplyContext): Promise<void> {
  const remaining = new Map<ResourceId, { item: PreparedAction; signed: SignedRecord; originPlanHash: Hash }>();
  // Validate every inherited signature before any of them can be broadcast.
  // A pipeline can leave several independent signed actions in one journal.
  for (const planned of ctx.plan.resources.filter(resource => resource.action === 'recover')) {
    const item = ctx.prepared.get(planned.id);
    const pinned = planned.observation.recovery;
    if (!item || !pinned || !planned.tx || item.resource.kind === 'external') {
      throw new ApplyError('plan-format', `Recovery for ${planned.id} has no prepared transaction.`, { actionId: planned.id });
    }
    if (!ctx.lanes.byAddress.has(pinned.signer.toLowerCase())) {
      throw new ApplyError('signer', `Recovery for ${planned.id} needs its original signer ${pinned.signer} to hold that account's lock.`, { actionId: planned.id });
    }
    const current = pendingRecovery(ctx.journal.records, item.resource, ctx.plan.chain);
    const source = ctx.journal.forAction(pinned.originPlanHash, planned.id)
      .filter(record => record.chain.id === ctx.plan.chain.id && record.chain.genesisHash.toLowerCase() === ctx.plan.chain.genesisHash.toLowerCase());
    const signed = source.find(record => record.phase === 'signed' && record.sequence === pinned.signedSequence);
    const latestSigned = source.filter(record => record.phase === 'signed').at(-1);
    if (!signed || signed.phase !== 'signed' || latestSigned?.sequence !== pinned.signedSequence ||
      signed.transactionHash.toLowerCase() !== pinned.transactionHash.toLowerCase() ||
      signed.signer.toLowerCase() !== pinned.signer.toLowerCase() || signed.nonce !== pinned.nonce ||
      (!current && source.at(-1)?.phase !== 'verified') || (current && (!current.matches ||
        current.recovery.originPlanHash !== pinned.originPlanHash || current.recovery.signedSequence !== pinned.signedSequence))) {
      throw new ApplyError('journal', `The signed transaction for ${planned.id} changed after this plan was created. Create a new plan.`, { actionId: planned.id });
    }
    const variants = signedVariants(source, signed as SignedRecord);
    for (const [index, variant] of variants.entries()) {
      try {
        const intent = intentForSigned(ctx.journal.records, variant);
        await validateSignedTransaction(variant, intent, planned, ctx.plan.chain.id);
        const previous = variants[index - 1];
        if (previous) {
          const oldIntent = intentForSigned(ctx.journal.records, previous);
          if (intent.replacesTransactionHash?.toLowerCase() !== previous.transactionHash.toLowerCase() ||
            BigInt(intent.maxFeePerGas) <= BigInt(oldIntent.maxFeePerGas) ||
            BigInt(intent.maxPriorityFeePerGas) <= BigInt(oldIntent.maxPriorityFeePerGas)) {
            throw new Error('Signed replacement does not raise fees for its predecessor.');
          }
        }
      } catch (error) {
        throw new ApplyError('journal', `The signed transaction for ${planned.id} is invalid: ${error instanceof Error ? error.message : String(error)}`, { actionId: planned.id });
      }
    }
    remaining.set(planned.id, { item, signed: signed as SignedRecord, originPlanHash: pinned.originPlanHash });
  }
  let firstFailure: unknown = null;
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter(({ item }) => item.planned.dependencies.every(id => !remaining.has(id)));
    if (ready.length === 0) throw new ApplyError('dependency', 'Recovery actions have a dependency cycle.');
    for (const { item, signed, originPlanHash } of ready) {
      const planned = item.planned;
      try {
        // Settlement writes receipt and verification records to the original plan's journal lineage.
        // This lets a later fresh plan use the existing verified-creation recovery path.
        const sourceItem: PreparedAction = { ...item, planned: { ...planned, action: item.resource.kind === 'contract' ? 'deploy' : 'call' } };
        const sourceCtx: ApplyContext = { ...ctx, plan: { ...ctx.plan, planHash: originPlanHash } };
        if (ctx.journal.forAction(originPlanHash, planned.id).at(-1)?.phase === 'verified') await decide(sourceCtx, sourceItem);
        else await settle(sourceCtx, sourceItem, signed);
        const outcome = ctx.outcomes.get(planned.id);
        if (!outcome || !('verification' in outcome)) throw new ApplyError('unverified', `Recovery for ${planned.id} did not verify.`, { actionId: planned.id });
        ctx.outcomes.set(planned.id, { ...outcome, action: 'recover' });
      } catch (error) {
        if (!(error instanceof ApplyError) || !['reverted', 'postcondition', 'receipt-timeout'].includes(error.code)) throw error;
        firstFailure ??= error;
      }
      remaining.delete(planned.id);
    }
  }
  if (firstFailure) throw firstFailure;
}
