import { hashJson } from '../identity.ts';
import { checkFactory, jsonSafe } from './preflight.ts';
import { LIVE_PHASES, latestRecord } from './journal.ts';
import { findReceipt } from './transactions.ts';
import { ApplyError } from './errors.ts';
import { pause } from './shared.ts';
import { recoveryProof, sameRecoveryProof } from '../recovery.ts';
import { STATEFUL_CONSTRUCTOR_LIMITATION_URL } from '../verification/limitations.ts';
import { assertPinnedAbsent, pinnedJournalCommitment } from '../verification/pinned-runtime.ts';
import { append, fail, summarizeVerification } from './report.ts';
import type { Hash, ResourceId } from '../types.ts';
import type { VerificationResult } from '../verification/types.ts';
import type { ApplyContext, JournalRecord, PreparedAction, Receipt, ReceiptJson, SignedRecord, VerifiedFields } from './types.ts';

const lower = (value: string | null | undefined): string | null => typeof value === 'string' ? value.toLowerCase() : value ?? null;

export async function verify(ctx: ApplyContext, item: PreparedAction, options: import('../verification/types.ts').VerifyOptions = {}): Promise<VerificationResult> {
  const id = item.planned.id;
  const outcome = ctx.outcomes.get(id);
  const saved = options.creationProof ?? (outcome && 'verification' in outcome ? outcome.verification.creationProof : undefined) ??
    ctx.stateSnapshot?.resources?.[id]?.creationProof ?? (item.planned.action === 'reuse' ? item.planned.observation.creationProof : undefined);
  const transactionHash = options.transactionHash ?? saved?.transactionHash ?? ctx.stateSnapshot?.resources?.[id]?.provenance?.creationTransactionHash ?? ctx.stateSnapshot?.resources?.[id]?.transactions?.at(-1);
  // An explicit journal proof must be checked even if its hash disagrees with
  // the record. A proof from previous state may belong to a replaced address.
  const creationProof = options.creationProof ?? (saved && (!transactionHash || saved.transactionHash.toLowerCase() === transactionHash.toLowerCase()) ? saved : undefined);
  return ctx.deps.verifyResource(item.resource, ctx.client, { ...options, chain: ctx.plan.chain, journalRecords: ctx.journal.records,
    ...(transactionHash ? { transactionHash } : {}), ...(creationProof ? { creationProof } : {}) });
}

export async function markVerified(ctx: ApplyContext, item: PreparedAction, verification: VerificationResult, fields: Pick<VerifiedFields, 'outcome'> & Partial<Pick<VerifiedFields, 'transactionHash' | 'blockNumber' | 'revertedTransaction' | 'unsentTransaction'>>): Promise<void> {
  const { planned } = item;
  await append(ctx, planned.id, { phase: 'verified', address: planned.address, codeHash: verification.codeHash, proofHash: hashJson(jsonSafe(verification)), verification: summarizeVerification(verification), ...(verification.creationProof ? { creationProof: verification.creationProof } : {}), ...fields });
  ctx.outcomes.set(planned.id, { id: planned.id, action: planned.action, outcome: fields.outcome, address: planned.address,
    ...(fields.transactionHash ? { transactionHash: fields.transactionHash } : {}), verification });
}

// Reads the chain before a write: a satisfied postcondition needs no transaction, a failed precondition is a conflict.

export async function precondition(ctx: ApplyContext, item: PreparedAction): Promise<{ satisfied: boolean; verification?: VerificationResult }> {
  const { planned } = item;
  if (planned.action === 'deploy' && planned.kind === 'contract') {
    if (!planned.factory) throw new ApplyError('plan-format', `Action ${planned.id} has no CREATE2 factory.`, { actionId: planned.id });
    await checkFactory(ctx.client, planned.factory);
    const code = await ctx.client.getCode({ address: planned.address });
    if (!code || code === '0x') {
      await assertPinnedAbsent(ctx.client, item.resource as import('../planning/types.ts').PreparedContract);
      return { satisfied: false };
    }
    return fail(ctx, item, 'conflict', 'The planned CREATE2 address acquired code without this plan settling a successful deployment transaction. Review and import it explicitly if it is intended.', { evidence: { status: 'conflict', address: planned.address } });
  }
  const verification = await verify(ctx, item);
  const observed = (verification.bindingChecks ?? []).map(check => check.observed);
  if (verification.status === 'verified' && observed.length > 0 && observed.every(state => state === 'after')) return { satisfied: true, verification };
  if (observed.length > 0 && observed.every(state => state === 'before')) return { satisfied: false, verification };
  return fail(ctx, item, 'conflict', 'The binding has neither its allowed before value nor its desired value.', { evidence: summarizeVerification(verification) });
}

