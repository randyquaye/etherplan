import { keccak256 } from 'viem';
import { intentForSigned, latestRecord, liveTransactions, readLocalJournal, signedVariants } from './journal.ts';
import { broadcast, feesFor, findKnownReceipt, findReceipt, nonceConsumed, receiptJson, signEnvelope, validateSignedTransaction, waitForReceipt, maximumCost } from './transactions.ts';
import { ApplyError } from './errors.ts';
import { safeExternalError } from './rpc-error.ts';
import { deploymentScope, scopeKey, validateJournal } from './backends.ts';
import { localSignerJournals } from './local-signer.ts';
import { canonicalLocalFile } from './lock.ts';
import { transactionFor } from './shared.ts';
import { budgetFor, commitments, spendWithVariant } from './funding.ts';
import { checkExecutionDependencies, finish, stableReceipt } from './outcome.ts';
import { append, fail, report } from './report.ts';
import { assertPinnedSignedIntent } from '../verification/pinned-runtime.ts';
import type { Address, Hash, ResourceId } from '../types.ts';
import type { ApplyContext, IntentRecord, JournalRecord, PreparedAction, Receipt, SignedBytes, SignedFields, SignedIndexEntry, SignedRecord, SignerAccount, StoredJournalRecord, TransactionEnvelope } from './types.ts';

export async function recordReceipt(ctx: ApplyContext, item: PreparedAction, signed: SignedRecord, receipt: Receipt): Promise<void> {
  const latest = latestRecord(ctx.journal.forAction(ctx.plan.planHash, item.planned.id));
  const json = receiptJson(receipt);
  if (latest?.phase === 'receipt' && latest.receipt?.blockHash === json.blockHash.toLowerCase()) return;
  await append(ctx, item.planned.id, { phase: 'receipt', signer: signed.signer, nonce: signed.nonce, transactionHash: signed.transactionHash, receipt: json });
}

// A partially signed pipeline wave may sign its remaining reserved nonces only
// after resumePipelineWave has validated the whole reservation. Every other
// signature, including one from this plan, needs a canonical receipt first.
export async function assertSignerHistory(ctx: ApplyContext, addresses: Address[], activeSignatures: ReadonlySet<string> = new Set()): Promise<void> {
  const { journalStore, scope } = ctx;
  if (!ctx.remote) {
    if (!ctx.journal.file) throw new ApplyError('config', 'Local signer history needs a journal file.');
    const current = await canonicalLocalFile(ctx.journal.file);
    for (const address of new Set(addresses.map(value => value.toLowerCase() as Address))) {
      const files = new Set([...(await localSignerJournals(ctx.plan.chain, address)), current]);
      for (const file of files) {
        await assertLocalJournalSettled(ctx, file, address, file === current ? ctx.journal.records : null,
          file === current ? activeSignatures : new Set());
      }
    }
    return;
  }
  if (!journalStore || !scope) return;
  const scopeRecords = new Map<string, StoredJournalRecord[]>();
  const priorJournal = async (entry: SignedIndexEntry): Promise<StoredJournalRecord[]> => {
    const priorScope = deploymentScope({ project: entry.project, environment: entry.environment, label: entry.label }, { id: scope.chainId, genesisHash: scope.genesisHash });
    const key = scopeKey(priorScope);
    const cached = scopeRecords.get(key);
    if (cached) return cached;
    const records: StoredJournalRecord[] = [];
    for await (const record of journalStore.read(priorScope)) records.push(record);
    validateJournal(records, priorScope);
    if (journalStore.head) {
      const head = await journalStore.head(priorScope);
      if ((head?.sequence ?? 0) !== records.length || (head?.recordHash ?? null) !== (records.at(-1)?.recordHash ?? null)) throw new ApplyError('journal', `Signer source journal ${key} differs from its head.`);
    }
    scopeRecords.set(key, records);
    return records;
  };
  for (const address of new Set(addresses.map(value => value.toLowerCase()))) {
    const groups = new Map<string, SignedIndexEntry[]>();
    for await (const signed of journalStore.signedForSigner(scope, address)) {
      if (typeof signed.project !== 'string' || typeof signed.environment !== 'string' || typeof signed.label !== 'string' ||
        typeof signed.actionId !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(signed.planHash ?? '') ||
        signed.signer?.toLowerCase() !== address || !/^0x[0-9a-fA-F]{64}$/.test(signed.transactionHash ?? '') ||
        !/^[0-9]+$/.test(signed.nonce ?? '')) throw new ApplyError('journal', 'Signer index entry has invalid source or transaction identity.', { actionId: signed.actionId });
      // The signer index has one row per signature. Every variant of one action
      // at a nonce represents the same possible spend, and only one can mine.
      const key = JSON.stringify([signed.project, signed.environment, signed.label, signed.planHash.toLowerCase(), signed.actionId, address, BigInt(signed.nonce).toString()]);
      const group = groups.get(key) ?? [];
      group.push(signed);
      groups.set(key, group);
    }
    for (const variants of groups.values()) {
      const first = variants[0]!;
      const records = await priorJournal(first);
      const signed = records.filter((record): record is StoredJournalRecord & Omit<SignedFields, 'rawTransaction'> => record.phase === 'signed' && record.planHash.toLowerCase() === first.planHash.toLowerCase() &&
        record.actionId === first.actionId && record.signer.toLowerCase() === address && BigInt(record.nonce) === BigInt(first.nonce));
      const indexed = new Set(variants.map(entry => entry.transactionHash.toLowerCase()));
      if (signed.length !== variants.length || indexed.size !== variants.length ||
        signed.some(record => !indexed.has(record.transactionHash.toLowerCase())) ||
        signed.some((record, index) => index === 0 ? Boolean(record.replacement || record.replacesTransactionHash) :
          !record.replacement || record.replacesTransactionHash?.toLowerCase() !== signed[index - 1]!.transactionHash.toLowerCase())) {
        throw new ApplyError('journal', `Signer index entries for ${first.actionId} are not one signed replacement chain.`, { actionId: first.actionId });
      }
      const activeCurrent = first.project === scope.project && first.environment === scope.environment && first.label === scope.label &&
        first.planHash.toLowerCase() === ctx.plan.planHash.toLowerCase() &&
        signed.every(record => activeSignatures.has(record.transactionHash.toLowerCase()));
      if (activeCurrent) continue;
      let mined: { signed: SignedIndexEntry; receipt: Receipt } | null = null;
      for (const signed of variants) {
        const receipt = await findReceipt(ctx.client, signed.transactionHash);
        if (receipt) { mined = { signed, receipt }; break; }
      }
      if (!mined) {
        const signed = variants[0]!;
        throw new ApplyError('foreign-outstanding', `Deployment ${signed.project}/${signed.environment}/${signed.label} has unresolved transaction ${signed.transactionHash} for signer ${address}. Settle that deployment before continuing.`, { actionId: signed.actionId, retryable: true });
      }
      await stableReceipt(ctx, mined.signed.transactionHash, mined.receipt, mined.signed.actionId);
    }
  }
}

