// Lowers parsed .ethp, .ethpvars, and .ethpconfig documents into the canonical JSON inputs. Variables,
// locals, conditionals, and enabled fold here, so the spec holds only concrete values and references and the
// engine never sees an expression. Each error names the file, line, and column of the attribute, block, or
// value that caused it.
import { fail } from './hcl.ts';
import { Evaluator, KINDS, checkReferences, describeValue, literal } from './evaluate.ts';
import { assertNotSecret, declareVariables, resolveVariables } from './variables.ts';
import type { JsonObject, JsonValue } from '../types.ts';
import type { NameScope, Root, Target } from './evaluate.ts';
import type { VariableInputs, VariableValue } from './variables.ts';
import type { CommandOptions, CompiledConfig, CompiledSpec, ConfigOptionName, ConfigOptions, HclAttribute, HclBlock, HclBody, HclDocument, HclExpression, Located } from './types.ts';

type ResourceType = 'contract' | 'external' | 'call' | 'check';
type DecoderKind = 'constant' | 'value' | 'target' | 'after' | 'creationMode' | 'createdCode';
type FieldMap = Record<string, readonly [string, DecoderKind]>;
type Decoder = (node: HclExpression, name: string) => JsonValue;
type DraftResource = Record<string, JsonValue | undefined> & {
  checks?: Record<string, JsonValue>;
  check?: JsonObject;
  before?: JsonObject;
  checkBlock?: string;
  checkBlocks?: Record<string, string>;
};
type Resources = Record<Root, Map<string, DraftResource>>;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const RESOURCE_TYPES: ResourceType[] = ['contract', 'external', 'call', 'check'];
const ROOTS = { contract: 'contracts', external: 'externals', call: 'calls' } as const;

// HCL attribute -> [JSON field, decoder]. Decoders: constant (folds to JSON), value (may hold references),
// target, after. Resource blocks also take the enabled meta-argument.
const CONTRACT_FIELDS: FieldMap = {
  artifact: ['artifact', 'constant'],
  source: ['source', 'constant'],
  name: ['name', 'constant'],
  address: ['address', 'value'],
  salt: ['salt', 'constant'],
  args: ['args', 'value'],
  libraries: ['libraries', 'value'],
  after: ['after', 'after'],
  code_hash: ['codeHash', 'constant'],
  creation_proof_mode: ['creationProofMode', 'creationMode'],
  created_code: ['createdCode', 'createdCode'],
  signer_role: ['signerRole', 'constant'],
  sender_independent: ['senderIndependent', 'constant'],
};
const EXTERNAL_FIELDS: FieldMap = {
  address: ['address', 'constant'],
  code_hash: ['codeHash', 'constant'],
  abi: ['abi', 'constant'],
};
const CALL_FIELDS: FieldMap = {
  target: ['target', 'target'],
  method: ['method', 'constant'],
  args: ['args', 'value'],
  after: ['after', 'after'],
  signer_role: ['signerRole', 'constant'],
  owner_only: ['ownerOnly', 'constant'],
  transfers_ownership: ['transfersOwnership', 'constant'],
};
const FACTORY_FIELDS: FieldMap = { address: ['address', 'constant'], code_hash: ['codeHash', 'constant'] };
// JSON field order for readable compile output. Key order does not affect spec hashes.
const CONTRACT_ORDER = ['id', 'artifact', 'source', 'name', 'address', 'salt', 'args', 'libraries', 'checks', 'after', 'codeHash', 'creationProofMode', 'createdCode', 'signerRole', 'senderIndependent'];
const EXTERNAL_ORDER = ['address', 'codeHash', 'abi', 'checks'];
const CALL_ORDER = ['id', 'target', 'method', 'args', 'check', 'before', 'after', 'signerRole', 'ownerOnly', 'transfersOwnership'];
const TOP_ATTRIBUTES = new Set(['chain_id', 'dependency_mode', 'execution_assumptions']);
const TOP_BLOCKS = new Set(['resource', 'factory', 'variable', 'locals']);
const ASSUMPTION_FIELDS = ['consumer', 'location', 'reference', 'reason'];
const CALL_CHECK_FIELDS = new Set(['getter', 'args', 'before', 'equals']);
// Getter names a getter-list check cannot use; enabled is the block's meta-argument there.
const RESERVED_GETTERS = new Set(['getter', 'args', 'before', 'equals', 'after']);

