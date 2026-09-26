// @ts-nocheck
export { DEFAULT_FACTORY, parseSpec, graph, dependencyGraphs, dependencyMode, dependencyWarnings, impact, resolve, usesDependencyPlan } from './spec/index.ts';
export { prepareResources, transactionFor, createPlan } from './planning/index.ts';
export { validateResources } from './validation/index.ts';
export { create2Address, linkBytecode, compareRuntime, verifyResource, verifyCreation } from './verification/index.ts';
export { createSchedule, executionWaves } from './scheduling/index.ts';
export { readState, writeStateAtomic, importResource, recordResource, validateState } from './state/index.ts';
export { applyPlan, acquireLock, openJournal } from './execution/index.ts';
export { acquireLeases, deploymentScope, encryptionContext, inspectDeployment, lockScopes, openStoredJournal, scopeKey, validateJournal } from './execution/backends.ts';
export { createAwsBackend } from './execution/aws.ts';
export { createSignerServiceProvider } from './execution/signer-service.ts';
export { createKmsSignerProvider } from './execution/kms-signer.ts';

// Type-only exports for signer-module authors and reporter consumers. These erase at run time.
export type { Abi, Address, ChainIdentity, Client, Hash, Hex, JsonValue, ResourceId, ResourceKind } from './types.ts';
export type { DependencyGraphs, DependencyMode, ExecutionAssumption, Factory, OrderedNode, ParsedSpec, SpecCall, SpecContract, SpecExternal } from './spec/types.ts';
export type { Artifacts, NormalizedArtifact } from './artifacts/types.ts';
export type { CreatePlanInput, Plan, PlanAction, PlannedResource, PreparedResource, PreparedResources } from './planning/types.ts';
export type { ExecutionWaves, Schedule, ScheduleEntry, ScheduleWave } from './scheduling/types.ts';
export type { CreationProof, VerificationResult, VerificationStatus, VerifyOptions } from './verification/types.ts';
export type { ImportResourceInput, RecordResourceInput, StateFile, StateResource } from './state/types.ts';
export type {
  ApplyErrorCode, ApplyInput, ApplyOptions, ApplyResult, AwsBackend, AwsBackendOptions, DeploymentScope, DeploymentStatus, FenceEntry,
  Journal, JournalCipher, JournalPhase, JournalRecord, JournalStore, KmsSignerOptions, Lease, LockProvider, PlanStore, ReportEvent, Reporter,
  SignerAccount, SignerAuthorization, SignerProvider, SignerRoles, SignerServiceOptions, Signers, SignTransactionRequest, StateStore, StoredJournalRecord,
} from './execution/types.ts';
