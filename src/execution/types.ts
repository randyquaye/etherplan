// The apply boundary: signers, stores, locks, journal records, report events, and the apply input, context, and
// result. Method lists come from call sites; re-derive with
// `grep -rhoE '\b(stateStore|journalStore|lockProvider|journalCipher|planStore)\.[a-zA-Z]+' src`.
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { KMSClient } from '@aws-sdk/client-kms';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Artifacts } from '../artifacts/types.ts';
import type { Plan, PlanAction, PlannedResource, PlannedTransaction, PreparedResource, PreparedResources } from '../planning/types.ts';
import type { Schedule } from '../scheduling/types.ts';
import type { OrderedNode, ParsedSpec } from '../spec/types.ts';
import type { RecordResourceInput, StateFile } from '../state/types.ts';
import type { Address, ChainIdentity, Client, DecimalString, DistributiveOmit, Hash, Hex, JsonValue, ResourceId } from '../types.ts';
import type { BindingObservation, CodeComparison, CreationProof, ProofMethod, VerificationResult, VerificationStatus, VerifyOptions } from '../verification/types.ts';

export type { Client };

// Signers

/** The EIP-1559 fields apply fills in before signing. In memory; journal records hold the same as decimal strings. */
export interface TransactionEnvelope {
  chainId: number;
  to: Address;
  data: Hex;
  value: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  nonce: number;
}

export type SignTransactionRequest = TransactionEnvelope & { type: 'eip1559' };

/** A local account (viem's privateKeyToAccount) or a provider-backed account built by signersFromProvider. */
export interface SignerAccount {
  address: Address;
  signTransaction(request: SignTransactionRequest): Promise<Hex | { rawTransaction: Hex }>;
}

/** Local signing: `deployer[0]` alone is used unless `parallel`. */
export interface Signers {
  deployer: SignerAccount[];
  owner?: SignerAccount;
}

/** Scope and lease tokens a signer service can check before signing. */
export interface SignerAuthorization {
  scope: DeploymentScope | null;
  fence: FenceEntry[] | null;
}

/** What a signer module exports as `signerProvider`. Etherplan never sees key material. */
export interface SignerProvider {
  address(role: string): Promise<Address>;
  signTransaction(role: string, request: SignTransactionRequest, authorization?: SignerAuthorization): Promise<Hex>;
}

/** Defaults: `deployer: ['deployer']`, `owner: 'owner'`. */
export interface SignerRoles {
  deployer?: string[];
  owner?: string;
}

export interface SignerLanes {
  pool: SignerAccount[];
  owner: SignerAccount | null;
  /** Keyed by lowercase address. */
  byAddress: Map<string, SignerAccount>;
}

