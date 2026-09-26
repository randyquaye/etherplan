// Shape of a normalized compiler artifact. Source of truth: normalizeArtifact in normalize.ts.
import type { Abi, Hash, Hex, JsonObject } from '../types.ts';

/** A Foundry, Hardhat 2, Hardhat 3, solc standard-JSON, or flat artifact before normalization. */
export type RawArtifact = unknown;

export type ArtifactFormat = 'hardhat2' | 'hardhat3' | 'solc' | 'foundry' | 'flat';

export interface ByteRange {
  start: number;
  length: number;
}

/** Source file to library name to the placeholder ranges (each 20 bytes) in the bytecode. */
export type LinkReferences = Record<string, Record<string, ByteRange[]>>;

/** Solidity AST ID (decimal string) to the ranges (each 1 to 32 bytes) an immutable occupies in the runtime. */
export type ImmutableReferences = Record<string, ByteRange[]>;

export interface CreationBytecode {
  /** Lowercase hex with link placeholders left in place. */
  object: Hex;
  linkReferences: LinkReferences;
}

export interface RuntimeBytecode {
  object: Hex;
  linkReferences: LinkReferences;
  immutableReferences: ImmutableReferences;
}

/** An immutable reference joined with its AST declaration when the build context supplies one. */
export interface NamedImmutable {
  id: string;
  ranges: ByteRange[];
  name?: string;
  type?: string;
  visibility?: string;
  source?: string;
  /** The public getter that reads this immutable, when one exists in the ABI. */
  getter?: string;
}

export type MetadataHashKind = 'ipfs' | 'bzzr0' | 'bzzr1';

export interface BuildIdentity {
  compiler?: 'solc' | 'vyper';
  language?: string;
  version?: string;
  settingsHash?: Hash;
  evmVersion?: string;
  optimizer?: JsonObject;
  viaIR?: boolean;
  /** `source:Contract`. */
  compilationTarget?: string;
  sourceHash?: Hash;
  metadataHash?: Hex;
  metadataHashKind?: MetadataHashKind;
  /** Set only when the metadata text reproduces the IPFS hash in the bytecode tail. */
  metadataVerified?: true;
}

/** Plain JSON. `artifactHash` covers every other field, with ABI entries sorted for hashing. */
export interface NormalizedArtifact {
  contractName?: string;
  sourceName?: string;
  abi: Abi;
  bytecode: CreationBytecode;
  deployedBytecode: RuntimeBytecode;
  immutables: NamedImmutable[];
  buildIdentity: BuildIdentity;
  artifactHash: Hash;
}

/** Keyed by contract ID without the `contract:` prefix; what loadArtifacts returns and generateAdapters reads. */
export type Artifacts = Map<string, NormalizedArtifact>;

/** Compiler output and source ASTs from the same compilation as the artifact, found by findBuildContext. */
export interface BuildContext {
  compilerOutput: unknown;
  sources: unknown;
}

export interface NormalizeOptions {
  compilerOutput?: unknown;
  sources?: unknown;
  contractName?: string;
  sourceName?: string;
}
