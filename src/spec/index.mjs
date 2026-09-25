import { isAddress } from 'viem';

export const DEFAULT_FACTORY = {
  address: '0x4e59b44847b379578588920cA78FbF26c0B4956C',
  codeHash: '0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989',
};

const ID = /^[a-z][a-zA-Z0-9_]*$/;
const ROLE = /^[a-z][a-z0-9_-]*$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const SECRET_KEY = /^(private[_-]?key|secret[_-]?key|mnemonic|seed[_-]?phrase|passphrase)$/i;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function cloneJson(value, location = 'Spec') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => cloneJson(item, `${location}[${index}]`));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      assert(item !== undefined, `${location}.${key} must be a JSON value.`);
      return [key, cloneJson(item, `${location}.${key}`)];
    }));
  }
  throw new Error(`${location} must contain only JSON values.`);
}

function assertKeys(value, allowed, location) {
  for (const key of Object.keys(value)) assert(allowed.has(key), `${location} has unknown field ${key}.`);
}

function assertNoSecrets(value, location = 'Spec') {
  if (Array.isArray(value)) value.forEach((item, index) => assertNoSecrets(item, `${location}[${index}]`));
  else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      assert(!SECRET_KEY.test(key), `${location} has forbidden signer secret field ${key}.`);
      assertNoSecrets(item, `${location}.${key}`);
    }
  }
}

function assertId(value, location) {
  assert(typeof value === 'string' && ID.test(value), `${location} must match ${ID}.`);
}

function assertHash(value, location) {
  assert(typeof value === 'string' && HASH.test(value), `${location} must be a 32-byte hex value.`);
}

function assertAddressOrReference(value, location) {
  assert(isAddress(value) || (isObject(value) && typeof value.ref === 'string' &&
    Object.keys(value).every(key => ['ref', 'requiresLive'].includes(key)) &&
    (value.requiresLive === undefined || typeof value.requiresLive === 'boolean')), `${location} must be an Ethereum address or one reference.`);
}

function assertChecks(value, location) {
  assert(isObject(value), `${location} must be an object.`);
  for (const name of Object.keys(value)) assert(typeof name === 'string' && name.length > 0, `${location} has an invalid function name.`);
}

function assertAfter(value, location) {
  assert(Array.isArray(value), `${location} must be an array.`);
  for (const dependency of value) {
    assert(typeof dependency === 'string' && /^(contract|external|call):[a-z][a-zA-Z0-9_]*$/.test(dependency), `${location} contains invalid dependency ${String(dependency)}.`);
  }
}

function collectReferences(value, into = new Set(), location = 'value') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectReferences(item, into, `${location}[${index}]`));
  } else if (isObject(value)) {
    if (Object.hasOwn(value, 'ref')) {
      assert(typeof value.ref === 'string' && Object.keys(value).every(key => ['ref', 'requiresLive'].includes(key)) &&
        (value.requiresLive === undefined || typeof value.requiresLive === 'boolean'), `${location} must use a reference object with ref and optional boolean requiresLive.`);
      into.add(value.ref);
    } else {
      for (const [key, item] of Object.entries(value)) collectReferences(item, into, `${location}.${key}`);
    }
  }
  return into;
}

function referenceDetails(value, location, into = []) {
  if (Array.isArray(value)) value.forEach((item, index) => referenceDetails(item, `${location}[${index}]`, into));
  else if (isObject(value)) {
    if (Object.hasOwn(value, 'ref')) {
      collectReferences(value, new Set(), location);
      into.push({ reference: value.ref, requiresLive: value.requiresLive === true, location });
    } else for (const [key, item] of Object.entries(value)) referenceDetails(item, `${location}.${key}`, into);
  }
  return into;
}

export function dependencyMode(spec) {
  return spec.dependencyMode ?? (spec.schema === 2 ? 'split' : 'compatibility');
}

export function usesDependencyPlan(spec) {
  return spec.schema === 2 || spec.dependencyMode !== undefined || spec.executionAssumptions !== undefined;
}