export const CONFIG_OPTIONS: ConfigOptionName[] = ['state', 'journal', 'backend', 'out', 'deployers', 'owner', 'parallel', 'pipeline'];
const CONFIG_PATHS = new Set(['state', 'journal', 'backend', 'out']);

function assert(condition: unknown, node: Located | undefined, message: string): asserts condition {
  if (!condition) fail(node as Located, message);
}

function byName(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function describe(block: HclBlock): string {
  return [block.type, ...block.labels.map(label => `"${label}"`)].join(' ');
}

// Returns the attributes of a body that must not contain nested blocks, sorted by name.
function attributesOf(body: HclBody, what: string) {
  const [block] = body.blocks;
  assert(!block, block, `${what} cannot contain a ${block?.type} block. Set its fields as attributes with =.`);
  return [...body.attributes.values()].sort((left, right) => byName(left.name, right.name));
}

// Checks attribute names against `fields` and returns the attributes to compile. Resource blocks also accept enabled.
function fieldAttributes(block: HclBlock, fields: FieldMap, resource: boolean): HclAttribute[] {
  const what = describe(block);
  return attributesOf(block.body, what).filter(attribute => {
    const { name } = attribute;
    if (resource && name === 'enabled') return false;
    const snake = name.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
    const hint = snake !== name && Object.hasOwn(fields, snake) ? ` Use ${snake}.`
      : ['checks', 'check', 'before'].includes(name) ? ' Declare checks in resource "check" blocks.' : '';
    assert(Object.hasOwn(fields, name), attribute, `${what} has unknown attribute ${name}.${hint}`);
    return true;
  });
}

function compileBlock(block: HclBlock, fields: FieldMap, decoders: Record<DecoderKind, Decoder>, resource = true): DraftResource {
  const item: DraftResource = {};
  for (const attribute of fieldAttributes(block, fields, resource)) {
    const [field, kind] = fields[attribute.name]!;
    const value = decoders[kind](attribute.value, attribute.name);
    // As in Terraform, null leaves the attribute unset, so a variable can supply it in some worlds only.
    if (value !== null) item[field] = value;
  }
  return item;
}

// The target of a check whose target is a plain reference, known without evaluating anything.
function staticTarget(node: HclExpression): Target | undefined {
  if (node.kind !== 'reference' || node.parts.length !== 2) return undefined;
  const [root, name] = node.parts as [string, string];
  return root === 'contracts' || root === 'externals' || root === 'calls' ? { root, name, id: `${KINDS[root]}:${name}` } : undefined;
}

// Checks a check block's attributes for its target kind without evaluating them, so a check that is dropped in
// one world is still checked there.
function checkShape(block: HclBlock, { root, id }: Target): void {
  const what = describe(block);
  const attributes = block.body.attributes;
  const fields = attributesOf(block.body, what).filter(attribute => attribute.name !== 'target' && attribute.name !== 'enabled');
  if (root === 'calls') {
    for (const attribute of fields) {
      assert(CALL_CHECK_FIELDS.has(attribute.name), attribute, `${what} targets a call and has unknown attribute ${attribute.name}. Use getter, args, before, and equals.`);
    }
    assert(['getter', 'before', 'equals'].every(field => attributes.has(field)), block, `${what} targets a call and needs getter, before, and equals.`);
    return;
  }
  if (attributes.has('getter')) {
    // The getter form reaches getter names that are reserved here or are not HCL identifiers.
    for (const attribute of fields) assert(['getter', 'equals'].includes(attribute.name), attribute, `${what} uses getter, so it can set only target, getter, equals, and enabled.`);
    assert(attributes.has('equals'), block, `${what} needs equals.`);
    return;
  }
  for (const attribute of fields) {
    assert(!RESERVED_GETTERS.has(attribute.name), attribute, `${what} targets ${id}; ${attribute.name} is only for a check that targets a call. Use getter and equals for a getter named ${attribute.name}.`);
    assertNotSecret(attribute.name, attribute);
  }
  assert(fields.length > 0, block, `${what} needs at least one getter.`);
}

// Folds one check block into the checks map of a contract or external, or into a call's check and before.
function foldCheck(block: HclBlock, target: Target, resources: Resources, evaluator: Evaluator): void {
  const name = block.labels[1];
  assert(name !== undefined, block, 'A check block needs a name label.');
  checkShape(block, target);
  const attributes = block.body.attributes;
  const fields = attributesOf(block.body, describe(block)).filter(attribute => attribute.name !== 'target' && attribute.name !== 'enabled');
  const get = (field: string) => attributes.get(field)?.value;
  if (target.root === 'calls') {
    const call = resources.calls.get(target.name);
    assert(call, block, `Missing ${target.id}.`);
    assert(!call.check, block, `${target.id} has more than one check block: ${call.checkBlock} and ${name}.`);
    call.checkBlock = name;
    call.check = {
      function: evaluator.constant(get('getter')!, 'getter'),
      args: attributes.has('args') ? evaluator.value(get('args')!, 'args') : [],
      equals: evaluator.value(get('equals')!, 'equals'),
    };
    call.before = { equals: evaluator.value(get('before')!, 'before') };
    return;
  }
  let getters: [string, HclExpression, Located][];
  if (attributes.has('getter')) {
    const getter = evaluator.constant(get('getter')!, 'getter');
    assert(typeof getter === 'string' && getter.length > 0, get('getter'), 'getter must be a nonempty string.');
    getters = [[getter, get('equals')!, get('getter')!]];
  } else {
    getters = fields.map(attribute => [attribute.name, attribute.value, attribute]);
  }
  const item = resources[target.root].get(target.name);
  assert(item, block, `Missing ${target.id}.`);
  // Null prototypes keep a getter named __proto__ as an ordinary key.
  const checks = item.checks ??= Object.create(null) as Record<string, JsonValue>;
  const checkBlocks = item.checkBlocks ??= Object.create(null) as Record<string, string>;
  for (const [getter, node, at] of getters) {
    assert(!Object.hasOwn(checks, getter), at, `${target.id} getter ${getter} is checked by both ${checkBlocks[getter]} and ${name}.`);
    checks[getter] = evaluator.value(node, getter);
    checkBlocks[getter] = name;
  }
}

function ordered(item: DraftResource, order: string[]): JsonObject {
  return Object.fromEntries(order.filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]])) as JsonObject;
}

