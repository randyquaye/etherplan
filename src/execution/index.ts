import { randomUUID } from 'node:crypto';
import { isAddress, keccak256 } from 'viem';
import { hashJson } from '../identity.ts';
import { validateState } from '../state/index.ts';
import { createSchedule } from '../scheduling/index.ts';
import { loadDependencies } from './dependencies.ts';
import { ApplyError } from './errors.ts';
import { LIVE_PHASES, intentForSigned, latestRecord, liveTransactions, openJournal, signedVariants } from './journal.ts';
import { acquireLock } from './lock.ts';
import { acquireLeases, deploymentScope, openStoredJournal } from './backends.ts';
import { checkFactory, jsonSafe, preflight } from './preflight.ts';
import { broadcast, estimateGasLimit, feesFor, findKnownReceipt, findReceipt, maximumCost, nonceConsumed, receiptJson, signEnvelope, validateSignedTransaction, waitForReceipt } from './transactions.ts';
import type { Plan, PlannedResource, PlannedTransaction, PreparedResource } from '../planning/types.ts';
import type { ScheduleEntry, ScheduleWave } from '../scheduling/types.ts';
import type { StateFile } from '../state/types.ts';
import type { Address, Client, Hash, ResourceId } from '../types.ts';
import type { VerificationResult } from '../verification/types.ts';
import type { ApplyConfig, ApplyContext, ApplyInput, ApplyResult, BroadcastOutcome, FailedFields, FailureCode, IntentRecord, JournalPhaseFields, JournalRecord, JournalRecordInput, PreparedAction, Receipt, ReceiptFields, ReceiptJson, ReportEvent, ReportEventType, ResourceOutcome, ResourceOutcomeSummary, SignerAccount, SignerAuthorization, SignerLanes, SignerProvider, SignerRoles, Signers, SignedRecord, SignedBytes, StateWriteResult, TransactionEnvelope, VerifiedFields, VerificationSummary } from './types.ts';

export { ApplyError } from './errors.ts';
export { acquireLock, LockError } from './lock.ts';
export { openJournal } from './journal.ts';
export { acquireLeases, deploymentScope, encryptionContext, lockScopes, openStoredJournal, scopeKey, validateJournal } from './backends.ts';

const DEFAULTS = { pollIntervalMs: 250, receiptTimeoutMs: 120_000, gasMultiplier: 1.2, fees: null, budgets: {}, hooks: {}, dependencies: {} };
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function transactionFor(item: PreparedAction): PlannedTransaction {
  const transaction = item.planned.tx;
  if (!transaction) throw new ApplyError('plan-format', `Action ${item.planned.id} has no planned transaction.`, { actionId: item.planned.id });
  return transaction;
}

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

type CostEnvelope = Omit<TransactionEnvelope, 'nonce'> & { nonce?: number };
interface FundedJob {
  item: PreparedAction;
  entry: ScheduleEntry;
  signer: SignerAccount;
  envelope: CostEnvelope;
  cost: bigint;
}
type SignedBatchJob = FundedJob & { signed: SignedRecord };
type PipelineBatchJob = SignedBatchJob & { intent: IntentRecord; signedIntent: IntentRecord; variants: SignedRecord[] };
type ActivePipelineJob = PipelineBatchJob | (ResumeJob & { signed: SignedRecord });
type CommitmentLedger = Map<string, Map<string, { cost: bigint; reservationId?: string }[]>>;
type PipelineAttempt = { receipt?: Receipt; accepted?: boolean; error?: unknown };

function roleOf(resource: PlannedResource | PreparedResource): string {
  return ('signerRole' in resource ? resource.signerRole : null) ?? (resource.kind === 'call' ? 'owner' : 'deployer');
}

function lanesFrom(signers: Signers | undefined, parallel: boolean): SignerLanes {
  if (!signers || !Array.isArray(signers.deployer) || signers.deployer.length === 0) throw new ApplyError('signer', 'Apply needs signers.deployer with at least one account.');
  const accounts = [...signers.deployer, ...(signers.owner ? [signers.owner] : [])];
  for (const account of accounts) {
    if (!isAddress(account?.address ?? '', { strict: false }) || typeof account.signTransaction !== 'function') throw new ApplyError('signer', 'Every signer needs an address and signTransaction(request).');
  }
  const deployers = signers.deployer.map(account => account.address.toLowerCase());
  if (new Set(deployers).size !== deployers.length) throw new ApplyError('signer', 'Deployer accounts must be distinct.');
  const byAddress = new Map(accounts.map((account): [string, SignerAccount] => [account.address.toLowerCase(), account]));
  return { pool: parallel ? signers.deployer : [signers.deployer[0]!], owner: signers.owner ?? null, byAddress };
}

async function signersFromProvider(provider: SignerProvider, roles: SignerRoles | undefined, plan: Plan, control: SignerAuthorization & { assertHeld: (() => Promise<void>) | null }): Promise<Signers> {
  if (typeof provider?.address !== 'function' || typeof provider?.signTransaction !== 'function') throw new ApplyError('signer', 'Signer provider needs address(role) and signTransaction(role, request).');
  const deployerRoles = roles?.deployer ?? ['deployer'];
  if (!Array.isArray(deployerRoles) || deployerRoles.length === 0 || deployerRoles.some(role => typeof role !== 'string')) throw new ApplyError('signer', 'signerRoles.deployer must be a nonempty role list.');
  const account = async (role: string): Promise<SignerAccount> => ({ address: await provider.address(role), async signTransaction(request) {
    await control.assertHeld?.();
    return provider.signTransaction(role, request, { scope: control.scope, fence: control.fence });
  } });
  const deployer = await Promise.all(deployerRoles.map(account));
  const needsOwner = plan?.resources?.some(resource => ['deploy', 'call'].includes(resource.action) && roleOf(resource) === 'owner');
  return { deployer, ...(needsOwner ? { owner: await account(roles?.owner ?? 'owner') } : {}) };
}