function validateReferences(spec) {
  for (const [name, value] of Object.entries(spec.values)) {
    assert(collectReferences(value).size === 0, `Value ${name} must be literal and cannot contain references.`);
  }

  const contractIds = new Set(spec.contracts.map(item => item.id));
  const externalIds = new Set(Object.keys(spec.externals));
  const candidates = [];
  for (const item of spec.contracts) candidates.push([`contract:${item.id}`, [item.address, item.args, item.libraries, item.checks]]);
  for (const [name, item] of Object.entries(spec.externals)) candidates.push([`external:${name}`, [item.checks]]);
  for (const item of spec.calls) candidates.push([`call:${item.id}`, [item.args, item.check, item.before]]);

  for (const [owner, values] of candidates) {
    for (const { reference, requiresLive } of referenceDetails(values, owner)) {
      const parts = reference.split('.');
      if (parts[0] === 'values') {
        assert(!requiresLive, `${owner} cannot use requiresLive on value ${reference}.`);
        assert(parts.length === 2, `${owner} has invalid reference ${reference}.`);
        assert(Object.hasOwn(spec.values, parts[1]), `Missing value ${parts[1]} for ${owner}.`);
      } else if (parts[0] === 'externals') {
        assert(parts.length === 3 && parts[2] === 'address', `${owner} has invalid reference ${reference}.`);
        assert(externalIds.has(parts[1]), `Missing graph node external:${parts[1]} for ${owner}.`);
      } else if (parts[0] === 'contracts') {
        assert(parts.length === 3 && parts[2] === 'address', `${owner} has invalid reference ${reference}.`);
        assert(contractIds.has(parts[1]), `Missing graph node contract:${parts[1]} for ${owner}.`);
      } else {
        throw new Error(`${owner} has unknown reference ${reference}.`);
      }
    }
  }
}

