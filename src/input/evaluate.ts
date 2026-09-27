// Evaluates .ethp expressions at compile time. Conditions, operators, locals, and constant fields fold to
// JSON. Value fields keep var.<name> and resource addresses as references for parseSpec, so the compiled
// spec holds only concrete values and references.
import { fail } from './hcl.ts';
import { MIXER, MIXER_HINT, deriveSalt } from '../spec/salt.ts';
import type { SaltDerivation } from '../spec/types.ts';
import type { Hash, JsonValue, ResourceId } from '../types.ts';
import type { HclAttribute, HclBinary, HclExpression, HclReference, Located } from './types.ts';

export type Root = 'contracts' | 'externals' | 'calls';
export type Target = { root: Root; name: string; id: ResourceId };

/**
 * `constant` fields such as salt must fold to JSON. `condition` is the same, for conditions and operator
 * operands, with its own errors. `value` fields such as args keep references.
 */
type Mode = 'constant' | 'condition' | 'value';

export const KINDS = { contracts: 'contract', externals: 'external', calls: 'call' } as const;
const RESOURCE_ROOTS: ReadonlySet<string> = new Set(['contracts', 'externals', 'calls']);
const HEX = /^0x[0-9a-fA-F]*$/;

export interface NameScope {
  /** Throws if `var.<name>` has no declaration or value. `what` names the attribute. */
  variable(name: string, node: Located, what: string): void;
  locals: ReadonlyMap<string, HclAttribute>;
  declared(root: Root, name: string): boolean;
}

export interface EvaluationScope {
  variables: ReadonlyMap<string, JsonValue>;
  locals: ReadonlyMap<string, HclAttribute>;
  /** Throws if a taken reference names a disabled resource. */
  live(root: Root, name: string, node: Located, what: string): void;
}

function kind(value: JsonValue): string {
  return value === null ? 'null' : Array.isArray(value) ? 'list' : typeof value === 'object' ? 'object' : typeof value;
}

/** A short description of a value for errors, such as `string "yes"`. */
export function describeValue(value: JsonValue): string {
  const text = JSON.stringify(value);
  return value === null ? 'null' : `${kind(value)} ${text.length > 60 ? `${text.slice(0, 57)}...` : text}`;
}

// Hex strings compare without regard to case, as addresses and hashes do on chain.
function same(left: JsonValue, right: JsonValue): boolean {
  if (typeof left === 'string' && typeof right === 'string' && HEX.test(left) && HEX.test(right)) return left.toLowerCase() === right.toLowerCase();
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => same(item, right[index]!));
  }
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && same(left[key]!, right[key]!));
}

/** Decodes a literal, list, or object with no references or expressions: var files, defaults, and config. */
export function literal(node: HclExpression, name: string): JsonValue {
  if (node.kind === 'literal') return node.value;
  if (node.kind === 'list') return node.items.map(item => literal(item, name));
  if (node.kind === 'object') return Object.fromEntries(node.entries.map(entry => [entry.key, literal(entry.value, name)]));
  if (node.kind === 'reference') fail(node, `${name} must be a literal; it cannot reference ${node.parts.join('.')}.`);
  if (node.kind === 'call') fail(node, `Function calls are not supported (${node.name}).`);
  fail(node, `${name} must be a literal, not an expression.`);
}

/** A salt that `derive` produced, with the derivation the compiled spec records beside it. */
export class DerivedSalt {
  declare salt: Hash;
  declare derivation: SaltDerivation;

  constructor(salt: Hash, derivation: SaltDerivation) {
    this.salt = salt;
    this.derivation = derivation;
  }
}

/** `derive` or `derive("label")`, or null for any other expression. */
function deriveNode(node: HclExpression): { label?: HclExpression } | null {
  if (node.kind === 'reference') return node.parts.length === 1 && node.parts[0] === 'derive' ? {} : null;
  if (node.kind !== 'call' || node.name !== 'derive') return null;
  const [label] = node.args;
  if (node.args.length !== 1 || label === undefined) fail(node, 'derive takes one label, such as derive("second-instance"). Write derive alone for the default salt.');
  return { label };
}

/**
 * Checks every reference in an expression, including branches that evaluation will not take: variables and
 * locals must exist, resources must be declared, and function calls other than derive are rejected. `salt` is
 * given for a salt field, where derive is valid; it is called for each derive. Calls `use` for each
 * var.<name> and local.<name>, which drives the unused checks and local cycle detection.
 */
