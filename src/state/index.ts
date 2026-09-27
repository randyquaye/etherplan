import { open, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isAddress } from 'viem';
import { canonicalJson, hashJson } from '../identity.ts';
import { assertDerivedSalt, assertSaltDerivation } from '../spec/salt.ts';
import { validateCreationProof } from '../verification/creation-proof.ts';
import type { PreparedResource } from '../planning/types.ts';
import type { Address, ChainIdentity, Hash, JsonValue } from '../types.ts';
import type { VerificationResult } from '../verification/types.ts';
import type { ArtifactRevision, ContractStateResource, ImportResourceInput, RecordResourceInput, StateFile, StateResource } from './types.ts';

const HASH = /^0x[0-9a-fA-F]{64}$/;
const RESOURCE_ID = /^(contract|external|call):[a-z][a-zA-Z0-9_]*$/;
const SECRET_KEY = /^(private[_-]?key|secret[_-]?key|mnemonic|seed[_-]?phrase|passphrase)$/i;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertHash(value: unknown, location: string): asserts value is Hash;
function assertHash(value: unknown, location: string, nullable: true): asserts value is Hash | null;
function assertHash(value: unknown, location: string, nullable = false): asserts value is Hash | null {
  assert((nullable && value === null) || (typeof value === 'string' && HASH.test(value)), `${location} must be a 32-byte hex value${nullable ? ' or null' : ''}.`);
}

function assertNoSecrets(value: unknown, location = 'State'): void {
  if (Array.isArray(value)) value.forEach((item, index) => assertNoSecrets(item, `${location}[${index}]`));
  else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      assert(!SECRET_KEY.test(key), `${location} has forbidden signer secret field ${key}.`);
      assertNoSecrets(item, `${location}.${key}`);
    }
  }
}

function validateChain(chain: unknown): asserts chain is ChainIdentity {
  assert(isObject(chain), 'State chain must be an object.');
  assert(Object.keys(chain).every(key => key === 'id' || key === 'genesisHash'), 'State chain has unknown fields.');
  assert(typeof chain.id === 'number' && Number.isSafeInteger(chain.id) && chain.id > 0, 'State chain needs a positive numeric id.');
  assertHash(chain.genesisHash, 'State chain genesisHash');
}

function validateRevision(id: string, revision: unknown, index: number): void {
  const location = `${id} artifactRevisions[${index}]`;
  assert(isObject(revision), `State resource ${location} must be an object.`);
  assert(Object.keys(revision).every(key => ['artifactHash', 'sourceHash', 'proofHash', 'codeHash'].includes(key)), `State resource ${location} has unknown fields.`);
  assertHash(revision.artifactHash, `${location} artifactHash`);
  if (revision.sourceHash !== undefined) assertHash(revision.sourceHash, `${location} sourceHash`);
  assertHash(revision.proofHash, `${location} proofHash`);
  assertHash(revision.codeHash, `${location} codeHash`);
}

