import { randomUUID } from 'node:crypto';
import { keccak256 } from 'viem';
import { estimateGasLimit, feesFor, maximumCost } from './transactions.ts';
import { safeExternalError, safeRpcMessage } from './rpc-error.ts';
import { ApplyError } from './errors.ts';
import { transactionFor } from './shared.ts';
import { decide, checkExecutionDependencies, finish } from './outcome.ts';
import { append, fail } from './report.ts';
import { assertPinnedAbsent, pinnedIntentFields } from '../verification/pinned-runtime.ts';
import { checkReplayCapabilities } from './preflight.ts';
import { assertSignerHistory, recordReceipt, send, signWithLease } from './settlement.ts';
import type { Hash } from '../types.ts';
import type { ScheduleEntry } from '../scheduling/types.ts';
import type { ApplyContext, CostEnvelope, FundedJob, PreparedAction, SignedBatchJob, SignedBytes, SignerAccount, TransactionEnvelope } from './types.ts';

export async function prepareBatch(ctx: ApplyContext, batch: ScheduleEntry[]): Promise<FundedJob[]> {
  const candidates: { item: PreparedAction; entry: ScheduleEntry; signer: SignerAccount }[] = [];
  for (const entry of batch) {
    const item = ctx.prepared.get(entry.id);
    if (!item) throw new ApplyError('schedule', `Schedule names missing action ${entry.id}.`, { actionId: entry.id });
    if (await decide(ctx, item)) {
      const signer = ctx.lanes.byAddress.get(entry.signer);
      if (!signer) throw new ApplyError('signer', `Signer ${entry.signer} is unavailable.`, { actionId: entry.id });
      candidates.push({ item, entry, signer });
    }
  }
  if (candidates.length === 0) return [];

  const fees = await feesFor(ctx.client, ctx.config.fees);
  const work: FundedJob[] = [];
  for (const job of candidates) {
    const tx = transactionFor(job.item);
    let gas: bigint;
    try {
      gas = await estimateGasLimit(ctx.client, { from: job.signer.address, tx, gasMultiplier: ctx.config.gasMultiplier });
    } catch {
      return fail(ctx, job.item, 'estimate-failed', safeRpcMessage('request-failed', 'estimate'), { retryable: true, signer: job.signer.address });
    }
    const envelope: CostEnvelope = { chainId: ctx.plan.chain.id, to: tx.to, data: tx.data, value: BigInt(tx.value), gas, ...fees };
    work.push({ ...job, envelope, cost: maximumCost(envelope as TransactionEnvelope) });
  }
  return work;
}

/** Serial signing reads each signer's latest nonce and rejects unknown pending transactions. */
export interface SerialSigningInput {
  wave: number;
  work: FundedJob[];
}

export async function signBatch(ctx: ApplyContext, { wave, work }: SerialSigningInput): Promise<SignedBatchJob[]> {
  await checkReplayCapabilities(ctx.client, work.map(job => job.item), ctx.verificationClient, ctx.plan.chain);
  await checkExecutionDependencies(ctx, work);
  await assertSignerHistory(ctx, work.map(job => job.signer.address));
  // Read every signer's nonce and reject pending transactions before recording any intent.
  for (const job of work) {
    const [latest, pending] = await Promise.all([
      ctx.client.getTransactionCount({ address: job.signer.address, blockTag: 'latest' }),
      ctx.client.getTransactionCount({ address: job.signer.address, blockTag: 'pending' }),
    ]);
    if (pending !== latest) {
      await fail(ctx, job.item, 'nonce-race', `Signer ${job.signer.address} has ${pending - latest} pending transactions that are not in the journal.`, { retryable: true, signer: job.signer.address });
    }
    job.envelope.nonce = latest;
  }

  const signedWork: SignedBatchJob[] = [];
  for (const job of work) {
    const { item, entry } = job;
    const nonce = job.envelope.nonce;
    if (nonce === undefined) throw new ApplyError('nonce-race', `Signer ${job.signer.address} has no reserved nonce.`, { actionId: item.planned.id });
    const envelope: TransactionEnvelope = { ...job.envelope, nonce };
    const attemptId = randomUUID();
    if (item.resource.kind === 'contract') await assertPinnedAbsent(ctx.client, item.resource);
    await ctx.lock.assertHeld?.();
    await append(ctx, item.planned.id, { phase: 'intent', ...pinnedIntentFields(ctx.plan.planHash, item), attemptId, wave, signer: job.signer.address, signerRole: entry.signerRole, pooled: entry.pooled, nonce: String(envelope.nonce), to: envelope.to, value: String(envelope.value), dataHash: keccak256(envelope.data), gas: String(envelope.gas), maxFeePerGas: String(envelope.maxFeePerGas), maxPriorityFeePerGas: String(envelope.maxPriorityFeePerGas) });
    let signed: SignedBytes;
    try {
      signed = await signWithLease(ctx, item.planned.id, job.signer, envelope);
    } catch (error) {
      return fail(ctx, item, 'signer', safeExternalError(error), { retryable: true, signer: job.signer.address });
    }
    const signedRecord = await append(ctx, item.planned.id, { phase: 'signed', attemptId, signer: job.signer.address, nonce: String(envelope.nonce), ...signed });
    signedWork.push({ ...job, signed: signedRecord });
    ctx.sent.push({ actionId: item.planned.id, wave, signer: job.signer.address.toLowerCase(), nonce: String(envelope.nonce), transactionHash: signed.transactionHash.toLowerCase() as Hash });
  }
  return signedWork;
}

export async function settleBatch(ctx: ApplyContext, work: SignedBatchJob[]): Promise<void> {
  // Every signed job gets a chance to settle before a batch error is reported.
  const settled = await Promise.allSettled(work.map(async job => {
    const receipt = await send(ctx, job.item, job.signed);
    await recordReceipt(ctx, job.item, job.signed, receipt);
    await finish(ctx, job.item, job.signed, receipt);
  }));
  const rejected = settled.find(result => result.status === 'rejected');
  if (rejected) throw rejected.reason;
}