function collectLocals(blocks: HclBlock[]): Map<string, HclAttribute> {
  const locals = new Map<string, HclAttribute>();
  for (const block of blocks) {
    assert(block.labels.length === 0, block, 'A locals block has no labels.');
    for (const attribute of attributesOf(block.body, 'A locals block')) {
      assertNotSecret(attribute.name, attribute);
      const first = locals.get(attribute.name);
      assert(!first, attribute, `local.${attribute.name} is already defined on line ${first?.at.line}.`);
      locals.set(attribute.name, attribute);
    }
  }
  return locals;
}

// Rejects locals that refer to themselves, even through a branch that evaluation would not take.
function assertAcyclic(locals: Map<string, HclAttribute>, edges: Map<string, Set<string>>): void {
  const done = new Set<string>();
  const visit = (name: string, path: string[]): void => {
    if (done.has(name)) return;
    const start = path.indexOf(name);
    assert(start < 0, locals.get(name), `Locals refer to themselves: ${[...path.slice(start), name].map(item => `local.${item}`).join(' -> ')}.`);
    for (const next of edges.get(name) ?? []) visit(next, [...path, name]);
    done.add(name);
  };
  for (const name of locals.keys()) visit(name, []);
}

/** A compiled spec and each variable's value and source. */
export interface CompiledProject {
  spec: CompiledSpec;
  variables: VariableValue[];
}