function validateResource(id: string, resource: unknown, chain: ChainIdentity): void {
  assert(RESOURCE_ID.test(id), `State resource ID ${id} is invalid.`);
  assert(isObject(resource), `State resource ${id} must be an object.`);
  const allowed = new Set(['address', 'priorAddress', 'artifactHash', 'sourceHash', 'artifactRevisions', 'initcodeHash', 'inputs', 'inputsHash', 'priorInputs', 'priorInputsHash', 'salt', 'saltDerivation', 'codeHash', 'priorCodeHash', 'proofHash', 'priorProofHash', 'transactions', 'provenance', 'creationProof']);
  assert(Object.keys(resource).every(key => allowed.has(key)), `State resource ${id} has unknown fields.`);
  const { address } = resource;
  assert(typeof address === 'string' && isAddress(address), `State resource ${id} needs an address.`);
  assert(resource.priorAddress === undefined || resource.priorAddress === null || (typeof resource.priorAddress === 'string' && isAddress(resource.priorAddress)), `State resource ${id} has an invalid priorAddress.`);
  if (id.startsWith('contract:')) {
    for (const key of ['artifactHash', 'initcodeHash', 'inputs', 'inputsHash', 'priorInputs', 'priorInputsHash', 'salt', 'codeHash', 'proofHash', 'transactions']) {
      assert(Object.hasOwn(resource, key), `State resource ${id} needs ${key}.`);
    }
  }
  if (resource.artifactHash !== undefined) assertHash(resource.artifactHash, `${id} artifactHash`);
  if (resource.sourceHash !== undefined) assertHash(resource.sourceHash, `${id} sourceHash`);
  if (resource.artifactRevisions !== undefined) {
    assert(Array.isArray(resource.artifactRevisions) && resource.artifactHash !== undefined, `State resource ${id} artifactRevisions must be an array beside an artifactHash.`);
    resource.artifactRevisions.forEach((revision: unknown, index: number) => validateRevision(id, revision, index));
  }
  if (resource.initcodeHash !== undefined) assertHash(resource.initcodeHash, `${id} initcodeHash`, true);
  if (resource.inputsHash !== undefined) assertHash(resource.inputsHash, `${id} inputsHash`);
  if (resource.priorInputsHash !== undefined) assertHash(resource.priorInputsHash, `${id} priorInputsHash`, true);
  if (resource.salt !== undefined) assertHash(resource.salt, `${id} salt`, true);
  if (resource.saltDerivation !== undefined) {
    assert(id.startsWith('contract:'), `${id} saltDerivation belongs only to a contract.`);
    assertDerivedSalt(resource.salt, assertSaltDerivation(resource.saltDerivation, `${id} saltDerivation`), id);
  }
  if (resource.codeHash !== undefined) assertHash(resource.codeHash, `${id} codeHash`, true);
  if (resource.priorCodeHash !== undefined) assertHash(resource.priorCodeHash, `${id} priorCodeHash`, true);
  if (resource.proofHash !== undefined) assertHash(resource.proofHash, `${id} proofHash`);
  if (resource.priorProofHash !== undefined) assertHash(resource.priorProofHash, `${id} priorProofHash`, true);
  if (resource.creationProof !== undefined) {
    assert(id.startsWith('contract:'), `${id} creationProof belongs only to a contract.`);
    const proof = validateCreationProof(resource.creationProof, `${id} creationProof`);
    assert(proof.chain.id === chain.id && proof.chain.genesisHash.toLowerCase() === chain.genesisHash.toLowerCase(), `${id} creationProof has a different chain.`);
    assert(proof.address.toLowerCase() === address.toLowerCase() && proof.codeHash.toLowerCase() === resource.codeHash?.toLowerCase(), `${id} creationProof has a different deployment.`);
    if (resource.initcodeHash !== null) assert(proof.initcodeHash.toLowerCase() === resource.initcodeHash?.toLowerCase(), `${id} creationProof has a different initcode.`);
    if (proof.kind === 'create2') assert(proof.salt.toLowerCase() === resource.salt?.toLowerCase(), `${id} creationProof has a different salt.`);
  }
  const { provenance } = resource;
  if (provenance !== undefined) {
    assert(isObject(provenance), `State resource ${id} provenance must be an object.`);
    assert(typeof provenance.kind === 'string' && ['apply', 'import', 'observed'].includes(provenance.kind), `State resource ${id} has invalid provenance kind.`);
    assert(Object.keys(provenance).every(key => key === 'kind' || key === 'creationTransactionHash'), `State resource ${id} provenance has unknown fields.`);
    if (provenance.creationTransactionHash !== undefined && provenance.creationTransactionHash !== null) {
      assert(provenance.kind === 'import', `State resource ${id} can name a creation transaction only for import.`);
      assertHash(provenance.creationTransactionHash, `${id} creationTransactionHash`);
    }
  }
  if (resource.inputs !== undefined) canonicalJson(resource.inputs);
  if (resource.priorInputs !== undefined) canonicalJson(resource.priorInputs);
  assert(Array.isArray(resource.transactions), `State resource ${id} needs transactions.`);
  resource.transactions.forEach((transaction: unknown, index: number) => assertHash(transaction, `${id} transactions[${index}]`));
}

