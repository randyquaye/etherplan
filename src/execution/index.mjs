import { randomUUID } from 'node:crypto';
import { isAddress, keccak256 } from 'viem';
import { hashJson } from '../identity.mjs';
import { validateState } from '../state/index.mjs';
import { createSchedule } from '../scheduling/index.mjs';
import { loadDependencies } from './dependencies.mjs';
import { ApplyError } from './errors.mjs';
import { LIVE_PHASES, intentForSigned, latestRecord, liveTransactions, openJournal } from './journal.mjs';
import { acquireLock } from './lock.mjs';
import { acquireLeases, deploymentScope, openStoredJournal } from './backends.mjs';
import { checkFactory, jsonSafe, preflight } from './preflight.mjs';
import { broadcast, estimateGasLimit, feesFor, findReceipt, maximumCost, nonceConsumed, receiptJson, signEnvelope, validateSignedTransaction, waitForReceipt } from './transactions.mjs';

export { ApplyError } from './errors.mjs';
export { acquireLock, LockError } from './lock.mjs';
export { openJournal } from './journal.mjs';
export { acquireLeases, deploymentScope, encryptionContext, lockScopes, openStoredJournal, scopeKey, validateJournal } from './backends.mjs';

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

async function signersFromProvider(provider, roles, plan, control) {
  if (typeof provider?.address !== 'function' || typeof provider?.signTransaction !== 'function') throw new ApplyError('signer', 'Signer provider needs address(role) and signTransaction(role, request).');
  const deployerRoles = roles?.deployer ?? ['deployer'];
  if (!Array.isArray(deployerRoles) || deployerRoles.length === 0 || deployerRoles.some(role => typeof role !== 'string')) throw new ApplyError('signer', 'signerRoles.deployer must be a nonempty role list.');
  const account = async role => ({ address: await provider.address(role), async signTransaction(request) {
    await control.assertHeld?.();
    return provider.signTransaction(role, request, { scope: control.scope, fence: control.fence });
  } });
  const deployer = await Promise.all(deployerRoles.map(account));
  const needsOwner = plan?.resources?.some(resource => ['deploy', 'call'].includes(resource.action) && roleOf(resource) === 'owner');
  return { deployer, ...(needsOwner ? { owner: await account(roles?.owner ?? 'owner') } : {}) };
}

async function report(ctx, type, fields = {}) {
  const event = jsonSafe({ type, at: new Date().toISOString(), planHash: ctx.plan.planHash, chain: ctx.plan.chain, scope: ctx.scope, principal: ctx.principal, ...fields });
  if (typeof ctx.config.reporter === 'function') await ctx.config.reporter(event);
  else await ctx.config.reporter?.emit(event);
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
  await ctx.lock.assertHeld?.();
  const started = Date.now();
  const record = await ctx.journal.append({ ...jsonSafe(fields), planHash: identity.planHash, chain: identity.chain, actionId, ...(ctx.remote ? { principal: ctx.principal } : {}) });
  await report(ctx, record.phase === 'failed' ? 'terminal-failure' : record.phase, { actionId, sequence: record.sequence, transactionHash: record.transactionHash, signer: record.signer, nonce: record.nonce, journalAppendLatencyMs: Date.now() - started, ...(record.phase === 'broadcast' ? { rebroadcast: record.rebroadcast } : {}) });
  await ctx.config.hooks.afterRecord?.(record);
  return record;
}

async function fail(ctx, item, code, reason, { retryable = false, evidence, ...fields } = {}) {
  await append(ctx, item.planned.id, { phase: 'failed', code, reason, retryable, ...fields, ...(evidence === undefined ? {} : { evidence }) });
  ctx.outcomes.set(item.planned.id, { id: item.planned.id, action: item.planned.action, outcome: 'failed',
    code, reason, retryable, ...fields });
  throw new ApplyError(code, reason, { actionId: item.planned.id, evidence, retryable });
}

