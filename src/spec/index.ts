import { isAddress } from 'viem';
import type { ContractId, DistributiveOmit, Hash, JsonValue, ResourceId } from '../types.ts';
import type { DependencyEdge, DependencyGraphs, DependencyMode, Factory, OrderedNode, ParsedSpec, ResolvedAddresses, SpecContract, SpecValue } from './types.ts';

export const DEFAULT_FACTORY: Factory = {
  address: '0x4e59b44847b379578588920cA78FbF26c0B4956C',
  codeHash: '0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989',
};

const ID = /^[a-z][a-zA-Z0-9_]*$/;
const ROLE = /^[a-z][a-z0-9_-]*$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const SECRET_KEY = /^(private[_-]?key|secret[_-]?key|mnemonic|seed[_-]?phrase|passphrase)$/i;

/** A reference found in a spec value, and where it sits. */
interface ReferenceDetail {
  reference: string;
  requiresLive: boolean;
  location: string;
}

/** A graph node before its edges are computed. */
type NodeDraft = DistributiveOmit<OrderedNode, 'resolutionEdges' | 'executionEdges' | 'resolutionDependencies' | 'executionDependencies' | 'dependencies' | 'deps'>;

type DependencyField = 'resolutionDependencies' | 'executionDependencies';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function cloneJson(value: unknown, location = 'Spec'): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => cloneJson(item, `${location}[${index}]`));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]): [string, JsonValue] => {
      assert(item !== undefined, `${location}.${key} must be a JSON value.`);
      return [key, cloneJson(item, `${location}.${key}`)];
    }));
  }
  throw new Error(`${location} must contain only JSON values.`);
}

function assertKeys(value: object, allowed: Set<string>, location: string): void {
  for (const key of Object.keys(value)) assert(allowed.has(key), `${location} has unknown field ${key}.`);
}

function assertNoSecrets(value: unknown, location = 'Spec'): void {
  if (Array.isArray(value)) value.forEach((item, index) => assertNoSecrets(item, `${location}[${index}]`));
  else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      assert(!SECRET_KEY.test(key), `${location} has forbidden signer secret field ${key}.`);
      assertNoSecrets(item, `${location}.${key}`);
    }
  }
}

function assertId(value: unknown, location: string): asserts value is string {
  assert(typeof value === 'string' && ID.test(value), `${location} must match ${ID}.`);
}

function assertHash(value: unknown, location: string): asserts value is Hash {
  assert(typeof value === 'string' && HASH.test(value), `${location} must be a 32-byte hex value.`);
}

function assertAddressOrReference(value: unknown, location: string): void {
  assert((typeof value === 'string' && isAddress(value)) || (isObject(value) && typeof value.ref === 'string' &&
    Object.keys(value).every(key => ['ref', 'requiresLive'].includes(key)) &&
    (value.requiresLive === undefined || typeof value.requiresLive === 'boolean')), `${location} must be an Ethereum address or one reference.`);
}

function assertChecks(value: unknown, location: string): void {
  assert(isObject(value), `${location} must be an object.`);
  for (const name of Object.keys(value)) assert(typeof name === 'string' && name.length > 0, `${location} has an invalid function name.`);
}

function assertAfter(value: unknown, location: string): void {
  assert(Array.isArray(value), `${location} must be an array.`);
  for (const dependency of value as unknown[]) {
    assert(typeof dependency === 'string' && /^(contract|external|call):[a-z][a-zA-Z0-9_]*$/.test(dependency), `${location} contains invalid dependency ${String(dependency)}.`);
  }
}

/** Validates a `{ ref, requiresLive? }` object and reads it. */
function referenceIn(value: Record<string, unknown>, location: string): { ref: string; requiresLive: boolean } {
  const { ref, requiresLive } = value;
  assert(typeof ref === 'string' && Object.keys(value).every(key => ['ref', 'requiresLive'].includes(key)) &&
    (requiresLive === undefined || typeof requiresLive === 'boolean'), `${location} must use a reference object with ref and optional boolean requiresLive.`);
  return { ref, requiresLive: requiresLive === true };
}

function collectReferences(value: unknown, into = new Set<string>(), location = 'value'): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectReferences(item, into, `${location}[${index}]`));
  } else if (isObject(value)) {
    if (Object.hasOwn(value, 'ref')) into.add(referenceIn(value, location).ref);
    else for (const [key, item] of Object.entries(value)) collectReferences(item, into, `${location}.${key}`);
  }
  return into;
}

