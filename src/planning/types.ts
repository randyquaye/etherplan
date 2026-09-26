// Prepared resources and the saved plan. Source of truth: prepareResources and transactionFor in resources.ts;
// planResource, decide, compareState, artifactDrift, and createPlan in index.ts.
import type { Artifacts, NormalizedArtifact } from '../artifacts/types.ts';
import type { ScheduleWave } from '../scheduling/types.ts';
import type { DependencyEdge, DependencyGraphs, DependencyMode, ExecutionAssumption, Factory } from '../spec/types.ts';
import type { StateFile } from '../state/types.ts';
import type { Address, CallId, ChainIdentity, Client, ContractId, DecimalString, ExternalId, Hash, Hex, JsonValue, ResourceId } from '../types.ts';
import type { VerificationResult } from '../verification/types.ts';

/** A getter check with its expected value resolved. */
export type PreparedCheck = {
  functionName: string;
  expected: JsonValue;
};

export type PreparedCallCheck = {
  functionName: string;
  args: JsonValue[];
};

/** The binding getter with the value it must hold before (`before`) or after (`after`) the call. */
export type PreparedBinding = {
  functionName: string;
  args: JsonValue[];
  expected: JsonValue;
};

interface PreparedBase {
  id: ResourceId;
  /** Execution dependencies, sorted. */
  dependencies: ResourceId[];
  /** Present only when the spec uses the dependency plan (schema 2, dependencyMode, or executionAssumptions). */
  resolutionDependencies?: ResourceId[];
  executionEdges?: DependencyEdge[];
  address: Address;
}

export interface PreparedExternal extends PreparedBase {
  id: ExternalId;
  kind: 'external';
  expectedCodeHash: Hash | null;
  checks: PreparedCheck[];
  abi?: NormalizedArtifact['abi'];
}

export interface PreparedContract extends PreparedBase {
  id: ContractId;
  kind: 'contract';
  artifact: NormalizedArtifact;
  artifactHash: Hash;
  /** Resolved constructor arguments. */
  inputs: JsonValue[];
  inputsHash: Hash;
  checks: PreparedCheck[];
  /** Defaults to `deployer`. */
  signerRole: string;
  senderIndependent: boolean;
  /** Present only when nonempty. */
  libraries?: Record<string, Address>;
  expectedCodeHash?: Hash;
  /** The next four are present together, for a CREATE2 deployment; absent for an imported address. */
  initcode?: Hex;
  initcodeHash?: Hash;
  salt?: Hash;
  factory?: Factory;
}

export interface PreparedCall extends PreparedBase {
  kind: 'call';
  id: CallId;
  targetId: ContractId;
  targetArtifact: NormalizedArtifact;
  abi: NormalizedArtifact['abi'];
  method: string;
  args: JsonValue[];
  check: PreparedCallCheck;
  before: PreparedBinding;
  after: PreparedBinding;
  /** Defaults to `owner`. */
  signerRole: string;
  /** The next two are present only when the spec uses the dependency plan. */
  ownerOnly?: boolean;
  transfersOwnership?: boolean;
}

/** A spec resource with every reference resolved and its inputs validated, but nothing read from the chain. */
export type PreparedResource = PreparedContract | PreparedExternal | PreparedCall;

/** A contract the plan can deploy: the CREATE2 fields are present together. */
export type DeployableContract = PreparedContract & Required<Pick<PreparedContract, 'initcode' | 'initcodeHash' | 'salt' | 'factory'>>;

export interface PreparedResources {
  resources: PreparedResource[];
  /** Contract name (without prefix) to resolved address. */
  addresses: Record<string, Address>;
}

/** The transaction a deploy or call action sends. `value` is always `"0"`. */
export interface PlannedTransaction {
  to: Address;
  data: Hex;
  value: DecimalString;
}

export type PlanAction = 'reuse' | 'deploy' | 'call' | 'conflict' | 'unverified';

/** Why a plan accepts a rebuilt artifact for an unchanged CREATE2 deployment, or why it does not. */
export interface ArtifactDrift {
  accepted: boolean;
  previousArtifactHash: Hash;
  artifactHash: Hash;
  previousSourceHash: Hash | null;
  sourceHash: Hash | null;
  baseline: {
    address: Address;
    initcodeHash: Hash | null;
    inputsHash: Hash;
    salt: Hash | null;
    codeHash: Hash | null;
  };
  reasons: string[];
}

