// A fail-closed stop. `retryable` means that a rerun of the same plan can continue; otherwise a new plan is necessary.

import type { ResourceId } from '../types.ts';
import type { ApplyErrorCode, ApplyErrorOptions, ApplyResult } from './types.ts';

export class ApplyError extends Error {
  declare code: ApplyErrorCode;
  declare actionId: ResourceId | undefined;
  declare evidence: unknown;
  declare retryable: boolean;
  /** Set by applyPlan before it rethrows: the apply summary at the point of failure. */
  declare result: ApplyResult | undefined;

  constructor(
    code: ApplyErrorCode,
    message: string,
    { actionId, evidence, retryable = false }: ApplyErrorOptions = {},
  ) {
    super(actionId ? `${actionId}: ${message}` : message);
    this.name = 'ApplyError';
    this.code = code;
    this.actionId = actionId;
    this.evidence = evidence;
    this.retryable = retryable;
  }
}
