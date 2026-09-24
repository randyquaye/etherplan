import { randomUUID } from 'node:crypto';
import { isAddress, keccak256 } from 'viem';
import { hashJson } from '../identity.mjs';
import { createSchedule } from '../scheduling/index.mjs';
import { loadDependencies } from './dependencies.mjs';
import { ApplyError } from './errors.mjs';
import { LIVE_PHASES, latestRecord, liveTransactions, openJournal } from './journal.mjs';
import { acquireLock } from './lock.mjs';
import { checkFactory, jsonSafe, preflight } from './preflight.mjs';
import { broadcast, estimateGasLimit, feesFor, findReceipt, maximumCost, nonceConsumed, receiptJson, signEnvelope, validateSignedTransaction, waitForReceipt } from './transactions.mjs';

export { ApplyError } from './errors.mjs';
export { acquireLock, LockError } from './lock.mjs';
export { openJournal } from './journal.mjs';

const DEFAULTS = { pollIntervalMs: 250, receiptTimeoutMs: 120_000, gasMultiplier: 1.2, fees: null, budgets: {}, hooks: {}, dependencies: {} };

function roleOf(resource) {
  return resource.signerRole ?? (resource.kind === 'call' ? 'owner' : 'deployer');
}

function lanesFrom(signers, parallel) {
  if (!signers || !Array.isArray(signers.deployer) || signers.deployer.length === 0) throw new ApplyError('signer', 'Apply needs signers.deployer with at least one account.');
  const accounts = [...signers.deployer, ...(signers.owner ? [signers.owner] : [])];
  for (const account of accounts) {
    if (!isAddress(account?.address ?? '', { strict: false }) || typeof account.signTransaction !== 'function') throw new ApplyError('signer', 'Every signer needs an address and signTransaction(request).');
  }
  const deployers = signers.deployer.map(account => account.address.toLowerCase());
  if (new Set(deployers).size !== deployers.length) throw new ApplyError('signer', 'Deployer accounts must be distinct.');
  const byAddress = new Map(accounts.map(account => [account.address.toLowerCase(), account]));
  return { pool: parallel ? signers.deployer : [signers.deployer[0]], owner: signers.owner ?? null, byAddress };
}

