// Verification evidence, proofs, and status. Source of truth: newResult, finish, verifyContract, verifyExternal,
// verifyCall, and verifyCreation in index.ts; compareRuntime in bytecode.ts; validateCreationProof in creation-proof.ts.
import type { ByteRange } from '../artifacts/types.ts';
import type { Factory } from '../spec/types.ts';
import type { Address, ChainIdentity, DecimalString, Hash, Hex, JsonValue, ResourceId } from '../types.ts';

/**
 * The status rule, from `finish`: any `reasons` entry makes the resource `conflict`; otherwise any `missingProofs`
 * entry makes it `unverified`; otherwise it is `verified`. `creationProof` is removed unless the status is `verified`.
 */
export type VerificationStatus = 'verified' | 'unverified' | 'conflict';

/** `absent` no code; `exact` every byte matched; `masked` matched outside immutables; `presence` code exists, identity unproven. */
export type CodeComparisonMode = 'absent' | 'exact' | 'masked' | 'mismatch' | 'presence';

export interface CodeComparison {
  mode: CodeComparisonMode;
  matched: boolean;
}

export type ProofMethod =
  | 'getter'
  | 'artifact-runtime'
  | 'masked-runtime'
  | 'cbor-metadata'
  | 'expected-code-hash'
  | 'create-transaction'
  | 'create2-transaction'
  | 'pinned-runtime'
  | 'code-hash'
  | 'create2-simulation'
  | 'immutable-word';

export interface Proof {
  name: string;
  method: ProofMethod;
  expected: JsonValue;
  actual: JsonValue;
  matched: boolean;
  args?: JsonValue[];
  error?: string;
}

/** What a call's binding getter returned relative to the allowed before value and the desired after value. */
export type BindingObservation = 'after' | 'before' | 'other' | 'read-failed';

export interface BindingCheck {
  name: ResourceId;
  functionName: string;
  expectedBefore: JsonValue;
  expectedAfter: JsonValue;
  actual: JsonValue;
  observed: BindingObservation;
  args?: JsonValue[];
  targetAbsent?: true;
  error?: string;
}

/** Where live runtime first differs from the expected runtime. `code` becomes `library-guard` when the offset is in the guard. */
export type RuntimeDifference =
  | { reason: 'length'; expectedBytes: number; liveBytes: number }
  | { reason: 'content'; offset: number; region: 'code' | 'library-guard' }
  | { reason: 'content'; offset: number; region: 'library'; library: string }
  | { reason: 'content'; offset: number; region: 'immutable'; immutable: string }
  | { reason: 'content'; offset: number; region: 'metadata'; expectedMetadataHash: Hex | null; liveMetadataHash: Hex | null };

/** The live word at one immutable's ranges; `consistent` when every range holds the same word. */
export interface ImmutableWord {
  id: string;
  ranges: ByteRange[];
  value: Hex;
  consistent: boolean;
}

/** `[astId, ranges]` sorted by numeric AST ID; what immutableEntries returns. */
export type ImmutableEntry = [id: string, ranges: ByteRange[]];

interface RuntimeComparisonBase {
  expectedSkeletonHash: Hash;
  liveSkeletonHash: Hash;
  immutables: ImmutableWord[];
}

export type RuntimeComparison =
  | (RuntimeComparisonBase & { mode: 'exact' | 'masked' })
  | (RuntimeComparisonBase & { mode: 'mismatch'; difference: RuntimeDifference });

export interface ImmutableEvidence {
  id: string;
  name: string | null;
  value: Hex;
  provenBy: ProofMethod | null;
}

export type SimulationEvidence =
  | { error: string }
  | { runtimeHash: Hash; sameOutsideImmutables: boolean; differingImmutables: { id: string; simulated: Hex }[] };

interface CreationProofBase {
  chain: ChainIdentity;
  transactionHash: Hash;
  /** The account that submitted the creation transaction. */
  creator: Address;
  blockNumber: DecimalString;
  blockHash: Hash;
  address: Address;
  initcodeHash: Hash;
  codeHash: Hash;
}