async function report(ctx: ApplyContext, type: ReportEventType, fields: Record<string, unknown> = {}): Promise<void> {
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

async function append<T extends JournalPhaseFields>(ctx: ApplyContext, actionId: ResourceId, fields: T, identity: Pick<Plan, 'planHash' | 'chain'> = ctx.plan): Promise<JournalRecord & T> {
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

async function fail(ctx: ApplyContext, item: PreparedAction, code: FailureCode, reason: string, { retryable = false, evidence, ...fields }: Omit<Partial<Omit<FailedFields, 'phase' | 'code' | 'reason'>>, 'evidence'> & { evidence?: unknown } = {}): Promise<never> {
  await append(ctx, item.planned.id, { phase: 'failed', code, reason, retryable, ...fields, ...(evidence === undefined ? {} : { evidence: jsonSafe(evidence) as import('../types.ts').JsonValue }) });
  ctx.outcomes.set(item.planned.id, { id: item.planned.id, action: item.planned.action, outcome: 'failed',
    code, reason, retryable, ...fields });
  throw new ApplyError(code, reason, { actionId: item.planned.id, evidence, retryable });
}

async function verify(ctx: ApplyContext, item: PreparedAction, options: import('../verification/types.ts').VerifyOptions = {}): Promise<VerificationResult> {
  const id = item.planned.id;
  const outcome = ctx.outcomes.get(id);
  const saved = options.creationProof ?? (outcome && 'verification' in outcome ? outcome.verification.creationProof : undefined) ?? ctx.stateSnapshot?.resources?.[id]?.creationProof;
  const transactionHash = options.transactionHash ?? saved?.transactionHash ?? ctx.stateSnapshot?.resources?.[id]?.provenance?.creationTransactionHash ?? ctx.stateSnapshot?.resources?.[id]?.transactions?.at(-1);
  const creationProof = saved && (!transactionHash || saved.transactionHash.toLowerCase() === transactionHash.toLowerCase()) ? saved : undefined;
  return ctx.deps.verifyResource(item.resource, ctx.client, { ...options, chain: ctx.plan.chain, ...(transactionHash ? { transactionHash } : {}), ...(creationProof ? { creationProof } : {}) });
}

async function markVerified(ctx: ApplyContext, item: PreparedAction, verification: VerificationResult, fields: Pick<VerifiedFields, 'outcome'> & Partial<Pick<VerifiedFields, 'transactionHash' | 'blockNumber' | 'revertedTransaction' | 'unsentTransaction'>>): Promise<void> {
  const { planned } = item;
  await append(ctx, planned.id, { phase: 'verified', address: planned.address, codeHash: verification.codeHash, proofHash: hashJson(jsonSafe(verification)), verification: summarizeVerification(verification), ...(verification.creationProof ? { creationProof: verification.creationProof } : {}), ...fields });
  ctx.outcomes.set(planned.id, { id: planned.id, action: planned.action, outcome: fields.outcome, address: planned.address,
    ...(fields.transactionHash ? { transactionHash: fields.transactionHash } : {}), verification });
}

// Reads the chain before a write: a satisfied postcondition needs no transaction, a failed precondition is a conflict.
async function precondition(ctx: ApplyContext, item: PreparedAction): Promise<{ satisfied: boolean; verification?: VerificationResult }> {
  const { planned } = item;
  if (planned.action === 'deploy' && planned.kind === 'contract') {
    if (!planned.factory) throw new ApplyError('plan-format', `Action ${planned.id} has no CREATE2 factory.`, { actionId: planned.id });
    await checkFactory(ctx.client, planned.factory);
    const code = await ctx.client.getCode({ address: planned.address });
    if (!code || code === '0x') return { satisfied: false };
    const verification = await verify(ctx, item);
    if (verification.status === 'verified') return { satisfied: true, verification };
    return fail(ctx, item, verification.status === 'unverified' ? 'unverified' : 'conflict', `The target address already has code, and it is ${verification.status}.`, { evidence: summarizeVerification(verification) });
  }
  const verification = await verify(ctx, item);
  const observed = (verification.bindingChecks ?? []).map(check => check.observed);
  if (verification.status === 'verified' && observed.length > 0 && observed.every(state => state === 'after')) return { satisfied: true, verification };
  if (observed.length > 0 && observed.every(state => state === 'before')) return { satisfied: false, verification };
  return fail(ctx, item, 'conflict', 'The binding has neither its allowed before value nor its desired value.', { evidence: summarizeVerification(verification) });
}

async function recordReceipt(ctx: ApplyContext, item: PreparedAction, signed: SignedRecord, receipt: Receipt): Promise<void> {
  const latest = latestRecord(ctx.journal.forAction(ctx.plan.planHash, item.planned.id));
  const json = receiptJson(receipt);
  if (latest?.phase === 'receipt' && latest.receipt?.blockHash === json.blockHash.toLowerCase()) return;
  await append(ctx, item.planned.id, { phase: 'receipt', signer: signed.signer, nonce: signed.nonce, transactionHash: signed.transactionHash, receipt: json });
}

async function stableReceipt(ctx: ApplyContext, transactionHash: Hash, receipt: Receipt | ReceiptJson, actionId: ResourceId, wait = false): Promise<Receipt> {
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

async function revalidateVerified(ctx: ApplyContext): Promise<void> {
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

async function assertSignerHistory(ctx: ApplyContext, addresses: Address[]): Promise<void> {
  if (!ctx.remote || !ctx.journalStore || !ctx.scope) return;
  for (const address of new Set(addresses.map(value => value.toLowerCase()))) {
    for await (const signed of ctx.journalStore.signedForSigner(ctx.scope, address)) {
      if (signed.label === ctx.scope.label && signed.planHash === ctx.plan.planHash) continue;
      const receipt = await findReceipt(ctx.client, signed.transactionHash);
      if (!receipt) throw new ApplyError('foreign-outstanding', `Label ${signed.label} has unresolved transaction ${signed.transactionHash} for signer ${address}. Resume that label first.`, { actionId: signed.actionId, retryable: true });
      await stableReceipt(ctx, signed.transactionHash, receipt, signed.actionId);
    }
  }
}

// A receipt does not complete an action. The postcondition must verify at the receipt block, and that block must still be canonical.
async function finish(ctx: ApplyContext, item: PreparedAction, signed: SignedRecord, receipt: Receipt): Promise<void> {
  const transactionHash = signed.transactionHash;
  await stableReceipt(ctx, transactionHash, receipt, item.planned.id, true);
  if (receipt.status !== 'success') {
    const verificationStart = Date.now();
    const verification = await verify(ctx, item, { blockNumber: receipt.blockNumber, transactionHash, account: signed.signer });
    ctx.timings.verificationMs += Date.now() - verificationStart;
    await stableReceipt(ctx, transactionHash, receipt, item.planned.id);
    if (verification.status === 'verified') return markVerified(ctx, item, verification, { outcome: 'already-satisfied', revertedTransaction: transactionHash });
    await fail(ctx, item, 'reverted', `Transaction ${transactionHash} reverted in block ${receipt.blockNumber}.`, { transactionHash, evidence: summarizeVerification(verification) });
  }
  const verificationStart = Date.now();
  const verification = await verify(ctx, item, { blockNumber: receipt.blockNumber, transactionHash, account: signed.signer });
  ctx.timings.verificationMs += Date.now() - verificationStart;
  await stableReceipt(ctx, transactionHash, receipt, item.planned.id);
  if (verification.status !== 'verified') {
    await fail(ctx, item, 'postcondition', `Transaction ${transactionHash} succeeded, but the result is ${verification.status}.`, { transactionHash, evidence: summarizeVerification(verification) });
  }
  await markVerified(ctx, item, verification, { outcome: 'applied', transactionHash, blockNumber: String(receipt.blockNumber) });
}

async function awaitReceipt(ctx: ApplyContext, item: PreparedAction, signed: SignedRecord, variants: SignedRecord[] = [signed]): Promise<Receipt> {
  const started = Date.now();
  const waited = await waitForReceipt(ctx.client, { signedVariants: variants, signer: signed.signer, nonce: signed.nonce, pollIntervalMs: ctx.config.pollIntervalMs, timeoutMs: ctx.config.receiptTimeoutMs });
  if ('dead' in waited) {
    return fail(ctx, item, 'nonce-race', `Signer ${signed.signer} nonce ${signed.nonce} was used by a transaction that is not in the journal. Stop the other writer, then rerun this plan.`, { retryable: true, signer: signed.signer, nonce: signed.nonce, transactionHash: signed.transactionHash });
  }
  if ('timeout' in waited) {
    throw new ApplyError('receipt-timeout', `No receipt for ${signed.transactionHash} after ${ctx.config.receiptTimeoutMs} ms. Rerun to resume or provide reviewed replacement fees.`, { actionId: item.planned.id, retryable: true });
  }
  await report(ctx, 'receipt-observed', { actionId: item.planned.id, transactionHash: waited.receipt.transactionHash, receiptLatencyMs: Date.now() - started });
  return waited.receipt;
}

async function send(ctx: ApplyContext, item: PreparedAction, signed: SignedRecord, { rebroadcast = false, variants = [signed] }: { rebroadcast?: boolean; variants?: SignedRecord[] } = {}): Promise<Receipt> {
  await ctx.lock.assertHeld?.();
  await append(ctx, item.planned.id, { phase: 'broadcast-attempt', signer: signed.signer, nonce: signed.nonce, transactionHash: signed.transactionHash, rebroadcast });
  await ctx.lock.assertHeld?.();
  const started = Date.now();
  const sent = await broadcast(ctx.client, signed.rawTransaction);
  await report(ctx, 'broadcast-result', { actionId: item.planned.id, transactionHash: signed.transactionHash, rebroadcast, accepted: sent.accepted, broadcastLatencyMs: Date.now() - started });
  if (!sent.accepted) {
    if (sent.nonceTooLow) {
      const receipt = await findKnownReceipt(ctx.client, variants);
      if (receipt) return receipt;
      await fail(ctx, item, 'nonce-race', `Signer ${signed.signer} nonce ${signed.nonce} was used by a transaction that is not in the journal. Stop the other writer, then rerun this plan.`, { retryable: true, signer: signed.signer, nonce: signed.nonce, transactionHash: signed.transactionHash });
    }
    const code = sent.replacementUnderpriced ? 'replacement-underpriced' : 'broadcast-failed';
    throw new ApplyError(code, `Broadcast of ${signed.transactionHash} failed: ${sent.error}. Rerun to resend the same signed transaction.`, { actionId: item.planned.id, retryable: true });
  }
  await append(ctx, item.planned.id, { phase: 'broadcast', signer: signed.signer, nonce: signed.nonce, transactionHash: signed.transactionHash, rebroadcast, ...(sent.known ? { known: true } : {}) });
  if (rebroadcast) ctx.rebroadcasts.push({ actionId: item.planned.id, transactionHash: signed.transactionHash });
  return awaitReceipt(ctx, item, signed, variants);
}

function matchingVariant(variants: SignedRecord[], receipt: Receipt): SignedRecord {
  const signed = variants.find(entry => entry.transactionHash.toLowerCase() === receipt.transactionHash.toLowerCase());
  if (!signed) throw new Error('Receipt is not for a journaled transaction.');
  return signed;
}

async function replaceSigned(ctx: ApplyContext, item: PreparedAction, signed: SignedRecord, variants: SignedRecord[]): Promise<SignedRecord> {
  const records = ctx.journal.forAction(ctx.plan.planHash, item.planned.id);
  const pending = records.at(-1);
  const orphan = pending?.phase === 'intent' && pending.replacement && pending.replacesTransactionHash?.toLowerCase() === signed.transactionHash.toLowerCase();
  const requested = ctx.config.replacementFees;
  if (!orphan && !requested) return signed;
  const oldIntent = intentForSigned(ctx.journal.records, signed);
  const tx = transactionFor(item);
  if (orphan && (pending.signer?.toLowerCase() !== signed.signer.toLowerCase() || pending.nonce !== signed.nonce ||
    pending.to?.toLowerCase() !== tx.to.toLowerCase() || String(pending.value) !== String(tx.value) ||
    pending.dataHash?.toLowerCase() !== keccak256(tx.data).toLowerCase() ||
    String(pending.gas) !== String(oldIntent.gas) || pending.reservationId !== oldIntent.reservationId)) {
    throw new ApplyError('journal', 'Saved replacement intent differs from the reserved transaction.', { actionId: item.planned.id });
  }
  const fees = orphan ? { maxFeePerGas: BigInt(pending.maxFeePerGas), maxPriorityFeePerGas: BigInt(pending.maxPriorityFeePerGas) }
    : await feesFor(ctx.client, requested);
  if (!orphan && signed.replacement && fees.maxFeePerGas === BigInt(oldIntent.maxFeePerGas) &&
    fees.maxPriorityFeePerGas === BigInt(oldIntent.maxPriorityFeePerGas)) return signed;
  const minimum = (value: string) => (BigInt(value) * 110n + 99n) / 100n || 1n;
  if (fees.maxFeePerGas < minimum(oldIntent.maxFeePerGas) || fees.maxPriorityFeePerGas < minimum(oldIntent.maxPriorityFeePerGas) ||
    fees.maxPriorityFeePerGas > fees.maxFeePerGas) throw new ApplyError('replacement-fees', 'Replacement fees must raise both caps by at least 10% and keep priority fee within the maximum fee.', { actionId: item.planned.id });
  const envelope: TransactionEnvelope = { chainId: ctx.plan.chain.id, nonce: Number(signed.nonce), to: tx.to,
    data: tx.data, value: BigInt(tx.value), gas: BigInt(oldIntent.gas), ...fees };
  const ceiling = BigInt(orphan ? pending.maxCostWei! : requested!.maxCostWei);
  const cost = maximumCost(envelope);
  if (cost > ceiling) throw new ApplyError('replacement-budget', `Replacement can cost ${cost} wei, above the reviewed ${ceiling} wei ceiling.`, { actionId: item.planned.id });
  const signer = ctx.lanes.byAddress.get(signed.signer.toLowerCase());
  if (!signer) throw new ApplyError('signer', `Signer ${signed.signer} for the replacement is unavailable.`, { actionId: item.planned.id });
  const balance = await ctx.client.getBalance({ address: signed.signer });
  if (balance < cost) throw new ApplyError('insufficient-funds', `Signer ${signed.signer} has ${balance} wei; replacement can cost ${cost} wei.`, { actionId: item.planned.id, retryable: true });
  const budget = ctx.config.budgets[signed.signer.toLowerCase()];
  if (budget !== undefined) {
    const ledger = await commitments(ctx);
    ledger.get(signed.signer.toLowerCase())?.delete(String(signed.nonce));
    if (signedSpend(ledger, signed.signer.toLowerCase()) + cost > BigInt(budget)) {
      throw new ApplyError('budget-exceeded', `Replacement would exceed signer ${signed.signer}'s ${budget} wei budget.`, { actionId: item.planned.id, retryable: true });
    }
  }
  let intent: IntentRecord;
  if (orphan && pending?.phase === 'intent') intent = pending;
  else {
    intent = await append(ctx, item.planned.id, { phase: 'intent', replacement: true, replacesTransactionHash: signed.transactionHash,
      maxCostWei: String(ceiling), signer: signed.signer, nonce: signed.nonce, to: envelope.to,
      value: String(envelope.value), dataHash: keccak256(envelope.data), gas: String(envelope.gas),
      maxFeePerGas: String(fees.maxFeePerGas), maxPriorityFeePerGas: String(fees.maxPriorityFeePerGas),
      ...Object.fromEntries((['wave', 'reservationId', 'signerRole', 'pooled', 'nonceOffset', 'waveAttemptId'] as const)
        .filter(field => oldIntent[field] !== undefined).map(field => [field, oldIntent[field]])) });
  }
  let bytes: SignedBytes;
  try { bytes = await signWithLease(ctx, item.planned.id, signer, envelope); }
  catch (error) { throw new ApplyError('signer', error instanceof Error ? error.message : String(error), { actionId: item.planned.id, retryable: true }); }
  const { formatVersion, planHash, chain, actionId, sequence, at, ...intentFields } = intent;
  const replacement = await append(ctx, item.planned.id, { ...intentFields, phase: 'signed', ...bytes });
  await validateSignedTransaction(replacement, intent, item.planned, ctx.plan.chain.id);
  variants.push(replacement);
  ctx.sent.push({ actionId: item.planned.id, ...(intent.wave === undefined ? {} : { wave: intent.wave }), signer: signed.signer.toLowerCase(), nonce: signed.nonce,
    transactionHash: replacement.transactionHash.toLowerCase() as Hash });
  return replacement;
}

// Resolves every signed variant at a reserved nonce before resending or replacing it.
async function settle(ctx: ApplyContext, item: PreparedAction, signed: SignedRecord): Promise<void> {
  await report(ctx, 'recovery', { actionId: item.planned.id, transactionHash: signed.transactionHash });
  const variants = signedVariants(ctx.journal.forAction(ctx.plan.planHash, item.planned.id), signed);
  let receipt = await findKnownReceipt(ctx.client, variants);
  if (!receipt && await nonceConsumed(ctx.client, signed.signer, signed.nonce)) {
    receipt = await findKnownReceipt(ctx.client, variants);
    if (!receipt) {
      await fail(ctx, item, 'nonce-race', `Signer ${signed.signer} nonce ${signed.nonce} was used by a transaction that is not in the journal. Stop the other writer, then rerun this plan.`, { retryable: true, signer: signed.signer, nonce: signed.nonce, transactionHash: signed.transactionHash });
    }
  }
  if (!receipt) {
    const observed = await precondition(ctx, item);
    if (observed.satisfied && observed.verification) return markVerified(ctx, item, observed.verification, { outcome: 'already-satisfied', unsentTransaction: signed.transactionHash });
    await checkExecutionDependencies(ctx, [{ item }], false);
    signed = await replaceSigned(ctx, item, signed, variants);
    receipt = await findKnownReceipt(ctx.client, variants);
    if (!receipt) receipt = await send(ctx, item, signed, { rebroadcast: true, variants });
  }
  const mined = matchingVariant(variants, receipt);
  await recordReceipt(ctx, item, mined, receipt);
  await finish(ctx, item, mined, receipt);
}

// Another plan's transaction can hold a signer's next nonce. Record its fate, or stop if it may still be sent.
async function settleForeign(ctx: ApplyContext, signed: SignedRecord): Promise<JournalRecord> {
  const identity = { planHash: signed.planHash, chain: signed.chain };
  const variants = signedVariants(ctx.journal.forAction(signed.planHash, signed.actionId), signed);
  let receipt = await findKnownReceipt(ctx.client, variants);
  if (!receipt) {
    if (!await nonceConsumed(ctx.client, signed.signer, signed.nonce)) {
      throw new ApplyError('foreign-outstanding', `Plan ${signed.planHash} has signed transaction ${signed.transactionHash} (signer ${signed.signer}, nonce ${signed.nonce}) that is not on chain. Resume that plan, or wait until the nonce is used, before you apply another plan.`, { actionId: signed.actionId, retryable: true });
    }
    receipt = await findKnownReceipt(ctx.client, variants);
    if (!receipt) return append(ctx, signed.actionId, { phase: 'failed', code: 'nonce-consumed', reason: 'Another transaction used this nonce.', retryable: true,
      signer: signed.signer, nonce: signed.nonce, transactionHash: signed.transactionHash }, identity);
  }
  const mined = matchingVariant(variants, receipt);
  return append(ctx, signed.actionId, { phase: 'receipt', signer: mined.signer, nonce: mined.nonce,
    transactionHash: mined.transactionHash, receipt: receiptJson(receipt) }, identity);
}

async function settleJournal(ctx: ApplyContext): Promise<void> {
  const { id, genesisHash } = ctx.plan.chain;
  const records = ctx.journal.records.filter(record => record.chain.id === id && record.chain.genesisHash.toLowerCase() === genesisHash.toLowerCase());
  for (const { latest, signed } of liveTransactions(records)) {
    if (latest.planHash !== ctx.plan.planHash && ctx.remote) throw new ApplyError('plan-mismatch', `An unfinished transaction belongs to plan ${latest.planHash}. Resume that plan first.`, { actionId: latest.actionId });
    if (latest.planHash === ctx.plan.planHash) {
      const item = ctx.prepared.get(latest.actionId);
      if (!item) throw new ApplyError('journal', 'Journal has a transaction for an action that is not in this plan.', { actionId: latest.actionId });
      try {
        const variants = signedVariants(records, signed);
        if (latest.phase === 'intent' && (!latest.replacement || latest.replacesTransactionHash?.toLowerCase() !== signed.transactionHash.toLowerCase())) {
          throw new Error('Latest replacement intent does not name the current signature.');
        }
        if (latest.phase !== 'intent' && !variants.some(entry => entry.transactionHash?.toLowerCase() === latest.transactionHash?.toLowerCase())) {
          throw new Error('Latest transaction phase has a hash outside the signed variants.');
        }
        for (const [index, variant] of variants.entries()) {
          const intent = intentForSigned(records, variant);
          await validateSignedTransaction(variant, intent, item.planned, id);
          const previous = variants[index - 1];
          if (previous && (intent.replacesTransactionHash?.toLowerCase() !== previous.transactionHash.toLowerCase() ||
            BigInt(intent.maxFeePerGas) <= BigInt(intentForSigned(records, previous).maxFeePerGas) ||
            BigInt(intent.maxPriorityFeePerGas) <= BigInt(intentForSigned(records, previous).maxPriorityFeePerGas))) {
            throw new Error('Signed replacement does not raise fees for its predecessor.');
          }
        }
      } catch (error) {
        throw new ApplyError('journal', `${latest.actionId}: ${error instanceof Error ? error.message : String(error)}`, { actionId: latest.actionId });
      }
    }
  }
  for (const { latest, signed } of liveTransactions(records)) {
    if (latest.planHash === ctx.plan.planHash) {
      if (ctx.pipeline && signed.reservationId) continue;
      const item = ctx.prepared.get(latest.actionId);
      if (!item) throw new ApplyError('journal', 'Journal has a transaction for an action that is not in this plan.', { actionId: latest.actionId });
      await settle(ctx, item, signed);
    } else if (latest.phase !== 'receipt') {
      await settleForeign(ctx, signed);
    }
  }
}

// A signed reservation commits the entire wave. Older journals have no attempt ID,
// but their complete intent set immediately precedes the first signature.
function pipelineAttempt(ctx: ApplyContext, wave: ScheduleWave): { intents: IntentRecord[]; attemptId: string | null } | null {
  const actions = new Set(wave.batches.flat().map(entry => entry.id));
  const records = ctx.journal.records.filter((record): record is IntentRecord | SignedRecord =>
    record.planHash === ctx.plan.planHash && actions.has(record.actionId) &&
    (record.phase === 'intent' || record.phase === 'signed') && Boolean(record.reservationId) && !record.replacement);
  const signatures = records.filter((record): record is SignedRecord => record.phase === 'signed');
  if (!signatures.length) return null;
  if (records.some(record => record.wave !== wave.wave || record.chain.id !== ctx.plan.chain.id ||
    record.chain.genesisHash.toLowerCase() !== ctx.plan.chain.genesisHash.toLowerCase())) {
    throw new ApplyError('journal', `Wave ${wave.wave} has a record with the wrong wave or chain.`);
  }
  const ids = new Set(signatures.map(record => record.waveAttemptId ?? null));
  if (ids.size !== 1) throw new ApplyError('journal', `Wave ${wave.wave} has signatures from multiple attempts.`);
  const attemptId = ids.values().next().value ?? null;
  const firstSignature = signatures[0]!;
  const intents = attemptId
    ? records.filter((record): record is IntentRecord => record.phase === 'intent' && record.waveAttemptId === attemptId)
    : records.filter((record): record is IntentRecord => record.phase === 'intent' && !record.waveAttemptId && record.sequence < firstSignature.sequence).slice(-wave.batches.flat().length);
  if (intents.length !== wave.batches.flat().length || signatures.some(record => !intents.some(intent =>
    intent.actionId === record.actionId && intent.reservationId === record.reservationId))) {
    throw new ApplyError('journal', `Wave ${wave.wave} has an incomplete or ambiguous signed attempt.`);
  }
  return { intents, attemptId };
}

async function resumePipelineWave(ctx: ApplyContext, wave: ScheduleWave): Promise<boolean> {
  const attempt = pipelineAttempt(ctx, wave);
  if (!attempt) return false;
  const { intents, attemptId } = attempt;
  const entries = wave.batches.flat();
  const byAction = new Map<ResourceId, IntentRecord>();
  for (const intent of intents) {
    if (byAction.has(intent.actionId)) throw new ApplyError('journal', `Wave ${wave.wave} has duplicate intents for ${intent.actionId}.`);
    byAction.set(intent.actionId, intent);
  }
  const groups = new Map<string, ResumeJob[]>();
  const jobs: ResumeJob[] = [];
  for (const entry of entries) {
    const intent = byAction.get(entry.id);
    const item = ctx.prepared.get(entry.id);
    const signer = ctx.lanes.byAddress.get(entry.signer);
    const tx = item ? transactionFor(item) : null;
    if (!intent || !item || !signer || intent.signer?.toLowerCase() !== entry.signer ||
      typeof entry.nonceOffset !== 'number' || intent.nonceOffset !== entry.nonceOffset || intent.to?.toLowerCase() !== tx?.to.toLowerCase() ||
      intent.value !== tx?.value || intent.dataHash?.toLowerCase() !== (tx ? keccak256(tx.data).toLowerCase() : null) ||
      !/^[0-9]+$/.test(String(intent.nonce)) || !/^[0-9]+$/.test(String(intent.gas)) ||
      !/^[0-9]+$/.test(String(intent.maxFeePerGas)) || !/^[0-9]+$/.test(String(intent.maxPriorityFeePerGas)) ||
      !Number.isSafeInteger(Number(intent.nonce)) ||
      !intent.reservationId) throw new ApplyError('journal', `Wave ${wave.wave} has an invalid intent for ${entry.id}.`, { actionId: entry.id });
    const group = groups.get(entry.signer) ?? [];
    if (group.length && (intent.reservationId !== group[0]!.intent.reservationId ||
      BigInt(intent.nonce) !== BigInt(group[0]!.intent.nonce) + BigInt(entry.nonceOffset))) {
      throw new ApplyError('journal', `Wave ${wave.wave} has inconsistent nonces or reservations for ${entry.signer}.`);
    }
    const actionRecords = ctx.journal.forAction(ctx.plan.planHash, entry.id);
    const nextIntent = actionRecords.find(record => record.phase === 'intent' && !record.replacement && record.sequence > intent.sequence);
    const history = actionRecords.filter(record => record.sequence >= intent.sequence && (!nextIntent || record.sequence < nextIntent.sequence));
    const signatures = history.filter((record): record is SignedRecord => record.phase === 'signed' && !record.replacement);
    if (signatures.length > 1 || signatures.some(record => record.reservationId !== intent.reservationId || (record.waveAttemptId ?? null) !== attemptId)) {
      throw new ApplyError('journal', `Wave ${wave.wave} has duplicate or mismatched signatures for ${entry.id}.`, { actionId: entry.id });
    }
    const original = signatures[0];
    const signed = original ? history.filter((record): record is SignedRecord => record.phase === 'signed').at(-1) ?? null : null;
    const variants = signed ? signedVariants(history, signed) : [];
    const signedIntent = signed ? intentForSigned(ctx.journal.records, signed) : null;
    if (signed) {
      try { await validateSignedTransaction(signed, signedIntent ?? intent, item.planned, ctx.plan.chain.id); }
      catch (error) { throw new ApplyError('journal', error instanceof Error ? error.message : String(error), { actionId: entry.id }); }
    }
    const job: ResumeJob = { item, entry, signer, intent, signed, signedIntent, variants, records: history, receipt: null, completed: false };
    group.push(job);
    groups.set(entry.signer, group);
    jobs.push(job);
  }
  if (byAction.size !== entries.length) throw new ApplyError('journal', `Wave ${wave.wave} has intents outside its saved schedule.`);
  for (const group of groups.values()) {
    if (group[0]?.entry.nonceOffset !== 0) throw new ApplyError('journal', `Wave ${wave.wave} has an invalid first nonce offset.`);
  }
  if (new Set([...groups.values()].map(group => group[0]!.intent.reservationId)).size !== groups.size) {
    throw new ApplyError('journal', `Wave ${wave.wave} shares a reservation across signer groups.`);
  }
  const conflict = jobs.find(job => { const last = job.records.at(-1); return last?.phase === 'failed' && !last.retryable; });
  const failure = conflict?.records.at(-1);
  if (conflict && failure?.phase === 'failed') throw new ApplyError(failure.code, failure.reason, { actionId: conflict.item.planned.id });

  // Check every signer and precondition before adding any signature or broadcast.
  for (const job of jobs) job.receipt = job.signed ? await findKnownReceipt(ctx.client, job.variants) : null;
  for (const job of jobs.filter(entry => entry.records.at(-1)?.phase === 'verified')) await decide(ctx, job.item);
  const outstanding = jobs.filter(job => job.records.at(-1)?.phase !== 'verified' && !job.receipt);
  await checkExecutionDependencies(ctx, outstanding, false);
  for (const job of outstanding) {
    const observed = await precondition(ctx, job.item);
    if (observed.satisfied) throw new ApplyError('conflict', `The precondition for ${job.item.planned.id} changed after its nonce was reserved.`, { actionId: job.item.planned.id });
  }
  for (const [address, group] of groups) {
    const [latest, pending] = await Promise.all([
      ctx.client.getTransactionCount({ address: address as Address, blockTag: 'latest' }),
      ctx.client.getTransactionCount({ address: address as Address, blockTag: 'pending' }),
    ]);
    const first = group[0]!;
    const base = BigInt(first.intent.nonce);
    if (BigInt(latest) < base || BigInt(pending) < BigInt(latest)) throw new ApplyError('nonce-conflict', `Signer ${address} no longer has the reserved nonce sequence.`, { actionId: first.item.planned.id });
    for (const job of group) {
      if (BigInt(job.intent.nonce) < BigInt(latest) && !job.receipt) {
        if (job.signed) await pipelineConflict(ctx, { item: job.item, signed: job.signed });
        throw new ApplyError('nonce-conflict', `Signer ${address} consumed unsigned reserved nonce ${job.intent.nonce}.`, { actionId: job.item.planned.id });
      }
    }
    for (let nonce = BigInt(latest); nonce < BigInt(pending); nonce++) {
      const job = group.find(entry => BigInt(entry.intent.nonce) === nonce);
      if (!job?.signed) throw new ApplyError('nonce-conflict', `Signer ${address} has an unknown pending transaction at nonce ${nonce}.`, { actionId: first.item.planned.id });
      let known = false;
      for (const variant of job.variants) {
        try { known ||= Boolean(await ctx.client.getTransaction({ hash: variant.transactionHash })); }
        catch (error) { if (!(error instanceof Error) || error.name !== 'TransactionNotFoundError') throw error; }
      }
      if (!known) throw new ApplyError('nonce-conflict', `Signer ${address} has an unknown pending transaction at nonce ${nonce}.`, { actionId: job.item.planned.id });
    }
    const unmined = group.filter(job => job.records.at(-1)?.phase !== 'verified' && !job.receipt);
    if (!unmined.length) continue;
    const required = unmined.reduce((sum, job) => sum + BigInt(job.intent.gas) * BigInt(job.intent.maxFeePerGas) + BigInt(job.intent.value), 0n);
    const balance = await ctx.client.getBalance({ address: address as Address });
    if (balance < required) throw new ApplyError('insufficient-funds', `Signer ${address} has ${balance} wei; the reserved group can cost ${required} wei.`, { actionId: unmined[0]!.item.planned.id, retryable: true });
    const budget = budgetFor(ctx, address);
    const reserved = group.reduce((sum, job) => sum + BigInt(job.intent.gas) * BigInt(job.intent.maxFeePerGas) + BigInt(job.intent.value), 0n);
    const spent = signedSpend(await commitments(ctx), address, first.intent.reservationId);
    if (spent + reserved > budget) {
      throw new ApplyError('budget-exceeded', `Signer ${address} has ${spent} wei committed; ${reserved} wei for reservation ${first.intent.reservationId} would exceed its ${budget} wei budget.`, { actionId: unmined[0]!.item.planned.id, retryable: true });
    }
  }
  for (const job of jobs.filter(entry => entry.receipt && entry.records.at(-1)?.phase !== 'verified')) {
    const receipt = job.receipt;
    if (!receipt) continue;
    const mined = matchingVariant(job.variants, receipt);
    await recordReceipt(ctx, job.item, mined, receipt);
    await finish(ctx, job.item, mined, receipt);
    await decide(ctx, job.item);
    job.completed = true;
  }
  await assertSignerHistory(ctx, jobs.filter(job => !job.signed).map(job => job.signer.address));
  for (const job of jobs.filter(entry => !entry.signed)) {
    const { intent, item, signer } = job;
    const tx = transactionFor(item);
    const envelope: TransactionEnvelope = { chainId: ctx.plan.chain.id, to: tx.to, data: tx.data, value: BigInt(intent.value),
      gas: BigInt(intent.gas), maxFeePerGas: BigInt(intent.maxFeePerGas), maxPriorityFeePerGas: BigInt(intent.maxPriorityFeePerGas), nonce: Number(intent.nonce) };
    let signed: SignedBytes;
    try { signed = await signWithLease(ctx, item.planned.id, signer, envelope); }
    catch (error) { throw new ApplyError('signer', error instanceof Error ? error.message : String(error), { actionId: item.planned.id, retryable: true }); }
    const signedRecord = await append(ctx, item.planned.id, { ...intentFields({ envelope, entry: job.entry, signer }, wave.wave, intent.reservationId!, attemptId), phase: 'signed', ...signed });
    job.signed = signedRecord;
    job.signedIntent = intent;
    job.variants = [signedRecord];
    ctx.sent.push({ actionId: item.planned.id, wave: wave.wave, signer: job.entry.signer, nonce: intent.nonce, transactionHash: signed.transactionHash.toLowerCase() as Hash });
  }
  const active = jobs.filter(job => job.records.at(-1)?.phase !== 'verified' && !job.completed);
  const signedActive: (ResumeJob & { signed: SignedRecord })[] = [];
  for (const job of active) {
    if (!job.signed) throw new ApplyError('journal', `Wave ${wave.wave} has an unsigned active action ${job.item.planned.id}.`, { actionId: job.item.planned.id });
    const signed = await replaceSigned(ctx, job.item, job.signed, job.variants);
    job.signed = signed;
    job.signedIntent = intentForSigned(ctx.journal.records, signed);
    signedActive.push({ ...job, signed });
  }
  for (const job of signedActive) await report(ctx, 'recovery', { actionId: job.item.planned.id, transactionHash: job.signed.transactionHash, reservationId: job.intent.reservationId });
  if (signedActive.length) await settlePipelineBatch(ctx, signedActive, { rebroadcast: true });
  for (const job of jobs) await decide(ctx, job.item);
  return true;
}

const lower = (value: string | null | undefined): string | null => typeof value === 'string' ? value.toLowerCase() : value ?? null;

// A plan accepts a rebuilt artifact against one saved record. Under the lock, state must still hold that record, or
// this rebaseline of it, and the live code must still be the code that record describes.
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

async function recheckReused(ctx: ApplyContext): Promise<void> {
  for (const item of ctx.prepared.values()) {
    if (item.planned.action !== 'reuse') continue;
    const verification = await verify(ctx, item);
    if (verification.status !== 'verified') {
      throw new ApplyError('drift', `A resource that the plan reuses is now ${verification.status}. Create a new plan.`, { actionId: item.planned.id, evidence: summarizeVerification(verification) });
    }
    const artifactDrift = checkArtifactDrift(ctx, item, verification);
    ctx.outcomes.set(item.planned.id, { id: item.planned.id, action: 'reuse', outcome: 'reused', address: item.planned.address, verification, ...(artifactDrift ? { artifactDrift } : {}) });
  }
}

// Returns the item if it needs a new transaction.
async function decide(ctx: ApplyContext, item: PreparedAction): Promise<PreparedAction | null> {
  const records = ctx.journal.forAction(ctx.plan.planHash, item.planned.id);
  const latest = latestRecord(records);
  if (latest?.phase === 'verified') {
    const verification = await verify(ctx, item, { ...(latest.transactionHash ? { transactionHash: latest.transactionHash } : {}), ...(latest.creationProof ? { creationProof: latest.creationProof } : {}) });
    if (verification.status !== 'verified') {
      await fail(ctx, item, 'drift', `The action verified earlier but is now ${verification.status}.`, { evidence: summarizeVerification(verification) });
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

async function prepareBatch(ctx: ApplyContext, batch: ScheduleEntry[]): Promise<FundedJob[]> {
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
    } catch (error) {
      const message = error instanceof Error ? ('shortMessage' in error ? error.shortMessage : error.message) : String(error);
      return fail(ctx, job.item, 'estimate-failed', `Gas estimation failed: ${message}`, { retryable: true, signer: job.signer.address });
    }
    const envelope: CostEnvelope = { chainId: ctx.plan.chain.id, to: tx.to, data: tx.data, value: BigInt(tx.value), gas, ...fees };
    work.push({ ...job, envelope, cost: maximumCost(envelope as TransactionEnvelope) });
  }
  return work;
}

// Count every durable signature, including mined and failed transactions. A nonce
// can only spend once, so replacements contribute their largest possible cost.
async function commitments(ctx: ApplyContext): Promise<CommitmentLedger> {
  const bySigner: CommitmentLedger = new Map();
  for (const record of ctx.journal.records) {
    if (record.planHash !== ctx.plan.planHash || record.phase !== 'signed') continue;
    const planned = ctx.prepared.get(record.actionId)?.planned;
    try {
      const intent = intentForSigned(ctx.journal.records, record);
      for (const entry of [intent, record]) {
        if (!entry || entry.chain.id !== ctx.plan.chain.id ||
          entry.chain.genesisHash.toLowerCase() !== ctx.plan.chain.genesisHash.toLowerCase()) {
          throw new Error('Signed transaction has no matching intent on this chain.');
        }
      }
      if (!planned) throw new Error('Signed transaction has no matching plan action.');
      const cost = await validateSignedTransaction(record, intent, planned, ctx.plan.chain.id);
      const signer = record.signer.toLowerCase();
      const nonces = bySigner.get(signer) ?? new Map<string, { cost: bigint; reservationId?: string }[]>();
      const nonce = BigInt(record.nonce).toString();
      const variants = nonces.get(nonce) ?? [];
      variants.push({ cost, ...(record.reservationId ? { reservationId: record.reservationId } : {}) });
      nonces.set(nonce, variants);
      bySigner.set(signer, nonces);
    } catch (error) {
      throw new ApplyError('journal', `${record.actionId}: ${error instanceof Error ? error.message : String(error)}`, { actionId: record.actionId });
    }
  }
  return bySigner;
}

function signedSpend(commitments: CommitmentLedger, signer: string, exceptReservation: string | null = null): bigint {
  return [...(commitments.get(signer)?.values() ?? [])].reduce((sum, variants) => {
    const costs = variants.filter(entry => entry.reservationId !== exceptReservation).map(entry => entry.cost);
    return sum + (costs.length ? costs.reduce((max, cost) => cost > max ? cost : max) : 0n);
  }, 0n);
}

function budgetFor(ctx: ApplyContext, signer: string): bigint {
  if (!ctx.plan.maxSpendWei) throw new ApplyError('plan-policy', 'The saved plan needs a maxSpendWei ceiling.');
  const approved = BigInt(ctx.plan.maxSpendWei);
  const supplied = ctx.config.budgets[signer];
  return supplied === undefined || approved < BigInt(supplied) ? approved : BigInt(supplied);
}

// Check the whole batch before signing any transaction in it.
async function checkBatchFunding(ctx: ApplyContext, work: FundedJob[]): Promise<void> {
  const shortfalls: { job: FundedJob; code: FailureCode; reason: string; balanceWei?: bigint; requiredWei: bigint; budgetWei?: bigint; spentWei?: bigint }[] = [];
  const ledger = await commitments(ctx);
  const groups = new Map<string, FundedJob[]>();
  for (const job of work) {
    const lane = job.signer.address.toLowerCase();
    const group = groups.get(lane) ?? [];
    group.push(job);
    groups.set(lane, group);
  }
  for (const [lane, jobs] of groups) {
    const job = jobs[0]!;
    const required = jobs.reduce((sum, entry) => sum + entry.cost, 0n);
    const balance = await ctx.client.getBalance({ address: job.signer.address });
    const spent = signedSpend(ledger, lane);
    const budget = budgetFor(ctx, lane);
    if (balance < required) shortfalls.push({ job, code: 'insufficient-funds', reason: `Signer ${job.signer.address} has ${balance} wei; the signer group can cost ${required} wei.`, balanceWei: balance, requiredWei: required });
    else if (spent + required > budget) shortfalls.push({ job, code: 'budget-exceeded', reason: `Signer ${job.signer.address} has ${spent} wei committed; ${required} wei for ${jobs.map(entry => entry.item.planned.id).join(', ')} would exceed its ${budget} wei budget.`, budgetWei: budget, spentWei: spent, requiredWei: required });
  }
  if (shortfalls.length) {
    for (const { job, code, reason, ...evidence } of shortfalls) {
      await append(ctx, job.item.planned.id, { phase: 'failed', code, reason, retryable: true, signer: job.signer.address, evidence: jsonSafe(evidence) as import('../types.ts').JsonValue });
    }
    const first = shortfalls[0]!;
    throw new ApplyError(first.code, `${first.reason} No transaction in this batch was signed.`, { actionId: first.job.item.planned.id, retryable: true, evidence: shortfalls.map(({ job, code, reason }) => ({ id: job.item.planned.id, code, reason })) });
  }
}

async function checkExecutionDependencies(ctx: ApplyContext, work: { item: PreparedAction }[], requireCompleted = true): Promise<void> {
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

// A lost lease stops the next signature.
async function signWithLease(ctx: ApplyContext, actionId: ResourceId, signer: SignerAccount, envelope: TransactionEnvelope): Promise<SignedBytes> {
  await ctx.lock.assertHeld?.();
  const started = Date.now();
  const signed = await signEnvelope(signer, envelope);
  await report(ctx, 'signer-result', { actionId, signer: signer.address, signerLatencyMs: Date.now() - started });
  return signed;
}

async function signBatch(ctx: ApplyContext, wave: number, work: FundedJob[]): Promise<SignedBatchJob[]> {
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
    await ctx.lock.assertHeld?.();
    await append(ctx, item.planned.id, { phase: 'intent', wave, signer: job.signer.address, signerRole: entry.signerRole, pooled: entry.pooled, nonce: String(envelope.nonce), to: envelope.to, value: String(envelope.value), dataHash: keccak256(envelope.data), gas: String(envelope.gas), maxFeePerGas: String(envelope.maxFeePerGas), maxPriorityFeePerGas: String(envelope.maxPriorityFeePerGas) });
    let signed: SignedBytes;
    try {
      signed = await signWithLease(ctx, item.planned.id, job.signer, envelope);
    } catch (error) {
      return fail(ctx, item, 'signer', error instanceof Error ? error.message : String(error), { retryable: true, signer: job.signer.address });
    }
    const signedRecord = await append(ctx, item.planned.id, { phase: 'signed', signer: job.signer.address, nonce: String(envelope.nonce), ...signed });
    signedWork.push({ ...job, signed: signedRecord });
    ctx.sent.push({ actionId: item.planned.id, wave, signer: job.signer.address.toLowerCase(), nonce: String(envelope.nonce), transactionHash: signed.transactionHash.toLowerCase() as Hash });
  }
  return signedWork;
}

function intentFields(job: { envelope: CostEnvelope; entry: ScheduleEntry; signer: SignerAccount }, wave: number, reservationId: string, waveAttemptId: string | null = null): import('./types.ts').IntentFields {
  const { envelope, entry } = job;
  if (envelope.nonce === undefined) throw new ApplyError('nonce-conflict', `Signer ${job.signer.address} has no reserved pipeline nonce.`, { actionId: entry.id });
  return { phase: 'intent', wave, reservationId, ...(waveAttemptId ? { waveAttemptId } : {}), signer: job.signer.address, signerRole: entry.signerRole, pooled: entry.pooled,
    ...(entry.nonceOffset === undefined ? {} : { nonceOffset: entry.nonceOffset }), nonce: String(envelope.nonce), to: envelope.to, value: String(envelope.value),
    dataHash: keccak256(envelope.data), gas: String(envelope.gas), maxFeePerGas: String(envelope.maxFeePerGas),
    maxPriorityFeePerGas: String(envelope.maxPriorityFeePerGas) };
}

async function signPipelineBatch(ctx: ApplyContext, wave: number, work: FundedJob[]): Promise<PipelineBatchJob[]> {
  await checkExecutionDependencies(ctx, work);
  await assertSignerHistory(ctx, work.map(job => job.signer.address));
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
    if (pending !== latest) return fail(ctx, jobs[0]!.item, 'nonce-conflict', `Signer ${signer} has unknown pending transactions.`, { signer: signer as Address, nonce: String(latest) });
    for (const [offset, job] of jobs.entries()) {
      if (job.entry.nonceOffset !== offset) throw new ApplyError('stale-pipeline', `Wave ${wave} has an already satisfied action before ${job.item.planned.id}; create a new pipeline plan.`, { actionId: job.item.planned.id });
      job.envelope.nonce = latest + offset;
    }
  }
  // Every intent is durable before any signature. Partial intent groups can be discarded on restart.
  const waveAttemptId = randomUUID();
  const intents = new Map<FundedJob, IntentRecord>();
  for (const jobs of groups.values()) {
    const reservationId = randomUUID();
    for (const job of jobs) intents.set(job, await append(ctx, job.item.planned.id, intentFields(job, wave, reservationId, waveAttemptId)));
  }
  // The lock remains held and no broadcast starts until every signed record is synced.
  const signedWork: PipelineBatchJob[] = [];
  for (const job of work) {
    const intent = intents.get(job);
    if (!intent?.reservationId || job.envelope.nonce === undefined) throw new ApplyError('journal', `Wave ${wave} has no durable intent for ${job.item.planned.id}.`, { actionId: job.item.planned.id });
    let signed: SignedBytes;
    try { signed = await signWithLease(ctx, job.item.planned.id, job.signer, { ...job.envelope, nonce: job.envelope.nonce }); }
    catch (error) { throw new ApplyError('signer', error instanceof Error ? error.message : String(error), { actionId: job.item.planned.id, retryable: true }); }
    const signedRecord = await append(ctx, job.item.planned.id, { ...intentFields(job, wave, intent.reservationId, waveAttemptId), phase: 'signed', ...signed });
    signedWork.push({ ...job, intent, signedIntent: intent, signed: signedRecord, variants: [signedRecord] });
    const signer = job.signer.address.toLowerCase();
    ctx.sent.push({ actionId: job.item.planned.id, wave, signer, nonce: String(job.envelope.nonce), transactionHash: signed.transactionHash.toLowerCase() as Hash });
  }
  return signedWork;
}

async function settleBatch(ctx: ApplyContext, work: SignedBatchJob[]): Promise<void> {
  // Every signed job gets a chance to settle before a batch error is reported.
  const settled = await Promise.allSettled(work.map(async job => {
    const receipt = await send(ctx, job.item, job.signed);
    await recordReceipt(ctx, job.item, job.signed, receipt);
    await finish(ctx, job.item, job.signed, receipt);
  }));
  const rejected = settled.find(result => result.status === 'rejected');
  if (rejected) throw rejected.reason;
}

async function pipelineConflict(ctx: ApplyContext, job: { item: PreparedAction; signed: SignedRecord }): Promise<never> {
  const { signer, nonce, transactionHash } = job.signed;
  return fail(ctx, job.item, 'nonce-conflict', `Signer ${signer} nonce ${nonce} for ${job.item.planned.id} was consumed by an unknown transaction; expected ${transactionHash}.`,
    { signer, nonce, transactionHash });
}

async function preparePipelineBroadcast(ctx: ApplyContext, job: ActivePipelineJob): Promise<PipelineAttempt> {
  const { signed } = job;
  let receipt = await findKnownReceipt(ctx.client, job.variants);
  if (receipt) return { receipt };
  if (await nonceConsumed(ctx.client, signed.signer, signed.nonce)) {
    receipt = await findKnownReceipt(ctx.client, job.variants);
    if (receipt) return { receipt };
    await pipelineConflict(ctx, job);
  }
  const pending = await ctx.client.getTransactionCount({ address: signed.signer, blockTag: 'pending' });
  if (BigInt(pending) > BigInt(signed.nonce)) {
    const knownBroadcast = ctx.journal.forAction(ctx.plan.planHash, job.item.planned.id)
      .some(record => record.phase === 'broadcast' && job.variants.some(variant => variant.transactionHash === record.transactionHash));
    if (!knownBroadcast) {
      let knownTransaction = false;
      for (const variant of job.variants) {
        try { knownTransaction ||= Boolean(await ctx.client.getTransaction({ hash: variant.transactionHash })); }
        catch (error) { if (!(error instanceof Error) || error.name !== 'TransactionNotFoundError') throw error; }
      }
      if (!knownTransaction) await pipelineConflict(ctx, job);
    }
  }
  return {};
}

async function transactionKnown(client: Client, hash: Hash): Promise<boolean> {
  try { return Boolean(await client.getTransaction({ hash })); }
  catch (error) {
    if (error instanceof Error && error.name === 'TransactionNotFoundError') return false;
    throw error;
  }
}

async function recordPipelineBroadcast(ctx: ApplyContext, job: ActivePipelineJob, sent: BroadcastOutcome, rebroadcast: boolean): Promise<PipelineAttempt> {
  const { signed } = job;
  await append(ctx, job.item.planned.id, { phase: 'broadcast-attempt', ...(signed.reservationId ? { reservationId: signed.reservationId } : {}), signer: signed.signer,
    nonce: signed.nonce, transactionHash: signed.transactionHash, accepted: sent.accepted,
    ...(!sent.accepted && sent.error ? { error: sent.error } : {}), rebroadcast });
  if (sent.accepted) {
    await append(ctx, job.item.planned.id, { phase: 'broadcast', ...(signed.reservationId ? { reservationId: signed.reservationId } : {}), signer: signed.signer,
      nonce: signed.nonce, transactionHash: signed.transactionHash, rebroadcast, ...(sent.known ? { known: true } : {}) });
    if (rebroadcast) ctx.rebroadcasts.push({ actionId: job.item.planned.id, transactionHash: signed.transactionHash });
  } else if (sent.nonceTooLow) {
    const receipt = await findKnownReceipt(ctx.client, job.variants);
    if (receipt) return { receipt };
    await pipelineConflict(ctx, job);
  }
  return { accepted: sent.accepted };
}

// Starts the raw request before its first await, so a group's requests begin in nonce order.
async function sendPipelineTransaction(ctx: ApplyContext, job: ActivePipelineJob, rebroadcast: boolean): Promise<PipelineAttempt> {
  const started = Date.now();
  const sent = await broadcast(ctx.client, job.signed.rawTransaction);
  await report(ctx, 'broadcast-result', { actionId: job.item.planned.id, transactionHash: job.signed.transactionHash, rebroadcast, accepted: sent.accepted, broadcastLatencyMs: Date.now() - started });
  return recordPipelineBroadcast(ctx, job, sent, rebroadcast);
}

async function attemptPipelineBroadcast(ctx: ApplyContext, job: ActivePipelineJob, rebroadcast: boolean): Promise<PipelineAttempt> {
  const prepared = await preparePipelineBroadcast(ctx, job);
  if (prepared.receipt) return prepared;
  await ctx.lock.assertHeld?.();
  return sendPipelineTransaction(ctx, job, rebroadcast);
}

async function settlePipelineBatch(ctx: ApplyContext, work: ActivePipelineJob[], { rebroadcast = false }: { rebroadcast?: boolean } = {}): Promise<void> {
  for (const job of work) {
    try { await validateSignedTransaction(job.signed, job.signedIntent ?? job.intent, job.item.planned, ctx.plan.chain.id); }
    catch (error) { throw new ApplyError('journal', `${job.item.planned.id}: ${error instanceof Error ? error.message : String(error)}`, { actionId: job.item.planned.id }); }
  }
  const submitStart = Date.now();
  // Reconcile the complete group first. Then initiate all raw requests in plan
  // order without waiting for a lower nonce's RPC response.
  const prepared = await Promise.all(work.map(job => preparePipelineBroadcast(ctx, job)));
  // One lease check covers the group, so no await separates its first requests.
  await ctx.lock.assertHeld?.();
  const firstAttempts = await Promise.all(work.map(async (job, index) => {
    if (prepared[index]?.receipt) return prepared[index]!;
    try { return await sendPipelineTransaction(ctx, job, rebroadcast); }
    catch (error) { return { error }; }
  }));
  ctx.timings.submitMs += Date.now() - submitStart;
  const settled = await Promise.allSettled(work.map(async (job, index) => {
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
            if (Date.now() >= deadline) throw new ApplyError('broadcast-failed', `Broadcast of ${job.signed.transactionHash} did not succeed before timeout. Rerun to retry the same bytes.`, { actionId: job.item.planned.id, retryable: true });
            await pause(ctx.config.pollIntervalMs);
            attempt = await attemptPipelineBroadcast(ctx, job, true);
          }
        } finally { ctx.timings.submitMs += Date.now() - retryStart; }
        if (attempt.receipt) {
          receipt = attempt.receipt;
          break;
        }
      }
      const waited = await waitForReceipt(ctx.client, { signedVariants: job.variants ?? [job.signed], signer: job.signed.signer, nonce: job.signed.nonce,
        pollIntervalMs: ctx.config.pollIntervalMs, timeoutMs: Math.min(1_000, Math.max(0, deadline - Date.now())) });
      if ('dead' in waited) await pipelineConflict(ctx, job);
      if ('receipt' in waited) {
        receipt = waited.receipt;
        break;
      }
      if (Date.now() >= deadline) throw new ApplyError('receipt-timeout', `No receipt for ${job.signed.transactionHash}. Rerun to resume the same transaction.`, { actionId: job.item.planned.id, retryable: true });
      // A node can acknowledge a higher nonce and leave it queued after lower
      // nonces settle. Retry the same durable bytes if it disappears or stalls.
      const known = await transactionKnown(ctx.client, job.signed.transactionHash);
      if (!known || Date.now() >= knownRetryAt) {
        const retryStart = Date.now();
        try { attempt = await attemptPipelineBroadcast(ctx, job, true); }
        finally { ctx.timings.submitMs += Date.now() - retryStart; }
        knownRetryAt = Date.now() + 10_000;
        receipt = attempt.receipt;
      }
    }
    if (!receipt) throw new ApplyError('receipt-timeout', `No receipt for ${job.signed.transactionHash}.`, { actionId: job.item.planned.id, retryable: true });
    if (!firstAttempts[index]?.receipt) await report(ctx, 'receipt-observed', { actionId: job.item.planned.id, transactionHash: receipt.transactionHash, receiptLatencyMs: Date.now() - receiptStart });
    ctx.timings.receiptMs += Date.now() - receiptStart;
    const mined = matchingVariant(job.variants ?? [job.signed], receipt);
    await recordReceipt(ctx, job.item, mined, receipt);
    await finish(ctx, job.item, mined, receipt);
  }));
  const rejected = settled.find(result => result.status === 'rejected');
  if (rejected) throw rejected.reason;
}

