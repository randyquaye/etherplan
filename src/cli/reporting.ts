import type { ApplyResult } from '../execution/types.ts';
import type { Plan, PlannedResource } from '../planning/types.ts';

function countText(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function applyCounts(result: ApplyResult): string {
  const applied = (action: string) =>
    result.resources.filter(
      (resource) =>
        resource.outcome === 'applied' &&
        resource.action === action &&
        !('resumed' in resource && resource.resumed),
    ).length;
  const counts = [
    [applied('deploy'), 'deployed', 'deployed'],
    [applied('call'), 'call executed', 'calls executed'],
    [
      result.resources.filter((resource) => resource.outcome === 'reused').length,
      'reused',
      'reused',
    ],
    [
      result.resources.filter((resource) => resource.outcome === 'already-satisfied').length,
      'already satisfied',
      'already satisfied',
    ],
    [
      result.resources.filter(
        (resource) => resource.outcome === 'applied' && 'resumed' in resource && resource.resumed,
      ).length,
      'previously completed',
      'previously completed',
    ],
  ] as const;
  const actions = counts
    .filter(([count]) => count > 0)
    .map(([count, singular, plural]) => countText(count, singular, plural));
  const verified = result.resources.filter(
    (resource) => 'verification' in resource && resource.verification?.status === 'verified',
  ).length;
  const failed = result.resources.filter((resource) => resource.outcome === 'failed').length;
  const pending = result.resources.filter((resource) => resource.outcome === 'pending').length;
  return `${actions.join(', ') || '0 actions'}; ${countText(verified, 'verified', 'verified')}${result.status === 'stopped' ? `, ${countText(failed, 'failed', 'failed')}, ${countText(pending, 'pending', 'pending')}` : ''}`;
}

export function formatApplyReport(result: ApplyResult): string {
  const lines = [`Transactions signed this run: ${result.transactionsSigned}`];
  for (const transaction of result.transactions) {
    const resource = result.resources.find((entry) => entry.id === transaction.actionId);
    lines.push(
      '',
      `  ${transaction.actionId} (${resource?.action ?? 'transaction'})`,
      `    hash     ${transaction.transactionHash}`,
      `    signer   ${transaction.signer}`,
      `    nonce    ${transaction.nonce}`,
    );
    if (transaction.wave !== undefined) lines.push(`    wave     ${transaction.wave}`);
    if (transaction.actionId.startsWith('contract:') && resource && 'address' in resource)
      lines.push(`    address  ${resource.address}`);
  }
  const reason = result.stoppedAt?.message ?? 'Execution did not complete';
  lines.push(
    '',
    result.status === 'applied'
      ? `Apply complete! ${applyCounts(result)}.`
      : `Apply stopped${result.stoppedAt?.code ? ` (${result.stoppedAt.code})` : ''}: ${/[.!?]$/.test(reason) ? reason : `${reason}.`} ${applyCounts(result)}.`,
  );
  return `${lines.join('\n')}\n`;
}

type VerifyStatus = 'verified' | 'unverified' | 'conflict';

function verifyStatus(resource: PlannedResource): VerifyStatus {
  if (resource.observation.status === 'conflict' || resource.action === 'conflict')
    return 'conflict';
  if (resource.observation.status === 'verified' && resource.action === 'reuse') return 'verified';
  return 'unverified';
}

export function formatVerifyReport(plan: Plan): string {
  const counts: Record<VerifyStatus, number> = { verified: 0, unverified: 0, conflict: 0 };
  const lines: string[] = [];
  for (const resource of plan.resources) {
    const status = verifyStatus(resource);
    counts[status]++;
    lines.push(`  ${resource.id}: ${status}${resource.address ? ` at ${resource.address}` : ''}`);
    if (status !== 'verified') {
      const reasons = [
        ...new Set([...resource.observation.reasons, ...resource.observation.missingProofs]),
      ];
      if (reasons.length === 0 && resource.action !== 'reuse')
        reasons.push(`Planned action: ${resource.action}.`);
      for (const reason of reasons) lines.push(`    ${reason}`);
    }
  }
  lines.push(
    '',
    `${counts.unverified || counts.conflict ? 'Verification incomplete' : 'Verification complete'}: ${countText(counts.verified, 'verified', 'verified')}, ${countText(counts.unverified, 'unverified', 'unverified')}, ${countText(counts.conflict, 'conflict')}.`,
  );
  return `${lines.join('\n')}\n`;
}
