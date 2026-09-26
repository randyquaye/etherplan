import { isAddress, keccak256 } from 'viem';
import { hashJson } from '../identity.ts';
import { dependencyGraphs, dependencyMode, dependencyWarnings, executionOrder, graph, parseSpec, usesDependencyPlan } from '../spec/index.ts';
import { executionWaves } from '../scheduling/index.ts';
import { prepareResources, transactionFor } from './resources.ts';
import { createSchedule } from '../scheduling/index.ts';
import { verifyResource } from '../verification/index.ts';
import type { Block } from 'viem';
import type { ContractStateResource, StateFile } from '../state/types.ts';
import type { Address, ChainIdentity, ContractId, DistributiveOmit, Hash, ResourceId } from '../types.ts';
import type { BindingObservation, VerificationResult, VerifyOptions } from '../verification/types.ts';
import type { ArtifactDrift, CreatePlanInput, DeployableContract, Plan, PlanAction, PlanObservation, PlannedResource, PreparedContract, PreparedResource, StateComparison } from './types.ts';

export { prepareResources, transactionFor } from './resources.ts';

const HASH = /^0x[0-9a-fA-F]{64}$/;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** A map entry the caller inserted for every resource. */
function lookup<K, V>(map: Map<K, V>, key: K): V {
  const value = map.get(key);
  assert(value !== undefined, `Missing planning entry for ${String(key)}.`);
  return value;
}

// Copies the named fields that are present, so a plan entry never holds `undefined`, which canonical JSON rejects.
function copyDefined(target: Record<string, unknown>, source: object, keys: string[]): void {
  const fields = source as Record<string, unknown>;
  for (const key of keys) if (fields[key] !== undefined) target[key] = fields[key];
}

// The saved plan omits artifacts and initcode; copy only fields defined for each resource kind.
function planResource(resource: PreparedResource, observation: PlanObservation, action: PlanAction): PlannedResource {
  const result: Record<string, unknown> = {
    id: resource.id,
    kind: resource.kind,
    dependencies: resource.dependencies,
    address: resource.address,
  };
  copyDefined(result, resource, ['resolutionDependencies', 'executionEdges']);
  if (resource.kind === 'contract') {
    copyDefined(result, resource, ['artifactHash', 'initcodeHash', 'inputsHash', 'salt', 'factory', 'checks', 'libraries', 'expectedCodeHash', 'signerRole', 'senderIndependent']);
  } else if (resource.kind === 'external') {
    copyDefined(result, resource, ['expectedCodeHash', 'checks']);
    result.signerRole = null;
  } else {
    copyDefined(result, resource, ['targetId', 'method', 'args', 'check', 'before', 'after', 'signerRole', 'ownerOnly', 'transfersOwnership']);
  }
  result.action = action;
  result.observation = observation;
  if (action === 'deploy' || action === 'call') result.tx = transactionFor(resource);
  return result as unknown as PlannedResource;
}

function bindingState(observation: VerificationResult): BindingObservation | null {
  return observation.bindingChecks?.[0]?.observed ?? null;
}

function decide(resource: PreparedResource, observation: VerificationResult, plannedById: Map<ResourceId, PlannedResource>): PlanAction {
  if (resource.kind === 'contract' && observation.codeComparison?.mode === 'absent') return resource.initcode === undefined ? 'conflict' : 'deploy';
  if (resource.kind === 'call') {
    const state = bindingState(observation);
    if (state === 'after') return 'reuse';
    if (state === 'before') return 'call';
    if (state === 'read-failed' && observation.bindingChecks?.[0]?.targetAbsent === true && plannedById.get(resource.targetId)?.action === 'deploy') return 'call';
    if (state === 'other' || state === 'read-failed') return 'conflict';
  }
  if (observation.status === 'verified') return 'reuse';
  if (observation.status === 'unverified') return 'unverified';
  return 'conflict';
}

function lower(value: string | null | undefined): string | null {
  return typeof value === 'string' ? value.toLowerCase() : value ?? null;
}

// A rebuilt artifact for an unchanged CREATE2 deployment is reused only when the saved and live code agree and the new
// artifact verifies the live contract. prepareResources derives the address from the current factory, salt, and initcode.
function artifactDrift(resource: PreparedContract, record: ContractStateResource, verification: VerificationResult): ArtifactDrift {
  const reasons: string[] = [];
  if (resource.initcodeHash === undefined || record.initcodeHash === null) {
    reasons.push(`An imported contract needs an explicit rebaseline: etherplan import --id ${resource.id} --rebaseline.`);
  } else if (lower(record.salt) !== lower(resource.salt)) {
    reasons.push('The saved salt differs from the spec salt.');
  }
  if (!record.codeHash) reasons.push('State has no code hash for this deployment.');
  else if (lower(record.codeHash) !== lower(verification.codeHash)) reasons.push(`Live code hash ${verification.codeHash ?? 'null'} differs from the saved code hash ${record.codeHash}.`);
  if (verification.status !== 'verified') reasons.push(`The new artifact leaves the live contract ${verification.status}.`);
  return {
    accepted: reasons.length === 0,
    previousArtifactHash: record.artifactHash,
    artifactHash: resource.artifactHash,
    previousSourceHash: record.sourceHash ?? null,
    sourceHash: resource.artifact.buildIdentity?.sourceHash ?? null,
    baseline: { address: record.address, initcodeHash: record.initcodeHash, inputsHash: record.inputsHash, salt: record.salt, codeHash: record.codeHash },
    reasons,
  };
}