async function runBatch(ctx: ApplyContext, wave: number, batch: ScheduleEntry[]): Promise<void> {
  if (!ctx.pipeline && new Set(batch.map(entry => entry.signer)).size !== batch.length) throw new ApplyError('schedule', `Wave ${wave} has a batch with two actions for one signer.`);
  const work = await prepareBatch(ctx, batch);
  if (work.length === 0) return;
  if (ctx.pipeline && work.length !== batch.length) throw new ApplyError('stale-pipeline', `Wave ${wave} no longer matches its saved nonce offsets. Create a new pipeline plan.`);
  await checkBatchFunding(ctx, work);
  if (ctx.pipeline) {
    const signingStart = Date.now();
    const signed = await signPipelineBatch(ctx, wave, work);
    ctx.timings.submitMs += Date.now() - signingStart;
    await settlePipelineBatch(ctx, signed);
  } else {
    const signed = await signBatch(ctx, wave, work);
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

function summary(ctx: ApplyContext, status: ApplyResult['status'], error?: Error & Partial<ApplyError>): ApplyResult {
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
export async function applyPlan({ plan, spec, artifacts, client, signers, signerProvider, signerRoles, stateStore, journalStore, lockProvider, journalCipher, scope: scopeInput, principal, ttlMs, stateFile, journalFile, parallel = false, pipeline = false, ...options }: ApplyInput): Promise<ApplyResult> {
  if (pipeline && plan?.pipeline) parallel = plan.pipeline.parallel;
  if (options.replacementFees !== undefined && (!options.replacementFees ||
    (['maxFeePerGas', 'maxPriorityFeePerGas', 'maxCostWei'] as const).some(field => !/^[0-9]+$/.test(String(options.replacementFees?.[field] ?? ''))))) {
    throw new ApplyError('config', 'replacementFees needs maxFeePerGas, maxPriorityFeePerGas, and maxCostWei as non-negative wei integers.');
  }
  const config: ApplyConfig = { ...DEFAULTS, ...options, confirmations: options.confirmations ?? 1,
    hooks: { ...options.hooks }, budgets: Object.fromEntries(Object.entries(options.budgets ?? {}).map(([address, wei]) => [address.toLowerCase(), wei])) };
  const remote = Boolean(stateStore || journalStore || lockProvider || journalCipher || scopeInput);
  if (remote && (!stateStore || !journalStore || !lockProvider || !journalCipher || !scopeInput)) throw new ApplyError('config', 'Production apply needs stateStore, journalStore, lockProvider, journalCipher, and scope together.');
  if (remote && typeof journalStore?.signedForSigner !== 'function') throw new ApplyError('config', 'Production journalStore needs signedForSigner(scope, address).');
  if (remote && options.confirmations === undefined) throw new ApplyError('config', 'Production apply needs an explicit confirmations policy.');
  if (!Number.isSafeInteger(config.confirmations) || config.confirmations < 1) throw new ApplyError('config', 'Confirmations must be a positive integer.');
  if (!remote && (typeof stateFile !== 'string' || typeof journalFile !== 'string')) throw new ApplyError('config', 'Apply needs stateFile and journalFile paths.');
  const backend = remote ? { stateStore: stateStore!, journalStore: journalStore!, lockProvider: lockProvider!, journalCipher: journalCipher!, scope: deploymentScope(scopeInput, plan.chain) } : null;
  const scope = backend?.scope ?? null;
  const signerControl: SignerAuthorization & { assertHeld: (() => Promise<void>) | null } = { scope, fence: null, assertHeld: null };
  const lanes = lanesFrom(signerProvider ? await signersFromProvider(signerProvider, signerRoles, plan, signerControl) : signers, parallel);
  const deps = loadDependencies(config.dependencies);
  const lockStarted = Date.now();
  const emitLeaseEvent = (event: ReportEvent) => typeof config.reporter === 'function' ? config.reporter(event) : config.reporter?.emit(event);
  const lock = backend
    ? await acquireLeases({ lockProvider: backend.lockProvider, scope: backend.scope, addresses: [...lanes.byAddress.keys()] as Address[], planHash: plan.planHash, principal, ttlMs,
      onRenew: event => emitLeaseEvent({ type: 'lock-renewal', at: new Date().toISOString(), planHash: plan.planHash, chain: plan.chain, scope: backend.scope, principal: event.holder.principal }),
      onRenewFailure: event => emitLeaseEvent({ type: 'lock-renewal-failure', at: new Date().toISOString(), planHash: plan.planHash, chain: plan.chain, scope: backend.scope, principal: event.holder.principal, reason: event.error.message }),
    })
    : await acquireLock(`${stateFile!}.lock`, { planHash: typeof plan.planHash === 'string' ? plan.planHash : null });
  const fence = 'fence' in lock ? lock.fence : null;
  signerControl.fence = fence;
  signerControl.assertHeld = () => lock.assertHeld();
  let journal: ApplyContext['journal'] | undefined;
  try {
    journal = backend ? await openStoredJournal({ journalStore: backend.journalStore, journalCipher: backend.journalCipher, scope: backend.scope, fence, assertHeld: () => lock.assertHeld() }) : await openJournal(journalFile!);
    const readState: ApplyContext['readState'] = backend
      ? async () => { const found = await backend.stateStore.read(backend.scope); return { version: found?.version ?? null, value: found ? validateState(found.value) : null }; }
      : async () => ({ version: null, value: await deps.readState(stateFile!) });
    const writeState: ApplyContext['writeState'] = backend
      ? (version, state) => backend.stateStore.compareAndSwap(backend.scope, version, validateState(state), { fence })
      : (_version, state) => deps.writeStateAtomic(stateFile!, state);
    const ctx: ApplyContext = { plan, spec, artifacts, client, lanes, deps, journal, journalStore: backend?.journalStore, lock, config, scope, remote,
      principal: 'principal' in lock.holder ? lock.holder.principal : principal, readState, writeState, stateFile: stateFile ?? null, parallel, pipeline,
      sent: [], rebroadcasts: [], outcomes: new Map<ResourceId, ResourceOutcome>(), timings: { submitMs: 0, receiptMs: 0, verificationMs: 0 },
      state: { file: stateFile ?? null, written: false }, prepared: new Map<ResourceId, PreparedAction>(), preflightComplete: false, stateSnapshot: null };
    await report(ctx, 'lock-acquisition', { holder: lock.holder, fencingTokens: fence?.map(entry => entry.token), lockWaitMs: Date.now() - lockStarted });
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
          ctx.state = { file: stateFile ?? null, written: false, reason: stateError instanceof Error ? stateError.message : String(stateError) };
        }
      }
      failure.result = summary(ctx, 'stopped', failure);
      throw error;
    }
  } finally {
    await journal?.close();
    await lock.release();
  }
}
