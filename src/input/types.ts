// The HCL subset Etherplan parses and what compile.ts lowers it to. Source of truth: tokenize and Parser in hcl.ts;
// compileSpec, compileConfig, and configOptions in compile.ts.
import type { JsonObject, JsonValue } from '../types.ts';

export interface SourcePosition {
  file: string;
  line: number;
  column: number;
}

/** Anything `fail` can name in an error: every node and token carries `at`. */
export interface Located {
  at: SourcePosition;
}

export type TokenType = 'newline' | 'string' | 'number' | 'ident' | 'operator' | 'eof'
  | '=' | ':' | ',' | '.' | '{' | '}' | '[' | ']' | '(' | ')' | '-';

export interface HclToken extends Located {
  type: TokenType;
  value: string;
}

export interface HclLiteral extends Located {
  kind: 'literal';
  /** Numbers are whole and within the safe integer range. */
  value: string | number | boolean | null;
}

/** `var.owner` or `contracts.registry.address`, as parts. */
export interface HclReference extends Located {
  kind: 'reference';
  parts: string[];
}

export interface HclList extends Located {
  kind: 'list';
  items: HclExpression[];
}

export interface HclObjectEntry extends Located {
  key: string;
  value: HclExpression;
}

export interface HclObject extends Located {
  kind: 'object';
  entries: HclObjectEntry[];
}

export type HclExpression = HclLiteral | HclReference | HclList | HclObject;

export interface HclAttribute extends Located {
  kind: 'attribute';
  name: string;
  value: HclExpression;
}

export interface HclBlock extends Located {
  kind: 'block';
  type: string;
  labels: string[];
  body: HclBody;
}

export interface HclBody extends Located {
  kind: 'body';
  /** Keyed by attribute name, in source order. */
  attributes: Map<string, HclAttribute>;
  blocks: HclBlock[];
}

/** What parseHcl returns: the file's top-level body. */
export type HclDocument = HclBody;

export type HclNode = HclBody | HclAttribute | HclBlock | HclExpression;

/** A schema 2 JSON spec for parseSpec. Loosely typed on purpose: parseSpec is the validator. */
export interface CompiledSpec {
  schema: 2;
  chainId: number;
  dependencyMode?: JsonValue;
  values: Record<string, JsonValue>;
  externals: Record<string, JsonObject>;
  factory?: JsonObject;
  contracts: JsonObject[];
  calls: JsonObject[];
  executionAssumptions?: JsonObject[];
}

export type ConfigOptionName = 'state' | 'journal' | 'backend' | 'out' | 'deployers' | 'owner' | 'parallel' | 'pipeline';

/** Options one .ethpconfig block sets. Paths are resolved; `deployers` is comma-joined like the CLI flag. */
export interface ConfigOptions {
  state?: string;
  journal?: string;
  backend?: string;
  out?: string;
  deployers?: string;
  owner?: string;
  parallel?: boolean;
  pipeline?: boolean;
}

export interface CompiledConfig {
  defaults: ConfigOptions;
  commands: Record<string, ConfigOptions>;
}

/** compileConfig output plus the config file's display path. */
export interface LoadedConfig extends CompiledConfig {
  file: string;
}

/** Command name to the CLI options it accepts; what loadConfig and compileConfig check block contents against. */
export type CommandOptions = Record<string, string[]>;