/**
 * Compiles a parsed .ethp document and its variable inputs into a schema 2 JSON spec for parseSpec.
 * Resources are sorted by type and ID, so source block order does not affect the spec or its hash.
 */
export function compileProject(document: HclDocument, inputs: VariableInputs = {}): CompiledProject {
  for (const attribute of document.attributes.values()) {
    const hint = attribute.name === 'chainId' ? ' Use chain_id.' : TOP_BLOCKS.has(attribute.name) ? ` Declare ${attribute.name} as a block.` : '';
    assert(TOP_ATTRIBUTES.has(attribute.name), attribute, `Unknown top-level attribute ${attribute.name}.${hint}`);
  }
  for (const block of document.blocks) {
    assert(TOP_BLOCKS.has(block.type), block, `Unknown block type ${block.type}.${TOP_ATTRIBUTES.has(block.type) ? ` Set ${block.type} with =.` : ''}`);
  }
  const chain = document.attributes.get('chain_id');
  assert(chain, document, 'The spec needs chain_id.');
  const declarations = declareVariables(document.blocks.filter(block => block.type === 'variable'));
  const variables = resolveVariables(declarations, inputs);
  const locals = collectLocals(document.blocks.filter(block => block.type === 'locals'));

  const blocks: Record<ResourceType, Map<string, HclBlock>> = {
    contract: new Map(), external: new Map(), call: new Map(), check: new Map(),
  };
  for (const block of document.blocks.filter(item => item.type === 'resource')) {
    assert(block.labels.length === 2, block, 'A resource block needs a type label and a name label, for example resource "contract" "registry".');
    const [type, name] = block.labels;
    assert(type !== undefined && name !== undefined && RESOURCE_TYPES.includes(type as ResourceType), block, `Unknown resource type ${type}. Use ${RESOURCE_TYPES.join(', ')}.`);
    const resourceType = type as ResourceType;
    const first = blocks[resourceType].get(name);
    assert(!first, block, `Duplicate resource "${type}" "${name}"; it is first declared on line ${first?.at.line}.`);
    blocks[resourceType].set(name, block);
  }
  const factories = document.blocks.filter(block => block.type === 'factory');
  assert(factories.length <= 1, factories[1], `Duplicate factory block; the first is on line ${factories[0]?.at.line}.`);
  assert(!factories[0]?.labels.length, factories[0], 'A factory block has no labels.');

  // Check every reference, including those in disabled resources and branches that are not taken.
  const names = { contracts: blocks.contract, externals: blocks.external, calls: blocks.call };
  const scope: NameScope = {
    variable(name, node, what) {
      assert(declarations.has(name), node, `${what} uses undeclared variable ${name}. Declare it with variable "${name}" {}.`);
    },
    locals,
    declared: (root, name) => names[root].has(name),
  };
  const usedVariables = new Set<string>();
  const usedLocals = new Set<string>();
  const localEdges = new Map<string, Set<string>>();
  const check = (node: HclExpression, what: string, local?: string) => checkReferences(node, what, scope, (root, name) => {
    if (root === 'var') usedVariables.add(name);
    else {
      usedLocals.add(name);
      if (local !== undefined) localEdges.set(local, (localEdges.get(local) ?? new Set()).add(name));
    }
  });
  for (const attribute of document.attributes.values()) {
    const { value } = attribute;
    if (attribute.name === 'execution_assumptions' && value.kind === 'list') {
      for (const item of value.items) {
        if (item.kind === 'object') for (const entry of item.entries) check(entry.value, entry.key);
        else check(item, attribute.name);
      }
    } else check(value, attribute.name);
  }
  for (const [name, attribute] of locals) check(attribute.value, `local.${name}`, name);
  for (const block of [...document.blocks.filter(item => item.type === 'resource'), ...factories]) {
    for (const attribute of block.body.attributes.values()) check(attribute.value, attribute.name);
  }
  assertAcyclic(locals, localEdges);

  const disabled = new Map<string, HclAttribute>();
  const live = (root: Root, name: string, node: Located, what: string) => {
    const off = disabled.get(`${root}.${name}`);
    assert(!off, node, `${what} references ${root}.${name}, but ${KINDS[root]}:${name} is disabled (its enabled on line ${off?.at.line} is false). Put the reference behind the same condition.`);
  };
  const evaluator = new Evaluator({ variables: new Map([...variables].map(([name, item]) => [name, item.value])), locals, live });
  const enabled = (block: HclBlock): boolean => {
    const attribute = block.body.attributes.get('enabled');
    if (!attribute) return true;
    const value = evaluator.constant(attribute.value, 'enabled');
    assert(typeof value === 'boolean', attribute.value, `enabled must be true or false; found ${describeValue(value)}.`);
    return value;
  };

  const chainId = evaluator.constant(chain.value, 'chain_id');
  assert(typeof chainId === 'number' && Number.isSafeInteger(chainId) && chainId > 0, chain.value, 'chain_id must be a positive integer.');
  const fields = { contract: CONTRACT_FIELDS, external: EXTERNAL_FIELDS, call: CALL_FIELDS };
  for (const type of ['contract', 'external', 'call'] as const) {
    for (const [name, block] of blocks[type]) {
      if (enabled(block)) continue;
      // A disabled resource is removed before references resolve. Its attributes must still be known ones.
      fieldAttributes(block, fields[type], true);
      disabled.set(`${ROOTS[type]}.${name}`, block.body.attributes.get('enabled')!);
    }
  }
  const sorted = (type: ResourceType) => [...blocks[type]].filter(([name]) => type === 'check' || !disabled.has(`${ROOTS[type as keyof typeof ROOTS]}.${name}`))
    .sort(([left], [right]) => byName(left, right));

  const decoders: Record<DecoderKind, Decoder> = {
    constant: (node, name) => evaluator.constant(node, name),
    value: (node, name) => evaluator.value(node, name),
    creationMode: (node, name) => {
      const mode = evaluator.constant(node, name);
      if (mode === null) return null;
      assert(mode === 'pinned_runtime', node, `${name} must be pinned_runtime.`);
      return 'pinned-runtime';
    },
    createdCode: (node, name) => {
      const entries = evaluator.constant(node, name);
      if (entries === null) return null;
      assert(Array.isArray(entries), node, `${name} must be a list of objects.`);
      return entries.map((entry, index) => {
        const location = node.kind === 'list' ? node.items[index] ?? node : node;
        assert(entry !== null && typeof entry === 'object' && !Array.isArray(entry), location, `${name} entries must be objects.`);
        for (const key of Object.keys(entry)) assert(['getter', 'create_nonce', 'code_hash'].includes(key), location, `${name} has unknown field ${key}.`);
        assert(['getter', 'create_nonce', 'code_hash'].every(key => Object.hasOwn(entry, key)), location, `${name} entries need getter, create_nonce, and code_hash.`);
        return { getter: entry.getter!, createNonce: entry.create_nonce!, codeHash: entry.code_hash! };
      });
    },
    target: (node, name) => evaluator.resource(node, name, ['contracts']).name,
    after: (node, name) => evaluator.resources(node, name, ['contracts', 'externals', 'calls']).map(target => target.id),
  };
  const compiled: Resources = {
    contracts: new Map(sorted('contract').map(([name, block]): [string, DraftResource] => [name, { id: name, ...compileBlock(block, CONTRACT_FIELDS, decoders) }])),
    externals: new Map(sorted('external').map(([name, block]): [string, DraftResource] => [name, compileBlock(block, EXTERNAL_FIELDS, decoders)])),
    calls: new Map(sorted('call').map(([name, block]): [string, DraftResource] => [name, { id: name, ...compileBlock(block, CALL_FIELDS, decoders) }])),
  };
  const disabledChecks = new Map<string, string>();
  for (const [name, block] of sorted('check')) {
    const target = block.body.attributes.get('target');
    assert(target, block, `${describe(block)} needs target.`);
    const known = staticTarget(target.value);
    if (known) checkShape(block, known);
    if (!enabled(block)) {
      if (known?.root === 'calls') disabledChecks.set(known.name, name);
      continue;
    }
    // A check follows its target: it is dropped when the target is disabled.
    const resolved = evaluator.resource(target.value, 'target', ['contracts', 'externals', 'calls'], false);
    if (disabled.has(`${resolved.root}.${resolved.name}`)) continue;
    foldCheck(block, resolved, compiled, evaluator);
  }
  for (const [name, call] of compiled.calls) {
    const off = disabledChecks.get(name);
    assert(call.check, blocks.call.get(name), `call:${name} needs one check block with target = calls.${name}.${off ? ` Its check block ${off} is disabled; an enabled call needs an enabled check.` : ''}`);
  }
  for (const item of [...compiled.contracts.values(), ...compiled.externals.values()]) {
    if (item.checks) item.checks = Object.fromEntries(Object.entries(item.checks).sort(([left], [right]) => byName(left, right)));
  }

  const mode = document.attributes.get('dependency_mode');
  const dependencyMode = mode ? evaluator.constant(mode.value, 'dependency_mode') : undefined;
  const factory = factories.length ? compileBlock(factories[0]!, FACTORY_FIELDS, decoders, false) as JsonObject : undefined;
  const assumptions = document.attributes.get('execution_assumptions')?.value;
  let executionAssumptions: JsonObject[] | undefined;
  if (assumptions) {
    assert(assumptions.kind === 'list', assumptions, 'execution_assumptions must be a list of objects.');
    executionAssumptions = assumptions.items.flatMap(item => {
      assert(item.kind === 'object', item, 'Each execution assumption must be an object.');
      const fields = new Map(item.entries.map(entry => [entry.key, entry.value]));
      for (const entry of item.entries) assert(ASSUMPTION_FIELDS.includes(entry.key), entry, `Execution assumption has unknown attribute ${entry.key}.`);
      assert(ASSUMPTION_FIELDS.every(key => fields.has(key)), item, `An execution assumption needs ${ASSUMPTION_FIELDS.join(', ')}.`);
      const reference = fields.get('reference');
      assert(reference, item, 'An execution assumption needs reference.');
      assert(reference.kind === 'reference' && reference.parts.length === 3 && reference.parts[0] === 'contracts' && reference.parts[2] === 'address',
        reference, 'reference must be contracts.<name>.address.');
      // An assumption follows its consumer, as a check follows its target.
      const consumer = evaluator.resource(fields.get('consumer')!, 'consumer', ['contracts'], false);
      if (disabled.has(`contracts.${consumer.name}`)) return [];
      live('contracts', reference.parts[1]!, reference, 'reference');
      return [{
        consumer: consumer.id,
        location: evaluator.constant(fields.get('location')!, 'location'),
        reference: reference.parts.join('.'),
        reason: evaluator.constant(fields.get('reason')!, 'reason'),
      }];
    });
  }

  // Only variables that value fields still reference become spec values. Those used in conditions, enabled,
  // or constant fields are already folded in, so changing one that no field uses does not change the spec hash.
  const spec: CompiledSpec = {
    schema: 2,
    chainId,
    ...(dependencyMode !== undefined && dependencyMode !== null ? { dependencyMode } : {}),
    values: Object.fromEntries([...evaluator.referenced].sort(byName).map(name => [name, variables.get(name)!.value])),
    externals: Object.fromEntries([...compiled.externals].map(([name, item]) => [name, ordered(item, EXTERNAL_ORDER)])),
    ...(factory ? { factory } : {}),
    contracts: [...compiled.contracts.values()].map(item => ordered(item, CONTRACT_ORDER)),
    calls: [...compiled.calls.values()].map(item => ordered(item, CALL_ORDER)),
    ...(executionAssumptions ? { executionAssumptions } : {}),
  };

  // The unused checks are syntactic: a variable or local that only a disabled resource or an untaken branch uses
  // still counts as used.
  const unused = [...declarations.keys()].filter(name => !usedVariables.has(name));
  assert(unused.length === 0, declarations.get(unused[0]!)?.block, `Unused variables: ${unused.join(', ')}. Remove their variable blocks or reference them as var.<name>.`);
  const unusedLocals = [...locals.keys()].filter(name => !usedLocals.has(name)).sort(byName);
  assert(unusedLocals.length === 0, locals.get(unusedLocals[0]!), `Unused locals: ${unusedLocals.join(', ')}. Remove them or reference them as local.<name>.`);
  return { spec, variables: [...variables.values()].sort((left, right) => byName(left.name, right.name)) };
}

