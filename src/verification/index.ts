import { concatHex, encodeAbiParameters, encodeDeployData, keccak256 } from 'viem';
import {
  compareRuntime,
  create2Address,
  fillLibraryGuard,
  hasLibraryGuard,
  immutableEntries,
  linkBytecode,
  linkedLibraries,
} from './bytecode.ts';
import { replayProviderFailure, simulateCreate2 } from './simulate.ts';
import { abiArguments, normalizeOutputs, safeError, sameJson } from './values.ts';
import { abiFunction } from '../validation/index.ts';
import { DEFAULT_FACTORY } from '../spec/index.ts';
import { validateCreationProof } from './creation-proof.ts';
import { STATEFUL_CONSTRUCTOR_LIMITATION_URL } from './limitations.ts';
import {
  pinnedChildAddress,
  pinnedJournalCommitment,
  samePinnedCommitments,
} from './pinned-runtime.ts';
import type { AbiFunction } from 'viem';
import type { NormalizedArtifact, NamedImmutable } from '../artifacts/types.ts';
import type {
  DeployableContract,
  PreparedCall,
  PreparedCheck,
  PreparedContract,
  PreparedExternal,
  PreparedResource,
} from '../planning/types.ts';
import type { Address, Client, Hash, Hex, JsonValue } from '../types.ts';
import type {
  BindingCheck,
  CreationEvidence,
  CreationProof,
  CreationVerification,
  PinnedChildEvidence,
  Proof,
  ProofMethod,
  RuntimeComparison,
  RuntimeDifference,
  SimulationEvidence,
  VerificationEvidence,
  VerificationResult,
  VerificationStatus,
  VerifyCreationOptions,
  VerifyOptions,
} from './types.ts';

export {
  compareRuntime,
  create2Address,
  fillLibraryGuard,
  hasLibraryGuard,
  linkBytecode,
  linkedLibraries,
  linkPlaceholder,
  normalizeCode,
} from './bytecode.ts';
export { cidV0, decodeMetadataTail, ipfsMetadataHash } from './metadata.ts';
export { PROBE_ADDRESS, PROBE_CODE, simulateCreate, simulateCreate2 } from './simulate.ts';
export { abiArguments, normalizeAbiValue, normalizeOutputs, safeError } from './values.ts';

const PINNED_MINT = Symbol('pinned-runtime apply mint');

/** Internal apply entry point. A public verification call can revalidate a saved pin but cannot mint one. */
export async function verifyResourceForApply(
  resource: PreparedResource,
  client: Client,
  options: VerifyOptions = {},
): Promise<VerificationResult> {
  return verifyResource(resource, client, { ...options, [PINNED_MINT]: true } as VerifyOptions);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function blockOf(value: VerifyOptions['blockNumber']): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) return BigInt(value);
  throw new Error(`Invalid block number ${String(value)}.`);
}

function at(blockNumber: bigint | undefined): { blockNumber?: bigint } {
  return blockNumber === undefined ? {} : { blockNumber };
}

function hasCode(code: unknown): code is Hex {
  return typeof code === 'string' && code !== '0x' && code.length > 2;
}

function lower<T extends string | null | undefined>(hex: T): T {
  return (typeof hex === 'string' ? hex.toLowerCase() : hex) as T;
}

