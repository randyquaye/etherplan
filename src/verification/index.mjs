import { concatHex, encodeAbiParameters, encodeDeployData, keccak256 } from 'viem';
import { compareRuntime, create2Address, fillLibraryGuard, hasLibraryGuard, immutableEntries, linkBytecode, linkedLibraries } from './bytecode.mjs';
import { simulateCreate, simulateCreate2 } from './simulate.mjs';
import { abiArguments, normalizeOutputs, safeError, sameJson } from './values.mjs';

export { compareRuntime, create2Address, fillLibraryGuard, hasLibraryGuard, linkBytecode, linkedLibraries, linkPlaceholder, normalizeCode } from './bytecode.mjs';
export { cidV0, decodeMetadataTail, ipfsMetadataHash } from './metadata.mjs';
export { PROBE_ADDRESS, PROBE_CODE, simulateCreate, simulateCreate2 } from './simulate.mjs';
export { abiArguments, normalizeAbiValue, normalizeOutputs, safeError } from './values.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function blockOf(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) return BigInt(value);
  throw new Error(`Invalid block number ${String(value)}.`);
}

function at(blockNumber) {
  return blockNumber === undefined ? {} : { blockNumber };
}

function hasCode(code) {
  return typeof code === 'string' && code !== '0x' && code.length > 2;
}

function lower(hex) {
  return typeof hex === 'string' ? hex.toLowerCase() : hex;
}

function newResult(resource) {
  return {
    id: resource.id,
    address: resource.address,
    codeHash: null,
    codeComparison: { mode: 'absent', matched: false },
    proofs: [],
    missingProofs: [],
    bindingChecks: [],
    reasons: [],
    status: 'conflict',
  };
}

function finish(result) {
  result.status = result.reasons.length > 0 ? 'conflict' : result.missingProofs.length > 0 ? 'unverified' : 'verified';
  return result;
}

function abiFunction(abi, name, argumentCount, label) {
  assert(Array.isArray(abi), `${label} needs an ABI to read ${name}.`);
  const matches = abi.filter(item => item.type === 'function' && item.name === name && (item.inputs ?? []).length === argumentCount);
  assert(matches.length === 1, `${label} has ${matches.length === 0 ? 'no' : 'more than one'} ABI function ${name} with ${argumentCount} argument(s).`);
  return matches[0];
}

async function readFunction(client, { address, fn, args, blockNumber }) {
  return client.readContract({ address, abi: [fn], functionName: fn.name, args: abiArguments(fn.inputs ?? [], args), ...at(blockNumber) });
}

async function getterProof(client, resource, check, abi, blockNumber) {
  const args = check.args ?? [];
  const fn = abiFunction(abi, check.functionName, args.length, resource.id);
  const expected = normalizeOutputs(fn.outputs ?? [], check.expected, `${resource.id} expected ${check.functionName}`);
  const proof = { name: check.functionName, method: 'getter', expected, actual: null, matched: false };
  if (args.length > 0) proof.args = args;
  try {
    proof.actual = normalizeOutputs(fn.outputs ?? [], await readFunction(client, { address: resource.address, fn, args, blockNumber }), `${resource.id} ${check.functionName}`);
    proof.matched = sameJson(expected, proof.actual);
  } catch (error) {
    proof.error = safeError(error);
  }
  return { proof, fn };
}

