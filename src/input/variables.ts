// Resolves .ethp variables. Every variable is declared with a variable block and a type, which lets defaults,
// ETHP_VAR_<name> environment variables, and --var strings supply values. Each variable takes its value from
// the highest-precedence input that sets it: default, environment, var files in order, then --var flags in order.
import { isUserAddress } from '../address.ts';
import { fail, parseHclExpression } from './hcl.ts';
import { describeValue, literal } from './evaluate.ts';
import type { JsonValue } from '../types.ts';
import type { HclBlock, HclDocument, HclExpression, Located } from './types.ts';

export type VariableType =
  | { kind: 'string' | 'number' | 'bool' | 'address' | 'bytes32' | 'any' }
  | { kind: 'list'; element: VariableType };

export interface VariableDeclaration {
  name: string;
  type: VariableType;
  default?: JsonValue;
  block: HclBlock;
}

export interface VariableFile {
  /** Display path used in errors and in the variable sources. */
  file: string;
  document: HclDocument;
}

export interface VariableInputs {
  /** Var files from lowest to highest precedence, for example main.ethpvars then each --var-file. */
  files?: VariableFile[];
  /** Read only for ETHP_VAR_<name> of declared variables. */
  env?: Record<string, string | undefined>;
  /** --var flags as name=value, in order. */
  vars?: string[];
  /** The main var file named in hints, even when it does not exist. */
  varsFile?: string;
}

export interface VariableValue {
  name: string;
  value: JsonValue;
  /** `default`, a var file path, ETHP_VAR_<name>, or --var. */
  source: string;
  /** The declaration, or the var file attribute that set the value. */
  node: Located;
}

const ID = /^[a-z][a-zA-Z0-9_]*$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const SECRET_KEY = /^(private[_-]?key|secret[_-]?key|mnemonic|seed[_-]?phrase|passphrase)$/i;
const PRIMITIVES = new Set(['string', 'number', 'bool', 'address', 'bytes32', 'any']);
const TYPE_HINT = 'type must be string, number, bool, address, bytes32, any, or list(<type>).';
const DECLARATION_FIELDS = new Set(['type', 'default', 'description']);

export function assertNotSecret(name: string, node: Located): void {
  if (SECRET_KEY.test(name)) fail(node, `${name} is a forbidden signer secret. Keep signer keys in the environment.`);
}

export function typeName(type: VariableType): string {
  return type.kind === 'list' ? `list(${typeName(type.element)})` : type.kind;
}

function expected(type: VariableType): string {
  switch (type.kind) {
    case 'string': return 'a string';
    case 'number': return 'a whole number within the safe integer range';
    case 'bool': return 'true or false';
    case 'address': return 'an address';
    case 'bytes32': return 'a 0x-prefixed 32-byte hex string';
    case 'any': return 'a value';
    case 'list': return `a list(${typeName(type.element)})`;
  }
}

function parseType(node: HclExpression): VariableType {
  if (node.kind === 'reference' && node.parts.length === 1 && PRIMITIVES.has(node.parts[0]!)) return { kind: node.parts[0] as 'string' };
  if (node.kind === 'call' && node.name === 'list' && node.args.length === 1) return { kind: 'list', element: parseType(node.args[0]!) };
  fail(node, node.kind === 'literal' && typeof node.value === 'string' ? `${TYPE_HINT} Write it without quotes.` : TYPE_HINT);
}

// Null is valid for every type, as in Terraform: a variable can default to null and be set only where needed.
function conforms(value: JsonValue, type: VariableType): boolean {
  if (value === null) return true;
  switch (type.kind) {
    case 'any': return true;
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isSafeInteger(value);
    case 'bool': return typeof value === 'boolean';
    case 'address': return isUserAddress(value);
    case 'bytes32': return typeof value === 'string' && BYTES32.test(value);
    case 'list': return Array.isArray(value) && value.every(item => conforms(item, type.element));
  }
}

// Environment and --var values are strings. As in Terraform, string and any take them as written, and lists
// parse as HCL literals.
function fromString(text: string, declaration: VariableDeclaration, source: string): JsonValue {
  const { name, type } = declaration;
  const invalid = () => { throw new Error(`${source} must be ${expected(type)} for variable ${name}; found ${JSON.stringify(text)}.`); };
  let value: JsonValue = text;
  if (type.kind === 'number') {
    if (!/^-?[0-9]+$/.test(text)) invalid();
    value = Number(text);
  } else if (type.kind === 'bool') {
    if (text !== 'true' && text !== 'false') invalid();
    value = text === 'true';
  } else if (type.kind === 'list') {
    value = literal(parseHclExpression(source, text), `${source} for variable ${name}`);
  }
  if (!conforms(value, type)) invalid();
  return value;
}

