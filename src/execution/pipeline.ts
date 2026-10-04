import { randomUUID } from 'node:crypto';
import { keccak256 } from 'viem';
import {
  findKnownReceipt,
  nonceConsumed,
  broadcast,
  validateSignedTransaction,
  waitForReceipt,
} from './transactions.ts';
import { intentForSigned, signedVariants } from './journal.ts';
import {
  assertPinnedAbsent,
  assertPinnedSignedIntent,
  pinnedCommitment,
  pinnedIntentFields,
} from '../verification/pinned-runtime.ts';
import { checkReplayCapabilities } from './preflight.ts';
import { ApplyError } from './errors.ts';
import { safeExternalError } from './rpc-error.ts';
import { transactionFor, pause } from './shared.ts';
import { commitments, signedSpend, budgetFor } from './funding.ts';
import {
  decide,
  precondition,
  finish,
  checkExecutionDependencies,
  stableReceipt,
} from './outcome.ts';
import { append, fail, report } from './report.ts';
import {
  assertSignerHistory,
  matchingVariant,
  recordReceipt,
  replaceSigned,
  signWithLease,
} from './settlement.ts';
import type { ScheduleEntry, ScheduleWave } from '../scheduling/types.ts';
import type { Address, Client, Hash, ResourceId } from '../types.ts';
import type {
  ApplyContext,
  BroadcastOutcome,
  CostEnvelope,
  FundedJob,
  PipelineFundedJob,
  IntentRecord,
  JournalRecord,
  PipelineBatchJob,
  PreparedAction,
  Receipt,
  SignedBytes,
  SignedRecord,
  SignerAccount,
  TransactionEnvelope,
} from './types.ts';

interface ResumeJob {
  item: PreparedAction;
  entry: ScheduleEntry;
  signer: SignerAccount;
  intent: IntentRecord;
  signed: SignedRecord | null;
  signedIntent: IntentRecord | null;
  variants: SignedRecord[];
  records: JournalRecord[];
  receipt: Receipt | null;
  completed: boolean;
}
type ActivePipelineJob = PipelineBatchJob | (ResumeJob & { signed: SignedRecord });
type PipelineAttempt = { receipt?: Receipt; accepted?: boolean; error?: unknown };

// A signed reservation commits the entire wave. Older journals have no attempt ID,
// but their complete intent set immediately precedes the first signature.
export function pipelineAttempt(
  ctx: ApplyContext,
  wave: ScheduleWave,
): { intents: IntentRecord[]; attemptId: string | null } | null {
  const actions = new Set(wave.batches.flat().map((entry) => entry.id));
  const records = ctx.journal.records.filter(
    (record): record is IntentRecord | SignedRecord =>
      record.planHash === ctx.plan.planHash &&
      actions.has(record.actionId) &&
      (record.phase === 'intent' || record.phase === 'signed') &&
      Boolean(record.reservationId) &&
      !record.replacement,
  );
  const signatures = records.filter((record): record is SignedRecord => record.phase === 'signed');
  if (!signatures.length) return null;
  if (
    records.some(
      (record) =>
        record.wave !== wave.wave ||
        record.chain.id !== ctx.plan.chain.id ||
        record.chain.genesisHash.toLowerCase() !== ctx.plan.chain.genesisHash.toLowerCase(),
    )
  ) {
    throw new ApplyError('journal', `Wave ${wave.wave} has a record with the wrong wave or chain.`);
  }
  const ids = new Set(signatures.map((record) => record.waveAttemptId ?? null));
  if (ids.size !== 1)
    throw new ApplyError('journal', `Wave ${wave.wave} has signatures from multiple attempts.`);
  const attemptId = ids.values().next().value ?? null;
  const firstSignature = signatures[0]!;
  const intents = attemptId
    ? records.filter(
        (record): record is IntentRecord =>
          record.phase === 'intent' && record.waveAttemptId === attemptId,
      )
    : records
        .filter(
          (record): record is IntentRecord =>
            record.phase === 'intent' &&
            !record.waveAttemptId &&
            record.sequence < firstSignature.sequence,
        )
        .slice(-wave.batches.flat().length);
  if (
    attemptId &&
    (intents.some((intent) => intent.sequence >= firstSignature.sequence) ||
      records.some(
        (record) =>
          record.phase === 'intent' &&
          record.sequence < firstSignature.sequence &&
          record.waveAttemptId !== attemptId &&
          !record.waveAttemptId,
      ))
  ) {
    throw new ApplyError('journal', `Wave ${wave.wave} has an ambiguous abandoned attempt.`);
  }
  if (
    intents.length !== wave.batches.flat().length ||
    signatures.some(
      (record) =>
        !intents.some(
          (intent) =>
            intent.actionId === record.actionId && intent.reservationId === record.reservationId,
        ),
    )
  ) {
    throw new ApplyError(
      'journal',
      `Wave ${wave.wave} has an incomplete or ambiguous signed attempt.`,
    );
  }
  return { intents, attemptId };
}

