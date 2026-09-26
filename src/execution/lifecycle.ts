import { hashJson } from '../identity.ts';
import { createSchedule } from '../scheduling/index.ts';
import { preflight } from './preflight.ts';
import { ApplyError } from './errors.ts';
import { roleOf } from './shared.ts';
import { commitments } from './funding.ts';
import { checkExecutionDependencies, recheckReused, revalidateVerified } from './outcome.ts';
import { settleJournal } from './settlement.ts';
import { pipelineAttempt, resumePipelineWave, signPipelineBatch, settlePipelineBatch } from './pipeline.ts';
import { prepareBatch, signBatch, settleBatch } from './batch.ts';
import { checkBatchFunding } from './funding.ts';
import { report, summary } from './report.ts';
import { openApplyContext } from './context.ts';
import type { Address } from '../types.ts';
import type { ScheduleEntry } from '../scheduling/types.ts';
import type { StateFile } from '../state/types.ts';
import type { ApplyContext, ApplyInput, ApplyResult, PipelineFundedJob, JournalRecord, ReceiptFields, StateWriteResult } from './types.ts';

async function runBatch(ctx: ApplyContext, wave: number, batch: ScheduleEntry[]): Promise<void> {
  if (!ctx.pipeline && new Set(batch.map(entry => entry.signer)).size !== batch.length) throw new ApplyError('schedule', `Wave ${wave} has a batch with two actions for one signer.`);
  const work = await prepareBatch(ctx, batch);
  if (work.length === 0) return;
  if (ctx.pipeline && work.length !== batch.length) throw new ApplyError('stale-pipeline', `Wave ${wave} no longer matches its saved nonce offsets. Create a new pipeline plan.`);
  await checkBatchFunding(ctx, work);
  if (ctx.pipeline) {
    // createSchedule gives pipeline entries saved offsets; signPipelineBatch checks each
    // group against its reserved sequence before it records an intent.
    const signingStart = Date.now();
    const signed = await signPipelineBatch(ctx, { wave, work: work as PipelineFundedJob[] });
    ctx.timings.submitMs += Date.now() - signingStart;
    await settlePipelineBatch(ctx, signed);
  } else {
    // Serial batches take a fresh nonce and reject any unknown pending nonce.
    const signed = await signBatch(ctx, { wave, work });
    await settleBatch(ctx, signed);
  }
}

async function persist(ctx: ApplyContext): Promise<StateWriteResult> {
  await revalidateVerified(ctx);
  if (!ctx.deps.recordResource) return { file: ctx.stateFile, written: false, reason: 'The state module has no recordResource function.' };
  const verified = ctx.plan.resources.filter(resource => {
    const outcome = ctx.outcomes.get(resource.id);
    return outcome && 'verification' in outcome;
  });
  if (verified.length === 0) return { file: ctx.stateFile, written: false, reason: 'No resource is verified yet.' };
  const current = await ctx.readState();
  assertFreshState(ctx, current.value);
  let state = current.value;
  for (const resource of verified) {
    const item = ctx.prepared.get(resource.id);
    const outcome = ctx.outcomes.get(resource.id);
    if (!item || !outcome || !('verification' in outcome)) throw new ApplyError('plan-format', `Verified resource ${resource.id} has no prepared action or verification.`, { actionId: resource.id });
    const transactions = ctx.journal.forAction(ctx.plan.planHash, resource.id)
      .filter((record): record is JournalRecord & ReceiptFields => record.phase === 'receipt' && record.receipt.status === 'success')
      .map(record => record.transactionHash);
    state = ctx.deps.recordResource({ resource: item.resource, verification: outcome.verification, state, chain: ctx.plan.chain, transactions });
  }
  if (!state) throw new ApplyError('stale-state', 'Verified resources did not produce a state file.');
  await ctx.lock.assertHeld?.();
  await ctx.writeState(current.version, { ...state, lastPlanHash: ctx.plan.planHash });
  return { file: ctx.stateFile, written: true, resources: verified.length };
}

function assertFreshState(ctx: ApplyContext, state: StateFile | null): void {
  if (typeof ctx.plan.stateHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(ctx.plan.stateHash) ||
    (hashJson(state) !== ctx.plan.stateHash && state?.lastPlanHash !== ctx.plan.planHash)) {
    throw new ApplyError('stale-state', 'State changed after this plan was created. Create a new plan.');
  }
}