// Deployment identity is the address, initcode, and constructor inputs; the artifact hash is provenance. Both address
// and deployment identity changing is a replacement; only one changing is a conflict. An artifact-only change is drift.
function compareState(resource: PreparedResource, state: StateFile | null, verification: VerificationResult): StateComparison | null {
  if (resource.kind !== 'contract') return null;
  const record = state?.resources[resource.id];
  if (!record) return null;
  const addressMatches = lower(record.address) === lower(resource.address);
  const identityMatches = lower(record.initcodeHash) === lower(resource.initcodeHash) && lower(record.inputsHash) === lower(resource.inputsHash);
  const artifactMatches = lower(record.artifactHash) === lower(resource.artifactHash);
  const comparison: StateComparison = {
    previousAddress: record.address,
    previousIdentity: {
      artifactHash: record.artifactHash,
      initcodeHash: record.initcodeHash ?? null,
      inputsHash: record.inputsHash,
    },
    addressMatches,
    identityMatches,
    artifactMatches,
    replacement: !addressMatches && !identityMatches,
    conflict: addressMatches !== identityMatches,
    liveCodeMatchesState: record.codeHash === null || record.codeHash === undefined || lower(record.codeHash) === lower(verification.codeHash),
  };
  if (addressMatches && identityMatches && !artifactMatches) {
    comparison.artifactDrift = artifactDrift(resource, record, verification);
    comparison.conflict = !comparison.artifactDrift.accepted;
  }
  return comparison;
}

function assertBlock(block: Block, location: string): void {
  assert(block && typeof block.hash === 'string' && HASH.test(block.hash), `${location} block needs a hash.`);
  assert(typeof block.number === 'bigint' || (typeof block.number === 'number' && Number.isSafeInteger(block.number)), `${location} block needs a number.`);
}

function assertStateChain(state: StateFile | null, chain: ChainIdentity): void {
  if (!state) return;
  assert(state.formatVersion === 1 && state.chain, 'State has an unsupported format.');
  assert(Number.isSafeInteger(state.chain.id) && typeof state.chain.genesisHash === 'string' && HASH.test(state.chain.genesisHash), 'State has an invalid chain identity.');
  assert(state.chain.id === chain.id && state.chain.genesisHash.toLowerCase() === chain.genesisHash.toLowerCase(), 'State belongs to a different chain.');
}

/**
 * Builds a plan from one observed chain block. Resolves values in resolution order,
 * evaluates unsafe dependents in execution order, and confirms the
 * observed block is still canonical before hashing the plan. Sends no transactions.
 */