export async function resumePipelineWave(ctx: ApplyContext, wave: ScheduleWave): Promise<boolean> {
  const attempt = pipelineAttempt(ctx, wave);
  if (!attempt) return false;
  const { intents, attemptId } = attempt;
  const entries = wave.batches.flat();
  const byAction = new Map<ResourceId, IntentRecord>();
  for (const intent of intents) {
    if (byAction.has(intent.actionId))
      throw new ApplyError(
        'journal',
        `Wave ${wave.wave} has duplicate intents for ${intent.actionId}.`,
      );
    byAction.set(intent.actionId, intent);
  }
  const groups = new Map<string, ResumeJob[]>();
  const jobs: ResumeJob[] = [];
  for (const entry of entries) {
    const intent = byAction.get(entry.id);
    const item = ctx.prepared.get(entry.id);
    const signer = ctx.lanes.byAddress.get(entry.signer);
    const tx = item ? transactionFor(item) : null;
    if (
      !intent ||
      !item ||
      !signer ||
      intent.signer?.toLowerCase() !== entry.signer ||
      typeof entry.nonceOffset !== 'number' ||
      intent.nonceOffset !== entry.nonceOffset ||
      intent.to?.toLowerCase() !== tx?.to.toLowerCase() ||
      intent.value !== tx?.value ||
      intent.dataHash?.toLowerCase() !== (tx ? keccak256(tx.data).toLowerCase() : null) ||
      !/^[0-9]+$/.test(String(intent.nonce)) ||
      !/^[0-9]+$/.test(String(intent.gas)) ||
      !/^[0-9]+$/.test(String(intent.maxFeePerGas)) ||
      !/^[0-9]+$/.test(String(intent.maxPriorityFeePerGas)) ||
      !Number.isSafeInteger(Number(intent.nonce)) ||
      !intent.reservationId
    )
      throw new ApplyError('journal', `Wave ${wave.wave} has an invalid intent for ${entry.id}.`, {
        actionId: entry.id,
      });
    if (
      item.resource.kind === 'contract' &&
      item.resource.creationProofMode === 'pinned-runtime' &&
      intent.pinnedCommitment?.toLowerCase() !==
        pinnedCommitment(ctx.plan.planHash, item.resource).toLowerCase()
    ) {
      throw new ApplyError(
        'journal',
        `Wave ${wave.wave} has no matching pinned-runtime intent for ${entry.id}.`,
        { actionId: entry.id },
      );
    }
    const group = groups.get(entry.signer) ?? [];
    if (
      group.length &&
      (intent.reservationId !== group[0]!.intent.reservationId ||
        BigInt(intent.nonce) !== BigInt(group[0]!.intent.nonce) + BigInt(entry.nonceOffset))
    ) {
      throw new ApplyError(
        'journal',
        `Wave ${wave.wave} has inconsistent nonces or reservations for ${entry.signer}.`,
      );
    }
    const actionRecords = ctx.journal.forAction(ctx.plan.planHash, entry.id);
    const nextIntent = actionRecords.find(
      (record) =>
        record.phase === 'intent' && !record.replacement && record.sequence > intent.sequence,
    );
    const history = actionRecords.filter(
      (record) =>
        record.sequence >= intent.sequence &&
        (!nextIntent || record.sequence < nextIntent.sequence),
    );
    const signatures = history.filter(
      (record): record is SignedRecord => record.phase === 'signed' && !record.replacement,
    );
    if (
      signatures.length > 1 ||
      signatures.some(
        (record) =>
          record.reservationId !== intent.reservationId ||
          (record.waveAttemptId ?? null) !== attemptId,
      )
    ) {
      throw new ApplyError(
        'journal',
        `Wave ${wave.wave} has duplicate or mismatched signatures for ${entry.id}.`,
        { actionId: entry.id },
      );
    }
    const original = signatures[0];
    const signed = original
      ? (history.filter((record): record is SignedRecord => record.phase === 'signed').at(-1) ??
        null)
      : null;
    const variants = signed ? signedVariants(history, signed) : [];
    const signedIntent = signed ? intentForSigned(ctx.journal.records, signed) : null;
    if (signed) {
      try {
        await validateSignedTransaction(
          signed,
          signedIntent ?? intent,
          item.planned,
          ctx.plan.chain.id,
        );
      } catch (error) {
        throw new ApplyError('journal', error instanceof Error ? error.message : String(error), {
          actionId: entry.id,
        });
      }
    }
    const job: ResumeJob = {
      item,
      entry,
      signer,
      intent,
      signed,
      signedIntent,
      variants,
      records: history,
      receipt: null,
      completed: false,
    };
    group.push(job);
    groups.set(entry.signer, group);
    jobs.push(job);
  }
  if (byAction.size !== entries.length)
    throw new ApplyError('journal', `Wave ${wave.wave} has intents outside its saved schedule.`);
  for (const group of groups.values()) {
    if (group[0]?.entry.nonceOffset !== 0)
      throw new ApplyError('journal', `Wave ${wave.wave} has an invalid first nonce offset.`);
  }
  if (
    new Set([...groups.values()].map((group) => group[0]!.intent.reservationId)).size !==
    groups.size
  ) {
    throw new ApplyError('journal', `Wave ${wave.wave} shares a reservation across signer groups.`);
  }
  const conflict = jobs.find((job) => {
    const last = job.records.at(-1);
    return (
      last?.phase === 'failed' &&
      !last.retryable &&
      !(
        last.code === 'postcondition' &&
        job.item.planned.action === 'deploy' &&
        job.records.some(
          (record) =>
            record.phase === 'receipt' &&
            record.receipt.status === 'success' &&
            record.transactionHash.toLowerCase() === last.transactionHash?.toLowerCase(),
        )
      )
    );
  });
  const failure = conflict?.records.at(-1);
  if (conflict && failure?.phase === 'failed')
    throw new ApplyError(failure.code, failure.reason, { actionId: conflict.item.planned.id });

  // Check every signer and precondition before adding any signature or broadcast.
  for (const job of jobs)
    job.receipt = job.signed ? await findKnownReceipt(ctx.client, job.variants) : null;
  for (const job of jobs) {
    const last = job.records.at(-1);
    if (
      last?.phase !== 'failed' ||
      last.code !== 'postcondition' ||
      job.item.planned.action !== 'deploy'
    )
      continue;
    const receipt = job.records.findLast(
      (record) =>
        record.phase === 'receipt' &&
        record.transactionHash.toLowerCase() === last.transactionHash?.toLowerCase(),
    );
    if (!receipt || receipt.phase !== 'receipt' || receipt.receipt.status !== 'success') {
      throw new ApplyError(
        'journal',
        `A failed deployment ${job.item.planned.id} has no successful journaled receipt.`,
        { actionId: job.item.planned.id },
      );
    }
    if (!job.receipt)
      job.receipt = await stableReceipt(
        ctx,
        receipt.transactionHash,
        receipt.receipt,
        job.item.planned.id,
      );
  }
  for (const job of jobs.filter((entry) => entry.records.at(-1)?.phase === 'verified'))
    await decide(ctx, job.item);
  const outstanding = jobs.filter(
    (job) => job.records.at(-1)?.phase !== 'verified' && !job.receipt,
  );
  await checkExecutionDependencies(ctx, outstanding, false);
  for (const job of outstanding) {
    const observed = await precondition(ctx, job.item);
    if (observed.satisfied)
      throw new ApplyError(
        'conflict',
        `The precondition for ${job.item.planned.id} changed after its nonce was reserved.`,
        { actionId: job.item.planned.id },
      );
  }
  for (const [address, group] of groups) {
    const [latest, pending] = await Promise.all([
      ctx.client.getTransactionCount({ address: address as Address, blockTag: 'latest' }),
      ctx.client.getTransactionCount({ address: address as Address, blockTag: 'pending' }),
    ]);
    const first = group[0]!;
    const base = BigInt(first.intent.nonce);
    if (BigInt(latest) < base || BigInt(pending) < BigInt(latest))
      throw new ApplyError(
        'nonce-conflict',
        `Signer ${address} no longer has the reserved nonce sequence.`,
        { actionId: first.item.planned.id },
      );
    for (const job of group) {
      if (BigInt(job.intent.nonce) < BigInt(latest) && !job.receipt) {
        if (job.signed) await pipelineConflict(ctx, { item: job.item, signed: job.signed });
        throw new ApplyError(
          'nonce-conflict',
          `Signer ${address} consumed unsigned reserved nonce ${job.intent.nonce}.`,
          { actionId: job.item.planned.id },
        );
      }
    }
    for (let nonce = BigInt(latest); nonce < BigInt(pending); nonce++) {
      const job = group.find((entry) => BigInt(entry.intent.nonce) === nonce);
      if (!job?.signed)
        throw new ApplyError(
          'nonce-conflict',
          `Signer ${address} has an unknown pending transaction at nonce ${nonce}.`,
          { actionId: first.item.planned.id },
        );
      let known = false;
      for (const variant of job.variants) {
        try {
          known ||= Boolean(await ctx.client.getTransaction({ hash: variant.transactionHash }));
        } catch (error) {
          if (!(error instanceof Error) || error.name !== 'TransactionNotFoundError') throw error;
        }
      }
      if (!known)
        throw new ApplyError(
          'nonce-conflict',
          `Signer ${address} has an unknown pending transaction at nonce ${nonce}.`,
          { actionId: job.item.planned.id },
        );
    }
    const unmined = group.filter((job) => job.records.at(-1)?.phase !== 'verified' && !job.receipt);
    if (!unmined.length) continue;
    const required = unmined.reduce(
      (sum, job) =>
        sum + BigInt(job.intent.gas) * BigInt(job.intent.maxFeePerGas) + BigInt(job.intent.value),
      0n,
    );
    const balance = await ctx.client.getBalance({ address: address as Address });
    if (balance < required)
      throw new ApplyError(
        'insufficient-funds',
        `Signer ${address} has ${balance} wei; the reserved group can cost ${required} wei.`,
        { actionId: unmined[0]!.item.planned.id, retryable: true },
      );
    const budget = budgetFor(ctx, address);
    const reserved = group.reduce(
      (sum, job) =>
        sum + BigInt(job.intent.gas) * BigInt(job.intent.maxFeePerGas) + BigInt(job.intent.value),
      0n,
    );
    const spent = signedSpend(await commitments(ctx), address, first.intent.reservationId);
    if (spent + reserved > budget) {
      throw new ApplyError(
        'budget-exceeded',
        `Signer ${address} has ${spent} wei committed; ${reserved} wei for reservation ${first.intent.reservationId} would exceed its ${budget} wei budget.`,
        { actionId: unmined[0]!.item.planned.id, retryable: true },
      );
    }
  }
  for (const job of jobs.filter(
    (entry) => entry.receipt && entry.records.at(-1)?.phase !== 'verified',
  )) {
    const receipt = job.receipt;
    if (!receipt) continue;
    const mined = matchingVariant(job.variants, receipt);
    await recordReceipt(ctx, job.item, mined, receipt);
    await finish(ctx, job.item, mined, receipt);
    await decide(ctx, job.item);
    job.completed = true;
  }
  const activeSignatures = new Set(
    jobs
      .filter((job) => job.signed && !job.receipt && !job.completed)
      .flatMap((job) => job.variants.map((variant) => variant.transactionHash.toLowerCase())),
  );
  await checkReplayCapabilities(
    ctx.client,
    jobs.filter((job) => !job.signed).map((job) => job.item),
    ctx.verificationClient,
    ctx.plan.chain,
  );
  await assertSignerHistory(
    ctx,
    jobs.filter((job) => !job.signed).map((job) => job.signer.address),
    activeSignatures,
  );
  for (const job of jobs.filter((entry) => !entry.signed)) {
    const { intent, item, signer } = job;
    if (item.resource.kind === 'contract') await assertPinnedAbsent(ctx.client, item.resource);
    const tx = transactionFor(item);
    const envelope: TransactionEnvelope = {
      chainId: ctx.plan.chain.id,
      to: tx.to,
      data: tx.data,
      value: BigInt(intent.value),
      gas: BigInt(intent.gas),
      maxFeePerGas: BigInt(intent.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(intent.maxPriorityFeePerGas),
      nonce: Number(intent.nonce),
    };
    let signed: SignedBytes;
    try {
      signed = await signWithLease(ctx, item.planned.id, signer, envelope);
    } catch (error) {
      throw new ApplyError('signer', safeExternalError(error), {
        actionId: item.planned.id,
        retryable: true,
      });
    }
    const signedRecord = await append(ctx, item.planned.id, {
      ...intentFields(
        { envelope, entry: job.entry, signer, item },
        wave.wave,
        intent.reservationId!,
        attemptId,
        ctx.plan.planHash,
      ),
      phase: 'signed',
      ...signed,
    });
    job.signed = signedRecord;
    job.signedIntent = intent;
    job.variants = [signedRecord];
    ctx.sent.push({
      actionId: item.planned.id,
      wave: wave.wave,
      signer: job.entry.signer,
      nonce: intent.nonce,
      transactionHash: signed.transactionHash.toLowerCase() as Hash,
    });
  }
  const active = jobs.filter((job) => job.records.at(-1)?.phase !== 'verified' && !job.completed);
  const signedActive: (ResumeJob & { signed: SignedRecord })[] = [];
  for (const job of active) {
    if (!job.signed)
      throw new ApplyError(
        'journal',
        `Wave ${wave.wave} has an unsigned active action ${job.item.planned.id}.`,
        { actionId: job.item.planned.id },
      );
    const signed = await replaceSigned(ctx, job.item, job.signed, job.variants);
    job.signed = signed;
    job.signedIntent = intentForSigned(ctx.journal.records, signed);
    signedActive.push({ ...job, signed });
  }
  for (const job of signedActive)
    await report(ctx, 'recovery', {
      actionId: job.item.planned.id,
      transactionHash: job.signed.transactionHash,
      reservationId: job.intent.reservationId,
    });
  if (signedActive.length) await settlePipelineBatch(ctx, signedActive, { rebroadcast: true });
  for (const job of jobs) await decide(ctx, job.item);
  return true;
}

function intentFields(
  job: {
    envelope: CostEnvelope;
    entry: ScheduleEntry;
    signer: SignerAccount;
    item: PreparedAction;
  },
  wave: number,
  reservationId: string,
  waveAttemptId: string | null = null,
  planHash?: Hash,
): import('./types.ts').IntentFields {
  const { envelope, entry } = job;
  if (envelope.nonce === undefined)
    throw new ApplyError(
      'nonce-conflict',
      `Signer ${job.signer.address} has no reserved pipeline nonce.`,
      { actionId: entry.id },
    );
  return {
    phase: 'intent',
    ...(planHash ? pinnedIntentFields(planHash, job.item) : {}),
    wave,
    reservationId,
    ...(waveAttemptId ? { waveAttemptId } : {}),
    signer: job.signer.address,
    signerRole: entry.signerRole,
    pooled: entry.pooled,
    ...(entry.nonceOffset === undefined ? {} : { nonceOffset: entry.nonceOffset }),
    nonce: String(envelope.nonce),
    to: envelope.to,
    value: String(envelope.value),
    dataHash: keccak256(envelope.data),
    gas: String(envelope.gas),
    maxFeePerGas: String(envelope.maxFeePerGas),
    maxPriorityFeePerGas: String(envelope.maxPriorityFeePerGas),
  };
}

/** Pipeline signing reserves each signer group's saved nonce offsets; every intent precedes every signature. */
export interface PipelineSigningInput {
  wave: number;
  work: PipelineFundedJob[];
}

export async function signPipelineBatch(
  ctx: ApplyContext,
  { wave, work }: PipelineSigningInput,
): Promise<PipelineBatchJob[]> {
  await checkReplayCapabilities(
    ctx.client,
    work.map((job) => job.item),
    ctx.verificationClient,
    ctx.plan.chain,
  );
  await checkExecutionDependencies(ctx, work);
  await assertSignerHistory(
    ctx,
    work.map((job) => job.signer.address),
  );
  const groups = new Map<string, FundedJob[]>();
  for (const job of work) {
    const signer = job.signer.address.toLowerCase();
    const group = groups.get(signer) ?? [];
    group.push(job);
    groups.set(signer, group);
  }
  for (const [signer, jobs] of groups) {
    const [latest, pending] = await Promise.all([
      ctx.client.getTransactionCount({ address: signer as Address, blockTag: 'latest' }),
      ctx.client.getTransactionCount({ address: signer as Address, blockTag: 'pending' }),
    ]);
    if (pending !== latest)
      return fail(
        ctx,
        jobs[0]!.item,
        'nonce-conflict',
        `Signer ${signer} has unknown pending transactions.`,
        { signer: signer as Address, nonce: String(latest) },
      );
    for (const [offset, job] of jobs.entries()) {
      if (job.entry.nonceOffset !== offset)
        throw new ApplyError(
          'stale-pipeline',
          `Wave ${wave} has an already satisfied action before ${job.item.planned.id}; create a new pipeline plan.`,
          { actionId: job.item.planned.id },
        );
      job.envelope.nonce = latest + offset;
    }
  }
  // Every intent is durable before any signature. Partial intent groups can be discarded on restart.
  const waveAttemptId = randomUUID();
  const intents = new Map<FundedJob, IntentRecord>();
  for (const jobs of groups.values()) {
    const reservationId = randomUUID();
    for (const job of jobs) {
      if (job.item.resource.kind === 'contract')
        await assertPinnedAbsent(ctx.client, job.item.resource);
      intents.set(
        job,
        await append(
          ctx,
          job.item.planned.id,
          intentFields(job, wave, reservationId, waveAttemptId, ctx.plan.planHash),
        ),
      );
    }
  }
  // The lock remains held and no broadcast starts until every signed record is synced.
  const signedWork: PipelineBatchJob[] = [];
  for (const job of work) {
    const intent = intents.get(job);
    if (!intent?.reservationId || job.envelope.nonce === undefined)
      throw new ApplyError(
        'journal',
        `Wave ${wave} has no durable intent for ${job.item.planned.id}.`,
        { actionId: job.item.planned.id },
      );
    if (job.item.resource.kind === 'contract')
      await assertPinnedAbsent(ctx.client, job.item.resource);
    let signed: SignedBytes;
    try {
      signed = await signWithLease(ctx, job.item.planned.id, job.signer, {
        ...job.envelope,
        nonce: job.envelope.nonce,
      });
    } catch (error) {
      throw new ApplyError('signer', safeExternalError(error), {
        actionId: job.item.planned.id,
        retryable: true,
      });
    }
    const signedRecord = await append(ctx, job.item.planned.id, {
      ...intentFields(job, wave, intent.reservationId, waveAttemptId, ctx.plan.planHash),
      phase: 'signed',
      ...signed,
    });
    signedWork.push({
      ...job,
      intent,
      signedIntent: intent,
      signed: signedRecord,
      variants: [signedRecord],
    });
    const signer = job.signer.address.toLowerCase();
    ctx.sent.push({
      actionId: job.item.planned.id,
      wave,
      signer,
      nonce: String(job.envelope.nonce),
      transactionHash: signed.transactionHash.toLowerCase() as Hash,
    });
  }
  return signedWork;
}

async function pipelineConflict(
  ctx: ApplyContext,
  job: { item: PreparedAction; signed: SignedRecord },
): Promise<never> {
  const { signer, nonce, transactionHash } = job.signed;
  return fail(
    ctx,
    job.item,
    'nonce-conflict',
    `Signer ${signer} nonce ${nonce} for ${job.item.planned.id} was consumed by an unknown transaction; expected ${transactionHash}.`,
    { signer, nonce, transactionHash },
  );
}

async function preparePipelineBroadcast(
  ctx: ApplyContext,
  job: ActivePipelineJob,
): Promise<PipelineAttempt> {
  const { signed } = job;
  let receipt = await findKnownReceipt(ctx.client, job.variants);
  if (receipt) return { receipt };
  if (await nonceConsumed(ctx.client, signed.signer, signed.nonce)) {
    receipt = await findKnownReceipt(ctx.client, job.variants);
    if (receipt) return { receipt };
    await pipelineConflict(ctx, job);
  }
  const pending = await ctx.client.getTransactionCount({
    address: signed.signer,
    blockTag: 'pending',
  });
  if (BigInt(pending) > BigInt(signed.nonce)) {
    const knownBroadcast = ctx.journal
      .forAction(ctx.plan.planHash, job.item.planned.id)
      .some(
        (record) =>
          record.phase === 'broadcast' &&
          job.variants.some((variant) => variant.transactionHash === record.transactionHash),
      );
    if (!knownBroadcast) {
      let knownTransaction = false;
      for (const variant of job.variants) {
        try {
          knownTransaction ||= Boolean(
            await ctx.client.getTransaction({ hash: variant.transactionHash }),
          );
        } catch (error) {
          if (!(error instanceof Error) || error.name !== 'TransactionNotFoundError') throw error;
        }
      }
      if (!knownTransaction) await pipelineConflict(ctx, job);
    }
  }
  return {};
}

async function transactionKnown(client: Client, hash: Hash): Promise<boolean> {
  try {
    return Boolean(await client.getTransaction({ hash }));
  } catch (error) {
    if (error instanceof Error && error.name === 'TransactionNotFoundError') return false;
    throw error;
  }
}

async function recordPipelineBroadcast(
  ctx: ApplyContext,
  job: ActivePipelineJob,
  sent: BroadcastOutcome,
  rebroadcast: boolean,
): Promise<PipelineAttempt> {
  const { signed } = job;
  await append(ctx, job.item.planned.id, {
    phase: 'broadcast-attempt',
    ...(signed.reservationId ? { reservationId: signed.reservationId } : {}),
    signer: signed.signer,
    nonce: signed.nonce,
    transactionHash: signed.transactionHash,
    accepted: sent.accepted,
    ...(!sent.accepted && sent.error ? { error: sent.error } : {}),
    rebroadcast,
  });
  if (sent.accepted) {
    await append(ctx, job.item.planned.id, {
      phase: 'broadcast',
      ...(signed.reservationId ? { reservationId: signed.reservationId } : {}),
      signer: signed.signer,
      nonce: signed.nonce,
      transactionHash: signed.transactionHash,
      rebroadcast,
      ...(sent.known ? { known: true } : {}),
    });
    if (rebroadcast)
      ctx.rebroadcasts.push({
        actionId: job.item.planned.id,
        transactionHash: signed.transactionHash,
      });
  } else if (sent.nonceTooLow) {
    const receipt = await findKnownReceipt(ctx.client, job.variants);
    if (receipt) return { receipt };
    await pipelineConflict(ctx, job);
  }
  return { accepted: sent.accepted };
}

// Starts the raw request before its first await, so a group's requests begin in nonce order.

async function sendPipelineTransaction(
  ctx: ApplyContext,
  job: ActivePipelineJob,
  rebroadcast: boolean,
): Promise<PipelineAttempt> {
  const started = Date.now();
  const sent = await broadcast(ctx.client, job.signed.rawTransaction);
  await report(ctx, 'broadcast-result', {
    actionId: job.item.planned.id,
    transactionHash: job.signed.transactionHash,
    rebroadcast,
    accepted: sent.accepted,
    broadcastLatencyMs: Date.now() - started,
  });
  return recordPipelineBroadcast(ctx, job, sent, rebroadcast);
}

async function attemptPipelineBroadcast(
  ctx: ApplyContext,
  job: ActivePipelineJob,
  rebroadcast: boolean,
): Promise<PipelineAttempt> {
  const prepared = await preparePipelineBroadcast(ctx, job);
  if (prepared.receipt) return prepared;
  await ctx.lock.assertHeld?.();
  return sendPipelineTransaction(ctx, job, rebroadcast);
}

export async function settlePipelineBatch(
  ctx: ApplyContext,
  work: ActivePipelineJob[],
  { rebroadcast = false }: { rebroadcast?: boolean } = {},
): Promise<void> {
  for (const job of work) {
    try {
      await validateSignedTransaction(
        job.signed,
        job.signedIntent ?? job.intent,
        job.item.planned,
        ctx.plan.chain.id,
      );
    } catch (error) {
      throw new ApplyError(
        'journal',
        `${job.item.planned.id}: ${error instanceof Error ? error.message : String(error)}`,
        { actionId: job.item.planned.id },
      );
    }
    assertPinnedSignedIntent(ctx.journal.records, ctx.plan.planHash, job.item, job.signed);
  }
  const submitStart = Date.now();
  // Reconcile the complete group first. Then initiate all raw requests in plan
  // order without waiting for a lower nonce's RPC response.
  const prepared = await Promise.all(work.map((job) => preparePipelineBroadcast(ctx, job)));
  // One lease check covers the group, so no await separates its first requests.
  await ctx.lock.assertHeld?.();
  const firstAttempts = await Promise.all(
    work.map(async (job, index) => {
      if (prepared[index]?.receipt) return prepared[index]!;
      try {
        return await sendPipelineTransaction(ctx, job, rebroadcast);
      } catch (error) {
        return { error };
      }
    }),
  );
  ctx.timings.submitMs += Date.now() - submitStart;
  const settled = await Promise.allSettled(
    work.map(async (job, index) => {
      let attempt: PipelineAttempt = firstAttempts[index]!;
      if (attempt.error) throw attempt.error;
      const deadline = Date.now() + ctx.config.receiptTimeoutMs;
      let knownRetryAt = Date.now() + 1_000;
      const receiptStart = Date.now();
      let receipt = attempt.receipt;
      while (!receipt) {
        if (!attempt.accepted) {
          const retryStart = Date.now();
          try {
            while (!attempt.accepted && !attempt.receipt) {
              if (Date.now() >= deadline)
                throw new ApplyError(
                  'broadcast-failed',
                  `Broadcast of ${job.signed.transactionHash} did not succeed before timeout. Rerun to retry the same bytes.`,
                  { actionId: job.item.planned.id, retryable: true },
                );
              await pause(ctx.config.pollIntervalMs);
              attempt = await attemptPipelineBroadcast(ctx, job, true);
            }
          } finally {
            ctx.timings.submitMs += Date.now() - retryStart;
          }
          if (attempt.receipt) {
            receipt = attempt.receipt;
            break;
          }
        }
        const waited = await waitForReceipt(ctx.client, {
          signedVariants: job.variants ?? [job.signed],
          signer: job.signed.signer,
          nonce: job.signed.nonce,
          pollIntervalMs: ctx.config.pollIntervalMs,
          timeoutMs: Math.min(1_000, Math.max(0, deadline - Date.now())),
        });
        if ('dead' in waited) await pipelineConflict(ctx, job);
        if ('receipt' in waited) {
          receipt = waited.receipt;
          break;
        }
        if (Date.now() >= deadline)
          throw new ApplyError(
            'receipt-timeout',
            `No receipt for ${job.signed.transactionHash}. Rerun to resume the same transaction.`,
            { actionId: job.item.planned.id, retryable: true },
          );
        // A node can acknowledge a higher nonce and leave it queued after lower
        // nonces settle. Retry the same durable bytes if it disappears or stalls.
        const known = await transactionKnown(ctx.client, job.signed.transactionHash);
        if (!known || Date.now() >= knownRetryAt) {
          const retryStart = Date.now();
          try {
            attempt = await attemptPipelineBroadcast(ctx, job, true);
          } finally {
            ctx.timings.submitMs += Date.now() - retryStart;
          }
          knownRetryAt = Date.now() + 10_000;
          receipt = attempt.receipt;
        }
      }
      if (!receipt)
        throw new ApplyError('receipt-timeout', `No receipt for ${job.signed.transactionHash}.`, {
          actionId: job.item.planned.id,
          retryable: true,
        });
      if (!firstAttempts[index]?.receipt)
        await report(ctx, 'receipt-observed', {
          actionId: job.item.planned.id,
          transactionHash: receipt.transactionHash,
          receiptLatencyMs: Date.now() - receiptStart,
        });
      ctx.timings.receiptMs += Date.now() - receiptStart;
      const mined = matchingVariant(job.variants ?? [job.signed], receipt);
      await recordReceipt(ctx, job.item, mined, receipt);
      await finish(ctx, job.item, mined, receipt);
    }),
  );
  const rejected = settled.find((result) => result.status === 'rejected');
  if (rejected) throw rejected.reason;
}