export function validateState(state: unknown): StateFile {
  assert(isObject(state), 'State must be an object.');
  assertNoSecrets(state);
  assert(Object.keys(state).every(key => key === 'formatVersion' || key === 'chain' || key === 'resources' || key === 'lastPlanHash'), 'State has unknown fields.');
  assert(state.formatVersion === 1, 'State must have formatVersion: 1.');
  if (state.lastPlanHash !== undefined) assertHash(state.lastPlanHash, 'State lastPlanHash');
  validateChain(state.chain);
  assert(isObject(state.resources), 'State resources must be an object.');
  for (const [id, resource] of Object.entries(state.resources)) validateResource(id, resource, state.chain);
  canonicalJson(state);
  return JSON.parse(JSON.stringify(state));
}

export async function readState(file: string): Promise<StateFile | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let state: unknown;
  try {
    state = JSON.parse(text);
  } catch (error) {
    throw new Error(`State file ${file} is not valid JSON: ${(error as Error).message}`);
  }
  return validateState(state);
}

export async function writeStateAtomic(file: string, stateInput: StateFile): Promise<void> {
  const state = validateState(stateInput);
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    const directoryHandle = await open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(cleanupError => {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError;
    });
    throw error;
  }
}

function sameChain(left: ChainIdentity, right: ChainIdentity): boolean {
  return left.id === right.id && left.genesisHash.toLowerCase() === right.genesisHash.toLowerCase();
}

// Deployment identity is the address, initcode, and constructor inputs. The artifact hash is provenance.
function sameDeployment(record: StateResource, { address, initcodeHash, inputsHash }: { address: Address; initcodeHash?: Hash | null | undefined; inputsHash: Hash }): boolean {
  return record.address.toLowerCase() === address.toLowerCase() &&
    (record.initcodeHash ?? null) === (initcodeHash ?? null) && record.inputsHash === inputsHash;
}

// A derived salt records its derivation. An explicit salt has none, so a record never keeps a stale one.
function setSaltDerivation(record: StateResource, resource: PreparedResource): void {
  if (resource.kind === 'contract' && resource.saltDerivation) record.saltDerivation = { ...resource.saltDerivation };
  else delete record.saltDerivation;
}

// The artifact evidence that a rebaseline supersedes. Deployment provenance stays on the record.
function artifactRevision(record: ContractStateResource & { codeHash: Hash }): ArtifactRevision {
  const revision: ArtifactRevision = { artifactHash: record.artifactHash, proofHash: record.proofHash, codeHash: record.codeHash };
  if (record.sourceHash !== undefined) revision.sourceHash = record.sourceHash;
  return revision;
}

function assertSameCode(existing: ContractStateResource, verification: VerificationResult, id: string): asserts existing is ContractStateResource & { codeHash: Hash } {
  assert(existing.codeHash !== null, `Cannot rebaseline ${id}: state has no code hash for it.`);
  assert(existing.codeHash.toLowerCase() === verification.codeHash?.toLowerCase(), `Cannot rebaseline ${id}: its live code hash differs from the saved code hash.`);
}

/**
 * Records a verified existing contract. With `rebaseline`, an existing imported record at the same address, initcode,
 * inputs, and live code hash takes the new artifact; its provenance, transactions, and prior fields are kept, and the
 * previous artifact evidence is appended to `artifactRevisions`.
 */