function referenceDetails(value: unknown, location: string, into: ReferenceDetail[] = []): ReferenceDetail[] {
  if (Array.isArray(value)) value.forEach((item, index) => referenceDetails(item, `${location}[${index}]`, into));
  else if (isObject(value)) {
    if (Object.hasOwn(value, 'ref')) {
      const { ref, requiresLive } = referenceIn(value, location);
      into.push({ reference: ref, requiresLive, location });
    } else for (const [key, item] of Object.entries(value)) referenceDetails(item, `${location}.${key}`, into);
  }
  return into;
}

export function dependencyMode(spec: ParsedSpec): DependencyMode {
  return spec.dependencyMode ?? (spec.schema === 2 ? 'split' : 'compatibility');
}

export function usesDependencyPlan(spec: ParsedSpec): boolean {
  return spec.schema === 2 || spec.dependencyMode !== undefined || spec.executionAssumptions !== undefined;
}

function validateReferences(spec: ParsedSpec): void {
  for (const [name, value] of Object.entries(spec.values)) {
    assert(collectReferences(value).size === 0, `Value ${name} must be literal and cannot contain references.`);
  }

  const contractIds = new Set(spec.contracts.map(item => item.id));
  const externalIds = new Set(Object.keys(spec.externals));
  const candidates: [string, unknown[]][] = [];
  for (const item of spec.contracts) candidates.push([`contract:${item.id}`, [item.address, item.args, item.libraries, item.checks]]);
  for (const [name, item] of Object.entries(spec.externals)) candidates.push([`external:${name}`, [item.checks]]);
  for (const item of spec.calls) candidates.push([`call:${item.id}`, [item.args, item.check, item.before]]);

  for (const [owner, values] of candidates) {
    for (const { reference, requiresLive } of referenceDetails(values, owner)) {
      const parts = reference.split('.');
      const [root, name] = parts;
      if (root === 'values') {
        assert(!requiresLive, `${owner} cannot use requiresLive on value ${reference}.`);
        assert(parts.length === 2 && name !== undefined, `${owner} has invalid reference ${reference}.`);
        assert(Object.hasOwn(spec.values, name), `Missing value ${name} for ${owner}.`);
      } else if (root === 'externals') {
        assert(parts.length === 3 && parts[2] === 'address' && name !== undefined, `${owner} has invalid reference ${reference}.`);
        assert(externalIds.has(name), `Missing graph node external:${name} for ${owner}.`);
      } else if (root === 'contracts') {
        assert(parts.length === 3 && parts[2] === 'address' && name !== undefined, `${owner} has invalid reference ${reference}.`);
        assert(contractIds.has(name), `Missing graph node contract:${name} for ${owner}.`);
      } else {
        throw new Error(`${owner} has unknown reference ${reference}.`);
      }
    }
  }
}

function creationReferences(item: SpecContract): (ReferenceDetail & { text: string })[] {
  return [
    ...referenceDetails(item.args, 'args').map(detail => ({ ...detail, text: 'constructor references' })),
    ...referenceDetails(item.libraries, 'libraries').map(detail => ({ ...detail, text: 'links library' })),
  ].filter(({ reference }) => reference.startsWith('contracts.'));
}

function validateAssumptions(contracts: SpecContract[], assumptions: unknown[]): void {
  const byId = new Map(contracts.map((item): [string, SpecContract] => [`contract:${item.id}`, item]));
  const seen = new Set<string>();
  for (const assumption of assumptions) {
    assert(isObject(assumption), 'Spec executionAssumptions must contain objects.');
    assertKeys(assumption, new Set(['consumer', 'location', 'reference', 'reason']), 'Execution assumption');
    const consumer = typeof assumption.consumer === 'string' ? byId.get(assumption.consumer) : undefined;
    assert(consumer !== undefined, `Execution assumption has unknown consumer ${String(assumption.consumer)}.`);
    assert(typeof assumption.location === 'string' && typeof assumption.reference === 'string' &&
      creationReferences(consumer).some(detail => detail.location === assumption.location && detail.reference === assumption.reference),
    `Execution assumption for ${assumption.consumer} must identify a real constructor or library reference and location.`);
    assert(typeof assumption.reason === 'string' && assumption.reason.trim().length > 0, 'Execution assumption needs a nonempty reason.');
    const key = `${assumption.consumer}\u0000${assumption.location}\u0000${assumption.reference}`;
    assert(!seen.has(key), `Duplicate execution assumption for ${assumption.consumer} ${assumption.location}.`);
    seen.add(key);
  }
}

