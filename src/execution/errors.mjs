// A fail-closed stop. `retryable` means that a rerun of the same plan can continue; otherwise a new plan is necessary.
export class ApplyError extends Error {
  constructor(code, message, { actionId, evidence, retryable = false } = {}) {
    super(actionId ? `${actionId}: ${message}` : message);
    this.name = 'ApplyError';
    this.code = code;
    this.actionId = actionId;
    this.evidence = evidence;
    this.retryable = retryable;
  }
}
