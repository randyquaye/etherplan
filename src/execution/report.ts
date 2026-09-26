import { jsonSafe } from './preflight.ts';
import { ApplyError } from './errors.ts';
import type { Plan } from '../planning/types.ts';
import type { ResourceId } from '../types.ts';
import type { VerificationResult } from '../verification/types.ts';
import type { ApplyContext, ApplyResult, FailedFields, FailureCode, JournalPhaseFields, JournalRecord, JournalRecordInput, PreparedAction, ReportEvent, ReportEventType, ResourceOutcomeSummary, VerificationSummary } from './types.ts';

export async function report(ctx: ApplyContext, type: ReportEventType, fields: Record<string, unknown> = {}): Promise<void> {
  const event = jsonSafe({ type, at: new Date().toISOString(), planHash: ctx.plan.planHash, chain: ctx.plan.chain, scope: ctx.scope, principal: ctx.principal, ...fields }) as ReportEvent;
  if (typeof ctx.config.reporter === 'function') await ctx.config.reporter(event);
  else await ctx.config.reporter?.emit(event);
}

export function summarizeVerification(verification: VerificationResult): VerificationSummary {
  return jsonSafe({
    status: verification.status,
    address: verification.address,
    codeHash: verification.codeHash,
    codeComparison: verification.codeComparison,
    missingProofs: verification.missingProofs,
    reasons: verification.reasons,
    failedProofs: (verification.proofs ?? []).filter(proof => !proof.matched).map(({ name, method }) => ({ name, method })),
    bindingChecks: (verification.bindingChecks ?? []).map(({ name, functionName, observed, actual, error }) => ({ name, functionName, observed, actual, error })),
  });
}

export async function append<T extends JournalPhaseFields>(ctx: ApplyContext, actionId: ResourceId, fields: T, identity: Pick<Plan, 'planHash' | 'chain'> = ctx.plan): Promise<JournalRecord & T> {
  await ctx.lock.assertHeld?.();
  const started = Date.now();
  const record = await ctx.journal.append({ ...jsonSafe(fields), planHash: identity.planHash, chain: identity.chain, actionId, ...(ctx.remote && ctx.principal ? { principal: ctx.principal } : {}) } as unknown as JournalRecordInput);
  await report(ctx, record.phase === 'failed' ? 'terminal-failure' : record.phase, { actionId, sequence: record.sequence,
    transactionHash: 'transactionHash' in record ? record.transactionHash : undefined,
    signer: 'signer' in record ? record.signer : undefined,
    nonce: 'nonce' in record ? record.nonce : undefined,
    journalAppendLatencyMs: Date.now() - started, ...(record.phase === 'broadcast' ? { rebroadcast: record.rebroadcast } : {}) });
  await ctx.config.hooks.afterRecord?.(record);
  return record as JournalRecord & T;
}

export async function fail(ctx: ApplyContext, item: PreparedAction, code: FailureCode, reason: string, { retryable = false, evidence, ...fields }: Omit<Partial<Omit<FailedFields, 'phase' | 'code' | 'reason'>>, 'evidence'> & { evidence?: unknown } = {}): Promise<never> {
  await append(ctx, item.planned.id, { phase: 'failed', code, reason, retryable, ...fields, ...(evidence === undefined ? {} : { evidence: jsonSafe(evidence) as import('../types.ts').JsonValue }) });
  ctx.outcomes.set(item.planned.id, { id: item.planned.id, action: item.planned.action, outcome: 'failed',
    code, reason, retryable, ...fields });
  throw new ApplyError(code, reason, { actionId: item.planned.id, evidence, retryable });
}

export function summary(ctx: ApplyContext, status: ApplyResult['status'], error?: Error & Partial<ApplyError>): ApplyResult {
  const resources: ResourceOutcomeSummary[] = ctx.plan.resources.map(resource => {
    const outcome = ctx.outcomes.get(resource.id);
    if (!outcome) return { id: resource.id, action: resource.action, outcome: 'pending' };
    if (!('verification' in outcome)) return outcome;
    const { verification, ...rest } = outcome;
    return { ...rest, verification: summarizeVerification(verification) };
  });
  return jsonSafe({
    status,
    planHash: ctx.plan.planHash,
    chain: ctx.plan.chain,
    parallel: ctx.parallel,
    pipeline: ctx.pipeline,
    timings: ctx.timings,
    transactionsSigned: ctx.sent.length,
    transactions: ctx.sent,
    rebroadcasts: ctx.rebroadcasts,
    resources,
    ...(ctx.schedule ? { schedule: ctx.schedule } : {}),
    lockRecovered: ctx.lock.recovered,
    journal: { file: ctx.journal.file, tornTailRemoved: ctx.journal.tornTail !== null },
    state: ctx.state,
    ...(error ? { stoppedAt: { ...(error.code ? { code: error.code } : {}), ...(error.actionId ? { actionId: error.actionId } : {}), message: error.message, ...(error.retryable !== undefined ? { retryable: error.retryable } : {}) } } : {}),
  } satisfies ApplyResult);
}
