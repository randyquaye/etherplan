import { concatHex, isAddress, keccak256 } from 'viem';
import { hashJson } from '../identity.mjs';
import { graph, parseSpec, resolve, usesDependencyPlan } from '../spec/index.mjs';
import { encodeConstructor, encodeMethod, validateResources } from '../validation/index.mjs';

const HASH = /^0x[0-9a-fA-F]{64}$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

/**
 * Resolves the spec in resolution order into concrete contracts, externals, and calls.
 * Contract addresses are known before dependent arguments and call targets are resolved.
 * Validates the resulting resources without reading the chain.
 */
export function prepareResources(specInput, orderedInput, artifacts) {
  const spec = parseSpec(specInput);
  const ordered = orderedInput ?? graph(spec);
  const describeDependencies = usesDependencyPlan(spec);
  const dependencyFields = node => describeDependencies ? {
    resolutionDependencies: [...node.resolutionDependencies],
    executionEdges: node.executionEdges,
  } : {};
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
        ...dependencyFields(node),
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
        initcode = encodeConstructor(artifact, inputs, libraries, node.id);
        address = create2Address(spec.factory.address, item.salt, initcode);
      }
      assert(isAddress(address), `contract:${item.id} has an invalid resolved address.`);
      assert(!Object.values(addresses).some(existing => existing.toLowerCase() === address.toLowerCase()), `contract:${item.id} resolves to a duplicate contract address.`);
      addresses[item.id] = address;

      const resource = {
        id: node.id,
        kind: 'contract',
        dependencies: [...(node.dependencies ?? node.deps ?? [])].sort(),
        ...dependencyFields(node),
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
      ...dependencyFields(node),
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
      ...(describeDependencies ? { ownerOnly: item.ownerOnly ?? false, transfersOwnership: item.transfersOwnership || item.method === 'transferOwnership' } : {}),
    });
  }

  validateResources(resources);
  return { resources, addresses };
}

export function transactionFor(resource) {
  if (resource.kind === 'contract' && resource.factory && resource.salt && resource.initcode) {
    return { to: resource.factory.address, data: concatHex([resource.salt, resource.initcode]), value: '0' };
  }
  if (resource.kind === 'call' && resource.abi && resource.method && Array.isArray(resource.args)) {
    return { to: resource.address, data: encodeMethod(resource.abi, resource.method, resource.args, resource.id), value: '0' };
  }
  throw new Error(`${resource.id ?? 'Resource'} has no transaction payload.`);
}