/** Reads variable blocks. */
export function declareVariables(blocks: HclBlock[]): Map<string, VariableDeclaration> {
  const declarations = new Map<string, VariableDeclaration>();
  for (const block of blocks) {
    if (block.labels.length !== 1) fail(block, 'A variable block needs one label, the variable name, for example variable "owner".');
    const name = block.labels[0]!;
    assertNotSecret(name, block);
    if (!ID.test(name)) fail(block, `Variable name ${name} must match ${ID}.`);
    const first = declarations.get(name);
    if (first) fail(block, `Duplicate variable "${name}"; it is first declared on line ${first.block.at.line}.`);
    const [nested] = block.body.blocks;
    if (nested) fail(nested, `variable "${name}" cannot contain a ${nested.type} block.`);
    for (const attribute of block.body.attributes.values()) {
      if (!DECLARATION_FIELDS.has(attribute.name)) fail(attribute, `variable "${name}" has unknown attribute ${attribute.name}. Use type, default, and description.`);
    }
    const { type: typeNode, default: fallback, description } = Object.fromEntries([...block.body.attributes].map(([key, attribute]) => [key, attribute.value]));
    const type = typeNode ? parseType(typeNode) : { kind: 'any' as const };
    if (description && !(description.kind === 'literal' && typeof description.value === 'string')) fail(description, 'description must be a string.');
    const declaration: VariableDeclaration = { name, type, block };
    if (fallback) {
      const value = literal(fallback, 'default');
      if (!conforms(value, type)) fail(fallback, `The default for variable ${name} must be ${expected(type)}; found ${describeValue(value)}.`);
      declaration.default = value;
    }
    declarations.set(name, declaration);
  }
  return declarations;
}

/**
 * Resolves each declared variable's value and where it came from. Var file entries and --var flags must name
 * declared variables. Only the input that wins is parsed from a string, so a stale ETHP_VAR_<name> that a var
 * file or flag overrides does not fail the compile.
 */
export function resolveVariables(declarations: Map<string, VariableDeclaration>, inputs: VariableInputs): Map<string, VariableValue> {
  const fromFiles = new Map<string, VariableValue>();
  for (const file of inputs.files ?? []) {
    const [block] = file.document.blocks;
    if (block) fail(block, `A variables file cannot contain a ${block.type} block. Set each variable with =.`);
    for (const attribute of file.document.attributes.values()) {
      const { name } = attribute;
      assertNotSecret(name, attribute);
      const declaration = declarations.get(name);
      if (!declaration) fail(attribute, `${name} is not declared. Add variable "${name}" {} to the .ethp file, or remove it from ${file.file}.`);
      const value = literal(attribute.value, `Variable ${name}`);
      if (!conforms(value, declaration.type)) fail(attribute.value, `Variable ${name} must be ${expected(declaration.type)}; found ${describeValue(value)}.`);
      fromFiles.set(name, { name, value, source: file.file, node: attribute });
    }
  }
  const fromFlags = new Map<string, string>();
  for (const assignment of inputs.vars ?? []) {
    const index = assignment.indexOf('=');
    const name = assignment.slice(0, index);
    if (index < 0 || !ID.test(name)) throw new Error(`--var ${assignment} must be name=value, for example --var owner=0x….`);
    if (!declarations.has(name)) throw new Error(`--var sets ${name}, which is not declared. Add variable "${name}" {} to the .ethp file.`);
    fromFlags.set(name, assignment.slice(index + 1));
  }
  const values = new Map<string, VariableValue>();
  for (const declaration of declarations.values()) {
    const { name, block } = declaration;
    const flag = fromFlags.get(name);
    const environment = inputs.env?.[`ETHP_VAR_${name}`];
    const file = fromFiles.get(name);
    if (flag !== undefined) values.set(name, { name, value: fromString(flag, declaration, `--var ${name}`), source: '--var', node: block });
    else if (file) values.set(name, file);
    else if (environment !== undefined) values.set(name, { name, value: fromString(environment, declaration, `ETHP_VAR_${name}`), source: `ETHP_VAR_${name}`, node: block });
    else if (Object.hasOwn(declaration, 'default')) values.set(name, { name, value: declaration.default!, source: 'default', node: block });
    else fail(block, `Variable ${name} has no value. Set it in ${inputs.varsFile ?? 'a var file'}, with ETHP_VAR_${name} or --var ${name}=<value>, or give it a default.`);
  }
  return values;
}
