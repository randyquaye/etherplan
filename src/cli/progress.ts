import type { ApplyResult, ReportEvent } from '../execution/types.ts';
import type { Plan } from '../planning/types.ts';

const STILL_APPLYING_MS = 30_000;

/** Human-readable CLI progress. Structured event consumers use applyPlan's reporter directly. */
export function createApplyProgress(plan: Plan, output: NodeJS.WriteStream = process.stderr) {
  let started = 0;
  let lastLine = 0;
  let timer: NodeJS.Timeout | undefined;
  const write = (message: string): void => {
    output.write(`${message}\n`);
    lastLine = Date.now();
  };
  return {
    start(): void {
      started = Date.now();
      const resources = Array.isArray(plan.resources) ? plan.resources.length : 0;
      write(
        `Applying plan ${plan.planHash} (chain ${plan.chain?.id ?? '?'}, ${resources} resource${resources === 1 ? '' : 's'})...`,
      );
      timer = setInterval(() => {
        if (Date.now() - lastLine >= STILL_APPLYING_MS) {
          write(`Still applying (${Math.floor((Date.now() - started) / 1000)}s elapsed)...`);
        }
      }, STILL_APPLYING_MS);
      timer.unref();
    },
    reporter(event: ReportEvent): void {
      switch (event.type) {
        case 'lock-acquisition':
          write('Apply lock acquired. Checking plan and chain...');
          break;
        case 'recovery':
          write(`  ${event.actionId}: resuming transaction ${event.transactionHash}`);
          break;
        case 'intent':
          write(
            `  ${event.actionId}: preparing transaction${event.nonce === undefined ? '' : ` (nonce ${event.nonce})`}...`,
          );
          break;
        case 'signed':
          write(`  ${event.actionId}: signed ${event.transactionHash}`);
          break;
        case 'broadcast-attempt':
          write(`  ${event.actionId}: broadcasting ${event.transactionHash}...`);
          break;
        case 'broadcast':
          write(
            `  ${event.actionId}: ${event.rebroadcast ? 'rebroadcast' : 'submitted'}; waiting for receipt...`,
          );
          break;
        case 'receipt':
          write(`  ${event.actionId}: receipt recorded; confirming and verifying...`);
          break;
        case 'verified':
          write(`  ${event.actionId}: verified`);
          break;
        case 'resource-reused':
          write(`  ${event.actionId}: reused and verified`);
          break;
        case 'resource-resumed':
          write(`  ${event.actionId}: already verified in this plan`);
          break;
        default:
          break;
      }
    },
    complete(result: ApplyResult): void {
      const resources = result.resources.length;
      const transactions = result.transactionsSigned;
      write(
        `Apply complete: ${resources} resource${resources === 1 ? '' : 's'}, ${transactions} transaction${transactions === 1 ? '' : 's'} signed.`,
      );
    },
    stop(): void {
      if (timer) clearInterval(timer);
    },
  };
}