export interface SignerServiceOptions {
  url: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface KmsSignerOptions {
  /** Role to KMS key ID, alias, or ARN. */
  keys: Record<string, string>;
  region?: string;
  kms?: KMSClient;
}

// Scopes, locks, and leases

export interface DeploymentScope {
  project: string;
  environment: string;
  chainId: number;
  genesisHash: Hash;
  label: string;
}

/** What deploymentScope accepts: chain fields default from the plan chain. */
export type DeploymentScopeInput = Partial<DeploymentScope>;

interface ChainLockScope {
  chainId: number;
  genesisHash: Hash;
}

/** A signer lease covers its address across every deployment in the shared table. */
export type DeploymentLockScope = ChainLockScope & { kind: 'deployment'; project: string; environment: string; label: string };
export type SignerLockScope = ChainLockScope & { kind: 'signer'; address: Address };
export type LockScope = DeploymentLockScope | SignerLockScope;

/** Written into the local `<state>.lock` file. */
export interface LocalLockHolder {
  id: string;
  pid: number;
  host: string;
  /** A plan hash, or `import` for the import command. */
  planHash: string | null;
  acquiredAt: string;
}

/** Stored beside each remote lease. */
export interface LeaseHolder {
  id: string;
  principal: string;
  host: string;
  pid: number;
  planHash: Hash | undefined;
  acquiredAt: string;
}

export type LockHolder = LocalLockHolder | LeaseHolder;

export interface FenceEntry {
  scope: LockScope;
  token: number;
  holderId: string;
  principal: string;
}

export interface Lease {
  fencingToken: number;
  renew(): Promise<void>;
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

export interface LeaseInspection {
  holder: unknown;
  expiresAt: string | null;
  active: boolean;
  fencingToken: number | undefined;
}

export interface LockProvider {
  acquire(scope: LockScope, holder: LeaseHolder, ttlMs: number): Promise<Lease>;
  inspect?(scope: LockScope): Promise<LeaseInspection | null>;
}

/** The local file lock from acquireLock. */
export interface LocalLock {
  file: string;
  holder: LocalLockHolder;
  /** The dead holder whose lock was removed, if any. */
  recovered: LocalLockHolder | null;
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

/** The set of remote leases from acquireLeases, renewed on a timer until released. */
export interface Leases {
  holder: LeaseHolder;
  fence: FenceEntry[];
  recovered: null;
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

export type Lock = LocalLock | Leases;

export interface AcquireLeasesInput {
  lockProvider: LockProvider;
  scope: DeploymentScope;
  addresses: Address[];
  planHash: Hash | undefined;
  principal?: string | undefined;
  /** At least 3000; defaults to 30000. */
  ttlMs?: number | undefined;
  onRenew?(event: { holder: LeaseHolder; scopes: LockScope[] }): unknown;
  onRenewFailure?(event: { holder: LeaseHolder; error: Error }): unknown;
}

// Stores

export interface StoredState {
  version: unknown;
  value: unknown;
  at?: string;
  principal?: string;
}

export interface StateStore {
  read(scope: DeploymentScope): Promise<StoredState | null>;
  compareAndSwap(scope: DeploymentScope, expectedVersion: unknown, state: StateFile, options: { fence: FenceEntry[] | null }): Promise<StoredState>;
}

export interface JournalHead {
  sequence: number;
  recordHash: Hash;
}

/** The signer-wide index entry written with every signed record. */
export interface SignedIndexEntry {
  project: string;
  environment: string;
  label: string;
  planHash: Hash;
  actionId: ResourceId;
  signer: Address;
  nonce: DecimalString;
  transactionHash: Hash;
}

export interface JournalAppendOptions {
  expectedSequence: number;
  expectedPreviousHash: Hash | null;
  fence: FenceEntry[] | null;
}

export interface JournalStore {
  head?(scope: DeploymentScope): Promise<JournalHead | null>;
  read(scope: DeploymentScope): AsyncIterable<StoredJournalRecord>;
  append(scope: DeploymentScope, record: StoredJournalRecord, options: JournalAppendOptions): Promise<StoredJournalRecord>;
  signedForSigner(scope: DeploymentScope, address: string): AsyncIterable<SignedIndexEntry>;
}

/** The AAD and KMS encryption context for one signed record. */
export interface EncryptionContext {
  planHash: Hash;
  chainId: number;
  genesisHash: Hash;
  actionId: ResourceId;
  signer: Address;
  nonce: DecimalString;
}

/** The ciphertext shape is the cipher's own; the journal stores it opaquely. */
export interface JournalCipher {
  encrypt(plaintext: Uint8Array, context: EncryptionContext): Promise<unknown>;
  decrypt(value: unknown, context: EncryptionContext): Promise<Uint8Array>;
}

export interface AwsJournalCiphertext {
  algorithm: 'AES-256-GCM+KMS';
  encryptedKey: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

export interface PlanStore {
  put(scope: DeploymentScope, plan: Plan): Promise<{ bucket: string; key: string; planHash: Hash }>;
  read(scope: DeploymentScope, planHash: Hash): Promise<Plan>;
}

export interface AwsBackendOptions {
  tableName: string;
  /** A symmetric key for journal and S3 encryption; not a signing key. */
  kmsKeyId: string;
  bucket?: string;
  prefix?: string;
  dynamodb?: DynamoDBDocumentClient;
  kms?: KMSClient;
  s3?: S3Client;
}

export interface AwsBackend {
  stateStore: StateStore;
  journalStore: JournalStore;
  lockProvider: LockProvider;
  journalCipher: JournalCipher;
  /** Present when the backend has a bucket. */
  planStore: PlanStore | null;
}

export interface InspectDeploymentInput {
  scope: unknown;
  chain?: ChainIdentity | null;
  planHash?: Hash | null;
  journalStore: JournalStore;
  stateStore: StateStore;
  lockProvider: LockProvider;
}

export interface DeploymentStatus {
  scope: DeploymentScope;
  planHash: Hash | null;
  lastJournalPhase: JournalPhase | null;
  lastJournalSequence: number | null;
  journalHead: { sequence: number; planHash: Hash; phase: JournalPhase; at: string } | null;
  stateVersion: unknown;
  stateUpdatedAt: string | null;
  lock: { holder: unknown; expiresAt: string | null; active: boolean; fencingToken: number | undefined } | null;
  signerLocks: ({ address: Address } & Partial<LeaseInspection>)[];
}

// Journal

export type JournalPhase = 'intent' | 'signed' | 'broadcast-attempt' | 'broadcast' | 'receipt' | 'verified' | 'failed';

/** A transaction in one of these phases may still change the chain or hold its signer's next nonce. */
export type LivePhase = 'signed' | 'broadcast-attempt' | 'broadcast' | 'receipt';

/** Codes written to `failed` records by `fail`, checkBatchFunding, and settleForeign. */
export type FailureCode =
  | 'budget-exceeded'
  | 'conflict'
  | 'drift'
  | 'estimate-failed'
  | 'insufficient-funds'
  | 'nonce-conflict'
  | 'nonce-consumed'
  | 'nonce-race'
  | 'postcondition'
  | 'reverted'
  | 'signer'
  | 'unverified';

/** `applied` after this plan's transaction; `already-satisfied` when the chain already held the desired state. */
export type VerifiedOutcome = 'applied' | 'already-satisfied';

/** Receipt fields kept in the journal; quantities as decimal strings. */
export interface ReceiptJson {
  transactionHash: Hash;
  status: 'success' | 'reverted';
  blockNumber: DecimalString;
  blockHash: Hash;
  gasUsed: DecimalString;
  effectiveGasPrice: DecimalString | null;
}

/** What summarizeVerification keeps of a VerificationResult for journal and report output. */
export interface VerificationSummary {
  status: VerificationStatus;
  address: Address;
  codeHash: Hash | null;
  codeComparison: CodeComparison;
  missingProofs: string[];
  reasons: string[];
  failedProofs: { name: string; method: ProofMethod }[];
  bindingChecks: { name: ResourceId; functionName: string; observed: BindingObservation; actual: JsonValue; error?: string }[];
  creation?: { method: 'replay' | 'pinned-runtime'; parentCodeHash: Hash; createdCode?: import('../verification/types.ts').PinnedChildEvidence[] };
}

/**
 * The durable choice of nonce, gas, and fees before signing. Serial intents carry `wave`, `signerRole`, and `pooled`;
 * pipeline intents add `reservationId`, `nonceOffset`, and (since the attempt ID was added) `waveAttemptId`;
 * replacement intents add `replacement`, `replacesTransactionHash`, and `maxCostWei`.
 */
export interface IntentFields {
  phase: 'intent';
  pinnedCommitment?: Hash;
  signer: Address;
  nonce: DecimalString;
  to: Address;
  value: DecimalString;
  dataHash: Hash;
  gas: DecimalString;
  maxFeePerGas: DecimalString;
  maxPriorityFeePerGas: DecimalString;
  wave?: number;
  signerRole?: string;
  pooled?: boolean;
  reservationId?: string;
  waveAttemptId?: string;
  attemptId?: string;
  nonceOffset?: number;
  replacement?: true;
  replacesTransactionHash?: Hash;
  maxCostWei?: DecimalString;
}

/** Serial signatures copy only `signer` and `nonce` from the intent; pipeline and replacement signatures copy it all. */
export type SignedFields = {
  phase: 'signed';
  signer: Address;
  nonce: DecimalString;
  rawTransaction: Hex;
  transactionHash: Hash;
} & Partial<Omit<IntentFields, 'phase' | 'signer' | 'nonce'>>;

export interface BroadcastAttemptFields {
  phase: 'broadcast-attempt';
  signer: Address;
  nonce: DecimalString;
  transactionHash: Hash;
  rebroadcast: boolean;
  /** Pipeline only. */
  reservationId?: string;
  /** Pipeline only; serial attempts record the outcome in the following `broadcast` record or failure. */
  accepted?: boolean;
  error?: string;
}

export interface BroadcastFields {
  phase: 'broadcast';
  signer: Address;
  nonce: DecimalString;
  transactionHash: Hash;
  rebroadcast: boolean;
  reservationId?: string;
  /** The node already had the transaction. */
  known?: true;
}

export interface ReceiptFields {
  phase: 'receipt';
  signer: Address;
  nonce: DecimalString;
  transactionHash: Hash;
  receipt: ReceiptJson;
}

export interface VerifiedFields {
  phase: 'verified';
  address: Address;
  codeHash: Hash | null;
  /** hashJson of the full verification result. */
  proofHash: Hash;
  verification: VerificationSummary;
  creationProof?: CreationProof;
  outcome: VerifiedOutcome;
  transactionHash?: Hash;
  blockNumber?: DecimalString;
  /** The transaction reverted but the postcondition already held. */
  revertedTransaction?: Hash;
  /** A signed transaction that was never needed. */
  unsentTransaction?: Hash;
}

export interface FailedFields {
  phase: 'failed';
  code: FailureCode;
  reason: string;
  retryable: boolean;
  evidence?: JsonValue;
  signer?: Address;
  nonce?: DecimalString;
  transactionHash?: Hash;
  balanceWei?: DecimalString;
  requiredWei?: DecimalString;
  budgetWei?: DecimalString;
  spentWei?: DecimalString;
}

export type JournalPhaseFields = IntentFields | SignedFields | BroadcastAttemptFields | BroadcastFields | ReceiptFields | VerifiedFields | FailedFields;

export interface JournalIdentity {
  planHash: Hash;
  chain: ChainIdentity;
  actionId: ResourceId;
  /** Always set on the remote path; never on the local path. */
  principal?: string;
}

/** What `journal.append` receives. */
export type JournalRecordInput = JournalPhaseFields & JournalIdentity;

/**
 * A record as `journal.records` holds it on either path. The local file writes format 1; the remote store holds
 * format 2 with the hash chain, and openStoredJournal restores `rawTransaction` beside the ciphertext.
 */
export type JournalRecord = JournalPhaseFields & JournalIdentity & {
  formatVersion: 1 | 2;
  sequence: number;
  at: string;
  previousHash?: Hash | null;
  recordHash?: Hash;
  encryptedRawTransaction?: unknown;
};

interface StoredEnvelope {
  formatVersion: 2;
  sequence: number;
  at: string;
  principal: string;
  previousHash: Hash | null;
  recordHash: Hash;
}

/** A record as the remote store holds it: hash-chained, and signed bytes encrypted. */
export type StoredJournalRecord = (
  | Exclude<JournalPhaseFields, SignedFields>
  | (Omit<SignedFields, 'rawTransaction'> & { encryptedRawTransaction: unknown })
) & Omit<JournalIdentity, 'principal'> & StoredEnvelope;

export interface Journal {
  /** The local file, or null for a stored journal. */
  file: string | null;
  /** An unterminated last line that openJournal removed, or null. */
  tornTail: string | null;
  records: JournalRecord[];
  /** Appends are serialized; the promise resolves only after the record is durable. */
  append(fields: JournalRecordInput): Promise<JournalRecord>;
  forAction(planHash: Hash, actionId: ResourceId): JournalRecord[];
  close(): Promise<void>;
}

export type SignedRecord = JournalRecord & SignedFields;
export type IntentRecord = JournalRecord & IntentFields;

/** A signed transaction that may still reach the chain, from liveTransactions. */
export interface LiveTransaction {
  latest: JournalRecord;
  signed: SignedRecord;
}

/** The newest signed transaction for an action with its latest phase, from currentTransaction. */
export interface CurrentTransaction {
  signed: SignedRecord;
  phase: JournalPhase;
  receipt: (JournalRecord & ReceiptFields) | null;
}

export interface OpenStoredJournalInput {
  journalStore: JournalStore;
  journalCipher: JournalCipher;
  scope: DeploymentScope;
  fence: FenceEntry[] | null;
  assertHeld(): Promise<void>;
}

// Errors and events

/** Codes passed to `new ApplyError`, including the failure codes `fail` rethrows. */
export type ApplyErrorCode =
  | FailureCode
  | 'broadcast-failed'
  | 'config'
  | 'dependency'
  | 'factory'
  | 'finality'
  | 'foreign-outstanding'
  | 'journal'
  | 'pipeline-plan'
  | 'plan-format'
  | 'plan-hash'
  | 'plan-mismatch'
  | 'plan-not-applicable'
  | 'plan-policy'
  | 'previous-failure'
  | 'receipt-timeout'
  | 'reorg'
  | 'replacement-budget'
  | 'replacement-fees'
  | 'replacement-underpriced'
  | 'schedule'
  | 'stale-artifact'
  | 'stale-observation'
  | 'stale-pipeline'
  | 'stale-resource'
  | 'stale-spec'
  | 'stale-state'
  | 'unschedulable'
  | 'wrong-chain';

export interface ApplyErrorOptions {
  actionId?: ResourceId | undefined;
  evidence?: unknown;
  /** A rerun of the same plan can continue; otherwise a new plan is needed. */
  retryable?: boolean;
}

/** Common fields `report` adds; `principal` is dropped when undefined. */
export interface ReportEventBase {
  at: string;
  planHash: Hash;
  chain: ChainIdentity;
  scope: DeploymentScope | null;
  principal?: string;
}

/** Emitted by `append` for every journal record; `failed` records report as `terminal-failure`. */
interface JournalEventFields {
  actionId: ResourceId;
  sequence: number;
  transactionHash?: Hash;
  signer?: Address;
  nonce?: DecimalString;
  journalAppendLatencyMs: number;
}

export type ReportEvent = ReportEventBase & (
  | ({ type: 'lock-acquisition'; holder: LockHolder; fencingTokens?: number[]; lockWaitMs: number })
  | ({ type: 'lock-renewal' })
  | ({ type: 'lock-renewal-failure'; reason: string })
  | ({ type: 'intent' | 'signed' | 'broadcast-attempt' | 'receipt' | 'verified' } & JournalEventFields)
  | ({ type: 'broadcast'; rebroadcast: boolean } & JournalEventFields)
  | ({ type: 'terminal-failure' } & JournalEventFields)
  | ({ type: 'terminal-failure' | 'conflict'; actionId?: ResourceId; code: ApplyErrorCode; reason: string })
  | ({ type: 'signer-result'; actionId: ResourceId; signer: Address; signerLatencyMs: number })
  | ({ type: 'broadcast-result'; actionId: ResourceId; transactionHash: Hash; rebroadcast: boolean; accepted: boolean; broadcastLatencyMs: number })
  | ({ type: 'receipt-observed'; actionId: ResourceId; transactionHash: Hash; receiptLatencyMs: number })
  | ({ type: 'recovery'; actionId: ResourceId; transactionHash: Hash; reservationId?: string })
);

export type ReportEventType = ReportEvent['type'];

export type Reporter = ((event: ReportEvent) => unknown) | { emit(event: ReportEvent): unknown };

// Apply

export interface FeeOverride {
  maxFeePerGas: bigint | number | string;
  maxPriorityFeePerGas: bigint | number | string;
}

/** Reviewed fees for replacing a stuck transaction; decimal wei strings. */
export interface ReplacementFees {
  maxFeePerGas: DecimalString;
  maxPriorityFeePerGas: DecimalString;
  maxCostWei: DecimalString;
}

export interface ApplyHooks {
  afterRecord?(record: JournalRecord): unknown;
}

/** The planner, verifier, and state functions apply uses, so apply and plan cannot disagree. */
export interface ApplyDependencies {
  parseSpec(raw: unknown): ParsedSpec;
  graph(spec: ParsedSpec): OrderedNode[];
  prepareResources(spec: ParsedSpec, ordered: OrderedNode[], artifacts: Artifacts): PreparedResources;
  transactionFor?(resource: PreparedResource): PlannedTransaction;
  verifyResource(resource: PreparedResource, client: Client, options?: VerifyOptions): Promise<VerificationResult>;
  readState(file: string): Promise<StateFile | null>;
  writeStateAtomic(file: string, state: StateFile): Promise<void>;
  recordResource?(input: RecordResourceInput): StateFile;
}

export type PlanIdentityDependencies = Pick<ApplyDependencies, 'parseSpec' | 'graph' | 'prepareResources' | 'transactionFor'>;

export interface ApplyOptions {
  pollIntervalMs?: number;
  receiptTimeoutMs?: number;
  gasMultiplier?: number;
  fees?: FeeOverride | null;
  /** Lowercase address to wei ceiling; the plan's `maxSpendWei` caps it. */
  budgets?: Record<string, bigint | number | string>;
  hooks?: ApplyHooks;
  dependencies?: Partial<ApplyDependencies>;
  /** Required on the remote path; defaults to 1 locally. */
  confirmations?: number;
  reporter?: Reporter;
  replacementFees?: ReplacementFees | undefined;
}

/** ApplyOptions with the DEFAULTS applied and `budgets` keys lowercased. */
export interface ApplyConfig {
  pollIntervalMs: number;
  receiptTimeoutMs: number;
  gasMultiplier: number;
  fees: FeeOverride | null;
  budgets: Record<string, bigint | number | string>;
  hooks: ApplyHooks;
  dependencies: Partial<ApplyDependencies>;
  confirmations: number;
  reporter?: Reporter;
  replacementFees?: ReplacementFees | undefined;
}

/** Local apply needs `stateFile` and `journalFile`; remote apply needs the four stores and `scope` together. */
export interface ApplyInput extends ApplyOptions {
  /** No validator narrows a plan file to this type; checkPlanIdentity trusts a matching planHash. */
  plan: Plan;
  spec: unknown;
  artifacts: Artifacts;
  client: Client;
  signers?: Signers;
  signerProvider?: SignerProvider;
  signerRoles?: SignerRoles;
  stateStore?: StateStore;
  journalStore?: JournalStore;
  lockProvider?: LockProvider;
  journalCipher?: JournalCipher;
  scope?: DeploymentScopeInput;
  principal?: string;
  ttlMs?: number;
  stateFile?: string;
  journalFile?: string;
  parallel?: boolean;
  pipeline?: boolean;
}

/** A planned entry paired with its freshly prepared resource, keyed by ID in `ctx.prepared`. */
export interface PreparedAction {
  planned: PlannedResource;
  resource: PreparedResource;
}

export interface PlanIdentityInput {
  plan: Plan;
  spec: unknown;
  artifacts: Artifacts;
  client: Client;
  deps: PlanIdentityDependencies;
}

export interface SentTransaction {
  actionId: ResourceId;
  wave?: number;
  signer: string;
  nonce: DecimalString;
  transactionHash: Hash;
}

export interface ApplyTimings {
  submitMs: number;
  receiptMs: number;
  verificationMs: number;
}

export type StateWriteResult =
  | { file: string | null; written: false; reason?: string }
  | { file: string | null; written: true; resources: number };

export type OutcomeKind = 'reused' | 'applied' | 'already-satisfied' | 'failed' | 'pending';

interface OutcomeBase {
  id: ResourceId;
  action: PlanAction;
}

/** What `ctx.outcomes` holds per resource. */
export type ResourceOutcome =
  | (OutcomeBase & { outcome: 'reused'; address: Address; verification: VerificationResult; artifactDrift?: { previousArtifactHash: Hash; artifactHash: Hash } })
  | (OutcomeBase & { outcome: VerifiedOutcome; address: Address; transactionHash?: Hash; verification: VerificationResult; resumed?: true })
  | (OutcomeBase & { outcome: 'failed'; code: FailureCode; reason: string; retryable: boolean; signer?: Address; nonce?: DecimalString; transactionHash?: Hash });

/** A ResourceOutcome with its verification summarized, or `pending` for a resource apply did not reach. */
export type ResourceOutcomeSummary =
  | (DistributiveOmit<ResourceOutcome, 'verification'> & { verification?: VerificationSummary })
  | (OutcomeBase & { outcome: 'pending' });

/** What applyPlan returns, and what `error.result` holds when it throws. JSON-safe. */
export interface ApplyResult {
  status: 'applied' | 'stopped';
  planHash: Hash;
  chain: ChainIdentity;
  parallel: boolean;
  pipeline: boolean;
  timings: ApplyTimings;
  transactionsSigned: number;
  transactions: SentTransaction[];
  rebroadcasts: { actionId: ResourceId; transactionHash: Hash }[];
  resources: ResourceOutcomeSummary[];
  schedule?: Schedule;
  lockRecovered: LocalLockHolder | null;
  journal: { file: string | null; tornTailRemoved: boolean };
  state: StateWriteResult;
  /** Ordinary errors may lack an apply code and retry policy. */
  stoppedAt?: { code?: ApplyErrorCode; actionId?: ResourceId; message: string; retryable?: boolean };
}

/** The initialized apply context is defined beside its constructor. */
export type { ApplyContext } from './context.ts';

// Transactions

/** The receipt fields apply reads. viem's TransactionReceipt satisfies this. */
export interface Receipt {
  transactionHash: Hash;
  status: 'success' | 'reverted';
  blockNumber: bigint;
  blockHash: Hash;
  gasUsed: bigint;
  effectiveGasPrice?: bigint | null | undefined;
  contractAddress?: Address | null | undefined;
}

export interface EstimateGasInput {
  from: Address;
  tx: PlannedTransaction;
  gasMultiplier: number;
}

export interface WaitForReceiptInput {
  hash?: Hash;
  /** Every signed variant at the nonce; defaults to `[{ transactionHash: hash }]`. */
  signedVariants?: { transactionHash: Hash }[];
  signer: Address;
  nonce: DecimalString | number;
  pollIntervalMs: number;
  timeoutMs: number;
}

/** `dead`: another transaction used the nonce and no variant has a receipt. */
export type ReceiptWait = { receipt: Receipt } | { dead: true } | { timeout: true };

/** Raw bytes and their hash, after signEnvelope has decoded and checked them. */
export interface SignedBytes {
  rawTransaction: Hex;
  transactionHash: Hash;
}

export type BroadcastOutcome =
  | { accepted: true; known?: true }
  | { accepted: false; error: string; nonceTooLow?: true; replacementUnderpriced?: true };

/** Costed action before any nonce is reserved. */
export type CostEnvelope = Omit<TransactionEnvelope, 'nonce'> & { nonce?: number };
export interface FundedJob {
  item: PreparedAction;
  entry: import('../scheduling/types.ts').ScheduleEntry;
  signer: SignerAccount;
  envelope: CostEnvelope;
  cost: bigint;
}
export type SignedBatchJob = FundedJob & { signed: SignedRecord };
export type PipelineBatchJob = SignedBatchJob & { intent: IntentRecord; signedIntent: IntentRecord; variants: SignedRecord[] };

/** A pipeline job carries its saved position in the signer group's nonce sequence. */
export type PipelineFundedJob = FundedJob & {
  entry: import('../scheduling/types.ts').ScheduleEntry & { nonceOffset: number };
};