export function parseSpec(raw: unknown): ParsedSpec {
  const spec = cloneJson(raw);
  assert(isObject(spec), 'Spec must be an object.');
  assertNoSecrets(spec);
  assertKeys(spec, new Set(['schema', 'chainId', 'values', 'externals', 'factory', 'contracts', 'calls', 'dependencyMode', 'executionAssumptions']), 'Spec');
  assert(spec.schema === 1 || spec.schema === 2, 'Spec must have schema: 1 or 2.');
  assert(spec.dependencyMode === undefined || (typeof spec.dependencyMode === 'string' && ['split', 'compatibility'].includes(spec.dependencyMode)), 'Spec dependencyMode must be split or compatibility.');
  if (spec.executionAssumptions !== undefined) {
    assert(Array.isArray(spec.executionAssumptions), 'Spec executionAssumptions must be an array.');
  }
  assert(typeof spec.chainId === 'number' && Number.isSafeInteger(spec.chainId) && spec.chainId > 0, 'Spec needs a positive numeric chainId.');
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
    assert(typeof external.address === 'string' && isAddress(external.address), `External ${name} needs an address.`);
    if (external.codeHash !== undefined) assertHash(external.codeHash, `External ${name} codeHash`);
    if (external.checks !== undefined) assertChecks(external.checks, `External ${name} checks`);
    if (external.abi !== undefined) assert(Array.isArray(external.abi), `External ${name} abi must be an array.`);
  }

  const ids = new Set<string>();
  for (const item of spec.contracts) {
    assert(isObject(item), 'Every contract must be an object.');
    assertKeys(item, new Set(['id', 'artifact', 'source', 'name', 'address', 'salt', 'args', 'libraries', 'checks', 'after', 'codeHash', 'creationProofMode', 'createdCode', 'signerRole', 'senderIndependent']), `Contract ${item.id ?? '<unknown>'}`);
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
    assert(item.creationProofMode === undefined || item.creationProofMode === 'pinned-runtime', `${fullId} creationProofMode must be pinned-runtime.`);
    if (item.creationProofMode === 'pinned-runtime') {
      assert(item.salt !== undefined && item.address === undefined, `${fullId} pinned-runtime requires a CREATE2 deployment.`);
      assert(item.codeHash !== undefined, `${fullId} pinned-runtime requires a parent codeHash.`);
      assert(Array.isArray(item.createdCode) && item.createdCode.length > 0, `${fullId} pinned-runtime requires createdCode.`);
    } else assert(item.createdCode === undefined, `${fullId} createdCode requires pinned-runtime mode.`);
    if (item.createdCode !== undefined) {
      assert(Array.isArray(item.createdCode), `${fullId} createdCode must be an array.`);
      const getters = new Set<string>();
      const nonces = new Set<number>();
      for (const child of item.createdCode) {
        assert(isObject(child), `${fullId} createdCode entry must be an object.`);
        assertKeys(child, new Set(['getter', 'createNonce', 'codeHash']), `${fullId} createdCode entry`);
        assert(typeof child.getter === 'string' && child.getter.length > 0, `${fullId} createdCode getter is invalid.`);
        assert(typeof child.createNonce === 'number' && Number.isSafeInteger(child.createNonce) && child.createNonce > 0, `${fullId} createdCode createNonce must be a positive safe integer.`);
        assertHash(child.codeHash, `${fullId} createdCode codeHash`);
        assert(!getters.has(child.getter) && !nonces.has(child.createNonce), `${fullId} createdCode has a duplicate getter or CREATE nonce.`);
        getters.add(child.getter);
        nonces.add(child.createNonce);
      }
    }
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

  if (spec.contracts.some(item => isObject(item) && item.salt !== undefined)) {
    spec.factory ??= cloneJson(DEFAULT_FACTORY);
    assert(isObject(spec.factory), 'Factory must be an object.');
    assertKeys(spec.factory, new Set(['address', 'codeHash']), 'Factory');
    assert(typeof spec.factory.address === 'string' && isAddress(spec.factory.address), 'Factory needs an address.');
    assertHash(spec.factory.codeHash, 'Factory codeHash');
    assert(!spec.contracts.some(item => isObject(item) && item.creationProofMode === 'pinned-runtime') ||
      (spec.factory.address.toLowerCase() === DEFAULT_FACTORY.address.toLowerCase() && spec.factory.codeHash.toLowerCase() === DEFAULT_FACTORY.codeHash.toLowerCase()),
    'Pinned-runtime requires the bundled atomic CREATE2 factory.');
  } else {
    assert(spec.factory === undefined, 'Factory is allowed only when a contract uses CREATE2.');
  }

  // The checks above are the runtime half of ParsedSpec; the reference and assumption checks need the typed shape.
  const parsed = spec as unknown as ParsedSpec;
  validateReferences(parsed);
  validateAssumptions(parsed.contracts, parsed.executionAssumptions ?? []);
  return parsed;
}

