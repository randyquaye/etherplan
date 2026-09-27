import { intentForSigned } from './journal.ts';
import { validateSignedTransaction } from './transactions.ts';
import { jsonSafe } from './preflight.ts';
import { ApplyError } from './errors.ts';
import { append } from './report.ts';
import type { ApplyContext, FailureCode, FundedJob } from './types.ts';

export type CommitmentLedger = Map<string, Map<string, { cost: bigint; reservationId?: string }[]>>;

// Count every durable signature, including mined and failed transactions. A nonce
// can only spend once, so replacements contribute their largest possible cost.
export async function commitments(ctx: ApplyContext): Promise<CommitmentLedger> {
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

export function signedSpend(commitments: CommitmentLedger, signer: string, exceptReservation: string | null = null): bigint {
  return [...(commitments.get(signer)?.values() ?? [])].reduce((sum, variants) => {
    const costs = variants.filter(entry => entry.reservationId !== exceptReservation).map(entry => entry.cost);
    return sum + (costs.length ? costs.reduce((max, cost) => cost > max ? cost : max) : 0n);
  }, 0n);
}

// A new variant changes a nonce's commitment only when its cap exceeds every
// signed variant already at that nonce. Other signed nonces still count in full.
export function spendWithVariant(commitments: CommitmentLedger, signer: string, nonce: string, cost: bigint): bigint {
  const variants = commitments.get(signer)?.get(BigInt(nonce).toString()) ?? [];
  const current = variants.reduce((max, entry) => entry.cost > max ? entry.cost : max, 0n);
  return signedSpend(commitments, signer) - current + (cost > current ? cost : current);
}

export function budgetFor(ctx: ApplyContext, signer: string): bigint {
  if (!ctx.plan.maxSpendWei) throw new ApplyError('plan-policy', 'The saved plan needs a maxSpendWei ceiling.');
  const approved = BigInt(ctx.plan.maxSpendWei);
  const supplied = ctx.config.budgets[signer];
  return supplied === undefined || approved < BigInt(supplied) ? approved : BigInt(supplied);
}

// Check the whole batch before signing any transaction in it.

export async function checkBatchFunding(ctx: ApplyContext, work: FundedJob[]): Promise<void> {
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
