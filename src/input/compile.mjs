// Lowers parsed .ethp, .ethpvars, and .ethpconfig documents into the canonical JSON inputs.
// Each error names the file, line, and column of the attribute, block, or value that caused it.
import { fail } from './hcl.mjs';

const ID = /^[a-z][a-zA-Z0-9_]*$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SECRET_KEY = /^(private[_-]?key|secret[_-]?key|mnemonic|seed[_-]?phrase|passphrase)$/i;
const RESOURCE_TYPES = ['contract', 'external', 'call', 'check'];
const KINDS = { contracts: 'contract', externals: 'external', calls: 'call' };

// HCL attribute -> [JSON field, decoder]. Decoders: literal, value (may hold references), target, after.
const CONTRACT_FIELDS = {
  artifact: ['artifact', 'literal'],
  source: ['source', 'literal'],
  name: ['name', 'literal'],
  address: ['address', 'value'],
  salt: ['salt', 'literal'],
  args: ['args', 'value'],
  libraries: ['libraries', 'value'],
  after: ['after', 'after'],
  code_hash: ['codeHash', 'literal'],
  signer_role: ['signerRole', 'literal'],
  sender_independent: ['senderIndependent', 'literal'],
};
const EXTERNAL_FIELDS = {
  address: ['address', 'literal'],
  code_hash: ['codeHash', 'literal'],
  abi: ['abi', 'literal'],
};
const CALL_FIELDS = {
  target: ['target', 'target'],
  method: ['method', 'literal'],
  args: ['args', 'value'],
  after: ['after', 'after'],
  signer_role: ['signerRole', 'literal'],
  owner_only: ['ownerOnly', 'literal'],
  transfers_ownership: ['transfersOwnership', 'literal'],
};
const FACTORY_FIELDS = { address: ['address', 'literal'], code_hash: ['codeHash', 'literal'] };
// JSON field order for readable compile output. Key order does not affect spec hashes.
const CONTRACT_ORDER = ['id', 'artifact', 'source', 'name', 'address', 'salt', 'args', 'libraries', 'checks', 'after', 'codeHash', 'signerRole', 'senderIndependent'];
const EXTERNAL_ORDER = ['address', 'codeHash', 'abi', 'checks'];
const CALL_ORDER = ['id', 'target', 'method', 'args', 'check', 'before', 'after', 'signerRole', 'ownerOnly', 'transfersOwnership'];
const TOP_ATTRIBUTES = new Set(['chain_id', 'dependency_mode', 'execution_assumptions']);
const TOP_BLOCKS = new Set(['resource', 'factory']);
const ASSUMPTION_FIELDS = ['consumer', 'location', 'reference', 'reason'];
const CALL_CHECK_FIELDS = new Set(['target', 'getter', 'args', 'before', 'equals']);
const RESERVED_GETTERS = new Set(['getter', 'args', 'before', 'equals', 'after']);

export const CONFIG_OPTIONS = ['state', 'journal', 'backend', 'out', 'deployers', 'owner', 'parallel', 'pipeline'];
const CONFIG_PATHS = new Set(['state', 'journal', 'backend', 'out']);

function assert(condition, node, message) {
  if (!condition) fail(node, message);
}