function references(value: unknown): Set<string> {
  return collectReferences(value);
}

function orderGraph(nodes: Map<ResourceId, OrderedNode>, field: DependencyField, label: string): OrderedNode[] {
  const visited = new Set<ResourceId>();
  const visiting = new Set<ResourceId>();
  const ordered: OrderedNode[] = [];
  function visit(id: ResourceId): void {
    const node = nodes.get(id);
    assert(node !== undefined, label === 'Dependency' ? `Missing graph node ${id}.` : `Missing ${label.toLowerCase()} resource ${id}.`);
    if (visited.has(id)) return;
    assert(!visiting.has(id), `${label} cycle at ${id}.`);
    visiting.add(id);
    for (const dependency of node[field]) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    ordered.push(node);
  }
  for (const id of nodes.keys()) visit(id);
  return ordered;
}

function addEdge(edges: Map<ResourceId, Set<string>>, dependency: ResourceId, reason: string): void {
  const reasons = edges.get(dependency);
  if (reasons) reasons.add(reason);
  else edges.set(dependency, new Set([reason]));
}

function edgeList(edges: Map<ResourceId, Set<string>>): DependencyEdge[] {
  return [...edges].sort(([left], [right]) => left.localeCompare(right))
    .map(([id, reasons]) => ({ id, reasons: [...reasons].sort() }));
}

export function graph(spec: ParsedSpec): OrderedNode[] {
  const mode = dependencyMode(spec);
  const drafts: NodeDraft[] = [];
  for (const [name, item] of Object.entries(spec.externals)) drafts.push({ id: `external:${name}`, kind: 'external', type: 'external', item });
  for (const item of spec.contracts) drafts.push({ id: `contract:${item.id}`, kind: 'contract', type: 'contract', item });
  for (const item of spec.calls) drafts.push({ id: `call:${item.id}`, kind: 'call', type: 'call', item });

  const nodes = new Map<ResourceId, OrderedNode>();
  for (const node of drafts) {
    const resolution = new Map<ResourceId, Set<string>>();
    const execution = new Map<ResourceId, Set<string>>();
    const fields: [string, unknown][] = node.kind === 'contract'
      ? [['address', node.item.address], ['args', node.item.args], ['libraries', node.item.libraries], ['checks', node.item.checks]]
      : node.kind === 'external' ? [['checks', node.item.checks]]
        : [['args', node.item.args], ['check', node.item.check], ['before', node.item.before]];
    for (const [field, value] of fields) {
      for (const { reference, requiresLive, location } of referenceDetails(value, field)) {
        const [root, name] = reference.split('.');
        if (root === 'values') continue;
        const dependency: ResourceId = `${root === 'contracts' ? 'contract' : 'external'}:${name}`;
        addEdge(resolution, dependency, `${location} needs ${reference}`);
        if (mode === 'compatibility') addEdge(execution, dependency, `compatibility reference ${reference}`);
        else if (requiresLive) addEdge(execution, dependency, `requiresLive ${reference}`);
        else if (root === 'externals' && node.kind !== 'external') addEdge(execution, dependency, `external verification ${reference}`);
      }
    }
    if (node.kind === 'call') {
      const target: ContractId = `contract:${node.item.target}`;
      addEdge(resolution, target, 'call target address');
      addEdge(execution, target, 'live call target');
    }
    const after = node.kind === 'external' ? undefined : node.item.after;
    for (const dependency of after ?? []) addEdge(execution, dependency, 'explicit after');
    if (node.kind === 'call' && (node.item.transfersOwnership || node.item.method === 'transferOwnership')) {
      for (const other of spec.calls) {
        if (other.id !== node.item.id && other.target === node.item.target && other.ownerOnly) {
          addEdge(execution, `call:${other.id}`, 'owner-only configuration before ownership transfer');
        }
      }
    }
    const resolutionEdges = edgeList(resolution);
    const executionEdges = edgeList(execution);
    const resolutionDependencies = resolutionEdges.map(edge => edge.id);
    const executionDependencies = executionEdges.map(edge => edge.id);
    nodes.set(node.id, { ...node, resolutionEdges, executionEdges, resolutionDependencies, executionDependencies, dependencies: executionDependencies, deps: executionDependencies });
  }

  const label = mode === 'compatibility' && spec.schema === 1 ? 'Dependency' : 'Resolution dependency';
  const resolutionOrder = orderGraph(nodes, 'resolutionDependencies', label);
  const executionSorted = orderGraph(nodes, 'executionDependencies', label === 'Dependency' ? label : 'Execution dependency');
  return mode === 'compatibility' ? executionSorted : resolutionOrder;
}