export async function createPlan({ spec: specInput, artifacts, client, state = null, pipeline = null, signers = null, maxSpendWei = null }: CreatePlanInput): Promise<Plan> {
  assert(client && typeof client.getChainId === 'function' && typeof client.getBlock === 'function', 'Plan needs a read-only chain client.');
  const spec = parseSpec(specInput);
  const described = usesDependencyPlan(spec);
  const ordered = graph(spec);
  const { resources } = prepareResources(spec, ordered, artifacts);
  const chainId = await client.getChainId();
  assert(chainId === spec.chainId, `Connected to chain ${chainId}; spec requires ${spec.chainId}.`);
  const genesis = await client.getBlock({ blockNumber: 0n });
  const observed = await client.getBlock({ blockTag: 'latest' });
  assertBlock(genesis, 'Genesis');
  assertBlock(observed, 'Observed');
  const chain: ChainIdentity = { id: chainId, genesisHash: genesis.hash };
  assertStateChain(state, chain);

  const deployable = resources.filter((resource): resource is DeployableContract => resource.kind === 'contract' && resource.initcode !== undefined);
  const [first] = deployable;
  if (first) {
    const factory = first.factory;
    assert(deployable.every(resource => resource.factory.address.toLowerCase() === factory.address.toLowerCase() && resource.factory.codeHash.toLowerCase() === factory.codeHash.toLowerCase()), 'Plan has inconsistent CREATE2 factories.');
    const code = await client.getCode({ address: factory.address, blockNumber: observed.number });
    assert(code && code !== '0x' && keccak256(code).toLowerCase() === factory.codeHash.toLowerCase(), 'CREATE2 factory code differs or is absent.');
  }

  const observations = new Map<ResourceId, { observation: PlanObservation; verification: VerificationResult; stateComparison: StateComparison | null }>();
  const resourceById = new Map(resources.map((resource): [ResourceId, PreparedResource] => [resource.id, resource]));
  const plannedById = new Map<ResourceId, PlannedResource>();
  for (const resource of resources) {
    const options: VerifyOptions = { blockNumber: observed.number };
    const saved = state?.resources[resource.id];
    const transactionHash = saved?.creationProof?.transactionHash ?? saved?.provenance?.creationTransactionHash ?? saved?.transactions?.at(-1);
    if (transactionHash) options.transactionHash = transactionHash;
    if (saved?.creationProof) options.creationProof = saved.creationProof;
    options.chain = chain;
    const verification = await verifyResource(resource, client, options);
    const stateComparison = compareState(resource, state, verification);
    const observation: PlanObservation = stateComparison ? { ...verification, stateComparison } : verification;
    observations.set(resource.id, { observation, verification, stateComparison });
  }
  for (const node of executionOrder(ordered)) {
    const resource = lookup(resourceById, node.id);
    const observed = lookup(observations, node.id);
    const { verification, stateComparison } = observed;
    let { observation } = observed;
    let action: PlanAction = stateComparison?.conflict ? 'conflict' : decide(resource, verification, plannedById);
    const unsafeDependencies = resource.dependencies.filter(dependency => {
      const planned = plannedById.get(dependency)?.action;
      return planned === 'conflict' || planned === 'unverified';
    });
    if (unsafeDependencies.length > 0) {
      action = 'conflict';
      observation = { ...observation, dependencyConflicts: unsafeDependencies };
    } else if (resource.kind === 'call' && action === 'call' && bindingState(verification) === 'read-failed') {
      observation = { ...observation, pending: { reason: 'Target contract is deployed earlier in this plan.', targetId: resource.targetId } };
    }
    const entry = planResource(resource, observation, action);
    plannedById.set(entry.id, entry);
  }
  const planned = resources.map(resource => lookup(plannedById, resource.id));

  const confirmed = await client.getBlock({ blockNumber: observed.number });
  assertBlock(confirmed, 'Confirmed observation');
  assert(confirmed.hash.toLowerCase() === observed.hash.toLowerCase(), `Observed block ${observed.number} changed while the plan was created.`);

  const artifactHashes = Object.fromEntries(resources
    .filter((resource): resource is PreparedContract => resource.kind === 'contract')
    .map((resource): [ContractId, Hash] => [resource.id, resource.artifactHash]));
  const base = {
    chain,
    observed: { blockNumber: observed.number.toString(), blockHash: observed.hash },
    stateHash: hashJson(state),
    specHash: hashJson(spec),
    artifactHashes,
    resources: planned,
  };
  const fields: DistributiveOmit<Plan, 'planHash'> = described ? {
    formatVersion: 2,
    ...base,
    dependencyMode: dependencyMode(spec),
    graphs: dependencyGraphs(ordered),
    executionWaves: executionWaves(planned),
    executionAssumptions: spec.executionAssumptions ?? [],
    warnings: dependencyWarnings(spec, ordered),
  } : { formatVersion: 1, ...base };
  if (maxSpendWei !== null) {
    assert((typeof maxSpendWei === 'string' || typeof maxSpendWei === 'bigint') &&
      /^[0-9]+$/.test(String(maxSpendWei)) && BigInt(maxSpendWei) > 0n, 'Plan maxSpendWei must be a positive decimal wei amount.');
    fields.maxSpendWei = String(maxSpendWei);
  }
  if (signers && pipeline) throw new Error('Supply signer addresses through either signers or pipeline.');
  if (signers) {
    const deployers = (signers.parallel ? signers.deployers : signers.deployers?.slice(0, 1))?.map(address => address.toLowerCase() as Address);
    assert(deployers?.length && deployers.every(address => isAddress(address, { strict: false })) && new Set(deployers).size === deployers.length, 'Plan needs distinct deployer addresses.');
    assert(signers.owner == null || isAddress(signers.owner, { strict: false }), 'Plan owner must be an Ethereum address.');
    const needsOwner = planned.some(resource => ['deploy', 'call'].includes(resource.action) && resource.signerRole === 'owner');
    assert(!needsOwner || signers.owner, 'Plan with owner actions needs --owner <address>.');
    fields.signers = { deployers, owner: needsOwner && signers.owner ? signers.owner.toLowerCase() as Address : null, parallel: signers.parallel ?? false };
  }
  if (pipeline) {
    const deployers = (pipeline.parallel ? pipeline.deployers : pipeline.deployers.slice(0, 1)).map(address => address.toLowerCase() as Address);
    const schedule = createSchedule(fields, deployers, { owner: pipeline.owner ?? null, parallel: pipeline.parallel ?? false, pipeline: true });
    if (schedule.ownerActions.length && !pipeline.owner) throw new Error('A pipeline plan with owner actions needs --owner <address>.');
    if (schedule.deferred.length) throw new Error(`Cannot pipeline unschedulable actions: ${schedule.deferred.map(entry => entry.id).join(', ')}.`);
    fields.pipeline = {
      deployers,
      owner: pipeline.owner ? pipeline.owner.toLowerCase() as Address : null,
      parallel: pipeline.parallel ?? false,
      waves: schedule.waves,
    };
  }
  return { ...fields, planHash: hashJson(fields) };
}