export async function stableReceipt(ctx: ApplyContext, transactionHash: Hash, receipt: Receipt | ReceiptJson, actionId: ResourceId, wait = false): Promise<Receipt> {
  const deadline = Date.now() + ctx.config.receiptTimeoutMs;
  for (;;) {
    const current = await findReceipt(ctx.client, transactionHash);
    const block = current && await ctx.client.getBlock({ blockNumber: BigInt(receipt.blockNumber) });
    if (!current || current.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      current.blockNumber !== BigInt(receipt.blockNumber) || block?.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
      throw new ApplyError('reorg', `Receipt for ${transactionHash} is no longer in its canonical block.`, { actionId, retryable: true });
    }
    if (ctx.config.confirmations === 1 ||
      (await ctx.client.getBlock({ blockTag: 'latest' })).number - current.blockNumber + 1n >= BigInt(ctx.config.confirmations)) return current;
    if (!wait || Date.now() >= deadline) throw new ApplyError('finality', `Transaction ${transactionHash} has fewer than ${ctx.config.confirmations} confirmations.`, { actionId, retryable: true });
    await pause(ctx.config.pollIntervalMs);
  }
}

export async function revalidateVerified(ctx: ApplyContext): Promise<void> {
  for (const item of ctx.prepared.values()) {
    const records = ctx.journal.forAction(ctx.plan.planHash, item.planned.id);
    const latest = records.at(-1);
    if (latest?.phase !== 'verified') continue;
    const hash = latest.transactionHash ?? latest.revertedTransaction;
    if (!hash) continue;
    const receipt = records.filter((record): record is JournalRecord & import('./types.ts').ReceiptFields => record.phase === 'receipt' && record.transactionHash === hash).at(-1)?.receipt;
    if (!receipt) throw new ApplyError('journal', `Verified action ${item.planned.id} has no receipt.`, { actionId: item.planned.id });
    await stableReceipt(ctx, hash, receipt, item.planned.id);
  }
}

/** Read every completed resource at one canonical block before persisting or reporting success. */
export async function revalidateDesiredState(ctx: ApplyContext): Promise<{ number: bigint; hash: Hash }> {
  const block = await ctx.client.getBlock({ blockTag: 'latest' });
  const fresh = new Map<ResourceId, VerificationResult>();
  for (const resource of ctx.plan.resources) {
    const item = ctx.prepared.get(resource.id);
    const outcome = ctx.outcomes.get(resource.id);
    if (!item || !outcome || !('verification' in outcome)) {
      throw new ApplyError('postcondition', `Resource ${resource.id} has no completed verification.`, { actionId: resource.id });
    }
    const verificationStart = Date.now();
    const verification = await verify(ctx, item, { blockNumber: block.number });
    ctx.timings.verificationMs += Date.now() - verificationStart;
    if (verification.status !== 'verified') {
      throw new ApplyError('postcondition', `The final desired condition is ${verification.status}.`, {
        actionId: resource.id, evidence: { blockNumber: String(block.number), blockHash: block.hash, verification: summarizeVerification(verification) },
      });
    }
    fresh.set(resource.id, verification);
  }
  await assertCanonicalSnapshot(ctx, block);
  for (const [id, verification] of fresh) {
    const outcome = ctx.outcomes.get(id)!;
    if ('verification' in outcome) ctx.outcomes.set(id, { ...outcome, verification });
  }
  return { number: block.number, hash: block.hash };
}