export function checkReferences(node: HclExpression, what: string, scope: NameScope, use: (root: 'var' | 'local', name: string) => void, salt?: (node: Located) => void): void {
  switch (node.kind) {
    case 'literal':
      return;
    case 'list':
      for (const item of node.items) checkReferences(item, what, scope, use);
      return;
    case 'object':
      for (const entry of node.entries) checkReferences(entry.value, what, scope, use);
      return;
    case 'conditional':
      checkReferences(node.condition, what, scope, use);
      checkReferences(node.then, what, scope, use, salt);
      checkReferences(node.otherwise, what, scope, use, salt);
      return;
    case 'binary':
      checkReferences(node.left, what, scope, use);
      checkReferences(node.right, what, scope, use);
      return;
    case 'not':
      checkReferences(node.operand, what, scope, use);
      return;
    case 'call': {
      const derive = deriveNode(node);
      if (!derive) fail(node, `Function calls are not supported (${node.name}).`);
      if (!salt) fail(node, `${what} uses derive, which is valid only as a salt value.`);
      salt(node);
      if (derive.label) checkReferences(derive.label, what, scope, use);
      return;
    }
  }
  if (deriveNode(node)) {
    if (!salt) fail(node, `${what} uses derive, which is valid only as a salt value.`);
    salt(node);
    return;
  }
  const [root, name, field] = node.parts;
  const text = node.parts.join('.');
  const unsupported: () => never = () => fail(node, `${what} has unsupported reference ${text}. Use var.<name>, local.<name>, contracts.<name>.address, or externals.<name>.address.`);
  if (name === undefined) unsupported();
  if (root === 'var' || root === 'local') {
    if (node.parts.length !== 2) unsupported();
    if (root === 'var') scope.variable(name, node, what);
    else if (!scope.locals.has(name)) fail(node, `${what} uses undefined local.${name}. Define it in a locals block.`);
    use(root, name);
    return;
  }
  if (!RESOURCE_ROOTS.has(root!)) unsupported();
  const addressable = root !== 'calls' && node.parts.length === 3 && field === 'address';
  if (node.parts.length !== 2 && !addressable) unsupported();
  if (!scope.declared(root as Root, name)) fail(node, `${what} references unknown ${root}.${name}.`);
}

/** Evaluates expressions that checkReferences has accepted. */
export class Evaluator {
  declare scope: EvaluationScope;
  /** Variables that evaluated value fields reference. Only these become spec values. */
  declare referenced: Set<string>;
  /** The top-level mixer that derive hashes, once the compiler has evaluated it. */
  declare mixer: string | null;

  constructor(scope: EvaluationScope) {
    this.scope = scope;
    this.referenced = new Set();
    this.mixer = null;
  }

  /** A field such as chain_id or enabled: folds to JSON with no resource references. */
  constant(node: HclExpression, what: string): JsonValue {
    return this.evaluate(node, what, 'constant');
  }

  /** The salt field: a constant, or derive / derive("label") where evaluation reaches one. */
  salt(node: HclExpression, what: string): JsonValue | DerivedSalt {
    if (node.kind === 'conditional') return this.salt(this.condition(node.condition, what) ? node.then : node.otherwise, what);
    const derive = deriveNode(node);
    if (!derive) return this.evaluate(node, what, 'constant');
    const { mixer } = this;
    if (mixer === null) fail(node, `${what} uses derive, so the spec needs a top-level mixer attribute.`);
    if (!derive.label) return new DerivedSalt(deriveSalt(mixer), { mixer });
    const label = this.constant(derive.label, `${what} derive label`);
    if (typeof label !== 'string' || !MIXER.test(label)) fail(derive.label, `derive takes one label, ${MIXER_HINT}; found ${describeValue(label)}.`);
    return new DerivedSalt(deriveSalt(mixer, label), { mixer, label });
  }

  /** A field such as args: var.<name> stays { ref: values.<name> } and addresses stay references. */
  value(node: HclExpression, what: string): JsonValue {
    return this.evaluate(node, what, 'value');
  }

  /** A resource such as contracts.registry. Unless `live` is false, it must be enabled. */
  resource(node: HclExpression, what: string, roots: Root[], live = true): Target {
    if (node.kind === 'conditional') return this.resource(this.condition(node.condition, what) ? node.then : node.otherwise, what, roots, live);
    const local = this.local(node);
    if (local) return this.resource(local.value, `${what} through local.${local.name}`, roots, live);
    if (!(node.kind === 'reference' && node.parts.length === 2 && roots.includes(node.parts[0] as Root))) {
      fail(node, `${what} must be ${roots.map(root => `${root}.<name>`).join(' or ')}.`);
    }
    const [root, name] = node.parts as [Root, string];
    if (live) this.scope.live(root, name, node, what);
    return { root, name, id: `${KINDS[root]}:${name}` };
  }