function newResult(resource: PreparedResource): VerificationResult {
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

function statusFor({
  reasons,
  missingProofs,
}: Pick<VerificationResult, 'reasons' | 'missingProofs'>): VerificationStatus {
  if (reasons.length > 0) return 'conflict';
  if (missingProofs.length > 0) return 'unverified';
  return 'verified';
}

function finish(result: VerificationResult): VerificationResult {
  result.status = statusFor(result);
  if (result.status !== 'verified') delete result.creationProof;
  return result;
}

async function readFunction(
  client: Client,
  {
    address,
    fn,
    args,
    blockNumber,
  }: { address: Address; fn: AbiFunction; args: JsonValue[]; blockNumber: bigint | undefined },
): Promise<unknown> {
  return client.readContract({
    address,
    abi: [fn],
    functionName: fn.name,
    args: abiArguments(fn.inputs ?? [], args),
    ...at(blockNumber),
  });
}

async function getterProof(
  client: Client,
  resource: PreparedResource,
  check: PreparedCheck & { args?: JsonValue[] },
  abi: NormalizedArtifact['abi'] | undefined,
  blockNumber: bigint | undefined,
): Promise<{ proof: Proof; fn: AbiFunction }> {
  const args = check.args ?? [];
  const fn = abiFunction(abi, check.functionName, args.length, resource.id);
  const expected = normalizeOutputs(
    fn.outputs ?? [],
    check.expected,
    `${resource.id} expected ${check.functionName}`,
  );
  const proof: Proof = {
    name: check.functionName,
    method: 'getter',
    expected,
    actual: null,
    matched: false,
  };
  if (args.length > 0) proof.args = args;
  try {
    proof.actual = normalizeOutputs(
      fn.outputs ?? [],
      await readFunction(client, { address: resource.address, fn, args, blockNumber }),
      `${resource.id} ${check.functionName}`,
    );
    proof.matched = sameJson(expected, proof.actual);
  } catch (error) {
    proof.error = safeError(error);
  }
  return { proof, fn };
}

function describe(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function recordGetter(result: VerificationResult, proof: Proof): void {
  result.proofs.push(proof);
  if (proof.error) result.reasons.push(`Getter ${proof.name} read failed: ${proof.error}`);
  else if (!proof.matched)
    result.reasons.push(
      `Getter ${proof.name} returned ${describe(proof.actual)}; expected ${describe(proof.expected)}.`,
    );
}

function librariesFor(
  resource: PreparedContract,
  artifact: NormalizedArtifact,
): Record<string, Address> {
  const legacy = resource as PreparedContract & {
    inputs: JsonValue[] & { libraries?: Record<string, Address> };
  };
  const declared = resource.libraries ?? legacy.inputs?.libraries ?? {};
  const creationLinks = artifact.bytecode?.linkReferences ?? {};
  const fromInitcode =
    resource.initcode && Object.keys(creationLinks).length > 0
      ? linkedLibraries(resource.initcode, creationLinks)
      : {};
  for (const [key, address] of Object.entries(fromInitcode)) {
    assert(
      declared[key] === undefined || lower(declared[key]) === address,
      `${resource.id} declares library ${key} at ${declared[key]}, but its initcode links ${address}.`,
    );
  }
  return {
    ...fromInitcode,
    ...Object.fromEntries(Object.entries(declared).map(([key, address]) => [key, lower(address)])),
  };
}

/**
 * Returns the resource initcode, or derives it from the artifact, `inputs`, and `libraries` for an imported contract.
 * Returns null when the inputs cannot encode the constructor.
 */
function initcodeFor(resource: PreparedContract): Hex | null {
  if (resource.initcode) return resource.initcode;
  const artifact = resource.artifact;
  if (!artifact?.bytecode?.object || !Array.isArray(resource.inputs)) return null;
  const constructor = artifact.abi.find((item) => item.type === 'constructor');
  try {
    const bytecode = linkBytecode(
      artifact.bytecode.object,
      artifact.bytecode.linkReferences ?? {},
      resource.libraries ?? {},
    );
    return encodeDeployData({
      abi: artifact.abi,
      bytecode,
      args: abiArguments(constructor?.inputs ?? [], resource.inputs),
    });
  } catch {
    return null;
  }
}

function expectedRuntime(resource: PreparedContract, artifact: NormalizedArtifact): Hex {
  const links = artifact.deployedBytecode.linkReferences ?? {};
  const libraries = librariesFor(resource, artifact);
  const used = new Set(
    Object.entries(links).flatMap(([file, names]) =>
      Object.keys(names).map((name) => `${file}:${name}`),
    ),
  );
  const runtime = linkBytecode(
    artifact.deployedBytecode.object,
    links,
    Object.fromEntries(Object.entries(libraries).filter(([key]) => used.has(key))),
  );
  return hasLibraryGuard(runtime) ? fillLibraryGuard(runtime, resource.address) : runtime;
}

function mismatchReason(difference: RuntimeDifference): string {
  if (difference.reason === 'length')
    return `Live runtime is ${difference.liveBytes} bytes; the artifact runtime is ${difference.expectedBytes} bytes.`;
  if (difference.region === 'metadata') {
    return `Live runtime differs from the artifact only in its CBOR metadata, so it comes from a different build (metadata hash ${difference.expectedMetadataHash} expected, ${difference.liveMetadataHash} live).`;
  }
  if (difference.region === 'library')
    return `Live runtime links a different address for library ${difference.library} (byte ${difference.offset}).`;
  if (difference.region === 'library-guard')
    return 'Live library call guard holds a different address, so this library code belongs to another address.';
  return `Live runtime differs from the artifact at byte ${difference.offset}.`;
}

function immutableLabel(info: NamedImmutable | undefined, id: string): string {
  return info?.name ? `${info.name} (AST ${id})` : `AST ${id}`;
}

async function creationEvidence(
  result: VerificationResult,
  resource: PreparedContract,
  client: Client,
  transactionHash: Hash,
  options: VerifyOptions,
  code: Hex,
): Promise<ProofMethod | null> {
  const creation = await verifyCreation(client, resource, transactionHash, {
    ...options,
    liveCode: code,
  });
  const method =
    creation.method === 'pinned-runtime'
      ? 'pinned-runtime'
      : creation.kind === 'create2'
        ? 'create2-transaction'
        : 'create-transaction';
  result.proofs.push({
    name: 'creation',
    method,
    expected: creation.initcodeHash ?? null,
    actual: transactionHash,
    matched: creation.status === 'verified',
  });
  const { proof, ...evidence }: CreationEvidence & { proof?: CreationProof } = creation;
  if (result.evidence) result.evidence.creation = evidence;
  if (creation.status === 'verified' && creation.proof) result.creationProof = creation.proof;
  if (creation.status === 'conflict') result.reasons.push(...creation.reasons);
  if (creation.status === 'unverified') result.missingProofs.push(...creation.reasons);
  return creation.status === 'verified' ? method : null;
}

async function simulationEvidence(
  result: VerificationResult,
  resource: DeployableContract,
  client: Client,
  options: VerifyOptions,
  code: Hex,
  comparison: Exclude<RuntimeComparison, { mode: 'mismatch' }>,
  covered: Map<string, ProofMethod>,
): Promise<ProofMethod | null> {
  const { factory, salt, initcode } = resource;
  const blockNumber = blockOf(options.blockNumber);
  assert(
    lower(create2Address(factory.address, salt, initcode)) === lower(resource.address),
    `${resource.id} address is not the CREATE2 address of its factory, salt, and initcode.`,
  );
  const factoryCode = await client.getCode({ address: factory.address, ...at(blockNumber) });
  const factoryHash = hasCode(factoryCode) ? keccak256(factoryCode) : null;
  const factoryMatched = factoryHash === lower(factory.codeHash);
  result.proofs.push({
    name: 'factory',
    method: 'code-hash',
    expected: lower(factory.codeHash),
    actual: factoryHash,
    matched: factoryMatched,
  });
  if (!factoryMatched) {
    result.missingProofs.push(
      'The CREATE2 factory code differs from its expected hash, so the creation simulation did not run.',
    );
    return null;
  }
  let runtime;
  try {
    runtime = await simulateCreate2(client, {
      factory: factory.address,
      salt,
      initcode,
      address: resource.address,
      ...(blockNumber === undefined ? {} : { blockNumber }),
      ...(options.account ? { account: options.account } : {}),
    });
  } catch (error) {
    const reason = safeError(error);
    const proof: Proof = {
      name: 'runtime',
      method: 'create2-simulation',
      expected: null,
      actual: result.codeHash,
      matched: false,
      error: reason,
    };
    result.proofs.push(proof);
    if (result.evidence) result.evidence.simulation = { error: reason };
    return null;
  }
  const simulatedHash = keccak256(runtime);
  const matched = simulatedHash === result.codeHash;
  result.proofs.push({
    name: 'runtime',
    method: 'create2-simulation',
    expected: simulatedHash,
    actual: result.codeHash,
    matched,
  });
  if (matched) return 'create2-simulation';
  const references = resource.artifact.deployedBytecode.immutableReferences ?? {};
  const simulated = compareRuntime(code, runtime, references);
  const simulation: SimulationEvidence = {
    runtimeHash: simulatedHash,
    sameOutsideImmutables: simulated.mode !== 'mismatch',
    differingImmutables: [],
  };
  if (result.evidence) result.evidence.simulation = simulation;
  if (simulated.mode === 'mismatch') return null;
  for (const entry of simulated.immutables) {
    const live = comparison.immutables.find((item) => item.id === entry.id);
    if (live && entry.consistent && live.value === entry.value)
      covered.set(entry.id, 'create2-simulation');
    else simulation.differingImmutables.push({ id: entry.id, simulated: entry.value });
  }
  return null;
}

/**
 * Collects runtime, immutable, creation, simulation, and getter evidence for a contract.
 * `finish` turns mismatches into conflict, missing proof into unverified, and complete
 * matching evidence into verified.
 */
function isDeployable(resource: PreparedContract): resource is DeployableContract {
  return Boolean(resource.salt && resource.factory && resource.initcode && resource.initcodeHash);
}

async function verifyContract(
  resource: PreparedContract,
  client: Client,
  options: VerifyOptions,
): Promise<VerificationResult> {
  const result = newResult(resource);
  const artifact = resource.artifact;
  assert(
    typeof artifact?.deployedBytecode?.object === 'string',
    `${resource.id} needs a normalized artifact.`,
  );
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
  const comparison = compareRuntime(
    expected,
    code,
    references,
    artifact.deployedBytecode.linkReferences ?? {},
  );
  const evidence: VerificationEvidence = {
    expectedSkeletonHash: comparison.expectedSkeletonHash,
    liveSkeletonHash: comparison.liveSkeletonHash,
    immutables: [],
  };
  result.evidence = evidence;

  if (comparison.mode === 'mismatch') {
    if (
      comparison.difference.reason === 'content' &&
      comparison.difference.region === 'code' &&
      hasLibraryGuard(artifact.deployedBytecode.object) &&
      comparison.difference.offset >= 1 &&
      comparison.difference.offset <= 20
    ) {
      comparison.difference.region = 'library-guard';
    }
    result.codeComparison = { mode: 'mismatch', matched: false };
    result.proofs.push({
      name: 'runtime',
      method: immutableCount > 0 ? 'masked-runtime' : 'artifact-runtime',
      expected: comparison.expectedSkeletonHash,
      actual: comparison.liveSkeletonHash,
      matched: false,
    });
    if (comparison.difference.reason === 'content' && comparison.difference.region === 'metadata') {
      result.proofs.push({
        name: 'metadata',
        method: 'cbor-metadata',
        expected: comparison.difference.expectedMetadataHash,
        actual: comparison.difference.liveMetadataHash,
        matched: false,
      });
    }
    evidence.difference = comparison.difference;
    result.reasons.push(mismatchReason(comparison.difference));
    return finish(result);
  }

  let exact: ProofMethod | null = null;
  if (immutableCount === 0) {
    result.codeComparison = { mode: 'exact', matched: true };
    result.proofs.push({
      name: 'runtime',
      method: 'artifact-runtime',
      expected: keccak256(expected),
      actual: result.codeHash,
      matched: true,
    });
    exact = 'artifact-runtime';
  } else {
    result.codeComparison = { mode: 'masked', matched: true };
    result.proofs.push({
      name: 'runtime-skeleton',
      method: 'masked-runtime',
      expected: comparison.expectedSkeletonHash,
      actual: comparison.liveSkeletonHash,
      matched: true,
    });
  }
  const info = new Map((artifact.immutables ?? []).map((item) => [item.id, item]));
  for (const entry of comparison.immutables) {
    if (!entry.consistent)
      result.reasons.push(
        `Immutable ${immutableLabel(info.get(entry.id), entry.id)} holds different values at its code ranges.`,
      );
  }

  const expectedCodeHash =
    resource.expectedCodeHash ??
    (resource as PreparedContract & { codeHash?: Hash }).codeHash ??
    null;
  if (expectedCodeHash) {
    const matched = lower(expectedCodeHash) === result.codeHash;
    result.proofs.push({
      name: 'runtime',
      method: 'expected-code-hash',
      expected: lower(expectedCodeHash),
      actual: result.codeHash,
      matched,
    });
    if (!matched)
      result.reasons.push(
        `Live runtime hash ${result.codeHash} differs from the expected code hash ${lower(expectedCodeHash)}.`,
      );
    else exact ??= 'expected-code-hash';
  }

  const transactionHash = options.transactionHash ?? options.creationProof?.transactionHash;
  if (transactionHash) {
    const creationMethod = await creationEvidence(
      result,
      resource,
      client,
      transactionHash,
      { ...options, ...at(blockNumber) },
      code,
    );
    exact ??= creationMethod;
  }

  const covered = new Map<string, ProofMethod>();
  if (!exact && isDeployable(resource) && options.simulate !== false) {
    exact = await simulationEvidence(
      result,
      resource,
      client,
      { ...options, ...at(blockNumber) },
      code,
      comparison,
      covered,
    );
  }

  const byGetter = new Map(
    (artifact.immutables ?? []).filter((item) => item.getter).map((item) => [item.getter, item]),
  );
  for (const check of resource.checks ?? []) {
    const { proof, fn } = await getterProof(client, resource, check, artifact.abi, blockNumber);
    recordGetter(result, proof);
    const immutable = byGetter.get(check.functionName);
    if (!immutable || (fn.inputs ?? []).length !== 0 || (fn.outputs ?? []).length !== 1) continue;
    const live = comparison.immutables.find((item) => item.id === immutable.id);
    if (!live) continue;
    const output = fn.outputs[0];
    assert(output, `${resource.id} getter has no output.`);
    const expectedWord = encodeAbiParameters(
      [output],
      abiArguments([output], [proof.expected]) as [unknown],
    );
    const matched = expectedWord === live.value && live.consistent;
    result.proofs.push({
      name: `immutable:${immutable.name}`,
      method: 'immutable-word',
      expected: expectedWord,
      actual: live.value,
      matched,
    });
    if (matched) covered.set(immutable.id, 'immutable-word');
    else
      result.reasons.push(
        `Immutable ${immutableLabel(immutable, immutable.id)} holds ${live.value} in the live runtime; expected ${expectedWord}.`,
      );
  }

  if (exact) result.codeComparison = { mode: 'exact', matched: true };
  for (const entry of comparison.immutables) {
    const item = info.get(entry.id);
    const provenBy = exact ?? covered.get(entry.id) ?? null;
    evidence.immutables.push({
      id: entry.id,
      name: item?.name ?? null,
      value: entry.value,
      provenBy,
    });
    if (provenBy) continue;
    const hint = item?.getter
      ? `declare a check on ${item.getter}()`
      : 'supply an expected code hash or creation evidence';
    result.missingProofs.push(
      `Immutable ${immutableLabel(item, entry.id)} at runtime byte ${entry.ranges.map((range) => range.start).join(', ')} has no value proof; ${hint}.`,
    );
  }
  return finish(result);
}

async function verifyExternal(
  resource: PreparedExternal,
  client: Client,
  options: VerifyOptions,
): Promise<VerificationResult> {
  const result = newResult(resource);
  const blockNumber = blockOf(options.blockNumber);
  const code = await client.getCode({ address: resource.address, ...at(blockNumber) });
  if (!hasCode(code)) {
    result.reasons.push('External has no code at its address.');
    return finish(result);
  }
  result.codeHash = keccak256(code);
  const expected =
    resource.expectedCodeHash ??
    (resource as PreparedExternal & { codeHash?: Hash }).codeHash ??
    null;
  if (expected) {
    const matched = lower(expected) === result.codeHash;
    result.codeComparison = { mode: matched ? 'exact' : 'mismatch', matched };
    result.proofs.push({
      name: 'runtime',
      method: 'expected-code-hash',
      expected: lower(expected),
      actual: result.codeHash,
      matched,
    });
    if (!matched)
      result.reasons.push(
        `External runtime hash ${result.codeHash} differs from the expected code hash ${lower(expected)}.`,
      );
  } else {
    result.codeComparison = { mode: 'presence', matched: true };
    result.missingProofs.push(
      'External has no expected code hash; code presence alone does not prove its identity.',
    );
  }
  const checks = resource.checks ?? [];
  const abi =
    resource.abi ??
    (resource as PreparedExternal & { artifact?: NormalizedArtifact }).artifact?.abi;
  for (const check of checks)
    recordGetter(result, (await getterProof(client, resource, check, abi, blockNumber)).proof);
  return finish(result);
}

async function verifyCall(
  resource: PreparedCall,
  client: Client,
  options: VerifyOptions,
): Promise<VerificationResult> {
  const result = newResult(resource);
  const blockNumber = blockOf(options.blockNumber);
  const after = resource.after;
  const before = resource.before;
  assert(
    after?.functionName && Object.hasOwn(after, 'expected'),
    `${resource.id} needs after.functionName and after.expected.`,
  );
  assert(before && Object.hasOwn(before, 'expected'), `${resource.id} needs before.expected.`);
  assert(
    !before.functionName || before.functionName === after.functionName,
    `${resource.id} reads different functions before and after the call.`,
  );
  const abi =
    resource.abi ??
    resource.targetArtifact?.abi ??
    (resource as PreparedCall & { artifact?: NormalizedArtifact }).artifact?.abi;
  const args = after.args ?? [];
  const fn = abiFunction(abi, after.functionName, args.length, resource.id);
  const expectedAfter = normalizeOutputs(
    fn.outputs ?? [],
    after.expected,
    `${resource.id} after.expected`,
  );
  const expectedBefore = normalizeOutputs(
    fn.outputs ?? [],
    before.expected,
    `${resource.id} before.expected`,
  );
  const binding: BindingCheck = {
    name: resource.id,
    functionName: after.functionName,
    expectedBefore,
    expectedAfter,
    actual: null,
    observed: 'read-failed',
  };
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
    binding.actual = normalizeOutputs(
      fn.outputs ?? [],
      await readFunction(client, { address: resource.address, fn, args, blockNumber }),
      `${resource.id} ${after.functionName}`,
    );
  } catch (error) {
    binding.error = safeError(error);
    result.reasons.push(`Binding read ${after.functionName} failed: ${binding.error}`);
    return finish(result);
  }
  if (sameJson(binding.actual, expectedAfter)) binding.observed = 'after';
  else if (sameJson(binding.actual, expectedBefore)) binding.observed = 'before';
  else binding.observed = 'other';
  if (binding.observed === 'before')
    result.missingProofs.push(
      `Binding ${after.functionName} is at its allowed before value; the call is pending.`,
    );
  if (binding.observed === 'other')
    result.reasons.push(
      `Binding ${after.functionName} is ${describe(binding.actual)}, which is neither the allowed before value ${describe(expectedBefore)} nor the desired value ${describe(expectedAfter)}.`,
    );
  return finish(result);
}

/**
 * Reads the chain and returns proof for one prepared resource. It never signs or sends a transaction.
 * `options.blockNumber` anchors every read, `options.transactionHash` adds creation evidence, `options.simulate: false`
 * turns off the CREATE2 simulation, and `options.account` sets the simulated transaction origin.
 */
export async function verifyResource(
  resource: PreparedResource,
  client: Client,
  options: VerifyOptions = {},
): Promise<VerificationResult> {
  assert(
    resource && typeof resource.id === 'string' && typeof resource.address === 'string',
    'Verification needs a prepared resource with id and address.',
  );
  if (resource.kind === 'contract') return verifyContract(resource, client, options);
  if (resource.kind === 'external') return verifyExternal(resource, client, options);
  if (resource.kind === 'call') return verifyCall(resource, client, options);
  throw new Error(
    `${(resource as PreparedResource).id} has unknown kind ${(resource as PreparedResource).kind}.`,
  );
}

/** Check creation identity and the canonical receipt block; capture or revalidate an exact runtime anchor. */
export async function verifyCreation(
  client: Client,
  resource: PreparedContract,
  transactionHash: Hash,
  options: VerifyCreationOptions = {},
): Promise<CreationVerification> {
  const result: CreationVerification = {
    kind: null,
    transactionHash,
    address: resource.address,
    status: 'unverified',
    matched: false,
    exactRuntime: false,
    codeHash: null,
    initcodeHash: null,
    blockNumber: null,
    reasons: [],
  };
  const saved = options.creationProof ? validateCreationProof(options.creationProof) : null;
  if (saved && lower(saved.transactionHash) !== lower(transactionHash)) {
    result.reasons.push('Saved creation proof names a different transaction.');
    return result;
  }
  let transaction;
  let receipt;
  try {
    transaction = await client.getTransaction({ hash: transactionHash });
    receipt = await client.getTransactionReceipt({ hash: transactionHash });
  } catch (error) {
    if (replayProviderFailure(error)) result.replayFailure = 'provider';
    result.reasons.push(`Creation transaction is not available: ${safeError(error)}`);
    return result;
  }
  if (!transaction || !receipt) {
    result.reasons.push('Creation transaction or receipt is not available.');
    return result;
  }
  if (options.expectedCreator && lower(transaction.from) !== lower(options.expectedCreator)) {
    result.status = 'conflict';
    result.reasons.push(
      'Creation transaction came from a different signer than the planned deployment.',
    );
    return result;
  }
  if (saved && lower(transaction.from) !== lower(saved.creator)) {
    result.status = 'conflict';
    result.reasons.push('Creation transaction sender differs from the saved proof.');
    return result;
  }
  if (
    (transaction.hash && lower(transaction.hash) !== lower(transactionHash)) ||
    (receipt.transactionHash && lower(receipt.transactionHash) !== lower(transactionHash))
  ) {
    result.reasons.push('Creation transaction and receipt have different transaction identities.');
    return result;
  }
  result.blockNumber = receipt.blockNumber.toString();
  if (receipt.status !== 'success') {
    result.reasons.push('Creation transaction failed.');
    return result;
  }
  let chain: { id: number; genesisHash: Hash | null };
  let block: Awaited<ReturnType<Client['getBlock']>>;
  try {
    chain = {
      id: await client.getChainId(),
      genesisHash: (await client.getBlock({ blockNumber: 0n })).hash,
    };
    block = await client.getBlock({ blockNumber: receipt.blockNumber });
  } catch (error) {
    if (replayProviderFailure(error)) result.replayFailure = 'provider';
    result.reasons.push(`Creation block is not available: ${safeError(error)}`);
    return result;
  }
  if (
    options.chain &&
    (options.chain.id !== chain.id || lower(options.chain.genesisHash) !== lower(chain.genesisHash))
  ) {
    result.reasons.push('Creation proof chain differs from the connected chain.');
    return result;
  }
  if (
    !block?.hash ||
    !receipt.blockHash ||
    lower(block.hash) !== lower(receipt.blockHash) ||
    (transaction.blockHash && lower(transaction.blockHash) !== lower(receipt.blockHash)) ||
    (transaction.blockNumber !== undefined &&
      transaction.blockNumber !== null &&
      BigInt(transaction.blockNumber) !== BigInt(receipt.blockNumber))
  ) {
    result.reasons.push(
      'Creation receipt block is no longer canonical or disagrees with the transaction.',
    );
    return result;
  }
  const initcode = initcodeFor(resource);
  if (!initcode) {
    result.reasons.push(
      'Resource inputs do not encode its constructor, so there is no expected initcode to compare with the creation transaction.',
    );
    return result;
  }
  result.initcodeHash = keccak256(initcode);
  let live;
  try {
    live =
      options.liveCode ??
      (await client.getCode({ address: resource.address, ...at(blockOf(options.blockNumber)) }));
  } catch (error) {
    if (replayProviderFailure(error)) result.replayFailure = 'provider';
    result.reasons.push(`Current runtime is not available: ${safeError(error)}`);
    return result;
  }
  if (!hasCode(live)) {
    result.status = 'conflict';
    result.reasons.push('No code at the address.');
    return result;
  }
  result.codeHash = keccak256(live);
  const input = lower(transaction.input);
  let kind: 'create' | 'create2';
  if (transaction.to === null || transaction.to === undefined) {
    kind = result.kind = 'create';
    if (lower(receipt.contractAddress) !== lower(resource.address)) {
      result.reasons.push(`The transaction created ${receipt.contractAddress}, not this address.`);
      return result;
    }
    if (input !== lower(initcode)) {
      result.status = 'conflict';
      result.reasons.push(
        'The transaction that created this address used different creation code or constructor arguments.',
      );
      return result;
    }
    result.matched = true;
  } else if (resource.factory && lower(transaction.to) === lower(resource.factory.address)) {
    kind = result.kind = 'create2';
    assert(resource.salt, `${resource.id} needs a CREATE2 salt.`);
    if (input !== lower(concatHex([resource.salt, initcode]))) {
      result.reasons.push('The factory transaction sent a different salt or initcode.');
      return result;
    }
    if (
      lower(create2Address(resource.factory.address, resource.salt, initcode)) !==
      lower(resource.address)
    ) {
      result.reasons.push('The factory transaction creates a different address.');
      return result;
    }
    result.matched = true;
  } else {
    result.reasons.push(
      'The transaction is neither a direct CREATE nor a call to the resource CREATE2 factory.',
    );
    return result;
  }
  if (
    kind === 'create2' &&
    options.expectedCreator &&
    lower(resource.factory?.codeHash) !== lower(DEFAULT_FACTORY.codeHash)
  ) {
    result.reasons.push(
      'The CREATE2 factory does not have the bundled atomic bytecode, so a successful call cannot prove this signer created the contract.',
    );
    return result;
  }
  const pinned = resource.creationProofMode === 'pinned-runtime';
  if (
    pinned &&
    (kind !== 'create2' ||
      lower(resource.factory?.address) !== lower(DEFAULT_FACTORY.address) ||
      lower(resource.factory?.codeHash) !== lower(DEFAULT_FACTORY.codeHash))
  ) {
    result.reasons.push(
      'Pinned-runtime requires a deployment through the bundled atomic CREATE2 factory.',
    );
    return result;
  }
  if (saved && (saved.kind === 'create2' && saved.method === 'pinned-runtime') !== pinned) {
    result.reasons.push('Saved creation proof method differs from the resource proof mode.');
    return result;
  }
  assert(
    chain.genesisHash && result.blockNumber && result.initcodeHash && result.codeHash,
    'Creation proof is missing chain or runtime identity.',
  );
  const base = {
    chain: { id: chain.id, genesisHash: lower(chain.genesisHash) },
    transactionHash: lower(transactionHash),
    creator: lower(transaction.from),
    blockNumber: result.blockNumber,
    blockHash: lower(receipt.blockHash),
    address: lower(resource.address),
    initcodeHash: result.initcodeHash,
    codeHash: result.codeHash,
  };
  const proof: CreationProof =
    kind === 'create2'
      ? {
          ...base,
          kind,
          factory: {
            address: lower(resource.factory!.address),
            codeHash: lower(resource.factory!.codeHash),
          },
          salt: lower(resource.salt!),
        }
      : { ...base, kind };
  if (kind === 'create2') {
    const factory = resource.factory;
    assert(factory, `${resource.id} needs a CREATE2 factory.`);
    let currentFactory;
    let receiptFactory;
    try {
      currentFactory = await client.getCode({
        address: factory.address,
        ...at(blockOf(options.blockNumber)),
      });
      if (!saved || pinned)
        receiptFactory = await client.getCode({
          address: factory.address,
          blockNumber: receipt.blockNumber,
        });
    } catch (error) {
      if (replayProviderFailure(error)) result.replayFailure = 'provider';
      result.reasons.push(`CREATE2 factory code is not available: ${safeError(error)}`);
      return result;
    }
    if (
      !hasCode(currentFactory) ||
      keccak256(currentFactory) !==
        (proof as Extract<CreationProof, { kind: 'create2' }>).factory.codeHash ||
      ((!saved || pinned) &&
        (!hasCode(receiptFactory) ||
          keccak256(receiptFactory) !==
            (proof as Extract<CreationProof, { kind: 'create2' }>).factory.codeHash))
    ) {
      result.reasons.push('CREATE2 factory code differs from its declared hash.');
      return result;
    }
  }
  if (saved) {
    const same = (left: string | null | undefined, right: string | null | undefined) =>
      lower(left) === lower(right);
    if (
      saved.chain.id !== proof.chain.id ||
      !same(saved.chain.genesisHash, proof.chain.genesisHash) ||
      saved.blockNumber !== proof.blockNumber ||
      !same(saved.blockHash, proof.blockHash) ||
      !same(saved.address, proof.address) ||
      !same(saved.creator, proof.creator) ||
      saved.kind !== proof.kind ||
      !same(saved.initcodeHash, proof.initcodeHash) ||
      !same(saved.codeHash, proof.codeHash) ||
      (kind === 'create2' &&
        saved.kind === 'create2' &&
        proof.kind === 'create2' &&
        (!same(saved.factory.address, proof.factory.address) ||
          !same(saved.factory.codeHash, proof.factory.codeHash) ||
          !same(saved.salt, proof.salt)))
    ) {
      result.reasons.push(
        'Saved creation proof differs from canonical deployment identity or current runtime.',
      );
      return result;
    }
    if (!pinned) {
      result.exactRuntime = true;
      result.status = 'verified';
      result.proof = proof;
      return result;
    }
  }
  let receiptCode;
  try {
    receiptCode = await client.getCode({
      address: resource.address,
      blockNumber: receipt.blockNumber,
    });
  } catch (error) {
    if (replayProviderFailure(error)) result.replayFailure = 'provider';
    result.reasons.push(`Runtime at the creation block is not available: ${safeError(error)}`);
    return result;
  }
  if (!hasCode(receiptCode) || keccak256(receiptCode) !== result.codeHash) {
    result.reasons.push('Runtime at the creation block differs from the current runtime.');
    return result;
  }
  if (kind === 'create') {
    result.exactRuntime = true;
    result.status = 'verified';
    result.proof = proof;
    return result;
  }
  if (pinned) {
    if (
      !saved &&
      (options as VerifyCreationOptions & { [PINNED_MINT]?: boolean })[PINNED_MINT] !== true
    ) {
      result.reasons.push(
        'A new pinned-runtime proof can be created only during apply from a pre-sign journal intent.',
      );
      return result;
    }
    if (
      !resource.expectedCodeHash ||
      !resource.createdCode?.length ||
      lower(result.codeHash) !== lower(resource.expectedCodeHash)
    ) {
      result.reasons.push('Parent runtime does not match the precommitted pinned-runtime hash.');
      return result;
    }
    const artifactRuntime = expectedRuntime(resource, resource.artifact);
    const artifactMatch = compareRuntime(
      artifactRuntime,
      receiptCode,
      resource.artifact.deployedBytecode.immutableReferences ?? {},
      resource.artifact.deployedBytecode.linkReferences ?? {},
    );
    if (artifactMatch.mode === 'mismatch') {
      result.reasons.push('Pinned parent runtime does not match the planned artifact skeleton.');
      return result;
    }
    for (const check of resource.checks) {
      for (const checkBlock of [receipt.blockNumber, blockOf(options.blockNumber)]) {
        const { proof: getter } = await getterProof(
          client,
          resource,
          check,
          resource.artifact.abi,
          checkBlock,
        );
        if (!getter.matched) {
          result.reasons.push(
            `Pinned parent getter ${check.functionName} differs at ${checkBlock?.toString() ?? 'current'}: ${getter.error ?? 'wrong value'}.`,
          );
          return result;
        }
      }
    }
    if (saved && !samePinnedCommitments(saved, resource)) {
      result.reasons.push(
        'Saved pinned-runtime child or parent commitment differs from the current resource.',
      );
      return result;
    }
    const origin =
      saved?.kind === 'create2' && saved.method === 'pinned-runtime'
        ? saved.originPlanHash
        : undefined;
    const journal = pinnedJournalCommitment(
      options.journalRecords,
      resource,
      transactionHash,
      origin,
      transaction.from,
      { blockHash: receipt.blockHash, blockNumber: receipt.blockNumber },
      { id: chain.id, genesisHash: chain.genesisHash },
    );
    if (
      !journal ||
      (saved?.kind === 'create2' &&
        saved.method === 'pinned-runtime' &&
        lower(saved.intentCommitment) !== lower(journal.commitment))
    ) {
      result.reasons.push(
        'Pinned-runtime creation has no matching pre-sign journal commitment and signed receipt.',
      );
      return result;
    }
    result.method = 'pinned-runtime';
    result.createdCode = [];
    for (const child of resource.createdCode) {
      const address = pinnedChildAddress(resource.address, child.createNonce);
      if (lower(address) !== lower(child.address)) {
        result.reasons.push(
          `Created child ${child.getter} has a different derived CREATE address.`,
        );
        return result;
      }
      const evidence: PinnedChildEvidence = {
        ...child,
        receiptCodeHash: null,
        currentCodeHash: null,
        receiptGetter: null,
        currentGetter: null,
        matched: false,
      };
      result.createdCode.push(evidence);
      try {
        const fn = abiFunction(resource.artifact.abi, child.getter, 0, resource.id);
        if (fn.outputs?.length !== 1 || fn.outputs[0]?.type !== 'address')
          throw new Error('getter must return one address');
        const currentBlock = blockOf(options.blockNumber);
        const [receiptGetter, currentGetter, receiptChildCode, currentChildCode] =
          await Promise.all([
            readFunction(client, {
              address: resource.address,
              fn,
              args: [],
              blockNumber: receipt.blockNumber,
            }),
            readFunction(client, {
              address: resource.address,
              fn,
              args: [],
              blockNumber: currentBlock,
            }),
            client.getCode({ address, blockNumber: receipt.blockNumber }),
            client.getCode({ address, ...at(currentBlock) }),
          ]);
        evidence.receiptGetter =
          typeof receiptGetter === 'string' ? (receiptGetter as Address) : null;
        evidence.currentGetter =
          typeof currentGetter === 'string' ? (currentGetter as Address) : null;
        evidence.receiptCodeHash = hasCode(receiptChildCode) ? keccak256(receiptChildCode) : null;
        evidence.currentCodeHash = hasCode(currentChildCode) ? keccak256(currentChildCode) : null;
        evidence.matched =
          lower(evidence.receiptGetter) === lower(address) &&
          lower(evidence.currentGetter) === lower(address) &&
          lower(evidence.receiptCodeHash) === lower(child.codeHash) &&
          lower(evidence.currentCodeHash) === lower(child.codeHash);
      } catch (error) {
        result.reasons.push(
          `Created child ${child.getter} cannot be checked at receipt and current blocks: ${safeError(error)}`,
        );
        return result;
      }
      if (!evidence.matched) {
        result.reasons.push(
          `Created child ${child.getter} at ${address} differs from its getter address or precommitted runtime hash.`,
        );
        return result;
      }
    }
    result.exactRuntime = true;
    result.status = 'verified';
    result.proof = {
      ...base,
      kind: 'create2',
      factory: resource.factory!,
      salt: resource.salt!,
      method: 'pinned-runtime',
      originPlanHash: journal.planHash,
      intentCommitment: journal.commitment,
      createdCode: resource.createdCode,
    };
    return result;
  }
  try {
    const runtime = await simulateCreate2(client, {
      factory: resource.factory!.address,
      salt: resource.salt!,
      initcode,
      address: resource.address,
      blockNumber: receipt.blockNumber,
      account: transaction.from,
    });
    result.exactRuntime = lower(runtime) === lower(receiptCode);
  } catch (error) {
    if (replayProviderFailure(error)) {
      result.replayFailure = 'provider';
      result.reasons.push(
        'Creation simulation at the receipt block could not be completed by the RPC provider. Retry this saved plan with a compatible RPC endpoint.',
      );
    } else {
      result.replayFailure = 'execution';
      result.reasons.push(
        `Creation simulation at the receipt block failed: ${safeError(error)} See the stateful constructor limitation and recovery steps: ${STATEFUL_CONSTRUCTOR_LIMITATION_URL}`,
      );
    }
    return result;
  }
  if (result.exactRuntime) {
    result.status = 'verified';
    result.proof = proof;
  } else {
    result.replayFailure = 'mismatch';
    result.reasons.push(
      `Creation simulation at the receipt block returned different runtime code. See the stateful constructor limitation and recovery steps: ${STATEFUL_CONSTRUCTOR_LIMITATION_URL}`,
    );
  }
  return result;
}