function byName(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertNotSecret(name, node) {
  assert(!SECRET_KEY.test(name), node, `${name} is a forbidden signer secret. Keep signer keys in the environment.`);
}

function describe(block) {
  return [block.type, ...block.labels.map(label => `"${label}"`)].join(' ');
}

// Decodes a literal, list, or object node. `reference` lowers each reference node, or rejects it.
function decode(node, reference) {
  if (node.kind === 'literal') return node.value;
  if (node.kind === 'list') return node.items.map(item => decode(item, reference));
  if (node.kind === 'object') return Object.fromEntries(node.entries.map(entry => [entry.key, decode(entry.value, reference)]));
  return reference(node);
}

function literal(node, name) {
  return decode(node, reference => fail(reference, `${name} must be a literal; it cannot reference ${reference.parts.join('.')}.`));
}

// Returns the attributes of a body that must not contain nested blocks, sorted by name.
function attributesOf(body, what) {
  const [block] = body.blocks;
  assert(!block, block, `${what} cannot contain a ${block?.type} block. Set its fields as attributes with =.`);
  return [...body.attributes.values()].sort((left, right) => byName(left.name, right.name));
}

function compileBlock(block, fields, decoders) {
  const what = describe(block);
  const item = {};
  for (const attribute of attributesOf(block.body, what)) {
    const { name } = attribute;
    const snake = name.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
    const hint = snake !== name && Object.hasOwn(fields, snake) ? ` Use ${snake}.`
      : ['checks', 'check', 'before'].includes(name) ? ' Declare checks in resource "check" blocks.' : '';
    assert(Object.hasOwn(fields, name), attribute, `${what} has unknown attribute ${name}.${hint}`);
    const [field, kind] = fields[name];
    item[field] = decoders[kind](attribute.value, name);
  }
  return item;
}

// Folds one check block into the checks map of a contract or external, or into a call's check and before.
function foldCheck(block, target, resources, value) {
  const name = block.labels[1];
  const what = describe(block);
  const attributes = block.body.attributes;
  const fields = attributesOf(block.body, what).filter(attribute => attribute.name !== 'target');
  const get = field => attributes.get(field)?.value;
  if (target.root === 'calls') {
    for (const attribute of fields) {
      assert(CALL_CHECK_FIELDS.has(attribute.name), attribute, `${what} targets a call and has unknown attribute ${attribute.name}. Use getter, args, before, and equals.`);
    }
    assert(['getter', 'before', 'equals'].every(field => attributes.has(field)), block, `${what} targets a call and needs getter, before, and equals.`);
    const call = resources.calls.get(target.name);
    assert(!call.check, block, `${target.id} has more than one check block: ${call.checkBlock} and ${name}.`);
    call.checkBlock = name;
    call.check = {
      function: literal(get('getter'), 'getter'),
      args: attributes.has('args') ? value(get('args'), 'args') : [],
      equals: value(get('equals'), 'equals'),
    };
    call.before = { equals: value(get('before'), 'before') };
    return;
  }
  let getters;
  if (attributes.has('getter')) {
    // The getter form reaches getter names that are reserved here or are not HCL identifiers.
    for (const attribute of fields) assert(['getter', 'equals'].includes(attribute.name), attribute, `${what} uses getter, so it can set only target, getter, and equals.`);
    assert(attributes.has('equals'), block, `${what} needs equals.`);
    const getter = literal(get('getter'), 'getter');
    assert(typeof getter === 'string' && getter.length > 0, get('getter'), 'getter must be a nonempty string.');
    getters = [[getter, get('equals'), get('getter')]];
  } else {
    for (const attribute of fields) {
      assert(!RESERVED_GETTERS.has(attribute.name), attribute, `${what} targets ${target.id}; ${attribute.name} is only for a check that targets a call. Use getter and equals for a getter named ${attribute.name}.`);
      assertNotSecret(attribute.name, attribute);
    }
    getters = fields.map(attribute => [attribute.name, attribute.value, attribute]);
  }
  assert(getters.length > 0, block, `${what} needs at least one getter.`);
  const item = resources[target.root].get(target.name);
  // Null prototypes keep a getter named __proto__ as an ordinary key.
  item.checks ??= Object.create(null);
  item.checkBlocks ??= Object.create(null);
  for (const [getter, node, at] of getters) {
    assert(!Object.hasOwn(item.checks, getter), at, `${target.id} getter ${getter} is checked by both ${item.checkBlocks[getter]} and ${name}.`);
    item.checks[getter] = value(node, getter);
    item.checkBlocks[getter] = name;
  }
}

function ordered(item, order) {
  return Object.fromEntries(order.filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]]));
}

/**
 * Compiles parsed .ethp and optional .ethpvars documents into a schema 2 JSON spec for parseSpec.
 * Resources are sorted by type and ID, so source block order does not affect the spec or its hash.
 */
