export { ApplyError } from './errors.ts';
export { acquireLock, LockError } from './lock.ts';
export { openJournal, readLocalJournal } from './journal.ts';
export {
  acquireLeases,
  deploymentScope,
  encryptionContext,
  lockScopes,
  openStoredJournal,
  readStoredJournal,
  scopeKey,
  validateJournal,
} from './backends.ts';
export { summarizeVerification } from './report.ts';
export { applyPlan } from './lifecycle.ts';