export async function assertCanonicalSnapshot(ctx: ApplyContext, snapshot: { number: bigint; hash: Hash }): Promise<void> {
  const block = await ctx.client.getBlock({ blockNumber: snapshot.number });
  if (block.hash.toLowerCase() !== snapshot.hash.toLowerCase()) {
    throw new ApplyError('reorg', `Final verification block ${snapshot.number} is no longer canonical.`, {
      retryable: true, evidence: { expected: snapshot.hash, actual: block.hash },
    });
  }
}

// A receipt does not complete an action. Verify the postcondition at its canonical block.
export async function finish(ctx: ApplyContext, item: PreparedAction, signed: SignedRecord, receipt: Receipt): Promise<void> {
  const transactionHash = signed.transactionHash;
  await stableReceipt(ctx, transactionHash, receipt, item.planned.id, true);
  if (receipt.status !== 'success') {
    if (item.planned.action === 'deploy') {
      return fail(ctx, item, 'reverted', `Deployment transaction ${transactionHash} reverted; matching code at the target cannot establish this plan's creator.`, { transactionHash });
    }
    const verificationStart = Date.now();
    const verification = await verify(ctx, item, { blockNumber: receipt.blockNumber, transactionHash, account: signed.signer });
    ctx.timings.verificationMs += Date.now() - verificationStart;
    await stableReceipt(ctx, transactionHash, receipt, item.planned.id);
    if (verification.status === 'verified') return markVerified(ctx, item, verification, { outcome: 'already-satisfied', revertedTransaction: transactionHash });
    await fail(ctx, item, 'reverted', `Transaction ${transactionHash} reverted in block ${receipt.blockNumber}.`, { transactionHash, evidence: summarizeVerification(verification) });
  }
  const verificationStart = Date.now();
  const verification = await verify(ctx, item, { blockNumber: receipt.blockNumber, transactionHash, account: signed.signer,
    ...(item.planned.action === 'deploy' ? { expectedCreator: signed.signer } : {}) });
  ctx.timings.verificationMs += Date.now() - verificationStart;
  await stableReceipt(ctx, transactionHash, receipt, item.planned.id);
  if (verification.status !== 'verified') {
    const replayHelp = item.planned.action === 'deploy' &&
      verification.missingProofs.some(reason => reason.includes(STATEFUL_CONSTRUCTOR_LIMITATION_URL))
      ? ` See the stateful constructor limitation and recovery steps: ${STATEFUL_CONSTRUCTOR_LIMITATION_URL}` : '';
    await fail(ctx, item, 'postcondition', `Transaction ${transactionHash} succeeded, but the result is ${verification.status}.${replayHelp}`, { transactionHash, evidence: summarizeVerification(verification) });
  }
  if (item.planned.action === 'deploy' &&
    (verification.creationProof?.kind !== 'create2' || verification.creationProof.transactionHash.toLowerCase() !== transactionHash.toLowerCase() ||
      verification.creationProof.creator.toLowerCase() !== signed.signer.toLowerCase())) {
    return fail(ctx, item, 'postcondition', 'Deployment verification has no creation proof from the planned signer.', { transactionHash, evidence: summarizeVerification(verification) });
  }
  if (item.resource.kind === 'contract' && item.resource.creationProofMode === 'pinned-runtime') {
    const proof = verification.creationProof;
    const commitment = pinnedJournalCommitment(ctx.journal.records, item.resource, transactionHash, ctx.plan.planHash, signed.signer,
      { blockHash: receipt.blockHash, blockNumber: receipt.blockNumber }, ctx.plan.chain);
    if (proof?.kind !== 'create2' || proof.method !== 'pinned-runtime' || !commitment ||
      lower(proof.originPlanHash) !== lower(ctx.plan.planHash) || lower(proof.intentCommitment) !== lower(commitment.commitment)) {
      return fail(ctx, item, 'postcondition', 'Deployment verification lacks this plan’s pre-sign pinned-runtime commitment.', { transactionHash, evidence: summarizeVerification(verification) });
    }
  }
  await markVerified(ctx, item, verification, { outcome: 'applied', transactionHash, blockNumber: String(receipt.blockNumber) });
}