/** Persisted creation facts, lowercase hex throughout. Never trusted without revalidation against the chain. */
export type CreationProof =
  | (CreationProofBase & { kind: 'create' })
  | (CreationProofBase & { kind: 'create2'; factory: Factory; salt: Hash; method?: never })
  | (CreationProofBase & { kind: 'create2'; factory: Factory; salt: Hash; method: 'pinned-runtime'; originPlanHash: Hash; intentCommitment: Hash; createdCode: PinnedCreatedCode[] });

export interface PinnedCreatedCode {
  getter: string;
  createNonce: number;
  address: Address;
  codeHash: Hash;
}

export interface PinnedChildEvidence extends PinnedCreatedCode {
  receiptCodeHash: Hash | null;
  currentCodeHash: Hash | null;
  receiptGetter: Address | null;
  currentGetter: Address | null;
  matched: boolean;
}

/** What verifyCreation returns. `proof` is present only when `status` is `verified`. */
export interface CreationVerification {
  kind: 'create' | 'create2' | null;
  transactionHash: Hash;
  address: Address;
  status: VerificationStatus;
  matched: boolean;
  exactRuntime: boolean;
  codeHash: Hash | null;
  initcodeHash: Hash | null;
  blockNumber: DecimalString | null;
  reasons: string[];
  method?: 'pinned-runtime';
  createdCode?: PinnedChildEvidence[];
  proof?: CreationProof;
}

/** CreationVerification without `proof`, as stored under `evidence.creation`. */
export type CreationEvidence = Omit<CreationVerification, 'proof'>;

export interface VerificationEvidence {
  expectedSkeletonHash: Hash;
  liveSkeletonHash: Hash;
  immutables: ImmutableEvidence[];
  difference?: RuntimeDifference;
  creation?: CreationEvidence;
  simulation?: SimulationEvidence;
}

/** Plain JSON, so the same shape serves plan observations, proofHash inputs, and journal summaries. */
export interface VerificationResult {
  id: ResourceId;
  address: Address;
  codeHash: Hash | null;
  codeComparison: CodeComparison;
  proofs: Proof[];
  missingProofs: string[];
  bindingChecks: BindingCheck[];
  reasons: string[];
  status: VerificationStatus;
  /** Contracts only, and only once the address has code. */
  evidence?: VerificationEvidence;
  /** Only when `status` is `verified` and creation evidence proved the deployment. */
  creationProof?: CreationProof;
}

export interface VerifyOptions {
  /** Anchors every read. Accepts bigint, a safe integer, or a decimal or hex string. */
  blockNumber?: bigint | number | string;
  transactionHash?: Hash;
  creationProof?: CreationProof;
  /** `false` turns off the CREATE2 simulation. */
  simulate?: boolean;
  /** Simulated transaction origin. */
  account?: Address;
  /** Require the creation transaction to come from this signer. */
  expectedCreator?: Address;
  chain?: ChainIdentity;
  /** Durable pre-sign journal history, required for pinned-runtime proofs. */
  journalRecords?: readonly import('../recovery.ts').RecoveryRecord[];
}

export interface VerifyCreationOptions {
  blockNumber?: bigint | number | string;
  creationProof?: CreationProof;
  chain?: ChainIdentity;
  /** Current runtime, when the caller already read it. */
  liveCode?: Hex;
  expectedCreator?: Address;
  journalRecords?: readonly import('../recovery.ts').RecoveryRecord[];
}

export interface SimulateCreate2Input {
  factory: Address;
  salt: Hash;
  initcode: Hex;
  /** The expected CREATE2 address; the state override empties it before the simulated deployment. */
  address: Address;
  blockNumber?: bigint | undefined;
  /** Simulated transaction origin. */
  account?: Address | undefined;
}

export interface SimulateCreateInput {
  from: Address;
  initcode: Hex;
  blockNumber?: bigint | undefined;
}

/** The solc CBOR metadata tail of runtime or creation code, from decodeMetadataTail. */
export interface MetadataTail {
  /** Byte offset where the tail starts. */
  start: number;
  raw: Hex;
  map: Record<string, unknown>;
  hashKind?: 'ipfs' | 'bzzr0' | 'bzzr1';
  hash?: Hex;
  solc?: string;
}
