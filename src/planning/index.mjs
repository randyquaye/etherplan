import { keccak256 } from 'viem';
import { hashJson } from '../identity.mjs';
import { dependencyGraphs, dependencyMode, dependencyWarnings, executionOrder, graph, parseSpec, usesDependencyPlan } from '../spec/index.mjs';
import { executionWaves } from '../scheduling/index.mjs';
import { prepareResources, transactionFor } from './resources.mjs';
import { createSchedule } from '../scheduling/index.mjs';

export { prepareResources, transactionFor } from './resources.mjs';

const HASH = /^0x[0-9a-fA-F]{64}$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function copyDefined(target, source, keys) {
  for (const key of keys) if (source[key] !== undefined) target[key] = source[key];
}

function planResource(resource, observation, action) {
  const result = {
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
  return result;
}

function bindingState(observation) {
  const binding = observation.bindingChecks?.[0];
  return binding?.state ?? binding?.result ?? binding?.observed ?? null;
}

function decide(resource, observation, plannedById) {
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

function lower(value) {
  return typeof value === 'string' ? value.toLowerCase() : value ?? null;
}

// A rebuilt artifact for an unchanged CREATE2 deployment is reused only when the saved and live code agree and the new
// artifact verifies the live contract. prepareResources derives the address from the current factory, salt, and initcode.
function artifactDrift(resource, record, verification) {
  const reasons = [];
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
function compareState(resource, record, verification) {
  if (!record || resource.kind !== 'contract') return null;
  const addressMatches = lower(record.address) === lower(resource.address);
  const identityMatches = lower(record.initcodeHash) === lower(resource.initcodeHash) && lower(record.inputsHash) === lower(resource.inputsHash);
  const artifactMatches = lower(record.artifactHash) === lower(resource.artifactHash);
  const comparison = {
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

function assertBlock(block, location) {
  assert(block && typeof block.hash === 'string' && HASH.test(block.hash), `${location} block needs a hash.`);
  assert(typeof block.number === 'bigint' || (typeof block.number === 'number' && Number.isSafeInteger(block.number)), `${location} block needs a number.`);
}

function assertStateChain(state, chain) {
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
export async function createPlan({ spec: specInput, artifacts, client, state = null, pipeline = null }) {
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
  const chain = { id: chainId, genesisHash: genesis.hash };
  assertStateChain(state, chain);

  const deployable = resources.filter(resource => resource.kind === 'contract' && resource.initcode !== undefined);
  if (deployable.length > 0) {
    const factory = deployable[0].factory;
    assert(deployable.every(resource => resource.factory.address.toLowerCase() === factory.address.toLowerCase() && resource.factory.codeHash.toLowerCase() === factory.codeHash.toLowerCase()), 'Plan has inconsistent CREATE2 factories.');
    const code = await client.getCode({ address: factory.address, blockNumber: observed.number });
    assert(code && code !== '0x' && keccak256(code).toLowerCase() === factory.codeHash.toLowerCase(), 'CREATE2 factory code differs or is absent.');
  }

  const { verifyResource } = await import('../verification/index.mjs');
  const observations = new Map();
  const resourceById = new Map(resources.map(resource => [resource.id, resource]));
  const plannedById = new Map();
  for (const resource of resources) {
    const options = { blockNumber: observed.number };
    const transactionHash = state?.resources?.[resource.id]?.transactions?.at(-1);
    if (transactionHash) options.transactionHash = transactionHash;
    const verification = await verifyResource(resource, client, options);
    const stateComparison = compareState(resource, state?.resources?.[resource.id], verification);
    const observation = stateComparison ? { ...verification, stateComparison } : verification;
    observations.set(resource.id, { observation, verification, stateComparison });
  }
  for (const node of executionOrder(ordered)) {
    const resource = resourceById.get(node.id);
    const { verification, stateComparison } = observations.get(node.id);
    let { observation } = observations.get(node.id);
    let action = stateComparison?.conflict ? 'conflict' : decide(resource, verification, plannedById);
    const unsafeDependencies = resource.dependencies.filter(dependency => ['conflict', 'unverified'].includes(plannedById.get(dependency)?.action));
    if (unsafeDependencies.length > 0) {
      action = 'conflict';
      observation = { ...observation, dependencyConflicts: unsafeDependencies };
    } else if (resource.kind === 'call' && action === 'call' && bindingState(verification) === 'read-failed') {
      observation = { ...observation, pending: { reason: 'Target contract is deployed earlier in this plan.', targetId: resource.targetId } };
    }
    const entry = planResource(resource, observation, action);
    plannedById.set(entry.id, entry);
  }
  const planned = resources.map(resource => plannedById.get(resource.id));

  const confirmed = await client.getBlock({ blockNumber: observed.number });
  assertBlock(confirmed, 'Confirmed observation');
  assert(confirmed.hash.toLowerCase() === observed.hash.toLowerCase(), `Observed block ${observed.number} changed while the plan was created.`);

  const artifactHashes = Object.fromEntries(resources
    .filter(resource => resource.kind === 'contract')
    .map(resource => [resource.id, resource.artifactHash]));
  const fields = {
    formatVersion: described ? 2 : 1,
    chain,
    observed: { blockNumber: observed.number.toString(), blockHash: observed.hash },
    specHash: hashJson(spec),
    artifactHashes,
    resources: planned,
    ...(described ? {
      dependencyMode: dependencyMode(spec),
      graphs: dependencyGraphs(ordered),
      executionWaves: executionWaves(planned),
      executionAssumptions: spec.executionAssumptions ?? [],
      warnings: dependencyWarnings(spec, ordered),
    } : {}),
  };
  if (pipeline) {
    const deployers = (pipeline.parallel ? pipeline.deployers : pipeline.deployers.slice(0, 1)).map(address => address.toLowerCase());
    const schedule = createSchedule(fields, deployers, { owner: pipeline.owner ?? null, parallel: pipeline.parallel ?? false, pipeline: true });
    if (schedule.ownerActions.length && !pipeline.owner) throw new Error('A pipeline plan with owner actions needs --owner <address>.');
    if (schedule.deferred.length) throw new Error(`Cannot pipeline unschedulable actions: ${schedule.deferred.map(entry => entry.id).join(', ')}.`);
    fields.pipeline = {
      deployers,
      owner: pipeline.owner?.toLowerCase() ?? null,
      parallel: pipeline.parallel ?? false,
      waves: schedule.waves,
    };
  }
  return { ...fields, planHash: hashJson(fields) };
}
