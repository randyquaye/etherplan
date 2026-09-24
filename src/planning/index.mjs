import { concatHex, encodeDeployData, encodeFunctionData, isAddress, keccak256 } from 'viem';
import { hashJson } from '../identity.mjs';
import { graph, parseSpec, resolve } from '../spec/index.mjs';

const HASH = /^0x[0-9a-fA-F]{64}$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function linkBytecode(bytecode, linkReferences = {}, libraries = {}) {
  let body = bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode;
  const used = new Set();
  for (const [file, names] of Object.entries(linkReferences)) {
    for (const [name, positions] of Object.entries(names)) {
      const key = `${file}:${name}`;
      const address = libraries[key];
      assert(isAddress(address), `Missing linked library ${key}.`);
      used.add(key);
      for (const { start, length } of positions) {
        assert(Number.isSafeInteger(start) && start >= 0 && length === 20, `Invalid link range for ${key}.`);
        assert((start + length) * 2 <= body.length, `Link range for ${key} exceeds bytecode.`);
        body = `${body.slice(0, start * 2)}${address.slice(2).toLowerCase()}${body.slice((start + length) * 2)}`;
      }
    }
  }
  for (const key of Object.keys(libraries)) assert(used.has(key), `Unknown linked library ${key}.`);
  assert(/^[0-9a-fA-F]*$/.test(body) && body.length % 2 === 0, 'Linked bytecode must be complete hex.');
  return `0x${body}`;
}

function create2Address(factory, salt, initcode) {
  const digest = keccak256(concatHex(['0xff', factory, salt, keccak256(initcode)]));
  return `0x${digest.slice(-40)}`;
}

function checks(value, spec, addresses) {
  return Object.entries(value ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([functionName, expected]) => ({ functionName, expected: resolve(expected, spec, addresses) }));
}

export function prepareResources(specInput, orderedInput, artifacts) {
  const spec = parseSpec(specInput);
  const ordered = orderedInput ?? graph(spec);
  assert(artifacts instanceof Map, 'Artifacts must be a Map keyed by contract ID.');
  const addresses = {};
  const resources = [];
  const contracts = new Map();

  for (const node of ordered) {
    if (node.kind === 'external' || node.type === 'external') {
      const name = node.id.slice('external:'.length);
      const item = spec.externals[name];
      const resource = {
        id: node.id,
        kind: 'external',
        dependencies: [...(node.dependencies ?? node.deps ?? [])].sort(),
        address: item.address,
        expectedCodeHash: item.codeHash ?? null,
        checks: checks(item.checks, spec, addresses),
      };
      if (item.abi) resource.abi = item.abi;
      resources.push(resource);
      continue;
    }

    if (node.kind === 'contract' || node.type === 'contract') {
      const item = node.item;
      const artifact = artifacts.get(item.id);
      assert(artifact, `Missing artifact for contract:${item.id}.`);
      assert(typeof artifact.artifactHash === 'string' && HASH.test(artifact.artifactHash), `contract:${item.id} needs a normalized artifactHash.`);
      const inputs = resolve(item.args ?? [], spec, addresses);
      const libraries = resolve(item.libraries ?? {}, spec, addresses);
      const imported = item.address !== undefined;
      let initcode;
      let address;
      if (imported) {
        address = resolve(item.address, spec, addresses);
      } else {
        const bytecode = linkBytecode(artifact.bytecode.object, artifact.bytecode.linkReferences, libraries);
        initcode = encodeDeployData({ abi: artifact.abi, bytecode, args: inputs });
        address = create2Address(spec.factory.address, item.salt, initcode);
      }
      assert(isAddress(address), `contract:${item.id} has an invalid resolved address.`);
      assert(!Object.values(addresses).some(existing => existing.toLowerCase() === address.toLowerCase()), `contract:${item.id} resolves to a duplicate contract address.`);
      addresses[item.id] = address;

      const resource = {
        id: node.id,
        kind: 'contract',
        dependencies: [...(node.dependencies ?? node.deps ?? [])].sort(),
        address,
        artifact,
        artifactHash: artifact.artifactHash,
        inputs,
        inputsHash: hashJson(inputs),
        checks: checks(item.checks, spec, addresses),
        signerRole: item.signerRole ?? 'deployer',
        senderIndependent: item.senderIndependent ?? false,
      };
      if (Object.keys(libraries).length > 0) resource.libraries = libraries;
      if (item.codeHash !== undefined) resource.expectedCodeHash = item.codeHash;
      if (initcode !== undefined) {
        resource.initcode = initcode;
        resource.initcodeHash = keccak256(initcode);
        resource.salt = item.salt;
        resource.factory = { ...spec.factory };
      }
      contracts.set(item.id, resource);
      resources.push(resource);
      continue;
    }

    const item = node.item;
    const target = contracts.get(item.target);
    assert(target, `${node.id} has unresolved target contract:${item.target}.`);
    const checkArgs = resolve(item.check.args, spec, addresses);
    const after = {
      functionName: item.check.function,
      args: checkArgs,
      expected: resolve(item.check.equals, spec, addresses),
    };
    const before = {
      functionName: item.check.function,
      args: checkArgs,
      expected: resolve(item.before.equals, spec, addresses),
    };
    const check = { functionName: item.check.function, args: checkArgs };
    resources.push({
      id: node.id,
      kind: 'call',
      dependencies: [...(node.dependencies ?? node.deps ?? [])].sort(),
      address: target.address,
      targetId: target.id,
      targetArtifact: target.artifact,
      abi: target.artifact.abi,
      method: item.method,
      args: resolve(item.args, spec, addresses),
      check,
      before,
      after,
      signerRole: item.signerRole ?? 'owner',
    });
  }

  return { resources, addresses };
}