/** compileProject without the variable report. */
export function compileSpec(document: HclDocument, inputs: VariableInputs = {}): CompiledSpec {
  return compileProject(document, inputs).spec;
}

/**
 * Decodes a parsed .ethpconfig document. `commands` maps each command that reads a spec to its CLI options.
 * `resolvePath` resolves configured paths relative to the config file.
 */
export function compileConfig(document: HclDocument, commands: CommandOptions, resolvePath: (value: string) => string): CompiledConfig {
  for (const attribute of document.attributes.values()) {
    assertNotSecret(attribute.name, attribute);
    fail(attribute, `Unknown top-level attribute ${attribute.name}. Set options in a defaults or command "<name>" block.`);
  }
  const options = (block: HclBlock, what: string, accepts: (name: ConfigOptionName) => boolean): ConfigOptions => Object.fromEntries(attributesOf(block.body, what).map(attribute => {
    const { name } = attribute;
    assertNotSecret(name, attribute);
    assert(CONFIG_OPTIONS.includes(name as ConfigOptionName), attribute, `${what} cannot set ${name}. Config can set only ${CONFIG_OPTIONS.join(', ')}.`);
    assert(accepts(name as ConfigOptionName), attribute, what === 'defaults' ? 'defaults cannot set out; set it in a command block.' : `${what} cannot set ${name}; the command has no --${name} option.`);
    const value = literal(attribute.value, name);
    if (name === 'parallel' || name === 'pipeline') {
      assert(typeof value === 'boolean', attribute.value, `${name} must be true or false.`);
      return [name, value];
    }
    if (name === 'deployers') {
      assert(Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && ADDRESS.test(item)), attribute.value, 'deployers must be a nonempty list of addresses.');
      return [name, value.join(',')];
    }
    assert(typeof value === 'string' && value.length > 0, attribute.value, `${name} must be a nonempty string.`);
    if (name === 'owner') assert(ADDRESS.test(value), attribute.value, 'owner must be an address.');
    return [name, CONFIG_PATHS.has(name) && value !== '-' ? resolvePath(value) : value];
  })) as ConfigOptions;

  const config: CompiledConfig = { defaults: {}, commands: {} };
  let defaults: HclBlock | undefined;
  for (const block of document.blocks) {
    if (block.type === 'defaults') {
      assert(block.labels.length === 0, block, 'A defaults block has no labels.');
      assert(!defaults, block, `Duplicate defaults block; the first is on line ${defaults?.at.line}.`);
      defaults = block;
      // out names a plan file for plan and a directory for adapters, so it has no shared default.
      config.defaults = options(block, 'defaults', name => name !== 'out');
    } else if (block.type === 'command') {
      assert(block.labels.length === 1, block, 'A command block needs one label, the command name, for example command "plan".');
      const [name] = block.labels;
      assert(name !== undefined, block, 'A command block needs one label.');
      assert(Object.hasOwn(commands, name), block, `command "${name}" does not read a spec. Use ${Object.keys(commands).join(', ')}.`);
      assert(!Object.hasOwn(config.commands, name), block, `Duplicate command "${name}" block.`);
      config.commands[name] = options(block, `command "${name}"`, option => commands[name]!.includes(option));
    } else {
      fail(block, `Unknown block type ${block.type}. Use defaults or command "<name>".`);
    }
  }
  return config;
}

/** Selects one command's config options: its command block over defaults, omitting false booleans. */
export function configOptions(config: CompiledConfig, command: string, accepted: string[]): ConfigOptions {
  const selected = {
    ...Object.fromEntries(Object.entries(config.defaults).filter(([name]) => accepted.includes(name))),
    ...config.commands[command],
  };
  return Object.fromEntries(Object.entries(selected).filter(([, value]) => value !== false));
}