export function dependencyGraphs(ordered: OrderedNode[]): DependencyGraphs {
  return {
    resolution: ordered.map(node => ({ id: node.id, needs: node.resolutionEdges })),
    execution: ordered.map(node => ({ id: node.id, after: node.executionEdges })),
  };
}

export function executionOrder(ordered: OrderedNode[]): OrderedNode[] {
  return orderGraph(new Map(ordered.map((node): [ResourceId, OrderedNode] => [node.id, node])), 'executionDependencies', 'Execution dependency');
}

export function dependencyWarnings(spec: ParsedSpec, ordered: OrderedNode[]): string[] {
  if (dependencyMode(spec) !== 'split') return [];
  const assumptions = spec.executionAssumptions ?? [];
  const warnings: string[] = [];
  for (const node of ordered) {
    if (node.kind !== 'contract') continue;
    // Creation code can call a constructor argument or a linked library, so both need an edge or an assumption.
    for (const { reference, location, text } of creationReferences(node.item)) {
      const name = reference.split('.')[1];
      const dependency: ContractId = `contract:${name}`;
      if (!node.executionDependencies.includes(dependency) &&
        !assumptions.some(entry => entry.consumer === node.id && entry.location === location && entry.reference === reference)) {
        warnings.push(`${node.id} ${text} ${reference} without an execution dependency; confirm its constructor does not call the referenced contract.`);
      }
    }
  }
  return [...new Set(warnings)].sort();
}

export function impact(spec: ParsedSpec, ordered: OrderedNode[], reference: string): ResourceId[] {
  assert(/^values\.[a-z][a-zA-Z0-9_]*$/.test(reference), 'Impact source must be values.<name>.');
  assert(Object.hasOwn(spec.values, reference.slice(7)), `Missing ${reference}.`);
  const affected = new Set<ResourceId>();
  for (const node of ordered) {
    const inputs = node.kind === 'contract'
      ? [node.item.address, node.item.args, node.item.libraries, node.item.checks]
      : node.kind === 'external' ? [node.item.checks] : [node.item.args, node.item.check, node.item.before];
    if (references(inputs).has(reference) || node.resolutionDependencies.some(dependency => affected.has(dependency))) affected.add(node.id);
  }
  return ordered.filter(node => affected.has(node.id)).map(node => node.id);
}

export function resolve(value: SpecValue[], spec: ParsedSpec, addresses: ResolvedAddresses): JsonValue[];
export function resolve(value: SpecValue, spec: ParsedSpec, addresses: ResolvedAddresses): JsonValue;
export function resolve(value: SpecValue, spec: ParsedSpec, addresses: ResolvedAddresses): JsonValue {
  if (Array.isArray(value)) return value.map(item => resolve(item, spec, addresses));
  if (isObject(value)) {
    if (Object.hasOwn(value, 'ref')) {
      assert(typeof value.ref === 'string' && Object.keys(value).every(key => ['ref', 'requiresLive'].includes(key)) &&
        (value.requiresLive === undefined || typeof value.requiresLive === 'boolean'), 'A reference object needs ref and optional boolean requiresLive.');
      const [root, name, field] = value.ref.split('.');
      if (root === 'values' && field === undefined) {
        assert(name !== undefined && Object.hasOwn(spec.values, name), `Missing value ${name}.`);
        return cloneJson(spec.values[name]);
      }
      if (root === 'externals' && field === 'address') {
        const external = name === undefined ? undefined : spec.externals[name];
        assert(external, `Missing external ${name}.`);
        return external.address;
      }
      if (root === 'contracts' && field === 'address') {
        const address = name === undefined ? undefined : addresses[name];
        assert(address, `Contract ${name} has no resolved address.`);
        return address;
      }
      throw new Error(`Invalid reference ${value.ref}.`);
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, spec, addresses)]));
  }
  return value;
}