export function parseSpec(raw) {
  const spec = cloneJson(raw);
  assert(isObject(spec), 'Spec must be an object.');
  assertNoSecrets(spec);
  assertKeys(spec, new Set(['schema', 'chainId', 'values', 'externals', 'factory', 'contracts', 'calls', 'dependencyMode', 'executionAssumptions']), 'Spec');
  assert(spec.schema === 1 || spec.schema === 2, 'Spec must have schema: 1 or 2.');
  assert(spec.dependencyMode === undefined || ['split', 'compatibility'].includes(spec.dependencyMode), 'Spec dependencyMode must be split or compatibility.');
  if (spec.executionAssumptions !== undefined) {
    assert(Array.isArray(spec.executionAssumptions) && spec.executionAssumptions.every(value => typeof value === 'string' && value.trim().length > 0), 'Spec executionAssumptions must be nonempty strings.');
  }
  assert(Number.isSafeInteger(spec.chainId) && spec.chainId > 0, 'Spec needs a positive numeric chainId.');
  assert(Array.isArray(spec.contracts) && spec.contracts.length > 0, 'Spec needs a nonempty contracts array.');
  spec.values ??= {};
  spec.externals ??= {};
  spec.calls ??= [];
  assert(isObject(spec.values), 'Spec values must be an object.');
  assert(isObject(spec.externals), 'Spec externals must be an object.');
  assert(Array.isArray(spec.calls), 'Spec calls must be an array.');

  for (const name of Object.keys(spec.values)) assertId(name, `Value name ${name}`);
  for (const [name, external] of Object.entries(spec.externals)) {
    assertId(name, `External name ${name}`);
    assert(isObject(external), `External ${name} must be an object.`);
    assertKeys(external, new Set(['address', 'codeHash', 'checks', 'abi']), `External ${name}`);
    assert(isAddress(external.address), `External ${name} needs an address.`);
    if (external.codeHash !== undefined) assertHash(external.codeHash, `External ${name} codeHash`);
    if (external.checks !== undefined) assertChecks(external.checks, `External ${name} checks`);
    if (external.abi !== undefined) assert(Array.isArray(external.abi), `External ${name} abi must be an array.`);
  }

  const ids = new Set();
  for (const item of spec.contracts) {
    assert(isObject(item), 'Every contract must be an object.');
    assertKeys(item, new Set(['id', 'artifact', 'source', 'name', 'address', 'salt', 'args', 'libraries', 'checks', 'after', 'codeHash', 'signerRole', 'senderIndependent']), `Contract ${item.id ?? '<unknown>'}`);
    assertId(item.id, 'Contract ID');
    const fullId = `contract:${item.id}`;
    assert(!ids.has(fullId), `Duplicate ${fullId}.`);
    ids.add(fullId);
    assert(typeof item.artifact === 'string' && item.artifact.endsWith('.json'), `${fullId} needs a JSON artifact path.`);
    if (item.source !== undefined) assert(typeof item.source === 'string' && item.source.length > 0, `${fullId} source must be a nonempty string.`);
    if (item.name !== undefined) assert(typeof item.name === 'string' && item.name.length > 0, `${fullId} name must be a nonempty string.`);
    assert((item.address === undefined) !== (item.salt === undefined), `${fullId} needs exactly one of address or salt.`);
    if (item.address !== undefined) assertAddressOrReference(item.address, `${fullId} address`);
    if (item.salt !== undefined) assertHash(item.salt, `${fullId} salt`);
    if (item.salt !== undefined) assert(Array.isArray(item.args), `${fullId} needs args for deployment.`);
    if (item.args !== undefined) assert(Array.isArray(item.args), `${fullId} args must be an array.`);
    if (item.libraries !== undefined) assert(isObject(item.libraries), `${fullId} libraries must be an object.`);
    if (item.checks !== undefined) assertChecks(item.checks, `${fullId} checks`);
    if (item.after !== undefined) assertAfter(item.after, `${fullId} after`);
    if (item.codeHash !== undefined) assertHash(item.codeHash, `${fullId} codeHash`);
    if (item.signerRole !== undefined) assert(typeof item.signerRole === 'string' && ROLE.test(item.signerRole), `${fullId} signerRole is invalid.`);
    if (item.senderIndependent !== undefined) assert(typeof item.senderIndependent === 'boolean', `${fullId} senderIndependent must be boolean.`);
  }

  for (const item of spec.calls) {
    assert(isObject(item), 'Every call must be an object.');
    assertKeys(item, new Set(['id', 'target', 'method', 'args', 'check', 'before', 'after', 'signerRole', 'ownerOnly', 'transfersOwnership']), `Call ${item.id ?? '<unknown>'}`);
    assertId(item.id, 'Call ID');
    const fullId = `call:${item.id}`;
    assert(!ids.has(fullId), `Duplicate ${fullId}.`);
    ids.add(fullId);
    assert(typeof item.target === 'string' && ID.test(item.target), `${fullId} needs a valid target contract ID.`);
    assert(typeof item.method === 'string' && item.method.length > 0, `${fullId} needs a method.`);
    assert(Array.isArray(item.args), `${fullId} needs args.`);
    assert(isObject(item.check), `${fullId} needs a check predicate.`);
    assertKeys(item.check, new Set(['function', 'args', 'equals']), `${fullId} check`);
    assert(typeof item.check.function === 'string' && item.check.function.length > 0 && Object.hasOwn(item.check, 'equals'), `${fullId} needs check.function and check.equals.`);
    item.check.args ??= [];
    assert(Array.isArray(item.check.args), `${fullId} check.args must be an array.`);
    assert(isObject(item.before), `${fullId} needs a before predicate.`);
    assertKeys(item.before, new Set(['equals']), `${fullId} before`);
    assert(Object.hasOwn(item.before, 'equals'), `${fullId} needs before.equals.`);
    if (item.after !== undefined) assertAfter(item.after, `${fullId} after`);
    if (item.signerRole !== undefined) assert(typeof item.signerRole === 'string' && ROLE.test(item.signerRole), `${fullId} signerRole is invalid.`);
    if (item.ownerOnly !== undefined) assert(typeof item.ownerOnly === 'boolean', `${fullId} ownerOnly must be boolean.`);
    if (item.transfersOwnership !== undefined) assert(typeof item.transfersOwnership === 'boolean', `${fullId} transfersOwnership must be boolean.`);
  }

  if (spec.contracts.some(item => item.salt !== undefined)) {
    spec.factory ??= cloneJson(DEFAULT_FACTORY);
    assert(isObject(spec.factory), 'Factory must be an object.');
    assertKeys(spec.factory, new Set(['address', 'codeHash']), 'Factory');
    assert(isAddress(spec.factory.address), 'Factory needs an address.');
    assertHash(spec.factory.codeHash, 'Factory codeHash');
  } else {
    assert(spec.factory === undefined, 'Factory is allowed only when a contract uses CREATE2.');
  }

  validateReferences(spec);
  return spec;
}