async function assertLocalJournalSettled(ctx: ApplyContext, file: string, address: Address, currentRecords: JournalRecord[] | null,
  activeSignatures: ReadonlySet<string>): Promise<void> {
  let records: JournalRecord[];
  try { records = currentRecords ?? await readLocalJournal(file); }
  catch (error) { throw new ApplyError('journal', `Cannot inspect signer journal ${file}: ${error instanceof Error ? error.message : String(error)}`); }
  const groups = new Map<string, SignedRecord[]>();
  for (const record of records) {
    if (record.phase !== 'signed' || record.signer.toLowerCase() !== address || record.chain.id !== ctx.plan.chain.id ||
      record.chain.genesisHash.toLowerCase() !== ctx.plan.chain.genesisHash.toLowerCase()) continue;
    const key = JSON.stringify([record.planHash, record.actionId, record.signer.toLowerCase(), BigInt(record.nonce).toString()]);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  for (const variants of groups.values()) {
    const first = variants[0]!;
    if (variants.some((record, index) => index === 0 ? Boolean(record.replacement || record.replacesTransactionHash) :
      !record.replacement || record.replacesTransactionHash?.toLowerCase() !== variants[index - 1]!.transactionHash.toLowerCase())) {
      throw new ApplyError('journal', `Signer journal ${file} has invalid replacement links.`, { actionId: first.actionId });
    }
    for (const signed of variants) {
      try { intentForSigned(records, signed); }
      catch (error) { throw new ApplyError('journal', `Signer journal ${file}: ${error instanceof Error ? error.message : String(error)}`, { actionId: signed.actionId }); }
    }
    if (first.planHash.toLowerCase() === ctx.plan.planHash.toLowerCase() &&
      variants.every(record => activeSignatures.has(record.transactionHash.toLowerCase()))) continue;
    let receipt: Receipt | null = null;
    let mined: SignedRecord | null = null;
    for (const signed of variants) {
      receipt = await findReceipt(ctx.client, signed.transactionHash);
      if (receipt) { mined = signed; break; }
    }
    if (!receipt || !mined) throw new ApplyError('foreign-outstanding', `Local journal ${file} has unresolved transaction ${first.transactionHash} for signer ${address}. Replan using that journal and apply its recovery before continuing.`, { actionId: first.actionId, retryable: true });
    await stableReceipt(ctx, mined.transactionHash, receipt, mined.actionId);
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
  assertPinnedSignedIntent(ctx.journal.records, ctx.plan.planHash, item, signed);
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
      if (await nonceConsumed(ctx.client, signed.signer, signed.nonce)) {
        const late = await findKnownReceipt(ctx.client, variants);
        if (late) return late;
        await fail(ctx, item, 'nonce-race', `Signer ${signed.signer} nonce ${signed.nonce} was used by a transaction that is not in the journal. Stop the other writer, then rerun this plan.`, { retryable: true, signer: signed.signer, nonce: signed.nonce, transactionHash: signed.transactionHash });
      }
      throw new ApplyError('broadcast-failed', `Broadcast of ${signed.transactionHash} was rejected as nonce too low, but nonce ${signed.nonce} is not yet consumed on chain. Rerun to settle this signed transaction.`, { actionId: item.planned.id, retryable: true });
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
  assertPinnedSignedIntent(ctx.journal.records, ctx.plan.planHash, item, signed);
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
  const lane = signed.signer.toLowerCase();
  const ledger = await commitments(ctx);
  const budget = budgetFor(ctx, lane);
  const committed = spendWithVariant(ledger, lane, signed.nonce, cost);
  if (committed > budget) {
    throw new ApplyError('budget-exceeded', `Replacement would commit ${committed} wei for signer ${signed.signer}, above its ${budget} wei budget.`, { actionId: item.planned.id, retryable: true });
  }
  let intent: IntentRecord;
  if (orphan && pending?.phase === 'intent') intent = pending;
  else {
    intent = await append(ctx, item.planned.id, { phase: 'intent', replacement: true, replacesTransactionHash: signed.transactionHash,
      maxCostWei: String(ceiling), signer: signed.signer, nonce: signed.nonce, to: envelope.to,
      value: String(envelope.value), dataHash: keccak256(envelope.data), gas: String(envelope.gas),
      maxFeePerGas: String(fees.maxFeePerGas), maxPriorityFeePerGas: String(fees.maxPriorityFeePerGas),
      ...Object.fromEntries((['wave', 'reservationId', 'signerRole', 'pooled', 'nonceOffset', 'waveAttemptId', 'attemptId', 'pinnedCommitment'] as const)
        .filter(field => oldIntent[field] !== undefined).map(field => [field, oldIntent[field]])) });
  }
  let bytes: SignedBytes;
  try { bytes = await signWithLease(ctx, item.planned.id, signer, envelope); }
  catch (error) { throw new ApplyError('signer', safeExternalError(error), { actionId: item.planned.id, retryable: true }); }
  const { formatVersion, planHash, chain, actionId, sequence, at, ...intentFields } = intent;
  const replacement = await append(ctx, item.planned.id, { ...intentFields, phase: 'signed', ...bytes });
  await validateSignedTransaction(replacement, intent, item.planned, ctx.plan.chain.id);
  variants.push(replacement);
  ctx.sent.push({ actionId: item.planned.id, ...(intent.wave === undefined ? {} : { wave: intent.wave }), signer: signed.signer.toLowerCase(), nonce: signed.nonce,
    transactionHash: replacement.transactionHash.toLowerCase() as Hash });
  return replacement;
}

// Resolves every signed variant at a reserved nonce before resending or replacing it.

export async function settle(ctx: ApplyContext, item: PreparedAction, signed: SignedRecord): Promise<void> {
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
    // The transaction is already signed and may still mine, even if another
    // writer has since satisfied the getter. Keep its nonce live until a
    // journaled variant has a receipt or an unknown transaction consumes it.
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
      throw new ApplyError('foreign-outstanding', `Plan ${signed.planHash} has signed transaction ${signed.transactionHash} (signer ${signed.signer}, nonce ${signed.nonce}) that is not on chain. Replan using its journaled action before applying another plan.`, { actionId: signed.actionId, retryable: true });
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
    if (latest.planHash !== ctx.plan.planHash && ctx.remote) throw new ApplyError('plan-mismatch', `An unfinished transaction belongs to plan ${latest.planHash}. Create a plan that recovers its action before applying new writes.`, { actionId: latest.actionId });
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