async function verify(ctx, item, options = {}) {
  const id = item.planned.id;
  const saved = options.creationProof ?? ctx.outcomes.get(id)?.verification?.creationProof ?? ctx.stateSnapshot?.resources?.[id]?.creationProof;
  const transactionHash = options.transactionHash ?? saved?.transactionHash ?? ctx.stateSnapshot?.resources?.[id]?.provenance?.creationTransactionHash ?? ctx.stateSnapshot?.resources?.[id]?.transactions?.at(-1);
  const creationProof = saved && (!transactionHash || saved.transactionHash.toLowerCase() === transactionHash.toLowerCase()) ? saved : undefined;
  return ctx.deps.verifyResource(item.resource, ctx.client, { ...options, chain: ctx.plan.chain, ...(transactionHash ? { transactionHash } : {}), ...(creationProof ? { creationProof } : {}) });
}

async function markVerified(ctx, item, verification, fields) {
  const { planned } = item;
  await append(ctx, planned.id, { phase: 'verified', address: planned.address, codeHash: verification.codeHash, proofHash: hashJson(jsonSafe(verification)), verification: summarizeVerification(verification), ...(verification.creationProof ? { creationProof: verification.creationProof } : {}), ...fields });
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
  const started = Date.now();
  const waited = await waitForReceipt(ctx.client, { hash: signed.transactionHash, signer: signed.signer, nonce: signed.nonce, pollIntervalMs: ctx.config.pollIntervalMs, timeoutMs: ctx.config.receiptTimeoutMs });
  if (waited.dead) {
    await fail(ctx, item, 'nonce-race', `Signer ${signed.signer} nonce ${signed.nonce} was used by a transaction that is not in the journal. Stop the other writer, then rerun this plan.`, { retryable: true, signer: signed.signer, nonce: signed.nonce, transactionHash: signed.transactionHash });
  }
  if (waited.timeout) {
    throw new ApplyError('receipt-timeout', `No receipt for ${signed.transactionHash} after ${ctx.config.receiptTimeoutMs} ms. Rerun to resume; the same signed transaction is reused.`, { actionId: item.planned.id, retryable: true });
  }
  await report(ctx, 'receipt-observed', { actionId: item.planned.id, transactionHash: signed.transactionHash, receiptLatencyMs: Date.now() - started });
  return waited.receipt;
}