function references(value) {
  return collectReferences(value);
}

function orderGraph(nodes, field, label) {
  const visited = new Set();
  const visiting = new Set();
  const ordered = [];
  function visit(id) {
    assert(nodes.has(id), label === 'Dependency' ? `Missing graph node ${id}.` : `Missing ${label.toLowerCase()} resource ${id}.`);
    if (visited.has(id)) return;
    assert(!visiting.has(id), `${label} cycle at ${id}.`);
    visiting.add(id);
    for (const dependency of nodes.get(id)[field]) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    ordered.push(nodes.get(id));
  }
  for (const id of nodes.keys()) visit(id);
  return ordered;
}

function addEdge(edges, dependency, reason) {
  if (!edges.has(dependency)) edges.set(dependency, new Set());
  edges.get(dependency).add(reason);
}

function edgeList(edges) {
  return [...edges].sort(([left], [right]) => left.localeCompare(right))
    .map(([id, reasons]) => ({ id, reasons: [...reasons].sort() }));
}

export function graph(spec) {
  const mode = dependencyMode(spec);
  const nodes = new Map();
  for (const [name, item] of Object.entries(spec.externals)) nodes.set(`external:${name}`, { id: `external:${name}`, kind: 'external', type: 'external', item });
  for (const item of spec.contracts) nodes.set(`contract:${item.id}`, { id: `contract:${item.id}`, kind: 'contract', type: 'contract', item });
  for (const item of spec.calls) nodes.set(`call:${item.id}`, { id: `call:${item.id}`, kind: 'call', type: 'call', item });

  for (const node of nodes.values()) {
    const resolution = new Map();
    const execution = new Map();
    const fields = node.kind === 'contract'
      ? [['address', node.item.address], ['args', node.item.args], ['libraries', node.item.libraries], ['checks', node.item.checks]]
      : node.kind === 'external' ? [['checks', node.item.checks]]
        : [['args', node.item.args], ['check', node.item.check], ['before', node.item.before]];
    for (const [field, value] of fields) {
      for (const { reference, requiresLive, location } of referenceDetails(value, field)) {
        const [root, name] = reference.split('.');
        if (root === 'values') continue;
        const dependency = `${root === 'contracts' ? 'contract' : 'external'}:${name}`;
        addEdge(resolution, dependency, `${location} needs ${reference}`);
        if (mode === 'compatibility') addEdge(execution, dependency, `compatibility reference ${reference}`);
        else if (requiresLive) addEdge(execution, dependency, `requiresLive ${reference}`);
        else if (root === 'externals' && node.kind !== 'external') addEdge(execution, dependency, `external verification ${reference}`);
      }
    }
    if (node.kind === 'call') {
      const target = `contract:${node.item.target}`;
      addEdge(resolution, target, 'call target address');
      addEdge(execution, target, 'live call target');
    }
    for (const dependency of node.item.after ?? []) addEdge(execution, dependency, 'explicit after');
    if (node.kind === 'call' && (node.item.transfersOwnership || node.item.method === 'transferOwnership')) {
      for (const other of spec.calls) {
        if (other.id !== node.item.id && other.target === node.item.target && other.ownerOnly) {
          addEdge(execution, `call:${other.id}`, 'owner-only configuration before ownership transfer');
        }
      }
    }
    node.resolutionEdges = edgeList(resolution);
    node.executionEdges = edgeList(execution);
    node.resolutionDependencies = node.resolutionEdges.map(edge => edge.id);
    node.executionDependencies = node.executionEdges.map(edge => edge.id);
    node.dependencies = node.executionDependencies;
    node.deps = node.dependencies;
  }

  const label = mode === 'compatibility' && spec.schema === 1 ? 'Dependency' : 'Resolution dependency';
  const resolutionOrder = orderGraph(nodes, 'resolutionDependencies', label);
  const executionSorted = orderGraph(nodes, 'executionDependencies', label === 'Dependency' ? label : 'Execution dependency');
  return mode === 'compatibility' ? executionSorted : resolutionOrder;
}