function describe(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function recordGetter(result, proof) {
  result.proofs.push(proof);
  if (proof.error) result.reasons.push(`Getter ${proof.name} read failed: ${proof.error}`);
  else if (!proof.matched) result.reasons.push(`Getter ${proof.name} returned ${describe(proof.actual)}; expected ${describe(proof.expected)}.`);
}

function librariesFor(resource, artifact) {
  const declared = resource.libraries ?? resource.inputs?.libraries ?? {};
  const creationLinks = artifact.bytecode?.linkReferences ?? {};
  const fromInitcode = resource.initcode && Object.keys(creationLinks).length > 0 ? linkedLibraries(resource.initcode, creationLinks) : {};
  for (const [key, address] of Object.entries(fromInitcode)) {
    assert(declared[key] === undefined || lower(declared[key]) === address, `${resource.id} declares library ${key} at ${declared[key]}, but its initcode links ${address}.`);
  }
  return { ...fromInitcode, ...Object.fromEntries(Object.entries(declared).map(([key, address]) => [key, lower(address)])) };
}

/**
 * Returns the resource initcode, or derives it from the artifact, `inputs`, and `libraries` for an imported contract.
 * Returns null when the inputs cannot encode the constructor.
 */
function initcodeFor(resource) {
  if (resource.initcode) return resource.initcode;
  const artifact = resource.artifact;
  if (!artifact?.bytecode?.object || !Array.isArray(resource.inputs)) return null;
  const constructor = artifact.abi.find(item => item.type === 'constructor');
  try {
    const bytecode = linkBytecode(artifact.bytecode.object, artifact.bytecode.linkReferences ?? {}, resource.libraries ?? {});
    return encodeDeployData({ abi: artifact.abi, bytecode, args: abiArguments(constructor?.inputs ?? [], resource.inputs) });
  } catch {
    return null;
  }
}

function expectedRuntime(resource, artifact) {
  const links = artifact.deployedBytecode.linkReferences ?? {};
  const libraries = librariesFor(resource, artifact);
  const used = new Set(Object.entries(links).flatMap(([file, names]) => Object.keys(names).map(name => `${file}:${name}`)));
  const runtime = linkBytecode(artifact.deployedBytecode.object, links, Object.fromEntries(Object.entries(libraries).filter(([key]) => used.has(key))));
  return hasLibraryGuard(runtime) ? fillLibraryGuard(runtime, resource.address) : runtime;
}

function mismatchReason(difference) {
  if (difference.reason === 'length') return `Live runtime is ${difference.liveBytes} bytes; the artifact runtime is ${difference.expectedBytes} bytes.`;
  if (difference.region === 'metadata') {
    return `Live runtime differs from the artifact only in its CBOR metadata, so it comes from a different build (metadata hash ${difference.expectedMetadataHash} expected, ${difference.liveMetadataHash} live).`;
  }
  if (difference.region === 'library') return `Live runtime links a different address for library ${difference.library} (byte ${difference.offset}).`;
  if (difference.region === 'library-guard') return 'Live library call guard holds a different address, so this library code belongs to another address.';
  return `Live runtime differs from the artifact at byte ${difference.offset}.`;
}

function immutableLabel(info, id) {
  return info?.name ? `${info.name} (AST ${id})` : `AST ${id}`;
}

async function creationEvidence(result, resource, client, transactionHash, blockNumber, code) {
  const creation = await verifyCreation(client, resource, transactionHash, { blockNumber, liveCode: code });
  const method = creation.kind === 'create2' ? 'create2-transaction' : 'create-replay';
  result.proofs.push({ name: 'creation', method, expected: creation.initcodeHash ?? null, actual: transactionHash, matched: creation.status === 'verified' });
  result.evidence.creation = creation;
  if (creation.status === 'conflict') result.reasons.push(...creation.reasons);
  return creation.status === 'verified' ? method : null;
}

async function simulationEvidence(result, resource, client, options, code, comparison, covered) {
  const { factory, salt, initcode } = resource;
  assert(lower(create2Address(factory.address, salt, initcode)) === lower(resource.address), `${resource.id} address is not the CREATE2 address of its factory, salt, and initcode.`);
  const factoryCode = await client.getCode({ address: factory.address, ...at(options.blockNumber) });
  const factoryHash = hasCode(factoryCode) ? keccak256(factoryCode) : null;
  const factoryMatched = factoryHash === lower(factory.codeHash);
  result.proofs.push({ name: 'factory', method: 'code-hash', expected: lower(factory.codeHash), actual: factoryHash, matched: factoryMatched });
  if (!factoryMatched) {
    result.missingProofs.push('The CREATE2 factory code differs from its expected hash, so the creation simulation did not run.');
    return null;
  }
  let runtime;
  try {
    runtime = await simulateCreate2(client, { factory: factory.address, salt, initcode, address: resource.address, blockNumber: options.blockNumber, account: options.account });
  } catch (error) {
    const proof = { name: 'runtime', method: 'create2-simulation', expected: null, actual: result.codeHash, matched: false, error: safeError(error) };
    result.proofs.push(proof);
    result.evidence.simulation = { error: proof.error };
    return null;
  }
  const simulatedHash = keccak256(runtime);
  const matched = simulatedHash === result.codeHash;
  result.proofs.push({ name: 'runtime', method: 'create2-simulation', expected: simulatedHash, actual: result.codeHash, matched });
  if (matched) return 'create2-simulation';
  const references = resource.artifact.deployedBytecode.immutableReferences ?? {};
  const simulated = compareRuntime(code, runtime, references);
  result.evidence.simulation = { runtimeHash: simulatedHash, sameOutsideImmutables: simulated.mode !== 'mismatch', differingImmutables: [] };
  if (simulated.mode === 'mismatch') return null;
  for (const entry of simulated.immutables) {
    const live = comparison.immutables.find(item => item.id === entry.id);
    if (live && entry.consistent && live.value === entry.value) covered.set(entry.id, 'create2-simulation');
    else result.evidence.simulation.differingImmutables.push({ id: entry.id, simulated: entry.value });
  }
  return null;
}

async function verifyContract(resource, client, options) {
  const result = newResult(resource);
  const artifact = resource.artifact;
  assert(typeof artifact?.deployedBytecode?.object === 'string', `${resource.id} needs a normalized artifact.`);
  const blockNumber = blockOf(options.blockNumber);
  const code = await client.getCode({ address: resource.address, ...at(blockNumber) });
  if (!hasCode(code)) {
    result.reasons.push('No code at the address.');
    return finish(result);
  }
  result.codeHash = keccak256(code);
  const references = artifact.deployedBytecode.immutableReferences ?? {};
  const immutableCount = immutableEntries(references).length;
  const expected = expectedRuntime(resource, artifact);
  const comparison = compareRuntime(expected, code, references, artifact.deployedBytecode.linkReferences ?? {});
  result.evidence = { expectedSkeletonHash: comparison.expectedSkeletonHash, liveSkeletonHash: comparison.liveSkeletonHash, immutables: [] };

  if (comparison.mode === 'mismatch') {
    if (comparison.difference.region === 'code' && hasLibraryGuard(artifact.deployedBytecode.object) && comparison.difference.offset >= 1 && comparison.difference.offset <= 20) {
      comparison.difference.region = 'library-guard';
    }
    result.codeComparison = { mode: 'mismatch', matched: false };
    result.proofs.push({ name: 'runtime', method: immutableCount > 0 ? 'masked-runtime' : 'artifact-runtime', expected: comparison.expectedSkeletonHash, actual: comparison.liveSkeletonHash, matched: false });
    if (comparison.difference.region === 'metadata') {
      result.proofs.push({ name: 'metadata', method: 'cbor-metadata', expected: comparison.difference.expectedMetadataHash, actual: comparison.difference.liveMetadataHash, matched: false });
    }
    result.evidence.difference = comparison.difference;
    result.reasons.push(mismatchReason(comparison.difference));
    return finish(result);
  }

  let exact = null;
  if (immutableCount === 0) {
    result.codeComparison = { mode: 'exact', matched: true };
    result.proofs.push({ name: 'runtime', method: 'artifact-runtime', expected: keccak256(expected), actual: result.codeHash, matched: true });
    exact = 'artifact-runtime';
  } else {
    result.codeComparison = { mode: 'masked', matched: true };
    result.proofs.push({ name: 'runtime-skeleton', method: 'masked-runtime', expected: comparison.expectedSkeletonHash, actual: comparison.liveSkeletonHash, matched: true });
  }
  const info = new Map((artifact.immutables ?? []).map(item => [item.id, item]));
  for (const entry of comparison.immutables) {
    if (!entry.consistent) result.reasons.push(`Immutable ${immutableLabel(info.get(entry.id), entry.id)} holds different values at its code ranges.`);
  }

  const expectedCodeHash = resource.expectedCodeHash ?? resource.codeHash ?? null;
  if (expectedCodeHash) {
    const matched = lower(expectedCodeHash) === result.codeHash;
    result.proofs.push({ name: 'runtime', method: 'expected-code-hash', expected: lower(expectedCodeHash), actual: result.codeHash, matched });
    if (!matched) result.reasons.push(`Live runtime hash ${result.codeHash} differs from the expected code hash ${lower(expectedCodeHash)}.`);
    else exact ??= 'expected-code-hash';
  }

  if (!exact && options.transactionHash) exact = await creationEvidence(result, resource, client, options.transactionHash, blockNumber, code);

  const covered = new Map();
  const deployable = Boolean(resource.salt && resource.factory && resource.initcode);
  if (!exact && deployable && options.simulate !== false) {
    exact = await simulationEvidence(result, resource, client, { ...options, blockNumber }, code, comparison, covered);
  }

  const byGetter = new Map((artifact.immutables ?? []).filter(item => item.getter).map(item => [item.getter, item]));
  for (const check of resource.checks ?? []) {
    const { proof, fn } = await getterProof(client, resource, check, artifact.abi, blockNumber);
    recordGetter(result, proof);
    const immutable = byGetter.get(check.functionName);
    if (!immutable || (fn.inputs ?? []).length !== 0 || (fn.outputs ?? []).length !== 1) continue;
    const live = comparison.immutables.find(item => item.id === immutable.id);
    if (!live) continue;
    const expectedWord = encodeAbiParameters([fn.outputs[0]], abiArguments([fn.outputs[0]], [proof.expected]));
    const matched = expectedWord === live.value && live.consistent;
    result.proofs.push({ name: `immutable:${immutable.name}`, method: 'immutable-word', expected: expectedWord, actual: live.value, matched });
    if (matched) covered.set(immutable.id, 'immutable-word');
    else result.reasons.push(`Immutable ${immutableLabel(immutable, immutable.id)} holds ${live.value} in the live runtime; expected ${expectedWord}.`);
  }

  if (exact) result.codeComparison = { mode: 'exact', matched: true };
  for (const entry of comparison.immutables) {
    const item = info.get(entry.id);
    const provenBy = exact ?? covered.get(entry.id) ?? null;
    result.evidence.immutables.push({ id: entry.id, name: item?.name ?? null, value: entry.value, provenBy });
    if (provenBy) continue;
    const hint = item?.getter ? `declare a check on ${item.getter}()` : 'supply an expected code hash or creation evidence';
    result.missingProofs.push(`Immutable ${immutableLabel(item, entry.id)} at runtime byte ${entry.ranges.map(range => range.start).join(', ')} has no value proof; ${hint}.`);
  }
  return finish(result);
}

async function verifyExternal(resource, client, options) {
  const result = newResult(resource);
  const blockNumber = blockOf(options.blockNumber);
  const code = await client.getCode({ address: resource.address, ...at(blockNumber) });
  if (!hasCode(code)) {
    result.reasons.push('External has no code at its address.');
    return finish(result);
  }
  result.codeHash = keccak256(code);
  const expected = resource.expectedCodeHash ?? resource.codeHash ?? null;
  if (expected) {
    const matched = lower(expected) === result.codeHash;
    result.codeComparison = { mode: matched ? 'exact' : 'mismatch', matched };
    result.proofs.push({ name: 'runtime', method: 'expected-code-hash', expected: lower(expected), actual: result.codeHash, matched });
    if (!matched) result.reasons.push(`External runtime hash ${result.codeHash} differs from the expected code hash ${lower(expected)}.`);
  } else {
    result.codeComparison = { mode: 'presence', matched: true };
    result.missingProofs.push('External has no expected code hash; code presence alone does not prove its identity.');
  }
  const checks = resource.checks ?? [];
  const abi = resource.abi ?? resource.artifact?.abi;
  for (const check of checks) recordGetter(result, (await getterProof(client, resource, check, abi, blockNumber)).proof);
  return finish(result);
}

async function verifyCall(resource, client, options) {
  const result = newResult(resource);
  const blockNumber = blockOf(options.blockNumber);
  const after = resource.after;
  const before = resource.before;
  assert(after?.functionName && Object.hasOwn(after, 'expected'), `${resource.id} needs after.functionName and after.expected.`);
  assert(before && Object.hasOwn(before, 'expected'), `${resource.id} needs before.expected.`);
  assert(!before.functionName || before.functionName === after.functionName, `${resource.id} reads different functions before and after the call.`);
  const abi = resource.abi ?? resource.targetArtifact?.abi ?? resource.artifact?.abi;
  const args = after.args ?? [];
  const fn = abiFunction(abi, after.functionName, args.length, resource.id);
  const expectedAfter = normalizeOutputs(fn.outputs ?? [], after.expected, `${resource.id} after.expected`);
  const expectedBefore = normalizeOutputs(fn.outputs ?? [], before.expected, `${resource.id} before.expected`);
  const binding = { name: resource.id, functionName: after.functionName, expectedBefore, expectedAfter, actual: null, observed: 'read-failed' };
  if (args.length > 0) binding.args = args;
  result.bindingChecks.push(binding);

  const code = await client.getCode({ address: resource.address, ...at(blockNumber) });
  if (!hasCode(code)) {
    binding.targetAbsent = true;
    binding.error = 'Target contract has no code.';
    result.missingProofs.push('Target contract has no code yet, so the binding cannot be read.');
    return finish(result);
  }
  result.codeHash = keccak256(code);
  result.codeComparison = { mode: 'presence', matched: true };
  try {
    binding.actual = normalizeOutputs(fn.outputs ?? [], await readFunction(client, { address: resource.address, fn, args, blockNumber }), `${resource.id} ${after.functionName}`);
  } catch (error) {
    binding.error = safeError(error);
    result.reasons.push(`Binding read ${after.functionName} failed: ${binding.error}`);
    return finish(result);
  }
  if (sameJson(binding.actual, expectedAfter)) binding.observed = 'after';
  else if (sameJson(binding.actual, expectedBefore)) binding.observed = 'before';
  else binding.observed = 'other';
  if (binding.observed === 'before') result.missingProofs.push(`Binding ${after.functionName} is at its allowed before value; the call is pending.`);
  if (binding.observed === 'other') result.reasons.push(`Binding ${after.functionName} is ${describe(binding.actual)}, which is neither the allowed before value ${describe(expectedBefore)} nor the desired value ${describe(expectedAfter)}.`);
  return finish(result);
}

/**
 * Reads the chain and returns proof for one prepared resource. It never signs or sends a transaction.
 * `options.blockNumber` anchors every read, `options.transactionHash` adds creation evidence, `options.simulate: false`
 * turns off the CREATE2 simulation, and `options.account` sets the simulated transaction origin.
 */
export async function verifyResource(resource, client, options = {}) {
  assert(resource && typeof resource.id === 'string' && typeof resource.address === 'string', 'Verification needs a prepared resource with id and address.');
  if (resource.kind === 'contract') return verifyContract(resource, client, options);
  if (resource.kind === 'external') return verifyExternal(resource, client, options);
  if (resource.kind === 'call') return verifyCall(resource, client, options);
  throw new Error(`${resource.id} has unknown kind ${resource.kind}.`);
}

/**
 * Checks that `transactionHash` created the resource from its expected initcode and replays the creation at the parent
 * block. A direct CREATE must have created this address from the same initcode; a CREATE2 transaction must send
 * `salt || initcode` to the resource factory. Evidence that concerns another address or payload is `unverified`, not
 * proof. A direct CREATE of this address from different initcode is a `conflict`.
 */
export async function verifyCreation(client, resource, transactionHash, options = {}) {
  const result = { kind: null, transactionHash, address: resource.address, status: 'unverified', matched: false, exactRuntime: false, codeHash: null, initcodeHash: null, blockNumber: null, reasons: [] };
  let transaction;
  let receipt;
  try {
    transaction = await client.getTransaction({ hash: transactionHash });
    receipt = await client.getTransactionReceipt({ hash: transactionHash });
  } catch (error) {
    result.reasons.push(`Creation transaction is not available: ${safeError(error)}`);
    return result;
  }
  result.blockNumber = receipt.blockNumber.toString();
  if (receipt.status !== 'success') {
    result.reasons.push('Creation transaction failed.');
    return result;
  }
  const initcode = initcodeFor(resource);
  if (!initcode) {
    result.reasons.push('Resource inputs do not encode its constructor, so there is no expected initcode to compare with the creation transaction.');
    return result;
  }
  result.initcodeHash = keccak256(initcode);
  const live = options.liveCode ?? await client.getCode({ address: resource.address, ...at(blockOf(options.blockNumber)) });
  if (!hasCode(live)) {
    result.status = 'conflict';
    result.reasons.push('No code at the address.');
    return result;
  }
  result.codeHash = keccak256(live);
  const input = lower(transaction.input);
  const parent = receipt.blockNumber > 0n ? receipt.blockNumber - 1n : undefined;
  let replay;
  if (transaction.to === null || transaction.to === undefined) {
    result.kind = 'create';
    if (lower(receipt.contractAddress) !== lower(resource.address)) {
      result.reasons.push(`The transaction created ${receipt.contractAddress}, not this address.`);
      return result;
    }
    if (input !== lower(initcode)) {
      result.status = 'conflict';
      result.reasons.push('The transaction that created this address used different creation code or constructor arguments.');
      return result;
    }
    result.matched = true;
    replay = () => simulateCreate(client, { from: transaction.from, initcode: transaction.input, blockNumber: parent });
  } else if (resource.factory && lower(transaction.to) === lower(resource.factory.address)) {
    result.kind = 'create2';
    if (input !== lower(concatHex([resource.salt, initcode]))) {
      result.reasons.push('The factory transaction sent a different salt or initcode.');
      return result;
    }
    if (lower(create2Address(resource.factory.address, resource.salt, initcode)) !== lower(resource.address)) {
      result.reasons.push('The factory transaction creates a different address.');
      return result;
    }
    result.matched = true;
    replay = () => simulateCreate2(client, { factory: resource.factory.address, salt: resource.salt, initcode, address: resource.address, blockNumber: parent, account: transaction.from });
  } else {
    result.reasons.push('The transaction is neither a direct CREATE nor a call to the resource CREATE2 factory.');
    return result;
  }
  if (parent === undefined) {
    result.reasons.push('Cannot replay a creation from the genesis block.');
    return result;
  }
  try {
    const runtime = await replay();
    result.exactRuntime = lower(runtime) === lower(live);
  } catch (error) {
    result.reasons.push(`Creation replay failed: ${safeError(error)}`);
    return result;
  }
  if (result.exactRuntime) result.status = 'verified';
  else result.reasons.push('Replay of the creation at the parent block returned different runtime code.');
  return result;
}