async function send(ctx, item, signed, { rebroadcast = false } = {}) {
  await ctx.lock.assertHeld?.();
  await append(ctx, item.planned.id, { phase: 'broadcast-attempt', signer: signed.signer, nonce: signed.nonce, transactionHash: signed.transactionHash, rebroadcast });
  await ctx.lock.assertHeld?.();
  const started = Date.now();
  const sent = await broadcast(ctx.client, signed.rawTransaction);
  await report(ctx, 'broadcast-result', { actionId: item.planned.id, transactionHash: signed.transactionHash, rebroadcast, accepted: sent.accepted, broadcastLatencyMs: Date.now() - started });
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
  await report(ctx, 'recovery', { actionId: item.planned.id, transactionHash: signed.transactionHash });
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
    await checkExecutionDependencies(ctx, [{ item }], false);
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
    if (latest.planHash !== ctx.plan.planHash && ctx.remote) throw new ApplyError('plan-mismatch', `An unfinished transaction belongs to plan ${latest.planHash}. Resume that plan first.`, { actionId: latest.actionId });
    if (latest.planHash === ctx.plan.planHash) {
      const item = ctx.prepared.get(latest.actionId);
      if (!item) throw new ApplyError('journal', 'Journal has a transaction for an action that is not in this plan.', { actionId: latest.actionId });
      try {
        if (latest.transactionHash?.toLowerCase() !== signed.transactionHash?.toLowerCase()) throw new Error('Latest transaction phase has a different hash from its signature.');
        const intent = intentForSigned(records, signed);
        await validateSignedTransaction(signed, intent, item.planned, id);
      } catch (error) {
        throw new ApplyError('journal', `${latest.actionId}: ${error.message}`, { actionId: latest.actionId });
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
function pipelineAttempt(ctx, wave) {
  const actions = new Set(wave.batches.flat().map(entry => entry.id));
  const records = ctx.journal.records.filter(record => record.planHash === ctx.plan.planHash && actions.has(record.actionId) &&
    record.reservationId && ['intent', 'signed'].includes(record.phase));
  const signatures = records.filter(record => record.phase === 'signed');
  if (!signatures.length) return null;
  if (records.some(record => record.wave !== wave.wave || record.chain.id !== ctx.plan.chain.id ||
    record.chain.genesisHash.toLowerCase() !== ctx.plan.chain.genesisHash.toLowerCase())) {
    throw new ApplyError('journal', `Wave ${wave.wave} has a record with the wrong wave or chain.`);
  }
  const ids = new Set(signatures.map(record => record.waveAttemptId ?? null));
  if (ids.size !== 1) throw new ApplyError('journal', `Wave ${wave.wave} has signatures from multiple attempts.`);
  const [attemptId] = ids;
  const intents = attemptId
    ? records.filter(record => record.phase === 'intent' && record.waveAttemptId === attemptId)
    : records.filter(record => record.phase === 'intent' && !record.waveAttemptId && record.sequence < signatures[0].sequence).slice(-wave.batches.flat().length);
  if (intents.length !== wave.batches.flat().length || signatures.some(record => !intents.some(intent =>
    intent.actionId === record.actionId && intent.reservationId === record.reservationId))) {
    throw new ApplyError('journal', `Wave ${wave.wave} has an incomplete or ambiguous signed attempt.`);
  }
  return { intents, attemptId };
}

async function resumePipelineWave(ctx, wave) {
  const attempt = pipelineAttempt(ctx, wave);
  if (!attempt) return false;
  const { intents, attemptId } = attempt;
  const entries = wave.batches.flat();
  const byAction = new Map();
  for (const intent of intents) {
    if (byAction.has(intent.actionId)) throw new ApplyError('journal', `Wave ${wave.wave} has duplicate intents for ${intent.actionId}.`);
    byAction.set(intent.actionId, intent);
  }
  const groups = new Map();
  const jobs = [];
  for (const entry of entries) {
    const intent = byAction.get(entry.id);
    const item = ctx.prepared.get(entry.id);
    const signer = ctx.lanes.byAddress.get(entry.signer);
    if (!intent || !item || !signer || intent.signer?.toLowerCase() !== entry.signer ||
      intent.nonceOffset !== entry.nonceOffset || intent.to?.toLowerCase() !== item.planned.tx.to.toLowerCase() ||
      intent.value !== item.planned.tx.value || intent.dataHash?.toLowerCase() !== keccak256(item.planned.tx.data).toLowerCase() ||
      !/^[0-9]+$/.test(String(intent.nonce)) || !/^[0-9]+$/.test(String(intent.gas)) ||
      !/^[0-9]+$/.test(String(intent.maxFeePerGas)) || !/^[0-9]+$/.test(String(intent.maxPriorityFeePerGas)) ||
      !Number.isSafeInteger(Number(intent.nonce)) ||
      !intent.reservationId) throw new ApplyError('journal', `Wave ${wave.wave} has an invalid intent for ${entry.id}.`, { actionId: entry.id });
    const group = groups.get(entry.signer) ?? [];
    if (group.length && (intent.reservationId !== group[0].intent.reservationId ||
      BigInt(intent.nonce) !== BigInt(group[0].intent.nonce) + BigInt(entry.nonceOffset))) {
      throw new ApplyError('journal', `Wave ${wave.wave} has inconsistent nonces or reservations for ${entry.signer}.`);
    }
    const actionRecords = ctx.journal.forAction(ctx.plan.planHash, entry.id);
    const nextIntent = actionRecords.find(record => record.phase === 'intent' && record.sequence > intent.sequence);
    const history = actionRecords.filter(record => record.sequence >= intent.sequence && (!nextIntent || record.sequence < nextIntent.sequence));
    const signatures = history.filter(record => record.phase === 'signed');
    if (signatures.length > 1 || signatures.some(record => record.reservationId !== intent.reservationId || (record.waveAttemptId ?? null) !== attemptId)) {
      throw new ApplyError('journal', `Wave ${wave.wave} has duplicate or mismatched signatures for ${entry.id}.`, { actionId: entry.id });
    }
    const signed = signatures[0];
    if (signed) {
      try { await validateSignedTransaction(signed, intent, item.planned, ctx.plan.chain.id); }
      catch (error) { throw new ApplyError('journal', error.message, { actionId: entry.id }); }
    }
    const job = { item, entry, signer, intent, signed, records: history };
    group.push(job);
    groups.set(entry.signer, group);
    jobs.push(job);
  }
  if (byAction.size !== entries.length) throw new ApplyError('journal', `Wave ${wave.wave} has intents outside its saved schedule.`);
  for (const group of groups.values()) {
    if (group[0].entry.nonceOffset !== 0) throw new ApplyError('journal', `Wave ${wave.wave} has an invalid first nonce offset.`);
  }
  if (new Set([...groups.values()].map(group => group[0].intent.reservationId)).size !== groups.size) {
    throw new ApplyError('journal', `Wave ${wave.wave} shares a reservation across signer groups.`);
  }
  const conflict = jobs.find(job => job.records.at(-1)?.phase === 'failed' && !job.records.at(-1).retryable);
  if (conflict) throw new ApplyError(conflict.records.at(-1).code, conflict.records.at(-1).reason, { actionId: conflict.item.planned.id });

  // Check every signer and precondition before adding any signature or broadcast.
  for (const job of jobs) job.receipt = job.signed ? await findReceipt(ctx.client, job.signed.transactionHash) : null;
  for (const job of jobs.filter(entry => entry.records.at(-1)?.phase === 'verified')) await decide(ctx, job.item);
  const outstanding = jobs.filter(job => job.records.at(-1)?.phase !== 'verified' && !job.receipt);
  await checkExecutionDependencies(ctx, outstanding, false);
  for (const job of outstanding) {
    const observed = await precondition(ctx, job.item);
    if (observed.satisfied) throw new ApplyError('conflict', `The precondition for ${job.item.planned.id} changed after its nonce was reserved.`, { actionId: job.item.planned.id });
  }
  for (const [address, group] of groups) {
    const [latest, pending] = await Promise.all([
      ctx.client.getTransactionCount({ address, blockTag: 'latest' }),
      ctx.client.getTransactionCount({ address, blockTag: 'pending' }),
    ]);
    const base = BigInt(group[0].intent.nonce);
    if (BigInt(latest) < base || BigInt(pending) < BigInt(latest)) throw new ApplyError('nonce-conflict', `Signer ${address} no longer has the reserved nonce sequence.`, { actionId: group[0].item.planned.id });
    for (const job of group) {
      if (BigInt(job.intent.nonce) < BigInt(latest) && !job.receipt) {
        if (job.signed) await pipelineConflict(ctx, job);
        throw new ApplyError('nonce-conflict', `Signer ${address} consumed unsigned reserved nonce ${job.intent.nonce}.`, { actionId: job.item.planned.id });
      }
    }
    for (let nonce = BigInt(latest); nonce < BigInt(pending); nonce++) {
      const job = group.find(entry => BigInt(entry.intent.nonce) === nonce);
      if (!job?.signed) throw new ApplyError('nonce-conflict', `Signer ${address} has an unknown pending transaction at nonce ${nonce}.`, { actionId: group[0].item.planned.id });
      let known = false;
      try { known = Boolean(await ctx.client.getTransaction({ hash: job.signed.transactionHash })); }
      catch (error) { if (error.name !== 'TransactionNotFoundError') throw error; }
      if (!known) throw new ApplyError('nonce-conflict', `Signer ${address} has an unknown pending transaction at nonce ${nonce}.`, { actionId: job.item.planned.id });
    }
    const unmined = group.filter(job => job.records.at(-1)?.phase !== 'verified' && !job.receipt);
    if (!unmined.length) continue;
    const required = unmined.reduce((sum, job) => sum + BigInt(job.intent.gas) * BigInt(job.intent.maxFeePerGas) + BigInt(job.intent.value), 0n);
    const balance = await ctx.client.getBalance({ address });
    if (balance < required) throw new ApplyError('insufficient-funds', `Signer ${address} has ${balance} wei; the reserved group can cost ${required} wei.`, { actionId: unmined[0].item.planned.id, retryable: true });
    const budget = ctx.config.budgets[address];
    const reserved = group.reduce((sum, job) => sum + BigInt(job.intent.gas) * BigInt(job.intent.maxFeePerGas) + BigInt(job.intent.value), 0n);
    if (budget !== undefined && signedSpend(ctx, address, group[0].intent.reservationId) + reserved > BigInt(budget)) {
      throw new ApplyError('budget-exceeded', `Signer ${address} would exceed its ${budget} wei budget.`, { actionId: unmined[0].item.planned.id, retryable: true });
    }
  }
  for (const job of jobs.filter(entry => entry.receipt && entry.records.at(-1)?.phase !== 'verified')) {
    await recordReceipt(ctx, job.item, job.signed, job.receipt);
    await finish(ctx, job.item, job.signed, job.receipt);
    await decide(ctx, job.item);
    job.completed = true;
  }
  for (const job of jobs.filter(entry => !entry.signed)) {
    const { intent, item, signer } = job;
    const envelope = { chainId: ctx.plan.chain.id, to: item.planned.tx.to, data: item.planned.tx.data, value: BigInt(intent.value),
      gas: BigInt(intent.gas), maxFeePerGas: BigInt(intent.maxFeePerGas), maxPriorityFeePerGas: BigInt(intent.maxPriorityFeePerGas), nonce: Number(intent.nonce) };
    let signed;
    try { signed = await signWithLease(ctx, item.planned.id, signer, envelope); }
    catch (error) { throw new ApplyError('signer', error.message, { actionId: item.planned.id, retryable: true }); }
    job.signed = await append(ctx, item.planned.id, { ...intentFields({ envelope, entry: job.entry, signer }, wave.wave, intent.reservationId, attemptId), phase: 'signed', ...signed });
    ctx.sent.push({ actionId: item.planned.id, wave: wave.wave, signer: job.entry.signer, nonce: intent.nonce, transactionHash: signed.transactionHash.toLowerCase() });
  }
  const active = jobs.filter(job => job.records.at(-1)?.phase !== 'verified' && !job.completed);
  for (const job of active) await report(ctx, 'recovery', { actionId: job.item.planned.id, transactionHash: job.signed.transactionHash, reservationId: job.intent.reservationId });
  if (active.length) await settlePipelineBatch(ctx, active, { rebroadcast: true });
  for (const job of jobs) await decide(ctx, job.item);
  return true;
}

const lower = value => typeof value === 'string' ? value.toLowerCase() : value ?? null;

// A plan accepts a rebuilt artifact against one saved record. Under the lock, state must still hold that record, or
// this rebaseline of it, and the live code must still be the code that record describes.
function checkArtifactDrift(ctx, item, verification) {
  const drift = item.planned.observation?.stateComparison?.artifactDrift;
  if (!drift) return null;
  const { id } = item.planned;
  if (drift.accepted !== true || lower(drift.artifactHash) !== lower(item.planned.artifactHash)) {
    throw new ApplyError('plan-not-applicable', `${id} is reused without an accepted artifact drift for its planned artifact.`, { actionId: id });
  }
  const record = ctx.stateSnapshot?.resources?.[id];
  const saved = record ? { address: record.address, initcodeHash: record.initcodeHash ?? null, inputsHash: record.inputsHash, salt: record.salt ?? null, codeHash: record.codeHash ?? null } : null;
  if (!saved || hashJson(jsonSafe(saved)) !== hashJson(jsonSafe(drift.baseline)) ||
    ![lower(drift.previousArtifactHash), lower(drift.artifactHash)].includes(lower(record.artifactHash))) {
    throw new ApplyError('stale-state', `The saved state for ${id} changed after the plan accepted its artifact drift. Create a new plan.`, {
      actionId: id, evidence: { expected: { ...drift.baseline, artifactHash: drift.previousArtifactHash }, actual: saved && { ...saved, artifactHash: record.artifactHash } },
    });
  }
  if (lower(verification.codeHash) !== lower(drift.baseline.codeHash)) {
    throw new ApplyError('drift', `The live code for ${id} changed after the plan accepted its artifact drift. Create a new plan.`, { actionId: id, evidence: summarizeVerification(verification) });
  }
  return { previousArtifactHash: drift.previousArtifactHash, artifactHash: drift.artifactHash };
}

async function recheckReused(ctx) {
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
async function decide(ctx, item) {
  const records = ctx.journal.forAction(ctx.plan.planHash, item.planned.id);
  const latest = latestRecord(records);
  if (latest?.phase === 'verified') {
    const verification = await verify(ctx, item, { ...(latest.transactionHash ? { transactionHash: latest.transactionHash } : {}), ...(latest.creationProof ? { creationProof: latest.creationProof } : {}) });
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

async function checkExecutionDependencies(ctx, work, requireCompleted = true) {
  const checked = new Map();
  for (const { item } of work) {
    for (const id of item.planned.dependencies) {
      const dependency = ctx.prepared.get(id);
      if (!dependency || (requireCompleted && !ctx.outcomes.get(id)?.verification)) {
        throw new ApplyError('dependency', `${item.planned.id} needs completed dependency ${id} before signing.`, { actionId: item.planned.id });
      }
      if (!checked.has(id)) {
        const evidence = ctx.journal.forAction(ctx.plan.planHash, id)
          .filter(record => ['receipt', 'verified'].includes(record.phase) && record.transactionHash).at(-1);
        const transactionHash = ctx.outcomes.get(id)?.transactionHash ?? evidence?.transactionHash;
        checked.set(id, await verify(ctx, dependency, transactionHash ? { transactionHash } : {}));
      }
      const verification = checked.get(id);
      if (verification.status !== 'verified') {
        throw new ApplyError('dependency', `${item.planned.id} needs verified dependency ${id}; it is now ${verification.status}.`, {
          actionId: item.planned.id, evidence: { dependency: id, verification: summarizeVerification(verification) },
        });
      }
    }
  }
}

// A lost lease stops the next signature.
async function signWithLease(ctx, actionId, signer, envelope) {
  await ctx.lock.assertHeld?.();
  const started = Date.now();
  const signed = await signEnvelope(signer, envelope);
  await report(ctx, 'signer-result', { actionId, signer: signer.address, signerLatencyMs: Date.now() - started });
  return signed;
}

async function signBatch(ctx, wave, work) {
  await checkExecutionDependencies(ctx, work);
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
    await ctx.lock.assertHeld?.();
    await append(ctx, item.planned.id, { phase: 'intent', wave, signer: job.signer.address, signerRole: entry.signerRole, pooled: entry.pooled, nonce: String(envelope.nonce), to: envelope.to, value: envelope.value, dataHash: keccak256(envelope.data), gas: envelope.gas, maxFeePerGas: envelope.maxFeePerGas, maxPriorityFeePerGas: envelope.maxPriorityFeePerGas });
    let signed;
    try {
      signed = await signWithLease(ctx, item.planned.id, job.signer, envelope);
    } catch (error) {
      await fail(ctx, item, 'signer', error.message, { retryable: true, signer: job.signer.address });
    }
    job.signed = await append(ctx, item.planned.id, { phase: 'signed', signer: job.signer.address, nonce: String(envelope.nonce), ...signed });
    const lane = job.signer.address.toLowerCase();
    ctx.spent.set(lane, (ctx.spent.get(lane) ?? 0n) + job.cost);
    ctx.sent.push({ actionId: item.planned.id, wave, signer: job.signer.address.toLowerCase(), nonce: String(envelope.nonce), transactionHash: signed.transactionHash.toLowerCase() });
  }
}

function intentFields(job, wave, reservationId, waveAttemptId = null) {
  const { envelope, entry } = job;
  return { phase: 'intent', wave, reservationId, ...(waveAttemptId ? { waveAttemptId } : {}), signer: job.signer.address, signerRole: entry.signerRole, pooled: entry.pooled,
    nonceOffset: entry.nonceOffset, nonce: String(envelope.nonce), to: envelope.to, value: envelope.value,
    dataHash: keccak256(envelope.data), gas: envelope.gas, maxFeePerGas: envelope.maxFeePerGas,
    maxPriorityFeePerGas: envelope.maxPriorityFeePerGas };
}

async function signPipelineBatch(ctx, wave, work) {
  await checkExecutionDependencies(ctx, work);
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
  const waveAttemptId = randomUUID();
  for (const jobs of groups.values()) {
    const reservationId = randomUUID();
    for (const job of jobs) job.intent = await append(ctx, job.item.planned.id, intentFields(job, wave, reservationId, waveAttemptId));
  }
  // The lock remains held and no broadcast starts until every signed record is synced.
  for (const job of work) {
    let signed;
    try { signed = await signWithLease(ctx, job.item.planned.id, job.signer, job.envelope); }
    catch (error) { throw new ApplyError('signer', error.message, { actionId: job.item.planned.id, retryable: true }); }
    job.signed = await append(ctx, job.item.planned.id, { ...intentFields(job, wave, job.intent.reservationId, waveAttemptId), phase: 'signed', ...signed });
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

async function preparePipelineBroadcast(ctx, job) {
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
  return {};
}

async function recordPipelineBroadcast(ctx, job, sent, rebroadcast) {
  const { signed } = job;
  await append(ctx, job.item.planned.id, { phase: 'broadcast-attempt', reservationId: signed.reservationId, signer: signed.signer,
    nonce: signed.nonce, transactionHash: signed.transactionHash, accepted: sent.accepted,
    ...(sent.error ? { error: sent.error } : {}), rebroadcast });
  if (sent.accepted) {
    await append(ctx, job.item.planned.id, { phase: 'broadcast', reservationId: signed.reservationId, signer: signed.signer,
      nonce: signed.nonce, transactionHash: signed.transactionHash, rebroadcast, ...(sent.known ? { known: true } : {}) });
    if (rebroadcast) ctx.rebroadcasts.push({ actionId: job.item.planned.id, transactionHash: signed.transactionHash });
  } else if (sent.nonceTooLow) {
    const receipt = await findReceipt(ctx.client, signed.transactionHash);
    if (receipt) return { receipt };
    await pipelineConflict(ctx, job);
  }
  return { accepted: sent.accepted };
}

// Starts the raw request before its first await, so a group's requests begin in nonce order.
async function sendPipelineTransaction(ctx, job, rebroadcast) {
  const started = Date.now();
  const sent = await broadcast(ctx.client, job.signed.rawTransaction);
  await report(ctx, 'broadcast-result', { actionId: job.item.planned.id, transactionHash: job.signed.transactionHash, rebroadcast, accepted: sent.accepted, broadcastLatencyMs: Date.now() - started });
  return recordPipelineBroadcast(ctx, job, sent, rebroadcast);
}

async function attemptPipelineBroadcast(ctx, job, rebroadcast) {
  const prepared = await preparePipelineBroadcast(ctx, job);
  if (prepared.receipt) return prepared;
  await ctx.lock.assertHeld?.();
  return sendPipelineTransaction(ctx, job, rebroadcast);
}

async function settlePipelineBatch(ctx, work, { rebroadcast = false } = {}) {
  for (const job of work) {
    try { await validateSignedTransaction(job.signed, job.intent, job.item.planned, ctx.plan.chain.id); }
    catch (error) { throw new ApplyError('journal', `${job.item.planned.id}: ${error.message}`, { actionId: job.item.planned.id }); }
  }
  const submitStart = Date.now();
  // Reconcile the complete group first. Then initiate all raw requests in plan
  // order without waiting for a lower nonce's RPC response.
  const prepared = await Promise.all(work.map(job => preparePipelineBroadcast(ctx, job)));
  // One lease check covers the group, so no await separates its first requests.
  await ctx.lock.assertHeld?.();
  const firstAttempts = await Promise.all(work.map(async (job, index) => {
    if (prepared[index].receipt) return prepared[index];
    try { return await sendPipelineTransaction(ctx, job, rebroadcast); }
    catch (error) { return { error }; }
  }));
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
      await report(ctx, 'receipt-observed', { actionId: job.item.planned.id, transactionHash: job.signed.transactionHash, receiptLatencyMs: Date.now() - receiptStart });
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
  const current = await ctx.readState();
  let state = current.value;
  for (const resource of verified) {
    const transactions = ctx.journal.forAction(ctx.plan.planHash, resource.id).filter(record => record.phase === 'receipt' && record.receipt?.status === 'success').map(record => record.transactionHash);
    state = await ctx.deps.recordResource({ resource: ctx.prepared.get(resource.id).resource, verification: ctx.outcomes.get(resource.id).verification, state, chain: ctx.plan.chain, transactions });
  }
  await ctx.lock.assertHeld?.();
  await ctx.writeState(current.version, state);
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
  ctx.stateSnapshot = (await ctx.readState()).value;
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
  await recheckReused(ctx);
  // Preserve the dependency check for a later signed wave before revisiting
  // completed earlier waves. This also stops a resend if its prerequisite drifted.
  if (ctx.pipeline) {
    for (const wave of ctx.schedule.waves) {
      if (!pipelineAttempt(ctx, wave)) continue;
      const work = wave.batches.flat().map(entry => ({ item: ctx.prepared.get(entry.id) }));
      await checkExecutionDependencies(ctx, work, false);
    }
  }
  for (const wave of ctx.schedule.waves) {
    if (ctx.pipeline && await resumePipelineWave(ctx, wave)) {
      ctx.state = await persist(ctx);
      continue;
    }
    for (const batch of wave.batches) {
      await runBatch(ctx, wave.wave, batch);
      ctx.state = await persist(ctx);
    }
  }
  ctx.state = await persist(ctx);
  return summary(ctx, 'applied');
}

// Applies a pinned plan under one writer lock, with a durable journal record before every broadcast.
export async function applyPlan({ plan, spec, artifacts, client, signers, signerProvider, signerRoles, stateStore, journalStore, lockProvider, journalCipher, scope: scopeInput, principal, ttlMs, stateFile, journalFile, parallel = false, pipeline = false, ...options }) {
  if (pipeline && plan?.pipeline) parallel = plan.pipeline.parallel;
  const config = { ...DEFAULTS, ...options, hooks: { ...options.hooks }, budgets: Object.fromEntries(Object.entries(options.budgets ?? {}).map(([address, wei]) => [address.toLowerCase(), wei])) };
  const remote = Boolean(stateStore || journalStore || lockProvider || journalCipher || scopeInput);
  if (remote && (!stateStore || !journalStore || !lockProvider || !journalCipher || !scopeInput)) throw new ApplyError('config', 'Production apply needs stateStore, journalStore, lockProvider, journalCipher, and scope together.');
  if (!remote && (typeof stateFile !== 'string' || typeof journalFile !== 'string')) throw new ApplyError('config', 'Apply needs stateFile and journalFile paths.');
  const scope = remote ? deploymentScope(scopeInput, plan?.chain) : null;
  const signerControl = { scope, fence: null, assertHeld: null };
  const lanes = lanesFrom(signerProvider ? await signersFromProvider(signerProvider, signerRoles, plan, signerControl) : signers, parallel);
  const deps = await loadDependencies(config.dependencies);
  const lockStarted = Date.now();
  const emitLeaseEvent = event => typeof config.reporter === 'function' ? config.reporter(event) : config.reporter?.emit?.(event);
  const lock = remote
    ? await acquireLeases({ lockProvider, scope, addresses: [...lanes.byAddress.keys()], planHash: plan?.planHash, principal, ttlMs,
      onRenew: event => emitLeaseEvent({ type: 'lock-renewal', at: new Date().toISOString(), planHash: plan?.planHash, chain: plan?.chain, scope, principal: event.holder.principal }),
      onRenewFailure: event => emitLeaseEvent({ type: 'lock-renewal-failure', at: new Date().toISOString(), planHash: plan?.planHash, chain: plan?.chain, scope, principal: event.holder.principal, reason: event.error.message }),
    })
    : await acquireLock(`${stateFile}.lock`, { planHash: typeof plan?.planHash === 'string' ? plan.planHash : null });
  signerControl.fence = lock.fence ?? null;
  signerControl.assertHeld = () => lock.assertHeld?.();
  let journal;
  try {
    journal = remote ? await openStoredJournal({ journalStore, journalCipher, scope, fence: lock.fence, assertHeld: () => lock.assertHeld() }) : await openJournal(journalFile);
    const readState = remote ? async () => { const found = await stateStore.read(scope); return { version: found?.version ?? null, value: found ? validateState(found.value) : null }; } : async () => ({ version: null, value: await deps.readState(stateFile) });
    const writeState = remote ? (version, state) => stateStore.compareAndSwap(scope, version, validateState(state), { fence: lock.fence }) : (_version, state) => deps.writeStateAtomic(stateFile, state);
    const ctx = { plan, spec, artifacts, client, lanes, deps, journal, lock, config, scope, remote, principal: lock.holder?.principal ?? principal, readState, writeState, stateFile: stateFile ?? null, parallel, pipeline, spent: new Map(), sent: [], rebroadcasts: [], outcomes: new Map(), timings: { submitMs: 0, receiptMs: 0, verificationMs: 0 }, state: { file: stateFile ?? null, written: false } };
    await report(ctx, 'lock-acquisition', { holder: lock.holder, fencingTokens: lock.fence?.map(entry => entry.token), lockWaitMs: Date.now() - lockStarted });
    try {
      return await run(ctx);
    } catch (error) {
      if (!error || typeof error !== 'object') throw error;
      await report(ctx, error.code === 'conflict' || error.code === 'plan-mismatch' ? 'conflict' : 'terminal-failure', { actionId: error.actionId, code: error.code, reason: error.message }).catch(() => {});
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