export function dependencyGraphs(ordered) {
  return {
    resolution: ordered.map(node => ({ id: node.id, needs: node.resolutionEdges })),
    execution: ordered.map(node => ({ id: node.id, after: node.executionEdges })),
  };
}

export function executionOrder(ordered) {
  return orderGraph(new Map(ordered.map(node => [node.id, node])), 'executionDependencies', 'Execution dependency');
}

// An assumption covers a contract only when it names the whole ID, so contracts.portalV2 does not cover contracts.portal.
function assumed(assumptions, name) {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_.])contracts\\.${name}(?![A-Za-z0-9_])`);
  return assumptions.some(text => pattern.test(text));
}

export function dependencyWarnings(spec, ordered) {
  if (dependencyMode(spec) !== 'split') return [];
  const assumptions = spec.executionAssumptions ?? [];
  const warnings = [];
  for (const node of ordered) {
    if (node.kind !== 'contract') continue;
    // Creation code can call a constructor argument or a linked library, so both need an edge or an assumption.
    const creationReferences = [
      ...referenceDetails(node.item.args, 'args').map(detail => ({ ...detail, text: 'constructor references' })),
      ...referenceDetails(node.item.libraries, 'libraries').map(detail => ({ ...detail, text: 'links library' })),
    ].filter(({ reference }) => reference.startsWith('contracts.'));
    for (const { reference, text } of creationReferences) {
      const name = reference.split('.')[1];
      if (!node.executionDependencies.includes(`contract:${name}`) && !assumed(assumptions, name)) {
        warnings.push(`${node.id} ${text} ${reference} without an execution dependency; confirm its constructor does not call the referenced contract.`);
      }
    }
  }
  return [...new Set(warnings)].sort();
}

export function impact(spec, ordered, reference) {
  assert(/^values\.[a-z][a-zA-Z0-9_]*$/.test(reference), 'Impact source must be values.<name>.');
  assert(Object.hasOwn(spec.values, reference.slice(7)), `Missing ${reference}.`);
  const affected = new Set();
  for (const node of ordered) {
    const inputs = node.kind === 'contract'
      ? [node.item.address, node.item.args, node.item.libraries, node.item.checks]
      : node.kind === 'external' ? [node.item.checks] : [node.item.args, node.item.check, node.item.before];
    if (references(inputs).has(reference) || node.resolutionDependencies.some(dependency => affected.has(dependency))) affected.add(node.id);
  }
  return ordered.filter(node => affected.has(node.id)).map(node => node.id);
}

export function resolve(value, spec, addresses) {
  if (Array.isArray(value)) return value.map(item => resolve(item, spec, addresses));
  if (isObject(value)) {
    if (Object.hasOwn(value, 'ref')) {
      assert(typeof value.ref === 'string' && Object.keys(value).every(key => ['ref', 'requiresLive'].includes(key)) &&
        (value.requiresLive === undefined || typeof value.requiresLive === 'boolean'), 'A reference object needs ref and optional boolean requiresLive.');
      const [root, name, field] = value.ref.split('.');
      if (root === 'values' && field === undefined) {
        assert(Object.hasOwn(spec.values, name), `Missing value ${name}.`);
        return cloneJson(spec.values[name]);
      }
      if (root === 'externals' && field === 'address') {
        assert(spec.externals[name], `Missing external ${name}.`);
        return spec.externals[name].address;
      }
      if (root === 'contracts' && field === 'address') {
        assert(addresses[name], `Contract ${name} has no resolved address.`);
        return addresses[name];
      }
      throw new Error(`Invalid reference ${value.ref}.`);
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, spec, addresses)]));
  }
  return value;
}