export function compileSpec(document, variables = null, varsFile = 'spec.ethpvars') {
  for (const attribute of document.attributes.values()) {
    const hint = attribute.name === 'chainId' ? ' Use chain_id.' : TOP_BLOCKS.has(attribute.name) ? ` Declare ${attribute.name} as a block.` : '';
    assert(TOP_ATTRIBUTES.has(attribute.name), attribute, `Unknown top-level attribute ${attribute.name}.${hint}`);
  }
  for (const block of document.blocks) {
    assert(TOP_BLOCKS.has(block.type), block, `Unknown block type ${block.type}.${TOP_ATTRIBUTES.has(block.type) ? ` Set ${block.type} with =.` : ''}`);
  }
  const chain = document.attributes.get('chain_id');
  assert(chain, document, 'The spec needs chain_id.');
  const chainId = literal(chain.value, 'chain_id');
  assert(Number.isSafeInteger(chainId) && chainId > 0, chain.value, 'chain_id must be a positive integer.');
  const values = variables ? compileVariables(variables) : {};
  const used = new Set();

  const blocks = Object.fromEntries(RESOURCE_TYPES.map(type => [type, new Map()]));
  for (const block of document.blocks.filter(item => item.type === 'resource')) {
    assert(block.labels.length === 2, block, 'A resource block needs a type label and a name label, for example resource "contract" "registry".');
    const [type, name] = block.labels;
    assert(RESOURCE_TYPES.includes(type), block, `Unknown resource type ${type}. Use ${RESOURCE_TYPES.join(', ')}.`);
    const first = blocks[type].get(name);
    assert(!first, block, `Duplicate resource "${type}" "${name}"; it is first declared on line ${first?.at.line}.`);
    blocks[type].set(name, block);
  }
  const sorted = type => [...blocks[type]].sort(([left], [right]) => byName(left, right));
  const names = { contracts: blocks.contract, externals: blocks.external, calls: blocks.call };
  const exists = (root, name, node, what) => assert(names[root].has(name), node, `${what} references unknown ${root}.${name}.`);

  const resource = (node, name, roots) => {
    assert(node.kind === 'reference' && node.parts.length === 2 && roots.includes(node.parts[0]), node,
      `${name} must be ${roots.map(root => `${root}.<name>`).join(' or ')}.`);
    exists(node.parts[0], node.parts[1], node, name);
    return { root: node.parts[0], name: node.parts[1], id: `${KINDS[node.parts[0]]}:${node.parts[1]}` };
  };
  const value = (node, name) => decode(node, reference => {
    const [root, target, field] = reference.parts;
    const text = reference.parts.join('.');
    if (root === 'var' && reference.parts.length === 2) {
      assert(Object.hasOwn(values, target), reference, `${name} uses missing variable ${target}. Add it to ${varsFile}.`);
      used.add(target);
      return { ref: `values.${target}` };
    }
    if ((root === 'contracts' || root === 'externals') && reference.parts.length === 3 && field === 'address') {
      exists(root, target, reference, name);
      return { ref: text };
    }
    if ((root === 'contracts' || root === 'externals') && reference.parts.length === 2) {
      fail(reference, `${name} references the resource ${text}. Use ${text}.address for its address, or list it in after for an execution barrier.`);
    }
    fail(reference, `${name} has unsupported reference ${text}. Use var.<name>, contracts.<name>.address, or externals.<name>.address.`);
  });
  const decoders = {
    literal,
    value,
    target: (node, name) => resource(node, name, ['contracts']).name,
    after: (node, name) => {
      assert(node.kind === 'list', node, `${name} must be a list of resources.`);
      return node.items.map(item => resource(item, name, ['contracts', 'externals', 'calls']).id);
    },
  };

  const compiled = {
    contracts: new Map(sorted('contract').map(([name, block]) => [name, { id: name, ...compileBlock(block, CONTRACT_FIELDS, decoders) }])),
    externals: new Map(sorted('external').map(([name, block]) => [name, compileBlock(block, EXTERNAL_FIELDS, decoders)])),
    calls: new Map(sorted('call').map(([name, block]) => [name, { id: name, ...compileBlock(block, CALL_FIELDS, decoders) }])),
  };
  for (const [, block] of sorted('check')) {
    const target = block.body.attributes.get('target');
    assert(target, block, `${describe(block)} needs target.`);
    foldCheck(block, resource(target.value, 'target', ['contracts', 'externals', 'calls']), compiled, value);
  }
  for (const [name, call] of compiled.calls) assert(call.check, blocks.call.get(name), `call:${name} needs one check block with target = calls.${name}.`);
  for (const item of [...compiled.contracts.values(), ...compiled.externals.values()]) {
    if (item.checks) item.checks = Object.fromEntries(Object.entries(item.checks).sort(([left], [right]) => byName(left, right)));
  }

  const factories = document.blocks.filter(block => block.type === 'factory');
  assert(factories.length <= 1, factories[1], `Duplicate factory block; the first is on line ${factories[0]?.at.line}.`);
  assert(!factories[0]?.labels.length, factories[0], 'A factory block has no labels.');
  const mode = document.attributes.get('dependency_mode');
  const spec = {
    schema: 2,
    chainId,
    ...(mode ? { dependencyMode: literal(mode.value, 'dependency_mode') } : {}),
    values,
    externals: Object.fromEntries([...compiled.externals].map(([name, item]) => [name, ordered(item, EXTERNAL_ORDER)])),
    ...(factories.length ? { factory: compileBlock(factories[0], FACTORY_FIELDS, decoders) } : {}),
    contracts: [...compiled.contracts.values()].map(item => ordered(item, CONTRACT_ORDER)),
    calls: [...compiled.calls.values()].map(item => ordered(item, CALL_ORDER)),
  };
  const assumptions = document.attributes.get('execution_assumptions')?.value;
  if (assumptions) {
    assert(assumptions.kind === 'list', assumptions, 'execution_assumptions must be a list of objects.');
    spec.executionAssumptions = assumptions.items.map(item => {
      assert(item.kind === 'object', item, 'Each execution assumption must be an object.');
      const fields = new Map(item.entries.map(entry => [entry.key, entry.value]));
      for (const entry of item.entries) assert(ASSUMPTION_FIELDS.includes(entry.key), entry, `Execution assumption has unknown attribute ${entry.key}.`);
      assert(ASSUMPTION_FIELDS.every(key => fields.has(key)), item, `An execution assumption needs ${ASSUMPTION_FIELDS.join(', ')}.`);
      const reference = fields.get('reference');
      assert(reference.kind === 'reference' && reference.parts.length === 3 && reference.parts[0] === 'contracts' && reference.parts[2] === 'address',
        reference, 'reference must be contracts.<name>.address.');
      exists('contracts', reference.parts[1], reference, 'reference');
      return {
        consumer: resource(fields.get('consumer'), 'consumer', ['contracts']).id,
        location: literal(fields.get('location'), 'location'),
        reference: reference.parts.join('.'),
        reason: literal(fields.get('reason'), 'reason'),
      };
    });
  }
  const unused = Object.keys(values).filter(name => !used.has(name));
  assert(unused.length === 0, variables?.attributes.get(unused[0]), `Unused variables: ${unused.join(', ')}. Remove them or reference them as var.<name>.`);
  return spec;
}

