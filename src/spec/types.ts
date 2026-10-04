// Shapes of a parsed specification and its dependency graph. Source of truth: parseSpec and graph in index.ts.
import type {
  Abi,
  Address,
  CallId,
  ContractId,
  ExternalId,
  Hash,
  JsonPrimitive,
  JsonValue,
  ResourceId,
} from '../types.ts';

/** A spec before parseSpec: JSON from disk or a compiled .ethp document. */
export type RawSpec = unknown;

export type SchemaVersion = 1 | 2;

/** `split` keeps resolution and execution edges apart; `compatibility` (the schema 1 default) merges them. */
export type DependencyMode = 'split' | 'compatibility';

/** `values.<name>`, `contracts.<name>.address`, or `externals.<name>.address`. */
export type Reference = {
  ref: string;
  requiresLive?: boolean;
};

/** An object in a spec value; a Reference is one whose only keys are `ref` and `requiresLive`. */
export type SpecObject = { [key: string]: SpecValue };

/** A JSON value that may hold Reference objects at any depth. */
export type SpecValue = JsonPrimitive | SpecValue[] | SpecObject;

/** Getter name to expected value. Names are validated as nonempty strings only. */
export type SpecChecks = Record<string, SpecValue>;

export interface SpecCreatedCode {
  getter: string;
  createNonce: number;
  codeHash: Hash;
}

export interface SpecContract {
  id: string;
  /** Path ending in `.json`, relative to the spec file. */
  artifact: string;
  source?: string;
  name?: string;
  /** Exactly one of `address` (imported) or `salt` (CREATE2 deployment) is present. */
  address?: Address | Reference;
  salt?: Hash;
  /** Present when `salt` was derived; `salt` must equal deriveSalt(mixer, label). */
  saltDerivation?: SaltDerivation;
  /** Required when `salt` is set. */
  args?: SpecValue[];
  /** `file:Name` to address or reference. */
  libraries?: Record<string, SpecValue>;
  checks?: SpecChecks;
  after?: ResourceId[];
  codeHash?: Hash;
  creationProofMode?: 'pinned-runtime';
  createdCode?: SpecCreatedCode[];
  /** Matches `/^[a-z][a-z0-9_-]*$/`; the scheduler has lanes only for `deployer` and `owner`. */
  signerRole?: string;
  senderIndependent?: boolean;
}

export interface SpecExternal {
  address: Address;
  codeHash?: Hash;
  checks?: SpecChecks;
  /** parseSpec checks only that this is an array; validateResources applies assertAbi. */
  abi?: Abi;
}

/** How a CREATE2 salt was derived: keccak256 of the mixer, or of `<mixer>:<label>`. */
export interface SaltDerivation {
  mixer: string;
  label?: string;
}

export interface SpecCallCheck {
  function: string;
  /** Defaults to `[]` in parseSpec. */
  args: SpecValue[];
  equals: SpecValue;
}

export interface SpecCall {
  id: string;
  /** Contract name without the `contract:` prefix. */
  target: string;
  method: string;
  args: SpecValue[];
  check: SpecCallCheck;
  before: { equals: SpecValue };
  after?: ResourceId[];
  signerRole?: string;
  ownerOnly?: boolean;
  transfersOwnership?: boolean;
}

export interface Factory {
  address: Address;
  codeHash: Hash;
}

/** A declared reason why a constructor or library reference needs no execution edge. */
export interface ExecutionAssumption {
  consumer: `contract:${string}`;
  location: string;
  reference: string;
  reason: string;
}

export interface ParsedSpec {
  schema: SchemaVersion;
  chainId: number;
  dependencyMode?: DependencyMode;
  executionAssumptions?: ExecutionAssumption[];
  /** Literal values only; `values.<name>` references resolve here. Defaults to `{}`. */
  values: Record<string, JsonValue>;
  /** Keyed by external name. Defaults to `{}`. */
  externals: Record<string, SpecExternal>;
  /** Present exactly when a contract uses CREATE2; defaults to DEFAULT_FACTORY. */
  factory?: Factory;
  contracts: SpecContract[];
  /** Defaults to `[]`. */
  calls: SpecCall[];
}

export interface DependencyEdge {
  id: ResourceId;
  reasons: string[];
}

interface OrderedNodeBase {
  id: ResourceId;
  resolutionEdges: DependencyEdge[];
  executionEdges: DependencyEdge[];
  resolutionDependencies: ResourceId[];
  executionDependencies: ResourceId[];
  /** Same array as `executionDependencies`. */
  dependencies: ResourceId[];
  /** Same array as `dependencies`. */
  deps: ResourceId[];
}

export interface OrderedContractNode extends OrderedNodeBase {
  id: ContractId;
  kind: 'contract';
  /** Same as `kind`. */
  type: 'contract';
  item: SpecContract;
}

export interface OrderedExternalNode extends OrderedNodeBase {
  id: ExternalId;
  kind: 'external';
  type: 'external';
  item: SpecExternal;
}

export interface OrderedCallNode extends OrderedNodeBase {
  id: CallId;
  kind: 'call';
  type: 'call';
  item: SpecCall;
}

/** One graph node in the order `graph` returns: resolution order in split mode, execution order in compatibility mode. */
export type OrderedNode = OrderedContractNode | OrderedExternalNode | OrderedCallNode;

export interface DependencyGraphs {
  resolution: { id: ResourceId; needs: DependencyEdge[] }[];
  execution: { id: ResourceId; after: DependencyEdge[] }[];
}

/** Contract name (without prefix) to its resolved address, filled in resolution order. */
export type ResolvedAddresses = Record<string, Address>;