async function run(ctx: ApplyContext): Promise<ApplyResult> {
  ctx.prepared = await preflight(ctx);
  ctx.preflightComplete = true;
  ctx.stateSnapshot = (await ctx.readState()).value;
  if (ctx.stateSnapshot && (ctx.stateSnapshot.chain?.id !== ctx.plan.chain.id || ctx.stateSnapshot.chain.genesisHash.toLowerCase() !== ctx.plan.chain.genesisHash.toLowerCase())) {
    throw new ApplyError('wrong-chain', 'State belongs to a different chain than the saved plan.');
  }
  assertFreshState(ctx, ctx.stateSnapshot);
  const ownerActions = ctx.plan.resources.filter(resource => ['deploy', 'call'].includes(resource.action) && roleOf(resource) === 'owner');
  if (ownerActions.length && !ctx.lanes.owner) throw new ApplyError('signer', `The plan has owner actions (${ownerActions.map(resource => resource.id).join(', ')}), but no owner signer was supplied.`);
  if (ctx.pipeline !== Boolean(ctx.plan.pipeline)) throw new ApplyError('pipeline-plan', 'A pipeline apply requires a saved pipeline plan, and a pipeline plan requires --pipeline.');
  const deployers = ctx.lanes.pool.map(account => account.address.toLowerCase() as Address);
  const owner = (ctx.pipeline || ownerActions.length) ? ctx.lanes.owner?.address.toLowerCase() as Address ?? null : null;
  const pinned = ctx.plan.pipeline ?? ctx.plan.signers;
  const hasWrites = ctx.plan.resources.some(resource => ['deploy', 'call'].includes(resource.action));
  if (hasWrites && (!pinned || !Array.isArray(pinned.deployers) || pinned.deployers.length === 0 ||
    typeof pinned.parallel !== 'boolean' || typeof ctx.plan.maxSpendWei !== 'string' ||
    !/^[0-9]+$/.test(ctx.plan.maxSpendWei) || BigInt(ctx.plan.maxSpendWei) === 0n)) {
    throw new ApplyError('plan-policy', 'The saved plan needs signer addresses and a positive maxSpendWei ceiling. Create a new plan.');
  }
  if (pinned && (hashJson(deployers) !== hashJson(pinned.deployers) || owner !== pinned.owner || ctx.parallel !== pinned.parallel)) {
    throw new ApplyError('signer', 'The supplied signers or parallel setting differ from the saved plan.');
  }
  ctx.schedule = createSchedule(ctx.plan, deployers, { owner, parallel: ctx.parallel, pipeline: ctx.pipeline });
  if (ctx.pipeline && ctx.plan.pipeline && hashJson(ctx.schedule.waves) !== hashJson(ctx.plan.pipeline.waves)) throw new ApplyError('pipeline-plan', 'The saved pipeline schedule differs from the plan resources.');
  if (ctx.schedule.deferred.length) throw new ApplyError('unschedulable', `Some actions have dependencies that the plan cannot satisfy: ${ctx.schedule.deferred.map(entry => entry.id).join(', ')}.`, { evidence: ctx.schedule.deferred });
  await commitments(ctx);
  await revalidateVerified(ctx);
  await settleJournal(ctx);
  await recheckReused(ctx);
  // Preserve the dependency check for a later signed wave before revisiting
  // completed earlier waves. This also stops a resend if its prerequisite drifted.
  if (ctx.pipeline) {
    for (const wave of ctx.schedule.waves) {
      if (!pipelineAttempt(ctx, wave)) continue;
      const work = wave.batches.flat().map(entry => {
        const item = ctx.prepared.get(entry.id);
        if (!item) throw new ApplyError('plan-format', `Scheduled action ${entry.id} has no prepared resource.`, { actionId: entry.id });
        return { item };
      });
      await checkExecutionDependencies(ctx, work, false);
    }
  }
  for (const wave of ctx.schedule.waves) {
    await revalidateVerified(ctx);
    if (ctx.pipeline && await resumePipelineWave(ctx, wave)) {
      ctx.state = await persist(ctx);
      continue;
    }
    for (const batch of wave.batches) {
      await revalidateVerified(ctx);
      await runBatch(ctx, wave.wave, batch);
      ctx.state = await persist(ctx);
    }
  }
  ctx.state = await persist(ctx);
  return summary(ctx, 'applied');
}

// Applies a pinned plan under one writer lock, with a durable journal record before every broadcast.
export async function applyPlan(input: ApplyInput): Promise<ApplyResult> {
  const { ctx, lockStarted, close } = await openApplyContext(input);
  try {
    await report(ctx, 'lock-acquisition', { holder: ctx.lock.holder, fencingTokens: 'fence' in ctx.lock ? ctx.lock.fence.map(entry => entry.token) : undefined, lockWaitMs: Date.now() - lockStarted });
    try {
      return await run(ctx);
    } catch (error) {
      if (!error || typeof error !== 'object') throw error;
      const failure = error as Error & Partial<ApplyError>;
      await report(ctx, failure.code === 'conflict' || failure.code === 'plan-mismatch' ? 'conflict' : 'terminal-failure', { actionId: failure.actionId, code: failure.code, reason: failure.message }).catch(() => {});
      if (ctx.preflightComplete) {
        try {
          ctx.state = await persist(ctx);
        } catch (stateError) {
          ctx.state = { file: ctx.stateFile, written: false, reason: stateError instanceof Error ? stateError.message : String(stateError) };
        }
      }
      failure.result = summary(ctx, 'stopped', failure);
      throw error;
    }
  } finally {
    await close();
  }
}