export function summarizeVerification(verification) {
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

async function append(ctx, actionId, fields, identity = ctx.plan) {
  const record = await ctx.journal.append({ ...jsonSafe(fields), planHash: identity.planHash, chain: identity.chain, actionId });
  await ctx.config.hooks.afterRecord?.(record);
  return record;
}

async function fail(ctx, item, code, reason, { retryable = false, evidence, ...fields } = {}) {
  await append(ctx, item.planned.id, { phase: 'failed', code, reason, retryable, ...fields, ...(evidence === undefined ? {} : { evidence }) });
  throw new ApplyError(code, reason, { actionId: item.planned.id, evidence, retryable });
}

async function verify(ctx, item, options = {}) {
  const transactionHash = options.transactionHash ?? ctx.stateSnapshot?.resources?.[item.planned.id]?.transactions?.at(-1);
  return ctx.deps.verifyResource(item.resource, ctx.client, transactionHash ? { ...options, transactionHash } : options);
}

async function markVerified(ctx, item, verification, fields) {
  const { planned } = item;
  await append(ctx, planned.id, { phase: 'verified', address: planned.address, codeHash: verification.codeHash, proofHash: hashJson(jsonSafe(verification)), verification: summarizeVerification(verification), ...fields });
  ctx.outcomes.set(planned.id, { id: planned.id, action: planned.action, outcome: fields.outcome, address: planned.address, transactionHash: fields.transactionHash, verification });
}

// Reads the chain before a write: a satisfied postcondition needs no transaction, a failed precondition is a conflict.
async function precondition(ctx, item) {
  const { planned } = item;
  if (planned.action === 'deploy') {
    await checkFactory(ctx.client, planned.factory);
    const code = await ctx.client.getCode({ address: planned.address });
    if (!code || code === '0x') return { satisfied: false };
    const verification = await verify(ctx, item);
    if (verification.status === 'verified') return { satisfied: true, verification };
    await fail(ctx, item, verification.status === 'unverified' ? 'unverified' : 'conflict', `The target address already has code, and it is ${verification.status}.`, { evidence: summarizeVerification(verification) });
  }
  const verification = await verify(ctx, item);
  const observed = (verification.bindingChecks ?? []).map(check => check.observed);
  if (verification.status === 'verified' && observed.length > 0 && observed.every(state => state === 'after')) return { satisfied: true, verification };
  if (observed.length > 0 && observed.every(state => state === 'before')) return { satisfied: false, verification };
  await fail(ctx, item, 'conflict', 'The binding has neither its allowed before value nor its desired value.', { evidence: summarizeVerification(verification) });
}

async function recordReceipt(ctx, item, signed, receipt) {
  const latest = latestRecord(ctx.journal.forAction(ctx.plan.planHash, item.planned.id));
  const json = receiptJson(receipt);
  if (latest?.phase === 'receipt' && latest.receipt?.blockHash === json.blockHash.toLowerCase()) return;
  await append(ctx, item.planned.id, { phase: 'receipt', signer: signed.signer, nonce: signed.nonce, transactionHash: signed.transactionHash, receipt: json });
}

// A receipt does not complete an action. The postcondition must verify at the receipt block, and that block must still be canonical.
async function finish(ctx, item, signed, receipt) {
  const transactionHash = signed.transactionHash;
  const block = await ctx.client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    throw new ApplyError('reorg', `Receipt block ${receipt.blockNumber} for ${transactionHash} is no longer canonical. Rerun to recheck.`, { actionId: item.planned.id, retryable: true });
  }
  if (receipt.status !== 'success') {
    const verificationStart = Date.now();
    const verification = await verify(ctx, item, { blockNumber: receipt.blockNumber, transactionHash, account: signed.signer });
    ctx.timings.verificationMs += Date.now() - verificationStart;
    const confirmed = await ctx.client.getBlock({ blockNumber: receipt.blockNumber });
    if (confirmed.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new ApplyError('reorg', `Receipt block ${receipt.blockNumber} for ${transactionHash} changed during verification.`, { actionId: item.planned.id, retryable: true });
    if (verification.status === 'verified') return markVerified(ctx, item, verification, { outcome: 'already-satisfied', revertedTransaction: transactionHash });
    await fail(ctx, item, 'reverted', `Transaction ${transactionHash} reverted in block ${receipt.blockNumber}.`, { transactionHash, evidence: summarizeVerification(verification) });
  }
  const verificationStart = Date.now();
  const verification = await verify(ctx, item, { blockNumber: receipt.blockNumber, transactionHash, account: signed.signer });
  ctx.timings.verificationMs += Date.now() - verificationStart;
  const confirmed = await ctx.client.getBlock({ blockNumber: receipt.blockNumber });
  if (confirmed.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new ApplyError('reorg', `Receipt block ${receipt.blockNumber} for ${transactionHash} changed during verification.`, { actionId: item.planned.id, retryable: true });
  if (verification.status !== 'verified') {
    await fail(ctx, item, 'postcondition', `Transaction ${transactionHash} succeeded, but the result is ${verification.status}.`, { transactionHash, evidence: summarizeVerification(verification) });
  }
  await markVerified(ctx, item, verification, { outcome: 'applied', transactionHash, blockNumber: receipt.blockNumber });
}

async function awaitReceipt(ctx, item, signed) {
  const waited = await waitForReceipt(ctx.client, { hash: signed.transactionHash, signer: signed.signer, nonce: signed.nonce, pollIntervalMs: ctx.config.pollIntervalMs, timeoutMs: ctx.config.receiptTimeoutMs });
  if (waited.dead) {
    await fail(ctx, item, 'nonce-race', `Signer ${signed.signer} nonce ${signed.nonce} was used by a transaction that is not in the journal. Stop the other writer, then rerun this plan.`, { retryable: true, signer: signed.signer, nonce: signed.nonce, transactionHash: signed.transactionHash });
  }
  if (waited.timeout) {
    throw new ApplyError('receipt-timeout', `No receipt for ${signed.transactionHash} after ${ctx.config.receiptTimeoutMs} ms. Rerun to resume; the same signed transaction is reused.`, { actionId: item.planned.id, retryable: true });
  }
  return waited.receipt;
}

async function send(ctx, item, signed, { rebroadcast = false } = {}) {
  const sent = await broadcast(ctx.client, signed.rawTransaction);
  if (!sent.accepted) {
    if (sent.nonceTooLow) {
      const receipt = await findReceipt(ctx.client, signed.transactionHash);
      if (receipt) return receipt;
      await fail(ctx, item, 'nonce-race', `Signer ${signed.signer} nonce ${signed.nonce} was used by a transaction that is not in the journal. Stop the other writer, then rerun this plan.`, { retryable: true, signer: signed.signer, nonce: signed.nonce, transactionHash: signed.transactionHash });
    }
    const code = sent.replacementUnderpriced ? 'nonce-race' : 'broadcast-failed';
    throw new ApplyError(code, `Broadcast of ${signed.transactionHash} failed: ${sent.error}. Rerun to resend the same signed transaction.`, { actionId: item.planned.id, retryable: true });
  }
  await append(ctx, item.planned.id, { phase: 'broadcast', signer: signed.signer, nonce: signed.nonce, transactionHash: signed.transactionHash, rebroadcast, ...(sent.known ? { known: true } : {}) });
  if (rebroadcast) ctx.rebroadcasts.push({ actionId: item.planned.id, transactionHash: signed.transactionHash });
  return awaitReceipt(ctx, item, signed);
}

// Resolves a transaction that an earlier run signed: use its receipt, detect that its nonce is gone, or resend the same bytes.
async function settle(ctx, item, signed) {
  let receipt = await findReceipt(ctx.client, signed.transactionHash);
  if (!receipt && await nonceConsumed(ctx.client, signed.signer, signed.nonce)) {
    receipt = await findReceipt(ctx.client, signed.transactionHash);
    if (!receipt) {
      await fail(ctx, item, 'nonce-race', `Signer ${signed.signer} nonce ${signed.nonce} was used by a transaction that is not in the journal. Stop the other writer, then rerun this plan.`, { retryable: true, signer: signed.signer, nonce: signed.nonce, transactionHash: signed.transactionHash });
    }
  }
  if (!receipt) {
    const observed = await precondition(ctx, item);
    if (observed.satisfied) return markVerified(ctx, item, observed.verification, { outcome: 'already-satisfied', unsentTransaction: signed.transactionHash });
    receipt = await send(ctx, item, signed, { rebroadcast: true });
  }
  await recordReceipt(ctx, item, signed, receipt);
  await finish(ctx, item, signed, receipt);
}

// Another plan's transaction can hold a signer's next nonce. Record its fate, or stop if it may still be sent.
async function settleForeign(ctx, signed) {
  const identity = { planHash: signed.planHash, chain: signed.chain };
  const fields = { signer: signed.signer, nonce: signed.nonce, transactionHash: signed.transactionHash };
  let receipt = await findReceipt(ctx.client, signed.transactionHash);
  if (!receipt) {
    if (!await nonceConsumed(ctx.client, signed.signer, signed.nonce)) {
      throw new ApplyError('foreign-outstanding', `Plan ${signed.planHash} has signed transaction ${signed.transactionHash} (signer ${signed.signer}, nonce ${signed.nonce}) that is not on chain. Resume that plan, or wait until the nonce is used, before you apply another plan.`, { actionId: signed.actionId, retryable: true });
    }
    receipt = await findReceipt(ctx.client, signed.transactionHash);
    if (!receipt) return append(ctx, signed.actionId, { phase: 'failed', code: 'nonce-consumed', reason: 'Another transaction used this nonce.', retryable: true, ...fields }, identity);
  }
  return append(ctx, signed.actionId, { phase: 'receipt', ...fields, receipt: receiptJson(receipt) }, identity);
}

async function settleJournal(ctx) {
  const { id, genesisHash } = ctx.plan.chain;
  const records = ctx.journal.records.filter(record => record.chain.id === id && record.chain.genesisHash.toLowerCase() === genesisHash.toLowerCase());
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

async function resumePipelineReservation(ctx, intents) {
  const first = intents[0];
  const wave = ctx.schedule.waves.find(entry => entry.wave === first.wave);
  const expected = wave?.batches.flat().filter(entry => entry.signer === first.signer.toLowerCase()) ?? [];
  if (expected.length !== intents.length || expected.some((entry, index) => entry.id !== intents[index].actionId || entry.nonceOffset !== intents[index].nonceOffset)) {
    throw new ApplyError('journal', `Reservation ${first.reservationId} does not match the saved pipeline schedule.`);
  }
  const base = BigInt(first.nonce);
  const jobs = [];
  for (const [index, intent] of intents.entries()) {
    const item = ctx.prepared.get(intent.actionId);
    const signer = ctx.lanes.byAddress.get(intent.signer.toLowerCase());
    if (!item || !signer || intent.signer.toLowerCase() !== first.signer.toLowerCase() ||
      BigInt(intent.nonce) !== base + BigInt(index) || intent.to.toLowerCase() !== item.planned.tx.to.toLowerCase() ||
      intent.value !== item.planned.tx.value || intent.dataHash.toLowerCase() !== keccak256(item.planned.tx.data).toLowerCase()) {
      throw new ApplyError('journal', `Reservation ${first.reservationId} has an invalid intent for ${intent.actionId}.`, { actionId: intent.actionId });
    }
    const records = ctx.journal.forAction(ctx.plan.planHash, intent.actionId).filter(record => record.reservationId === first.reservationId);
    const signatures = records.filter(record => record.phase === 'signed');
    if (signatures.length > 1) throw new ApplyError('journal', `Reservation ${first.reservationId} has duplicate signatures.`, { actionId: intent.actionId });
    const signed = signatures[0];
    if (signed) {
      try { await validateSignedTransaction(signed, intent, item.planned, ctx.plan.chain.id); }
      catch (error) { throw new ApplyError('journal', error.message, { actionId: intent.actionId }); }
    }
    jobs.push({ item, entry: expected[index], signer, intent, signed, records });
  }
  if (jobs.some(job => job.signed) && jobs.some(job => !job.signed)) {
    if (jobs.some(job => job.records.some(record => ['broadcast-attempt', 'broadcast', 'receipt'].includes(record.phase)))) {
      throw new ApplyError('journal', `Reservation ${first.reservationId} was broadcast before all signatures were persisted.`);
    }
    const [latest, pending] = await Promise.all([
      ctx.client.getTransactionCount({ address: first.signer, blockTag: 'latest' }),
      ctx.client.getTransactionCount({ address: first.signer, blockTag: 'pending' }),
    ]);
    if (BigInt(latest) > base) {
      const affected = jobs.find(job => BigInt(job.intent.nonce) < BigInt(latest)) ?? jobs[0];
      if (affected.signed && !await findReceipt(ctx.client, affected.signed.transactionHash)) await pipelineConflict(ctx, affected);
      throw new ApplyError('nonce-conflict', `Signer ${first.signer} consumed reserved nonce ${affected.intent.nonce} for ${affected.item.planned.id}.`, { actionId: affected.item.planned.id });
    }
    if (pending !== latest) {
      throw new ApplyError('nonce-conflict', `Signer ${first.signer} has unknown pending transactions in the reserved nonce sequence starting at ${base}.`, { actionId: jobs[0].item.planned.id });
    }
    const required = jobs.reduce((sum, job) => sum + BigInt(job.intent.gas) * BigInt(job.intent.maxFeePerGas) + BigInt(job.intent.value), 0n);
    const balance = await ctx.client.getBalance({ address: first.signer });
    if (balance < required) throw new ApplyError('insufficient-funds', `Signer ${first.signer} has ${balance} wei; the reserved group can cost ${required} wei.`, { actionId: jobs[0].item.planned.id, retryable: true });
    const budget = ctx.config.budgets[first.signer.toLowerCase()];
    if (budget !== undefined && signedSpend(ctx, first.signer.toLowerCase(), first.reservationId) + required > BigInt(budget)) {
      throw new ApplyError('budget-exceeded', `Signer ${first.signer} would exceed its ${budget} wei budget.`, { actionId: jobs[0].item.planned.id, retryable: true });
    }
    for (const job of jobs.filter(entry => !entry.signed)) {
      const { intent, item, signer } = job;
      const envelope = { chainId: ctx.plan.chain.id, to: item.planned.tx.to, data: item.planned.tx.data, value: BigInt(intent.value),
        gas: BigInt(intent.gas), maxFeePerGas: BigInt(intent.maxFeePerGas), maxPriorityFeePerGas: BigInt(intent.maxPriorityFeePerGas), nonce: Number(intent.nonce) };
      const signed = await signEnvelope(signer, envelope);
      job.signed = await append(ctx, item.planned.id, { ...intentFields({ envelope, entry: job.entry, signer }, first.wave, first.reservationId), phase: 'signed', ...signed });
      ctx.sent.push({ actionId: item.planned.id, wave: first.wave, signer: first.signer.toLowerCase(), nonce: intent.nonce, transactionHash: signed.transactionHash.toLowerCase() });
    }
  }
  const active = jobs.filter(job => {
    const latest = job.records.at(-1);
    return latest?.phase !== 'verified' && !(latest?.phase === 'failed' && !latest.retryable);
  });
  if (active.length) await settlePipelineBatch(ctx, active, { rebroadcast: true });
}

async function resumePipelineJournal(ctx) {
  const groups = new Map();
  for (const record of ctx.journal.records) {
    if (record.planHash !== ctx.plan.planHash || record.phase !== 'intent' || !record.reservationId) continue;
    if (!groups.has(record.reservationId)) groups.set(record.reservationId, []);
    groups.get(record.reservationId).push(record);
  }
  const active = [...groups.values()].filter(intents => intents.some(intent => ctx.journal.forAction(ctx.plan.planHash, intent.actionId)
    .some(record => record.phase === 'signed' && record.reservationId === intent.reservationId)));
  const settled = await Promise.allSettled(active.map(intents => resumePipelineReservation(ctx, intents)));
  const rejected = settled.find(result => result.status === 'rejected');
  if (rejected) throw rejected.reason;
}

async function recheckReused(ctx) {
  for (const item of ctx.prepared.values()) {
    if (item.planned.action !== 'reuse') continue;
    const verification = await verify(ctx, item);
    if (verification.status !== 'verified') {
      throw new ApplyError('drift', `A resource that the plan reuses is now ${verification.status}. Create a new plan.`, { actionId: item.planned.id, evidence: summarizeVerification(verification) });
    }
    ctx.outcomes.set(item.planned.id, { id: item.planned.id, action: 'reuse', outcome: 'reused', address: item.planned.address, verification });
  }
}

// Returns the item if it needs a new transaction.
async function decide(ctx, item) {
  const records = ctx.journal.forAction(ctx.plan.planHash, item.planned.id);
  const latest = latestRecord(records);
  if (latest?.phase === 'verified') {
    const verification = await verify(ctx, item, latest.transactionHash ? { transactionHash: latest.transactionHash } : {});
    if (verification.status !== 'verified') {
      await fail(ctx, item, 'drift', `The action verified earlier but is now ${verification.status}.`, { evidence: summarizeVerification(verification) });
    }
    ctx.outcomes.set(item.planned.id, { id: item.planned.id, action: item.planned.action, outcome: latest.outcome, address: item.planned.address, transactionHash: latest.transactionHash, verification, resumed: true });
    return null;
  }
  if (latest?.phase === 'failed' && !latest.retryable) {
    throw new ApplyError('previous-failure', `This plan already failed here (${latest.code}: ${latest.reason}). Create a new plan to retry.`, { actionId: item.planned.id, evidence: latest });
  }
  if (latest && LIVE_PHASES.has(latest.phase)) throw new ApplyError('journal', `Action has an unsettled ${latest.phase} record.`, { actionId: item.planned.id });
  const observed = await precondition(ctx, item);
  if (observed.satisfied) {
    await markVerified(ctx, item, observed.verification, { outcome: 'already-satisfied' });
    return null;
  }
  return item;
}

async function prepareBatch(ctx, batch) {
  const work = [];
  for (const entry of batch) {
    const item = ctx.prepared.get(entry.id);
    if (await decide(ctx, item)) work.push({ item, entry, signer: ctx.lanes.byAddress.get(entry.signer) });
  }
  if (work.length === 0) return work;

  const fees = await feesFor(ctx.client, ctx.config.fees);
  for (const job of work) {
    const { tx } = job.item.planned;
    let gas;
    try {
      gas = await estimateGasLimit(ctx.client, { from: job.signer.address, tx, gasMultiplier: ctx.config.gasMultiplier });
    } catch (error) {
      await fail(ctx, job.item, 'estimate-failed', `Gas estimation failed: ${error.shortMessage ?? error.message}`, { retryable: true, signer: job.signer.address });
    }
    job.envelope = { chainId: ctx.plan.chain.id, to: tx.to, data: tx.data, value: BigInt(tx.value), gas, ...fees };
    job.cost = maximumCost(job.envelope);
  }
  return work;
}

function signedSpend(ctx, signer, exceptReservation = null) {
  return ctx.journal.records
    .filter(record => record.planHash === ctx.plan.planHash && record.phase === 'signed' &&
      record.signer?.toLowerCase() === signer && record.reservationId !== exceptReservation)
    .reduce((sum, record) => sum + BigInt(record.gas) * BigInt(record.maxFeePerGas) + BigInt(record.value), 0n);
}

// Check the whole batch before signing any transaction in it.
async function checkBatchFunding(ctx, work) {
  const shortfalls = [];
  const groups = new Map();
  for (const job of work) {
    const lane = job.signer.address.toLowerCase();
    if (!groups.has(lane)) groups.set(lane, []);
    groups.get(lane).push(job);
  }
  for (const [lane, jobs] of groups) {
    const job = jobs[0];
    const required = jobs.reduce((sum, entry) => sum + entry.cost, 0n);
    const balance = await ctx.client.getBalance({ address: job.signer.address });
    const spent = ctx.pipeline ? signedSpend(ctx, lane) : (ctx.spent.get(lane) ?? 0n);
    const budget = ctx.config.budgets[lane];
    if (balance < required) shortfalls.push({ job, code: 'insufficient-funds', reason: `Signer ${job.signer.address} has ${balance} wei; the signer group can cost ${required} wei.`, balanceWei: balance, requiredWei: required });
    else if (budget !== undefined && spent + required > BigInt(budget)) shortfalls.push({ job, code: 'budget-exceeded', reason: `Signer ${job.signer.address} would exceed its ${budget} wei budget.`, spentWei: spent, requiredWei: required });
  }
  if (shortfalls.length) {
    for (const { job, code, reason, ...evidence } of shortfalls) {
      await append(ctx, job.item.planned.id, { phase: 'failed', code, reason, retryable: true, signer: job.signer.address, evidence });
    }
    const [first] = shortfalls;
    throw new ApplyError(first.code, `${first.reason} No transaction in this batch was signed.`, { actionId: first.job.item.planned.id, retryable: true, evidence: shortfalls.map(({ job, code, reason }) => ({ id: job.item.planned.id, code, reason })) });
  }
}

async function signBatch(ctx, wave, work) {
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

  for (const job of work) {
    const { envelope, item, entry } = job;
    await append(ctx, item.planned.id, { phase: 'intent', wave, signer: job.signer.address, signerRole: entry.signerRole, pooled: entry.pooled, nonce: String(envelope.nonce), to: envelope.to, value: envelope.value, dataHash: keccak256(envelope.data), gas: envelope.gas, maxFeePerGas: envelope.maxFeePerGas, maxPriorityFeePerGas: envelope.maxPriorityFeePerGas });
    let signed;
    try {
      signed = await signEnvelope(job.signer, envelope);
    } catch (error) {
      await fail(ctx, item, 'signer', error.message, { retryable: true, signer: job.signer.address });
    }
    job.signed = await append(ctx, item.planned.id, { phase: 'signed', signer: job.signer.address, nonce: String(envelope.nonce), ...signed });
    const lane = job.signer.address.toLowerCase();
    ctx.spent.set(lane, (ctx.spent.get(lane) ?? 0n) + job.cost);
    ctx.sent.push({ actionId: item.planned.id, wave, signer: job.signer.address.toLowerCase(), nonce: String(envelope.nonce), transactionHash: signed.transactionHash.toLowerCase() });
  }
}

function intentFields(job, wave, reservationId) {
  const { envelope, entry } = job;
  return { phase: 'intent', wave, reservationId, signer: job.signer.address, signerRole: entry.signerRole, pooled: entry.pooled,
    nonceOffset: entry.nonceOffset, nonce: String(envelope.nonce), to: envelope.to, value: envelope.value,
    dataHash: keccak256(envelope.data), gas: envelope.gas, maxFeePerGas: envelope.maxFeePerGas,
    maxPriorityFeePerGas: envelope.maxPriorityFeePerGas };
}

async function signPipelineBatch(ctx, wave, work) {
  const groups = new Map();
  for (const job of work) {
    const signer = job.signer.address.toLowerCase();
    if (!groups.has(signer)) groups.set(signer, []);
    groups.get(signer).push(job);
  }
  for (const [signer, jobs] of groups) {
    const [latest, pending] = await Promise.all([
      ctx.client.getTransactionCount({ address: signer, blockTag: 'latest' }),
      ctx.client.getTransactionCount({ address: signer, blockTag: 'pending' }),
    ]);
    if (pending !== latest) await fail(ctx, jobs[0].item, 'nonce-conflict', `Signer ${signer} has unknown pending transactions.`, { signer, nonce: String(latest) });
    for (const [offset, job] of jobs.entries()) {
      if (job.entry.nonceOffset !== offset) throw new ApplyError('stale-pipeline', `Wave ${wave} has an already satisfied action before ${job.item.planned.id}; create a new pipeline plan.`, { actionId: job.item.planned.id });
      job.envelope.nonce = latest + offset;
    }
  }
  // Every intent is durable before any signature. Partial intent groups can be discarded on restart.
  for (const jobs of groups.values()) {
    const reservationId = randomUUID();
    for (const job of jobs) job.intent = await append(ctx, job.item.planned.id, intentFields(job, wave, reservationId));
  }
  // The lock remains held and no broadcast starts until every signed record is synced.
  for (const job of work) {
    let signed;
    try { signed = await signEnvelope(job.signer, job.envelope); }
    catch (error) { throw new ApplyError('signer', error.message, { actionId: job.item.planned.id, retryable: true }); }
    job.signed = await append(ctx, job.item.planned.id, { ...intentFields(job, wave, job.intent.reservationId), phase: 'signed', ...signed });
    const signer = job.signer.address.toLowerCase();
    ctx.spent.set(signer, (ctx.spent.get(signer) ?? 0n) + job.cost);
    ctx.sent.push({ actionId: job.item.planned.id, wave, signer, nonce: String(job.envelope.nonce), transactionHash: signed.transactionHash.toLowerCase() });
  }
}

async function settleBatch(ctx, work) {
  // Every signed job gets a chance to settle before a batch error is reported.
  const settled = await Promise.allSettled(work.map(async job => {
    const receipt = await send(ctx, job.item, job.signed);
    await recordReceipt(ctx, job.item, job.signed, receipt);
    await finish(ctx, job.item, job.signed, receipt);
  }));
  const rejected = settled.find(result => result.status === 'rejected');
  if (rejected) throw rejected.reason;
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function pipelineConflict(ctx, job) {
  const { signer, nonce, transactionHash } = job.signed;
  await fail(ctx, job.item, 'nonce-conflict', `Signer ${signer} nonce ${nonce} for ${job.item.planned.id} was consumed by an unknown transaction; expected ${transactionHash}.`,
    { signer, nonce, transactionHash });
}

async function attemptPipelineBroadcast(ctx, job, rebroadcast) {
  const { signed } = job;
  let receipt = await findReceipt(ctx.client, signed.transactionHash);
  if (receipt) return { receipt };
  if (await nonceConsumed(ctx.client, signed.signer, signed.nonce)) {
    receipt = await findReceipt(ctx.client, signed.transactionHash);
    if (receipt) return { receipt };
    await pipelineConflict(ctx, job);
  }
  const pending = await ctx.client.getTransactionCount({ address: signed.signer, blockTag: 'pending' });
  if (BigInt(pending) > BigInt(signed.nonce)) {
    const knownBroadcast = ctx.journal.forAction(ctx.plan.planHash, job.item.planned.id)
      .some(record => record.phase === 'broadcast' && record.transactionHash === signed.transactionHash);
    if (!knownBroadcast) {
      let knownTransaction = false;
      try { knownTransaction = Boolean(await ctx.client.getTransaction({ hash: signed.transactionHash })); }
      catch (error) { if (error.name !== 'TransactionNotFoundError') throw error; }
      if (!knownTransaction) await pipelineConflict(ctx, job);
    }
  }
  const sent = await broadcast(ctx.client, signed.rawTransaction);
  await append(ctx, job.item.planned.id, { phase: 'broadcast-attempt', reservationId: signed.reservationId, signer: signed.signer,
    nonce: signed.nonce, transactionHash: signed.transactionHash, accepted: sent.accepted,
    ...(sent.error ? { error: sent.error } : {}), rebroadcast });
  if (sent.accepted) {
    await append(ctx, job.item.planned.id, { phase: 'broadcast', reservationId: signed.reservationId, signer: signed.signer,
      nonce: signed.nonce, transactionHash: signed.transactionHash, rebroadcast, ...(sent.known ? { known: true } : {}) });
    if (rebroadcast) ctx.rebroadcasts.push({ actionId: job.item.planned.id, transactionHash: signed.transactionHash });
  } else if (sent.nonceTooLow) {
    receipt = await findReceipt(ctx.client, signed.transactionHash);
    if (receipt) return { receipt };
    await pipelineConflict(ctx, job);
  }
  return { accepted: sent.accepted };
}

async function settlePipelineBatch(ctx, work, { rebroadcast = false } = {}) {
  for (const job of work) {
    try { await validateSignedTransaction(job.signed, job.intent, job.item.planned, ctx.plan.chain.id); }
    catch (error) { throw new ApplyError('journal', `${job.item.planned.id}: ${error.message}`, { actionId: job.item.planned.id }); }
  }
  const submitStart = Date.now();
  const firstAttempts = [];
  // First attempts run in plan order, which is increasing nonce order within each signer.
  for (const job of work) {
    try { firstAttempts.push(await attemptPipelineBroadcast(ctx, job, rebroadcast)); }
    catch (error) { firstAttempts.push({ error }); }
  }
  ctx.timings.submitMs += Date.now() - submitStart;
  const settled = await Promise.allSettled(work.map(async (job, index) => {
    let attempt = firstAttempts[index];
    if (attempt.error) throw attempt.error;
    const deadline = Date.now() + ctx.config.receiptTimeoutMs;
    if (!attempt.accepted && !attempt.receipt) {
      const retryStart = Date.now();
      try {
        while (!attempt.accepted && !attempt.receipt) {
          if (Date.now() >= deadline) throw new ApplyError('broadcast-failed', `Broadcast of ${job.signed.transactionHash} did not succeed before timeout. Rerun to retry the same bytes.`, { actionId: job.item.planned.id, retryable: true });
          await pause(ctx.config.pollIntervalMs);
          attempt = await attemptPipelineBroadcast(ctx, job, true);
        }
      } finally { ctx.timings.submitMs += Date.now() - retryStart; }
    }
    const receiptStart = Date.now();
    let receipt = attempt.receipt;
    if (!receipt) {
      const waited = await waitForReceipt(ctx.client, { hash: job.signed.transactionHash, signer: job.signed.signer, nonce: job.signed.nonce,
        pollIntervalMs: ctx.config.pollIntervalMs, timeoutMs: Math.max(0, deadline - Date.now()) });
      if (waited.dead) await pipelineConflict(ctx, job);
      if (waited.timeout) throw new ApplyError('receipt-timeout', `No receipt for ${job.signed.transactionHash}. Rerun to resume the same transaction.`, { actionId: job.item.planned.id, retryable: true });
      receipt = waited.receipt;
    }
    ctx.timings.receiptMs += Date.now() - receiptStart;
    await recordReceipt(ctx, job.item, job.signed, receipt);
    await finish(ctx, job.item, job.signed, receipt);
  }));
  const rejected = settled.find(result => result.status === 'rejected');
  if (rejected) throw rejected.reason;
}

async function runBatch(ctx, wave, batch) {
  if (!ctx.pipeline && new Set(batch.map(entry => entry.signer)).size !== batch.length) throw new ApplyError('schedule', `Wave ${wave} has a batch with two actions for one signer.`);
  const work = await prepareBatch(ctx, batch);
  if (work.length === 0) return;
  if (ctx.pipeline && work.length !== batch.length) throw new ApplyError('stale-pipeline', `Wave ${wave} no longer matches its saved nonce offsets. Create a new pipeline plan.`);
  await checkBatchFunding(ctx, work);
  if (ctx.pipeline) {
    const signingStart = Date.now();
    await signPipelineBatch(ctx, wave, work);
    ctx.timings.submitMs += Date.now() - signingStart;
    await settlePipelineBatch(ctx, work);
  } else {
    await signBatch(ctx, wave, work);
    await settleBatch(ctx, work);
  }
}

async function persist(ctx) {
  if (!ctx.deps.recordResource) return { file: ctx.stateFile, written: false, reason: 'The state module has no recordResource function.' };
  const verified = ctx.plan.resources.filter(resource => ctx.outcomes.get(resource.id)?.verification);
  if (verified.length === 0) return { file: ctx.stateFile, written: false, reason: 'No resource is verified yet.' };
  let state = await ctx.deps.readState(ctx.stateFile);
  for (const resource of verified) {
    const transactions = ctx.journal.forAction(ctx.plan.planHash, resource.id).filter(record => record.phase === 'receipt' && record.receipt?.status === 'success').map(record => record.transactionHash);
    state = await ctx.deps.recordResource({ resource: ctx.prepared.get(resource.id).resource, verification: ctx.outcomes.get(resource.id).verification, state, chain: ctx.plan.chain, transactions });
  }
  await ctx.deps.writeStateAtomic(ctx.stateFile, state);
  return { file: ctx.stateFile, written: true, resources: verified.length };
}

function summary(ctx, status, error) {
  return jsonSafe({
    status,
    planHash: ctx.plan?.planHash,
    chain: ctx.plan?.chain,
    parallel: ctx.parallel,
    pipeline: ctx.pipeline,
    timings: ctx.timings,
    transactionsSigned: ctx.sent.length,
    transactions: ctx.sent,
    rebroadcasts: ctx.rebroadcasts,
    resources: (ctx.plan?.resources ?? []).map(resource => {
      const outcome = ctx.outcomes.get(resource.id);
      if (!outcome) return { id: resource.id, action: resource.action, outcome: 'pending' };
      const { verification, ...rest } = outcome;
      return { ...rest, verification: verification ? summarizeVerification(verification) : undefined };
    }),
    schedule: ctx.schedule,
    lockRecovered: ctx.lock.recovered,
    journal: { file: ctx.journal.file, tornTailRemoved: ctx.journal.tornTail !== null },
    state: ctx.state,
    ...(error ? { stoppedAt: { code: error.code, actionId: error.actionId, message: error.message, retryable: error.retryable } } : {}),
  });
}

async function run(ctx) {
  ctx.prepared = await preflight(ctx);
  ctx.stateSnapshot = await ctx.deps.readState(ctx.stateFile);
  if (ctx.stateSnapshot && (ctx.stateSnapshot.chain?.id !== ctx.plan.chain.id || ctx.stateSnapshot.chain.genesisHash.toLowerCase() !== ctx.plan.chain.genesisHash.toLowerCase())) {
    throw new ApplyError('wrong-chain', 'State belongs to a different chain than the saved plan.');
  }
  const ownerActions = ctx.plan.resources.filter(resource => ['deploy', 'call'].includes(resource.action) && roleOf(resource) === 'owner');
  if (ownerActions.length && !ctx.lanes.owner) throw new ApplyError('signer', `The plan has owner actions (${ownerActions.map(resource => resource.id).join(', ')}), but no owner signer was supplied.`);
  if (ctx.pipeline !== Boolean(ctx.plan.pipeline)) throw new ApplyError('pipeline-plan', 'A pipeline apply requires a saved pipeline plan, and a pipeline plan requires --pipeline.');
  const deployers = ctx.lanes.pool.map(account => account.address.toLowerCase());
  const owner = ctx.lanes.owner?.address.toLowerCase() ?? null;
  if (ctx.pipeline && (hashJson(deployers) !== hashJson(ctx.plan.pipeline.deployers) || owner !== ctx.plan.pipeline.owner || ctx.parallel !== ctx.plan.pipeline.parallel)) {
    throw new ApplyError('pipeline-plan', 'The supplied signers differ from the saved pipeline plan.');
  }
  ctx.schedule = createSchedule(ctx.plan, deployers, { owner, parallel: ctx.parallel, pipeline: ctx.pipeline });
  if (ctx.pipeline && hashJson(ctx.schedule.waves) !== hashJson(ctx.plan.pipeline.waves)) throw new ApplyError('pipeline-plan', 'The saved pipeline schedule differs from the plan resources.');
  if (ctx.schedule.deferred.length) throw new ApplyError('unschedulable', `Some actions have dependencies that the plan cannot satisfy: ${ctx.schedule.deferred.map(entry => entry.id).join(', ')}.`, { evidence: ctx.schedule.deferred });
  await settleJournal(ctx);
  if (ctx.pipeline) await resumePipelineJournal(ctx);
  await recheckReused(ctx);
  for (const wave of ctx.schedule.waves) {
    for (const batch of wave.batches) {
      await runBatch(ctx, wave.wave, batch);
      ctx.state = await persist(ctx);
    }
  }
  ctx.state = await persist(ctx);
  return summary(ctx, 'applied');
}

// Applies a pinned plan under one writer lock, with a durable journal record before every broadcast.
export async function applyPlan({ plan, spec, artifacts, client, signers, stateFile, journalFile, parallel = false, pipeline = false, ...options }) {
  if (pipeline && plan?.pipeline) parallel = plan.pipeline.parallel;
  const config = { ...DEFAULTS, ...options, hooks: { ...options.hooks }, budgets: Object.fromEntries(Object.entries(options.budgets ?? {}).map(([address, wei]) => [address.toLowerCase(), wei])) };
  if (typeof stateFile !== 'string' || typeof journalFile !== 'string') throw new ApplyError('config', 'Apply needs stateFile and journalFile paths.');
  const lanes = lanesFrom(signers, parallel);
  const deps = await loadDependencies(config.dependencies);
  const lock = await acquireLock(`${stateFile}.lock`, { planHash: typeof plan?.planHash === 'string' ? plan.planHash : null });
  let journal;
  try {
    journal = await openJournal(journalFile);
    const ctx = { plan, spec, artifacts, client, lanes, deps, journal, lock, config, stateFile, parallel, pipeline, spent: new Map(), sent: [], rebroadcasts: [], outcomes: new Map(), timings: { submitMs: 0, receiptMs: 0, verificationMs: 0 }, state: { file: stateFile, written: false } };
    try {
      return await run(ctx);
    } catch (error) {
      if (!error || typeof error !== 'object') throw error;
      if (ctx.prepared) {
        try {
          ctx.state = await persist(ctx);
        } catch (stateError) {
          ctx.state = { file: stateFile, written: false, reason: stateError.message };
        }
      }
      error.result = summary(ctx, 'stopped', error);
      throw error;
    }
  } finally {
    await journal?.close();
    await lock.release();
  }
}
