import { keccak256 } from 'viem';
import { intentForSigned, latestRecord, liveTransactions, signedVariants } from './journal.ts';
import { broadcast, feesFor, findKnownReceipt, findReceipt, nonceConsumed, receiptJson, signEnvelope, validateSignedTransaction, waitForReceipt, maximumCost } from './transactions.ts';
import { ApplyError } from './errors.ts';
import { transactionFor } from './shared.ts';
import { commitments, signedSpend } from './funding.ts';
import { checkExecutionDependencies, finish, markVerified, precondition, stableReceipt } from './outcome.ts';
import { append, fail, report } from './report.ts';
import type { Address, Hash, ResourceId } from '../types.ts';
import type { ApplyContext, IntentRecord, JournalRecord, PreparedAction, Receipt, SignedBytes, SignedRecord, SignerAccount, TransactionEnvelope } from './types.ts';

export async function recordReceipt(ctx: ApplyContext, item: PreparedAction, signed: SignedRecord, receipt: Receipt): Promise<void> {
  const latest = latestRecord(ctx.journal.forAction(ctx.plan.planHash, item.planned.id));
  const json = receiptJson(receipt);
  if (latest?.phase === 'receipt' && latest.receipt?.blockHash === json.blockHash.toLowerCase()) return;
  await append(ctx, item.planned.id, { phase: 'receipt', signer: signed.signer, nonce: signed.nonce, transactionHash: signed.transactionHash, receipt: json });
}

export async function assertSignerHistory(ctx: ApplyContext, addresses: Address[]): Promise<void> {
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

export async function send(ctx: ApplyContext, item: PreparedAction, signed: SignedRecord, { rebroadcast = false, variants = [signed] }: { rebroadcast?: boolean; variants?: SignedRecord[] } = {}): Promise<Receipt> {
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

export function matchingVariant(variants: SignedRecord[], receipt: Receipt): SignedRecord {
  const signed = variants.find(entry => entry.transactionHash.toLowerCase() === receipt.transactionHash.toLowerCase());
  if (!signed) throw new Error('Receipt is not for a journaled transaction.');
  return signed;
}

export async function replaceSigned(ctx: ApplyContext, item: PreparedAction, signed: SignedRecord, variants: SignedRecord[]): Promise<SignedRecord> {
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

export async function settleJournal(ctx: ApplyContext): Promise<void> {
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

// A lost lease stops the next signature.
export async function signWithLease(ctx: ApplyContext, actionId: ResourceId, signer: SignerAccount, envelope: TransactionEnvelope): Promise<SignedBytes> {
  await ctx.lock.assertHeld?.();
  const started = Date.now();
  const signed = await signEnvelope(signer, envelope);
  await report(ctx, 'signer-result', { actionId, signer: signer.address, signerLatencyMs: Date.now() - started });
  return signed;
}