export function importResource({ resource, verification, state: stateInput, chain, creationTransactionHash = null, rebaseline = false }: ImportResourceInput): StateFile {
  assert(resource?.kind === 'contract', 'Only a contract resource can be imported.');
  assert(verification?.id === resource.id && verification.address?.toLowerCase() === resource.address.toLowerCase(), 'Verification identity does not match the imported resource.');
  assert(verification.status === 'verified', `Cannot import ${resource.id} without verified live evidence.`);
  assert(typeof verification.codeHash === 'string' && HASH.test(verification.codeHash), `Cannot import ${resource.id} without a live code hash.`);
  if (creationTransactionHash !== null) {
    assertHash(creationTransactionHash, `${resource.id} creationTransactionHash`);
    assert(verification.evidence?.creation?.status === 'verified' && verification.evidence.creation.transactionHash?.toLowerCase() === creationTransactionHash.toLowerCase(), `Cannot record an unverified creation transaction for ${resource.id}.`);
  }
  validateChain(chain);

  const state: StateFile = stateInput === null || stateInput === undefined
    ? { formatVersion: 1, chain: { ...chain }, resources: {} }
    : validateState(stateInput);
  assert(sameChain(state.chain, chain), 'State belongs to a different chain.');
  const existing = state.resources[resource.id];
  const sourceHash = resource.artifact?.buildIdentity?.sourceHash;
  if (existing) assert(existing.address.toLowerCase() === resource.address.toLowerCase(), `${resource.id} already has a different state address.`);

  let record: ContractStateResource;
  if (rebaseline) {
    assert(existing, `${resource.id} has no state record to rebaseline. Import it without --rebaseline.`);
    assert(existing.provenance?.kind === 'import', `${resource.id} was not imported. Plan and apply accept a rebuilt artifact for an unchanged CREATE2 deployment.`);
    assert(existing.inputsHash === resource.inputsHash, `Cannot rebaseline ${resource.id}: its constructor inputs differ from state.`);
    assert(sameDeployment(existing, resource) && (existing.salt ?? null) === (resource.salt ?? null), `Cannot rebaseline ${resource.id}: its initcode or salt differs from state.`);
    assert(existing.artifactHash !== resource.artifactHash, `${resource.id} already records this artifact; there is nothing to rebaseline.`);
    assertSameCode(existing, verification, resource.id);
    const recorded = existing.provenance.creationTransactionHash ?? null;
    assert(creationTransactionHash === null || recorded === null || recorded.toLowerCase() === creationTransactionHash.toLowerCase(), `${resource.id} records a different creation transaction.`);
    record = {
      ...existing,
      artifactHash: resource.artifactHash,
      proofHash: hashJson(verification),
      ...(verification.creationProof ? { creationProof: verification.creationProof } : {}),
      artifactRevisions: [...(existing.artifactRevisions ?? []), artifactRevision(existing)],
    };
    delete record.sourceHash;
  } else {
    if (existing) assert(existing.artifactHash === resource.artifactHash, `${resource.id} already has a different artifact identity. Use import --rebaseline to accept a new artifact for the same live contract.`);
    record = {
      address: resource.address,
      priorAddress: existing?.priorAddress ?? null,
      artifactHash: resource.artifactHash,
      initcodeHash: resource.initcodeHash ?? null,
      inputs: resource.inputs,
      inputsHash: resource.inputsHash,
      priorInputs: existing?.inputs ?? null,
      priorInputsHash: existing?.inputsHash ?? null,
      salt: resource.salt ?? null,
      codeHash: verification.codeHash,
      priorCodeHash: existing?.priorCodeHash ?? null,
      proofHash: hashJson(verification),
      ...(verification.creationProof ? { creationProof: verification.creationProof } : {}),
      priorProofHash: existing?.priorProofHash ?? null,
      transactions: existing?.transactions ? [...existing.transactions] : [],
      provenance: { kind: 'import', creationTransactionHash },
    };
    if (existing?.artifactRevisions && sameDeployment(existing, resource)) record.artifactRevisions = [...existing.artifactRevisions];
  }
  if (sourceHash !== undefined) record.sourceHash = sourceHash;
  setSaltDerivation(record, resource);
  const imported = {
    formatVersion: 1,
    chain: { ...state.chain },
    resources: { ...state.resources, [resource.id]: record },
  };
  return validateState(imported);
}

function desiredInputs(resource: PreparedResource): JsonValue {
  if (resource.kind === 'contract') return resource.inputs;
  if (resource.kind === 'call') {
    return {
      method: resource.method,
      args: resource.args,
      check: resource.check,
      before: resource.before,
      after: resource.after,
      signerRole: resource.signerRole,
    };
  }
  return { expectedCodeHash: resource.expectedCodeHash ?? null, checks: resource.checks ?? [] };
}

function mergeTransactions(previous: Hash[] = [], current: Hash[] = []): Hash[] {
  assert(Array.isArray(current), 'Resource transactions must be an array.');
  const transactions: Hash[] = [];
  const seen = new Set<string>();
  for (const transaction of [...previous, ...current]) {
    assertHash(transaction, 'Resource transaction');
    const normalized = transaction.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      transactions.push(transaction);
    }
  }
  return transactions;
}

