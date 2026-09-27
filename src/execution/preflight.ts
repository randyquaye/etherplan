import { concatHex, keccak256 } from 'viem';
import { canonicalJson, hashJson } from '../identity.ts';
import { encodeMethod } from '../validation/index.ts';
import { ApplyError } from './errors.ts';
import { DEFAULT_FACTORY, dependencyGraphs, dependencyMode, dependencyWarnings, usesDependencyPlan } from '../spec/index.ts';
import { executionWaves } from '../scheduling/index.ts';
import type { DeployableContract, Plan, PlannedContract, PlannedResource, PlannedTransaction, PreparedCall, PreparedContract, PreparedResource } from '../planning/types.ts';
import type { Factory } from '../spec/types.ts';
import type { Address, Client, ContractId, Hash, Hex, JsonSafe, ResourceId } from '../types.ts';
import type { PlanIdentityInput, PreparedAction } from './types.ts';

const APPLICABLE = new Set(['reuse', 'deploy', 'call']);
const IDENTITY_FIELDS = ['kind', 'dependencies', 'resolutionDependencies', 'executionEdges', 'address', 'artifactHash', 'initcodeHash', 'inputsHash', 'salt', 'factory', 'checks', 'libraries', 'expectedCodeHash', 'creationProofMode', 'createdCode', 'signerRole', 'senderIndependent', 'targetId', 'method', 'args', 'check', 'before', 'after', 'ownerOnly', 'transfersOwnership'];

function convert(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return /^0x[0-9a-fA-F]*$/.test(value) ? value.toLowerCase() : value;
  if (Array.isArray(value)) return value.map(convert);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, convert(item)]));
  }
  return value;
}

// Makes in-memory values comparable with plan JSON: quantities become decimal strings and hex becomes lowercase.
export function jsonSafe<T>(value: T): JsonSafe<T> {
  return convert(value) as JsonSafe<T>;
}

function same(a: unknown, b: unknown): boolean {
  return canonicalJson(jsonSafe(a ?? null)) === canonicalJson(jsonSafe(b ?? null));
}

/** Reads one of IDENTITY_FIELDS from a planned or prepared resource, whichever kind it is. */
function fieldOf(resource: PlannedResource | PreparedResource, field: string): unknown {
  return (resource as unknown as Record<string, unknown>)[field];
}

export function create2Address(factory: Address, salt: Hex, initcodeHash: Hash): Address {
  return `0x${keccak256(concatHex(['0xff', factory, salt, initcodeHash])).slice(-40)}`;
}

function deployable(resource: PreparedContract): resource is DeployableContract {
  return Boolean(resource.initcode && resource.salt && resource.factory);
}

export function deployTransaction(resource: DeployableContract): PlannedTransaction {
  return { to: resource.factory.address, data: concatHex([resource.salt, resource.initcode]), value: '0' };
}

export function callTransaction(resource: PreparedCall): PlannedTransaction {
  const abi = resource.abi ?? resource.targetArtifact?.abi;
  return { to: resource.address, data: encodeMethod(abi, resource.method, resource.args, resource.id), value: '0' };
}

function checkDeployPayload(planned: PlannedContract, fresh: PreparedContract): string[] {
  const failures: string[] = [];
  if (!deployable(fresh)) return ['deployable contract has no initcode, salt, or factory'];
  const initcodeHash = keccak256(fresh.initcode);
  if (initcodeHash.toLowerCase() !== planned.initcodeHash?.toLowerCase()) failures.push('initcode hash differs');
  if (create2Address(fresh.factory.address, fresh.salt, initcodeHash).toLowerCase() !== planned.address.toLowerCase()) failures.push('CREATE2 address differs');
  if (!same(planned.tx, deployTransaction(fresh))) failures.push('transaction payload differs from factory, salt, and initcode');
  return failures;
}