function checkArtifactDrift(ctx: ApplyContext, item: PreparedAction, verification: VerificationResult): { previousArtifactHash: Hash; artifactHash: Hash } | null {
  const drift = item.planned.observation?.stateComparison?.artifactDrift;
  if (!drift) return null;
  const { id } = item.planned;
  if (item.planned.kind !== 'contract' || drift.accepted !== true || lower(drift.artifactHash) !== lower(item.planned.artifactHash)) {
    throw new ApplyError('plan-not-applicable', `${id} is reused without an accepted artifact drift for its planned artifact.`, { actionId: id });
  }
  const record = ctx.stateSnapshot?.resources?.[id];
  const saved = record ? { address: record.address, initcodeHash: record.initcodeHash ?? null, inputsHash: record.inputsHash, salt: record.salt ?? null, codeHash: record.codeHash ?? null } : null;
  if (!saved || !record || hashJson(jsonSafe(saved)) !== hashJson(jsonSafe(drift.baseline)) ||
    ![lower(drift.previousArtifactHash), lower(drift.artifactHash)].includes(lower(record.artifactHash))) {
    throw new ApplyError('stale-state', `The saved state for ${id} changed after the plan accepted its artifact drift. Create a new plan.`, {
      actionId: id, evidence: { expected: { ...drift.baseline, artifactHash: drift.previousArtifactHash }, actual: saved && { ...saved, artifactHash: record?.artifactHash } },
    });
  }
  if (lower(verification.codeHash) !== lower(drift.baseline.codeHash)) {
    throw new ApplyError('drift', `The live code for ${id} changed after the plan accepted its artifact drift. Create a new plan.`, { actionId: id, evidence: summarizeVerification(verification) });
  }
  return { previousArtifactHash: drift.previousArtifactHash, artifactHash: drift.artifactHash };
}

/** Reject a saved recovered proof before settling or sending any transaction. */
export function assertRecoveryEvidence(ctx: ApplyContext): void {
  for (const item of ctx.prepared.values()) {
    if (item.planned.action !== 'reuse') continue;
    if (item.resource.kind === 'contract' && item.resource.initcode && !ctx.stateSnapshot?.resources?.[item.planned.id]) {
      const recovered = recoveryProof(ctx.journal.records, item.resource, ctx.plan.chain);
      if (!sameRecoveryProof(recovered, item.planned.observation.creationProof)) {
        throw new ApplyError('journal', `The recovered creation proof for ${item.planned.id} is absent or differs from the saved plan.`, { actionId: item.planned.id });
      }
    }
  }
}

export async function recheckReused(ctx: ApplyContext): Promise<void> {
  for (const item of ctx.prepared.values()) {
    if (item.planned.action !== 'reuse') continue;
    const verification = await verify(ctx, item);
    if (verification.status !== 'verified') {
      throw new ApplyError('drift', `A resource that the plan reuses is now ${verification.status}. Create a new plan.`, { actionId: item.planned.id, evidence: summarizeVerification(verification) });
    }
    if (item.resource.kind === 'contract' && item.resource.initcode !== undefined && !verification.creationProof) {
      const imported = ctx.stateSnapshot?.resources[item.planned.id];
      if (imported?.provenance?.kind !== 'import' || imported.address.toLowerCase() !== item.resource.address.toLowerCase() ||
        imported.initcodeHash?.toLowerCase() !== item.resource.initcodeHash?.toLowerCase() || imported.inputsHash !== item.resource.inputsHash) {
        throw new ApplyError('unverified', 'A reused CREATE2 deployment has no verified creation transaction or explicit import.', { actionId: item.planned.id });
      }
    }
    const artifactDrift = checkArtifactDrift(ctx, item, verification);
    ctx.outcomes.set(item.planned.id, { id: item.planned.id, action: 'reuse', outcome: 'reused', address: item.planned.address, verification, ...(artifactDrift ? { artifactDrift } : {}) });
  }
}

// Returns the item if it needs a new transaction.