export function recordResource({ resource, verification, state: stateInput, chain, transactions = [] }: RecordResourceInput): StateFile {
  assert(['contract', 'call', 'external'].includes(resource?.kind), 'State can record only a prepared contract, call, or external resource.');
  assert(verification?.id === resource.id && verification.address?.toLowerCase() === resource.address.toLowerCase(), 'Verification identity does not match the recorded resource.');
  assert(verification.status === 'verified', `Cannot record ${resource.id} without a verified postcondition.`);
  if (resource.kind === 'call') {
    assert((verification.bindingChecks?.length ?? 0) > 0 && verification.bindingChecks.every(check => check.observed === 'after'), `Cannot record ${resource.id} before its desired binding is verified.`);
  }
  assert(typeof verification.codeHash === 'string' && HASH.test(verification.codeHash), `Cannot record ${resource.id} without a live code hash.`);
  validateChain(chain);

  const state: StateFile = stateInput === null || stateInput === undefined
    ? { formatVersion: 1, chain: { ...chain }, resources: {} }
    : validateState(stateInput);
  assert(sameChain(state.chain, chain), 'State belongs to a different chain.');
  const existing = state.resources[resource.id];
  // The same record, typed with the fields the state validator requires of a contract.
  const contract = resource.kind === 'contract' ? state.resources[resource.id] : undefined;
  const inputs = desiredInputs(resource);
  const inputsHash = hashJson(inputs);
  const artifact = resource.kind === 'contract' ? resource.artifact : resource.kind === 'call' ? resource.targetArtifact : undefined;
  const artifactHash = resource.kind === 'contract' ? resource.artifactHash : artifact?.artifactHash;
  const initcodeHash = resource.kind === 'contract' ? resource.initcodeHash ?? null : null;
  const salt = resource.kind === 'contract' ? resource.salt ?? null : null;
  const identityChanged = existing !== undefined && !sameDeployment(existing, { address: resource.address, initcodeHash, inputsHash });
  // A rebuilt artifact for the same deployment changes provenance, not identity. Only import --rebaseline accepts a new
  // artifact for an imported contract.
  const rebaseline = contract !== undefined && !identityChanged && contract.artifactHash.toLowerCase() !== artifactHash?.toLowerCase();
  let revision: ArtifactRevision | undefined;
  if (rebaseline) {
    assert(contract.initcodeHash !== null, `${resource.id} is an imported contract. Accept its new artifact with import --rebaseline.`);
    assertSameCode(contract, verification, resource.id);
    revision = artifactRevision(contract);
  }
  const record: StateResource = {
    address: resource.address,
    priorAddress: identityChanged ? existing.address : existing?.priorAddress ?? null,
    inputs,
    inputsHash,
    priorInputs: identityChanged ? existing.inputs ?? null : existing?.priorInputs ?? null,
    priorInputsHash: identityChanged ? existing.inputsHash ?? null : existing?.priorInputsHash ?? null,
    codeHash: verification.codeHash,
    priorCodeHash: identityChanged ? existing.codeHash ?? null : existing?.priorCodeHash ?? null,
    proofHash: hashJson(verification),
    ...(verification.creationProof ? { creationProof: verification.creationProof } : {}),
    priorProofHash: identityChanged ? existing.proofHash ?? null : existing?.priorProofHash ?? null,
    transactions: mergeTransactions(existing?.transactions, transactions),
    provenance: transactions.length > 0 ? { kind: 'apply' } : identityChanged ? { kind: 'observed' } : existing?.provenance ?? { kind: 'observed' },
  };
  if (artifactHash !== undefined) record.artifactHash = artifactHash;
  // A replacement starts a new revision trail.
  const revisions = identityChanged ? [] : [...(existing?.artifactRevisions ?? []), ...(revision ? [revision] : [])];
  if (revisions.length > 0) record.artifactRevisions = revisions;
  if (resource.kind === 'contract' || resource.kind === 'call') {
    record.initcodeHash = initcodeHash;
    record.salt = salt;
  }
  const sourceHash = artifact?.buildIdentity?.sourceHash;
  if (sourceHash !== undefined) record.sourceHash = sourceHash;
  setSaltDerivation(record, resource);
  return validateState({
    formatVersion: 1,
    chain: { ...state.chain },
    resources: { ...state.resources, [resource.id]: record },
  });
}