async function checkChain(plan: Plan, client: Client): Promise<void> {
  const chainId = await client.getChainId();
  if (chainId !== plan.chain.id) throw new ApplyError('wrong-chain', `Connected to chain ${chainId}; the plan is for chain ${plan.chain.id}.`, { evidence: { expected: plan.chain.id, actual: chainId } });
  const genesis = await client.getBlock({ blockNumber: 0n });
  if (genesis.hash.toLowerCase() !== plan.chain.genesisHash.toLowerCase()) {
    throw new ApplyError('wrong-chain', 'The genesis block hash differs from the plan.', { evidence: { expected: plan.chain.genesisHash, actual: genesis.hash } });
  }
  let anchor;
  try {
    anchor = await client.getBlock({ blockNumber: BigInt(plan.observed.blockNumber) });
  } catch {
    throw new ApplyError('stale-observation', `The plan's observed block ${plan.observed.blockNumber} is not on this chain.`, { evidence: plan.observed });
  }
  if (anchor.hash.toLowerCase() !== plan.observed.blockHash.toLowerCase()) {
    throw new ApplyError('stale-observation', `Block ${plan.observed.blockNumber} changed after the plan (reorg or reset). Create a new plan.`, { evidence: { expected: plan.observed.blockHash, actual: anchor.hash } });
  }
}

export async function checkFactory(client: Client, factory: Factory): Promise<void> {
  const code = await client.getCode({ address: factory.address });
  const codeHash = code && code !== '0x' ? keccak256(code) : null;
  if (codeHash?.toLowerCase() !== factory.codeHash.toLowerCase()) {
    throw new ApplyError('factory', `CREATE2 factory ${factory.address} code is absent or differs.`, { evidence: { expected: factory.codeHash, actual: codeHash } });
  }
}