/** Decodes a flat .ethpvars document of literal assignments into spec values. */
export function compileVariables(document) {
  return Object.fromEntries(attributesOf(document, 'A variables file').map(attribute => {
    const { name } = attribute;
    assertNotSecret(name, attribute);
    assert(name !== 'chain_id', attribute, 'chain_id belongs in the .ethp file, not in variables.');
    assert(ID.test(name), attribute, `Variable name ${name} must match ${ID}.`);
    return [name, decode(attribute.value, reference => fail(reference, `Variable ${name} must be a literal; it cannot reference ${reference.parts.join('.')}.`))];
  }));
}

/**
 * Decodes a parsed .ethpconfig document. `commands` maps each command that reads a spec to its CLI options.
 * `resolvePath` resolves configured paths relative to the config file.
 */
export function compileConfig(document, commands, resolvePath) {
  for (const attribute of document.attributes.values()) {
    assertNotSecret(attribute.name, attribute);
    fail(attribute, `Unknown top-level attribute ${attribute.name}. Set options in a defaults or command "<name>" block.`);
  }
  const options = (block, what, accepts) => Object.fromEntries(attributesOf(block.body, what).map(attribute => {
    const { name } = attribute;
    assertNotSecret(name, attribute);
    assert(CONFIG_OPTIONS.includes(name), attribute, `${what} cannot set ${name}. Config can set only ${CONFIG_OPTIONS.join(', ')}.`);
    assert(accepts(name), attribute, what === 'defaults' ? 'defaults cannot set out; set it in a command block.' : `${what} cannot set ${name}; the command has no --${name} option.`);
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
  }));

  const config = { defaults: {}, commands: {} };
  let defaults;
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
      assert(Object.hasOwn(commands, name), block, `command "${name}" does not read a spec. Use ${Object.keys(commands).join(', ')}.`);
      assert(!Object.hasOwn(config.commands, name), block, `Duplicate command "${name}" block.`);
      config.commands[name] = options(block, `command "${name}"`, option => commands[name].includes(option));
    } else {
      fail(block, `Unknown block type ${block.type}. Use defaults or command "<name>".`);
    }
  }
  return config;
}

/** Selects one command's config options: its command block over defaults, omitting false booleans. */
export function configOptions(config, command, accepted) {
  const selected = {
    ...Object.fromEntries(Object.entries(config.defaults).filter(([name]) => accepted.includes(name))),
    ...config.commands[command],
  };
  return Object.fromEntries(Object.entries(selected).filter(([, value]) => value !== false));
}