function copyDefined(target, source, keys) {
  for (const key of keys) if (source[key] !== undefined) target[key] = source[key];
}

export function transactionFor(resource) {
  if (resource.kind === 'contract' && resource.factory && resource.salt && resource.initcode) {
    return { to: resource.factory.address, data: concatHex([resource.salt, resource.initcode]), value: '0' };
  }
  if (resource.kind === 'call' && resource.abi && resource.method && Array.isArray(resource.args)) {
    return { to: resource.address, data: encodeFunctionData({ abi: resource.abi, functionName: resource.method, args: resource.args }), value: '0' };
  }
  throw new Error(`${resource.id ?? 'Resource'} has no transaction payload.`);
}

function planResource(resource, observation, action) {
  const result = {
    id: resource.id,
    kind: resource.kind,
    dependencies: resource.dependencies,
    address: resource.address,
  };
  if (resource.kind === 'contract') {
    copyDefined(result, resource, ['artifactHash', 'initcodeHash', 'inputsHash', 'salt', 'factory', 'checks', 'libraries', 'expectedCodeHash', 'signerRole', 'senderIndependent']);
  } else if (resource.kind === 'external') {
    copyDefined(result, resource, ['expectedCodeHash', 'checks']);
    result.signerRole = null;
  } else {
    copyDefined(result, resource, ['targetId', 'method', 'args', 'check', 'before', 'after', 'signerRole']);
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

function compareState(resource, record) {
  if (!record || resource.kind !== 'contract') return null;
  const addressMatches = record.address.toLowerCase() === resource.address.toLowerCase();
  const identity = {
    artifactHash: resource.artifactHash,
    initcodeHash: resource.initcodeHash ?? null,
    inputsHash: resource.inputsHash,
  };
  const previousIdentity = {
    artifactHash: record.artifactHash,
    initcodeHash: record.initcodeHash ?? null,
    inputsHash: record.inputsHash,
  };
  const identityMatches = Object.keys(identity).every(key => identity[key]?.toLowerCase?.() === previousIdentity[key]?.toLowerCase?.());
  return {
    previousAddress: record.address,
    previousIdentity,
    addressMatches,
    identityMatches,
    replacement: !addressMatches && !identityMatches,
    conflict: addressMatches !== identityMatches,
  };
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

export async function createPlan({ spec: specInput, artifacts, client, state = null }) {
  assert(client && typeof client.getChainId === 'function' && typeof client.getBlock === 'function', 'Plan needs a read-only chain client.');
  const spec = parseSpec(specInput);
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
  const planned = [];
  const plannedById = new Map();
  for (const resource of resources) {
    const options = { blockNumber: observed.number };
    const transactionHash = state?.resources?.[resource.id]?.transactions?.at(-1);
    if (transactionHash) options.transactionHash = transactionHash;
    const verification = await verifyResource(resource, client, options);
    const stateComparison = compareState(resource, state?.resources?.[resource.id]);
    let observation = stateComparison ? { ...verification, stateComparison: {
      ...stateComparison,
      liveCodeMatchesState: state?.resources?.[resource.id]?.codeHash === null || state?.resources?.[resource.id]?.codeHash === undefined ||
        state.resources[resource.id].codeHash.toLowerCase() === verification.codeHash?.toLowerCase(),
    } } : verification;
    let action = stateComparison?.conflict ? 'conflict' : decide(resource, verification, plannedById);
    const unsafeDependencies = resource.dependencies.filter(dependency => ['conflict', 'unverified'].includes(plannedById.get(dependency)?.action));
    if (unsafeDependencies.length > 0) {
      action = 'conflict';
      observation = { ...observation, dependencyConflicts: unsafeDependencies };
    } else if (resource.kind === 'call' && action === 'call' && bindingState(verification) === 'read-failed') {
      observation = { ...observation, pending: { reason: 'Target contract is deployed earlier in this plan.', targetId: resource.targetId } };
    }
    const entry = planResource(resource, observation, action);
    planned.push(entry);
    plannedById.set(entry.id, entry);
  }

  const confirmed = await client.getBlock({ blockNumber: observed.number });
  assertBlock(confirmed, 'Confirmed observation');
  assert(confirmed.hash.toLowerCase() === observed.hash.toLowerCase(), `Observed block ${observed.number} changed while the plan was created.`);

  const artifactHashes = Object.fromEntries(resources
    .filter(resource => resource.kind === 'contract')
    .map(resource => [resource.id, resource.artifactHash]));
  const fields = {
    formatVersion: 1,
    chain,
    observed: { blockNumber: observed.number.toString(), blockHash: observed.hash },
    specHash: hashJson(spec),
    artifactHashes,
    resources: planned,
  };
  return { ...fields, planHash: hashJson(fields) };
}