/** How a contract compares with its state record. Address and deployment identity both changing is a replacement. */
export interface StateComparison {
  previousAddress: Address;
  previousIdentity: {
    artifactHash: Hash;
    initcodeHash: Hash | null;
    inputsHash: Hash;
  };
  addressMatches: boolean;
  identityMatches: boolean;
  artifactMatches: boolean;
  replacement: boolean;
  conflict: boolean;
  liveCodeMatchesState: boolean;
  artifactDrift?: ArtifactDrift;
}

/** The verification result plus what the planner learned from state and dependencies. */
export type PlanObservation = VerificationResult & {
  stateComparison?: StateComparison;
  dependencyConflicts?: ResourceId[];
  pending?: { reason: string; targetId: ResourceId };
};

interface PlannedBase {
  id: ResourceId;
  dependencies: ResourceId[];
  address: Address;
  resolutionDependencies?: ResourceId[];
  executionEdges?: DependencyEdge[];
  action: PlanAction;
  observation: PlanObservation;
  /** Present when `action` is `deploy` or `call`. */
  tx?: PlannedTransaction;
}

export interface PlannedContract extends PlannedBase {
  kind: 'contract';
  artifactHash: Hash;
  initcodeHash?: Hash;
  inputsHash: Hash;
  salt?: Hash;
  factory?: Factory;
  checks: PreparedCheck[];
  libraries?: Record<string, Address>;
  expectedCodeHash?: Hash;
  signerRole: string;
  senderIndependent: boolean;
}

export interface PlannedExternal extends PlannedBase {
  kind: 'external';
  expectedCodeHash: Hash | null;
  checks: PreparedCheck[];
  signerRole: null;
}

export interface PlannedCall extends PlannedBase {
  kind: 'call';
  targetId: `contract:${string}`;
  method: string;
  args: JsonValue[];
  check: PreparedCallCheck;
  before: PreparedBinding;
  after: PreparedBinding;
  signerRole: string;
  ownerOnly?: boolean;
  transfersOwnership?: boolean;
}

/** One plan entry: the prepared resource without artifacts or initcode, plus the decided action and its evidence. */
export type PlannedResource = PlannedContract | PlannedExternal | PlannedCall;

/** Lowercase addresses pinned at plan time; apply refuses different signers. */
export interface PlanSigners {
  deployers: Address[];
  owner: Address | null;
  parallel: boolean;
}

export interface PlanPipeline extends PlanSigners {
  waves: ScheduleWave[];
}

interface PlanBase {
  chain: ChainIdentity;
  observed: { blockNumber: DecimalString; blockHash: Hash };
  /** Hash of the state the plan was created against (`hashJson(null)` when there was none). */
  stateHash: Hash;
  specHash: Hash;
  /** Contract resource ID to artifact hash. */
  artifactHashes: Record<ContractId, Hash>;
  resources: PlannedResource[];
  /** Present on write plans; a positive decimal wei ceiling per signer. */
  maxSpendWei?: DecimalString;
  signers?: PlanSigners;
  pipeline?: PlanPipeline;
  /** Hash of every other field. */
  planHash: Hash;
}

export interface PlanV1 extends PlanBase {
  formatVersion: 1;
}

/** Written when the spec uses the dependency plan; carries the graphs apply revalidates. */
export interface PlanV2 extends PlanBase {
  formatVersion: 2;
  dependencyMode: DependencyMode;
  graphs: DependencyGraphs;
  executionWaves: { waves: ResourceId[][]; deferred: { id: ResourceId; waitingFor: ResourceId[] }[] };
  executionAssumptions: ExecutionAssumption[];
  warnings: string[];
}

/** The plan file. Disk shape: decimal strings for quantities, never bigint. */
export type Plan = PlanV1 | PlanV2;

/** Signer addresses for a plan; `deployers[0]` alone is used unless `parallel`. */
export interface PlanSignerInput {
  deployers: string[];
  owner?: string | null;
  parallel?: boolean;
}

export interface CreatePlanInput {
  /** Raw or already parsed; createPlan calls parseSpec either way. */
  spec: unknown;
  artifacts: Artifacts;
  client: Client;
  state?: StateFile | null;
  /** Supply at most one of `pipeline` and `signers`. */
  pipeline?: PlanSignerInput | null;
  signers?: PlanSignerInput | null;
  maxSpendWei?: string | bigint | null;
}
