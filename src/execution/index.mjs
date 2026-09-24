import { isAddress, keccak256 } from 'viem';
import { hashJson } from '../identity.mjs';
import { createSchedule } from '../scheduling/index.mjs';
import { loadDependencies } from './dependencies.mjs';
import { ApplyError } from './errors.mjs';
import { LIVE_PHASES, latestRecord, liveTransactions, openJournal } from './journal.mjs';
import { acquireLock } from './lock.mjs';
import { checkFactory, jsonSafe, preflight } from './preflight.mjs';
import { broadcast, estimateGasLimit, feesFor, findReceipt, maximumCost, nonceConsumed, receiptJson, signEnvelope, waitForReceipt } from './transactions.mjs';

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
  if (receipt.status !== 'success') {
    const verification = await verify(ctx, item);
    if (verification.status === 'verified') return markVerified(ctx, item, verification, { outcome: 'already-satisfied', revertedTransaction: transactionHash });
    await fail(ctx, item, 'reverted', `Transaction ${transactionHash} reverted in block ${receipt.blockNumber}.`, { transactionHash, evidence: summarizeVerification(verification) });
  }
  const block = await ctx.client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    throw new ApplyError('reorg', `Receipt block ${receipt.blockNumber} for ${transactionHash} is no longer canonical. Rerun to recheck.`, { actionId: item.planned.id, retryable: true });
  }
  const verification = await verify(ctx, item, { blockNumber: receipt.blockNumber, transactionHash, account: signed.signer });
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
      const item = ctx.prepared.get(latest.actionId);
      if (!item) throw new ApplyError('journal', 'Journal has a transaction for an action that is not in this plan.', { actionId: latest.actionId });
      await settle(ctx, item, signed);
    } else if (latest.phase !== 'receipt') {
      await settleForeign(ctx, signed);
    }
  }
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

async function runBatch(ctx, wave, batch) {
  if (new Set(batch.map(entry => entry.signer)).size !== batch.length) throw new ApplyError('schedule', `Wave ${wave} has a batch with two actions for one signer.`);
  const work = [];
  for (const entry of batch) {
    const item = ctx.prepared.get(entry.id);
    if (await decide(ctx, item)) work.push({ item, entry, signer: ctx.lanes.byAddress.get(entry.signer) });
  }
  if (work.length === 0) return;

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

  const shortfalls = [];
  for (const job of work) {
    const lane = job.signer.address.toLowerCase();
    const balance = await ctx.client.getBalance({ address: job.signer.address });
    const spent = ctx.spent.get(lane) ?? 0n;
    const budget = ctx.config.budgets[lane];
    if (balance < job.cost) shortfalls.push({ job, code: 'insufficient-funds', reason: `Signer ${job.signer.address} has ${balance} wei; the transaction can cost ${job.cost} wei.`, balanceWei: balance, requiredWei: job.cost });
    else if (budget !== undefined && spent + job.cost > BigInt(budget)) shortfalls.push({ job, code: 'budget-exceeded', reason: `Signer ${job.signer.address} would exceed its ${budget} wei budget.`, spentWei: spent, requiredWei: job.cost });
  }
  if (shortfalls.length) {
    for (const { job, code, reason, ...evidence } of shortfalls) {
      await append(ctx, job.item.planned.id, { phase: 'failed', code, reason, retryable: true, signer: job.signer.address, evidence });
    }
    const [first] = shortfalls;
    throw new ApplyError(first.code, `${first.reason} No transaction in this batch was signed.`, { actionId: first.job.item.planned.id, retryable: true, evidence: shortfalls.map(({ job, code, reason }) => ({ id: job.item.planned.id, code, reason })) });
  }

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

  const settled = await Promise.allSettled(work.map(async job => {
    const receipt = await send(ctx, job.item, job.signed);
    await recordReceipt(ctx, job.item, job.signed, receipt);
    await finish(ctx, job.item, job.signed, receipt);
  }));
  const rejected = settled.find(result => result.status === 'rejected');
  if (rejected) throw rejected.reason;
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
  await settleJournal(ctx);
  await recheckReused(ctx);
  ctx.schedule = createSchedule(ctx.plan, ctx.lanes.pool.map(account => account.address), { owner: ctx.lanes.owner?.address ?? null, parallel: ctx.parallel });
  if (ctx.schedule.deferred.length) throw new ApplyError('unschedulable', `Some actions have dependencies that the plan cannot satisfy: ${ctx.schedule.deferred.map(entry => entry.id).join(', ')}.`, { evidence: ctx.schedule.deferred });
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
export async function applyPlan({ plan, spec, artifacts, client, signers, stateFile, journalFile, parallel = false, ...options }) {
  const config = { ...DEFAULTS, ...options, hooks: { ...options.hooks }, budgets: Object.fromEntries(Object.entries(options.budgets ?? {}).map(([address, wei]) => [address.toLowerCase(), wei])) };
  if (typeof stateFile !== 'string' || typeof journalFile !== 'string') throw new ApplyError('config', 'Apply needs stateFile and journalFile paths.');
  const lanes = lanesFrom(signers, parallel);
  const deps = await loadDependencies(config.dependencies);
  const lock = await acquireLock(`${stateFile}.lock`, { planHash: typeof plan?.planHash === 'string' ? plan.planHash : null });
  let journal;
  try {
    journal = await openJournal(journalFile);
    const ctx = { plan, spec, artifacts, client, lanes, deps, journal, lock, config, stateFile, parallel, spent: new Map(), sent: [], rebroadcasts: [], outcomes: new Map(), state: { file: stateFile, written: false } };
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
