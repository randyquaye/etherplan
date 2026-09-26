// The state file. Source of truth: validateState, validateResource, validateRevision, and validateChain in index.ts.
import type { PreparedContract, PreparedResource } from '../planning/types.ts';
import type { Address, ChainIdentity, Hash, JsonValue, ResourceId } from '../types.ts';
import type { CreationProof, VerificationResult } from '../verification/types.ts';

export type ProvenanceKind = 'apply' | 'import' | 'observed';

export interface Provenance {
  kind: ProvenanceKind;
  /** Only `import` may name a creation transaction. */
  creationTransactionHash?: Hash | null;
}

/** Artifact evidence that a rebaseline superseded. */
export interface ArtifactRevision {
  artifactHash: Hash;
  sourceHash?: Hash;
  proofHash: Hash;
  codeHash: Hash;
}

/**
 * One recorded resource. Every field is optional at the validator except `address` and `transactions`;
 * ContractStateResource lists what a `contract:` record must also carry.
 */
export interface StateResource {
  address: Address;
  priorAddress?: Address | null;
  artifactHash?: Hash;
  sourceHash?: Hash;
  /** Present only beside an `artifactHash`. */
  artifactRevisions?: ArtifactRevision[];
  initcodeHash?: Hash | null;
  inputs?: JsonValue;
  inputsHash?: Hash;
  priorInputs?: JsonValue;
  priorInputsHash?: Hash | null;
  salt?: Hash | null;
  codeHash?: Hash | null;
  priorCodeHash?: Hash | null;
  proofHash?: Hash;
  priorProofHash?: Hash | null;
  transactions: Hash[];
  provenance?: Provenance;
  /** Contracts only. */
  creationProof?: CreationProof;
}

export type ContractStateResource = StateResource & Required<Pick<StateResource,
  'artifactHash' | 'initcodeHash' | 'inputs' | 'inputsHash' | 'priorInputs' | 'priorInputsHash' | 'salt' | 'codeHash' | 'proofHash'>>;

export interface ImportResourceInput {
  resource: PreparedContract;
  /** Must be `verified` for the same id and address. */
  verification: VerificationResult;
  state?: StateFile | null | undefined;
  chain: ChainIdentity;
  creationTransactionHash?: Hash | null;
  /** Accept a rebuilt artifact for an existing imported record at the same deployment. */
  rebaseline?: boolean;
}

export interface RecordResourceInput {
  resource: PreparedResource;
  verification: VerificationResult;
  state?: StateFile | null | undefined;
  chain: ChainIdentity;
  /** Successful transaction hashes from this apply; merged with the record's existing list. */
  transactions?: Hash[];
}

/** The state file. Disk shape; `validateState` returns a deep JSON copy of it. */
export interface StateFile {
  formatVersion: 1;
  chain: ChainIdentity;
  resources: Record<ResourceId, StateResource>;
  lastPlanHash?: Hash;
}