  /** A list of live resources, such as after. */
  resources(node: HclExpression, what: string, roots: Root[]): Target[] {
    if (node.kind === 'conditional') return this.resources(this.condition(node.condition, what) ? node.then : node.otherwise, what, roots);
    const local = this.local(node);
    if (local) return this.resources(local.value, `${what} through local.${local.name}`, roots);
    if (node.kind !== 'list') fail(node, `${what} must be a list of resources.`);
    return node.items.map(item => this.resource(item, what, roots));
  }

  local(node: HclExpression): { name: string; value: HclExpression } | null {
    if (node.kind !== 'reference' || node.parts[0] !== 'local' || node.parts.length !== 2) return null;
    const name = node.parts[1]!;
    return { name, value: this.scope.locals.get(name)!.value };
  }

  condition(node: HclExpression, what: string, operator = '?'): boolean {
    const value = this.evaluate(node, what, 'condition');
    if (typeof value !== 'boolean') {
      fail(node, `${operator === '?' ? 'The condition' : `The operand of ${operator}`} in ${what} must be true or false; found ${describeValue(value)}.`);
    }
    return value;
  }

  evaluate(node: HclExpression, what: string, mode: Mode): JsonValue {
    switch (node.kind) {
      case 'literal':
        return node.value;
      case 'list':
        return node.items.map(item => this.evaluate(item, what, mode));
      case 'object':
        return Object.fromEntries(node.entries.map(entry => [entry.key, this.evaluate(entry.value, what, mode)]));
      case 'conditional':
        return this.evaluate(this.condition(node.condition, what) ? node.then : node.otherwise, what, mode);
      case 'not':
        return !this.condition(node.operand, what, '!');
      case 'binary':
        return this.binary(node, what);
      case 'call':
        fail(node, `Function calls are not supported (${node.name}).`);
      case 'reference':
        return this.reference(node, what, mode);
    }
  }

  binary(node: HclBinary, what: string): boolean {
    const { operator } = node;
    // && and || skip their right operand once the left decides, so it can guard a null check.
    if (operator === '&&' || operator === '||') {
      const left = this.condition(node.left, what, operator);
      return (operator === '&&') === left ? this.condition(node.right, what, operator) : left;
    }
    const left = this.evaluate(node.left, what, 'condition');
    const right = this.evaluate(node.right, what, 'condition');
    const at = { at: node.operatorAt };
    if (operator === '==' || operator === '!=') {
      if (left !== null && right !== null && kind(left) !== kind(right)) {
        fail(at, `${operator} in ${what} compares ${describeValue(left)} with ${describeValue(right)}. Both sides must have the same type, or one must be null.`);
      }
      return same(left, right) === (operator === '==');
    }
    if (typeof left !== 'number' || typeof right !== 'number') fail(at, `${operator} in ${what} compares numbers; found ${describeValue(left)} and ${describeValue(right)}.`);
    return operator === '<' ? left < right : operator === '<=' ? left <= right : operator === '>' ? left > right : left >= right;
  }

  reference(node: HclReference, what: string, mode: Mode): JsonValue {
    const [root, name] = node.parts as [string, string];
    const text = node.parts.join('.');
    if (root === 'var') {
      // A null variable is inlined even in a value field, so an attribute set to it is left unset.
      const value = this.scope.variables.get(name)!;
      if (mode !== 'value' || value === null) return structuredClone(value);
      this.referenced.add(name);
      return { ref: `values.${name}` };
    }
    if (root === 'local') return this.evaluate(this.scope.locals.get(name)!.value, `${what} through local.${name}`, mode);
    if (mode === 'condition') fail(node, `${what} uses ${text} in a condition or comparison. Those can use only literals, var.<name>, and local.<name>.`);
    if (mode === 'constant') fail(node, `${what} must be a constant, so it cannot reference ${text}. Use a literal, var.<name>, or local.<name>.`);
    if (node.parts.length === 2 && root !== 'calls') {
      fail(node, `${what} references the resource ${text}. Use ${text}.address for its address, or list it in after for an execution barrier.`);
    }
    if (root === 'calls') fail(node, `${what} has unsupported reference ${text}. Use var.<name>, local.<name>, contracts.<name>.address, or externals.<name>.address.`);
    this.scope.live(root as Root, name, node, what);
    return { ref: text };
  }
}