// Read-only identity check shared by apply and saved-plan schedule previews.
export async function checkPlanIdentity({ plan, spec, artifacts, client, deps }: PlanIdentityInput): Promise<Map<ResourceId, PreparedAction>> {
  if (!plan || ![1, 2].includes(plan.formatVersion) || !Array.isArray(plan.resources)) throw new ApplyError('plan-format', 'Plan must have formatVersion 1 or 2 and resources[].');
  const { planHash, ...fields } = plan;
  if (typeof planHash !== 'string' || hashJson(fields) !== planHash) throw new ApplyError('plan-hash', 'Plan content does not match its planHash. The plan changed after it was created.');

  if (spec === undefined || spec === null) throw new ApplyError('stale-spec', 'Apply needs the spec that produced the plan.');
  const parsed = deps.parseSpec(structuredClone(spec));
  const specHash = hashJson(parsed);
  if (specHash !== plan.specHash) throw new ApplyError('stale-spec', 'The spec changed after the plan was created.', { evidence: { expected: plan.specHash, actual: specHash } });
  if (plan.formatVersion !== (usesDependencyPlan(parsed) ? 2 : 1)) throw new ApplyError('stale-spec', 'The plan format does not match the specification dependency mode.');

  if (!(artifacts instanceof Map)) throw new ApplyError('stale-artifact', 'Apply needs the artifact map that produced the plan.');
  for (const [id, expected] of Object.entries(plan.artifactHashes ?? {}) as [ContractId, Hash][]) {
    const actual = artifacts.get(id.replace(/^contract:/, ''))?.artifactHash;
    if (actual !== expected) throw new ApplyError('stale-artifact', 'The artifact changed after the plan was created.', { actionId: id, evidence: { expected, actual: actual ?? null } });
  }
  const contracts = plan.resources.filter(resource => resource.kind === 'contract').map(resource => resource.id);
  const missing = contracts.filter(id => !Object.hasOwn(plan.artifactHashes ?? {}, id));
  if (missing.length) throw new ApplyError('stale-artifact', `Plan has no artifact hash for ${missing.join(', ')}.`);
  if (Object.keys(plan.artifactHashes ?? {}).length !== contracts.length) throw new ApplyError('stale-artifact', 'The plan artifact hash set differs from its contracts.');

  const ordered = deps.graph(parsed);
  if (plan.formatVersion === 2 && (!same(plan.graphs, dependencyGraphs(ordered)) ||
    plan.dependencyMode !== dependencyMode(parsed) ||
    !same(plan.executionAssumptions, parsed.executionAssumptions ?? []) ||
    !same(plan.warnings, dependencyWarnings(parsed, ordered)))) {
    throw new ApplyError('stale-resource', 'The saved dependency graphs or execution assumptions differ from the current specification.');
  }
  const { resources } = await deps.prepareResources(parsed, ordered, artifacts);
  const freshIds = resources.map(resource => resource.id);
  const plannedIds = plan.resources.map(resource => resource.id);
  if (!same(freshIds, plannedIds)) throw new ApplyError('stale-resource', 'The resource set or its order differs from the plan.', { evidence: { expected: plannedIds, actual: freshIds } });
  if (plan.formatVersion === 2 && !same(plan.executionWaves, executionWaves(plan.resources))) {
    throw new ApplyError('stale-resource', 'The saved execution waves differ from the plan resources.');
  }

  const prepared = new Map<ResourceId, PreparedAction>();
  for (const [index, planned] of plan.resources.entries()) {
    // The ID lists matched above, so every plan entry has a fresh resource at its index.
    const fresh = resources[index]!;
    const failures = IDENTITY_FIELDS.filter(field => !same(fieldOf(planned, field), fieldOf(fresh, field))).map(field => `${field} differs`);
    if (planned.action === 'deploy') {
      if (planned.kind !== 'contract') failures.push('only a contract can be deployed');
      else if (fresh.kind === 'contract') {
        failures.push(...checkDeployPayload(planned, fresh));
        if (deps.transactionFor && !same(planned.tx, deps.transactionFor(fresh))) failures.push('transaction payload differs from the planner encoding');
      }
    }
    if (planned.action === 'call') {
      if (planned.kind !== 'call') failures.push('only a call resource can be called');
      else if (fresh.kind === 'call' && !same(planned.tx, deps.transactionFor?.(fresh) ?? callTransaction(fresh))) failures.push('transaction payload differs');
    }
    if (['deploy', 'call'].includes(planned.action) && String(planned.tx?.value ?? '') !== '0') failures.push('transaction value must be 0');
    if (failures.length) throw new ApplyError('stale-resource', `Plan entry does not match the current inputs: ${failures.join('; ')}.`, { actionId: planned.id, evidence: failures });
    prepared.set(planned.id, { planned, resource: fresh });
  }

  await checkChain(plan, client);
  return prepared;
}

// Apply also requires every planned action to be executable.
export async function preflight(input: PlanIdentityInput): Promise<Map<ResourceId, PreparedAction>> {
  const { plan } = input;
  const blocked = plan?.resources?.filter(resource => !APPLICABLE.has(resource.action)) ?? [];
  if (blocked.length) {
    throw new ApplyError('plan-not-applicable', `Plan has resources that cannot be applied: ${blocked.map(resource => `${resource.id} (${resource.action})`).join(', ')}.`, { evidence: blocked.map(resource => ({ id: resource.id, action: resource.action, observation: resource.observation })) });
  }
  const prepared = await checkPlanIdentity(input);
  const factories = new Map<string, Factory>();
  for (const resource of plan.resources) {
    if (resource.action !== 'deploy') continue;
    // checkPlanIdentity has matched every deploy entry against a deployable contract, so it carries the factory.
    if (resource.kind !== 'contract' || resource.factory === undefined) throw new ApplyError('plan-format', `${resource.id} is planned for deployment without a CREATE2 factory.`);
    factories.set(resource.factory.address.toLowerCase(), resource.factory);
  }
  for (const factory of factories.values()) {
    if (factory.codeHash.toLowerCase() !== DEFAULT_FACTORY.codeHash.toLowerCase()) {
      throw new ApplyError('factory', 'Automated CREATE2 deployment requires the bundled atomic factory bytecode; import contracts from other factories explicitly.');
    }
    await checkFactory(input.client, factory);
  }
  return prepared;
}