export async function decide(ctx: ApplyContext, item: PreparedAction): Promise<PreparedAction | null> {
  const records = ctx.journal.forAction(ctx.plan.planHash, item.planned.id);
  const latest = latestRecord(records);
  if (latest?.phase === 'verified') {
    const signed = item.planned.action === 'deploy' && latest.transactionHash
      ? records.find(record => record.phase === 'signed' && record.transactionHash.toLowerCase() === latest.transactionHash?.toLowerCase())
      : undefined;
    const expectedCreator = signed?.phase === 'signed' ? signed.signer : null;
    if (item.planned.action === 'deploy' && (!latest.transactionHash || !expectedCreator)) {
      throw new ApplyError('journal', 'A verified deployment has no matching signed transaction.', { actionId: item.planned.id });
    }
    const verification = await verify(ctx, item, { ...(latest.transactionHash ? { transactionHash: latest.transactionHash } : {}),
      ...(latest.creationProof ? { creationProof: latest.creationProof } : {}),
      ...(expectedCreator ? { expectedCreator } : {}) });
    if (verification.status !== 'verified') {
      await fail(ctx, item, 'drift', `The action verified earlier but is now ${verification.status}.`, { evidence: summarizeVerification(verification) });
    }
    if (item.planned.action === 'deploy' &&
      (verification.creationProof?.kind !== 'create2' || verification.creationProof.transactionHash.toLowerCase() !== latest.transactionHash?.toLowerCase() ||
        verification.creationProof.creator.toLowerCase() !== expectedCreator?.toLowerCase())) {
      throw new ApplyError('journal', 'A verified deployment has no valid creation proof from its signed transaction.', { actionId: item.planned.id });
    }
    ctx.outcomes.set(item.planned.id, { id: item.planned.id, action: item.planned.action, outcome: latest.outcome, address: item.planned.address,
      ...(latest.transactionHash ? { transactionHash: latest.transactionHash } : {}), verification, resumed: true });
    return null;
  }
  if (latest?.phase === 'failed' && !latest.retryable) {
    throw new ApplyError('previous-failure', `This plan already failed here (${latest.code}: ${latest.reason}). Create a new plan to retry.`, { actionId: item.planned.id, evidence: latest });
  }
  if (latest && LIVE_PHASES.has(latest.phase)) throw new ApplyError('journal', `Action has an unsettled ${latest.phase} record.`, { actionId: item.planned.id });
  const observed = await precondition(ctx, item);
  if (observed.satisfied) {
    if (!observed.verification) throw new ApplyError('unverified', `Action ${item.planned.id} has no verification.`, { actionId: item.planned.id });
    await markVerified(ctx, item, observed.verification, { outcome: 'already-satisfied' });
    return null;
  }
  return item;
}

export async function checkExecutionDependencies(ctx: ApplyContext, work: { item: PreparedAction }[], requireCompleted = true): Promise<void> {
  const checked = new Map<ResourceId, VerificationResult>();
  for (const { item } of work) {
    for (const id of item.planned.dependencies) {
      const dependency = ctx.prepared.get(id);
      const outcome = ctx.outcomes.get(id);
      if (!dependency || (requireCompleted && !(outcome && 'verification' in outcome))) {
        throw new ApplyError('dependency', `${item.planned.id} needs completed dependency ${id} before signing.`, { actionId: item.planned.id });
      }
      if (!checked.has(id)) {
        const evidence = ctx.journal.forAction(ctx.plan.planHash, id)
          .filter((record): record is JournalRecord & (import('./types.ts').ReceiptFields | VerifiedFields) =>
            (record.phase === 'receipt' || record.phase === 'verified') && Boolean(record.transactionHash)).at(-1);
        const transactionHash = outcome && 'transactionHash' in outcome ? outcome.transactionHash : evidence?.transactionHash;
        checked.set(id, await verify(ctx, dependency, transactionHash ? { transactionHash } : {}));
      }
      const verification = checked.get(id)!;
      if (verification.status !== 'verified') {
        throw new ApplyError('dependency', `${item.planned.id} needs verified dependency ${id}; it is now ${verification.status}.`, {
          actionId: item.planned.id, evidence: { dependency: id, verification: summarizeVerification(verification) },
        });
      }
    }
  }
}
