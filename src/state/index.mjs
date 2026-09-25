import { open, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isAddress } from 'viem';
import { canonicalJson, hashJson } from '../identity.mjs';
import { validateCreationProof } from '../verification/creation-proof.mjs';

const HASH = /^0x[0-9a-fA-F]{64}$/;
const RESOURCE_ID = /^(contract|external|call):[a-z][a-zA-Z0-9_]*$/;
const SECRET_KEY = /^(private[_-]?key|secret[_-]?key|mnemonic|seed[_-]?phrase|passphrase)$/i;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertHash(value, location, nullable = false) {
  assert((nullable && value === null) || (typeof value === 'string' && HASH.test(value)), `${location} must be a 32-byte hex value${nullable ? ' or null' : ''}.`);
}

function assertNoSecrets(value, location = 'State') {
  if (Array.isArray(value)) value.forEach((item, index) => assertNoSecrets(item, `${location}[${index}]`));
  else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      assert(!SECRET_KEY.test(key), `${location} has forbidden signer secret field ${key}.`);
      assertNoSecrets(item, `${location}.${key}`);
    }
  }
}

function validateChain(chain) {
  assert(isObject(chain), 'State chain must be an object.');
  assert(Object.keys(chain).every(key => key === 'id' || key === 'genesisHash'), 'State chain has unknown fields.');
  assert(Number.isSafeInteger(chain.id) && chain.id > 0, 'State chain needs a positive numeric id.');
  assertHash(chain.genesisHash, 'State chain genesisHash');
}

function validateResource(id, resource, chain) {
  assert(RESOURCE_ID.test(id), `State resource ID ${id} is invalid.`);
  assert(isObject(resource), `State resource ${id} must be an object.`);
  const allowed = new Set(['address', 'priorAddress', 'artifactHash', 'sourceHash', 'initcodeHash', 'inputs', 'inputsHash', 'priorInputs', 'priorInputsHash', 'salt', 'codeHash', 'priorCodeHash', 'proofHash', 'priorProofHash', 'transactions', 'provenance', 'creationProof']);
  assert(Object.keys(resource).every(key => allowed.has(key)), `State resource ${id} has unknown fields.`);
  assert(isAddress(resource.address), `State resource ${id} needs an address.`);
  assert(resource.priorAddress === undefined || resource.priorAddress === null || isAddress(resource.priorAddress), `State resource ${id} has an invalid priorAddress.`);
  if (id.startsWith('contract:')) {
    for (const key of ['artifactHash', 'initcodeHash', 'inputs', 'inputsHash', 'priorInputs', 'priorInputsHash', 'salt', 'codeHash', 'proofHash', 'transactions']) {
      assert(Object.hasOwn(resource, key), `State resource ${id} needs ${key}.`);
    }
  }
  if (resource.artifactHash !== undefined) assertHash(resource.artifactHash, `${id} artifactHash`);
  if (resource.sourceHash !== undefined) assertHash(resource.sourceHash, `${id} sourceHash`);
  if (resource.initcodeHash !== undefined) assertHash(resource.initcodeHash, `${id} initcodeHash`, true);
  if (resource.inputsHash !== undefined) assertHash(resource.inputsHash, `${id} inputsHash`);
  if (resource.priorInputsHash !== undefined) assertHash(resource.priorInputsHash, `${id} priorInputsHash`, true);
  if (resource.salt !== undefined) assertHash(resource.salt, `${id} salt`, true);
  if (resource.codeHash !== undefined) assertHash(resource.codeHash, `${id} codeHash`, true);
  if (resource.priorCodeHash !== undefined) assertHash(resource.priorCodeHash, `${id} priorCodeHash`, true);
  if (resource.proofHash !== undefined) assertHash(resource.proofHash, `${id} proofHash`);
  if (resource.priorProofHash !== undefined) assertHash(resource.priorProofHash, `${id} priorProofHash`, true);
  if (resource.creationProof !== undefined) {
    assert(id.startsWith('contract:'), `${id} creationProof belongs only to a contract.`);
    const proof = validateCreationProof(resource.creationProof, `${id} creationProof`);
    assert(proof.chain.id === chain.id && proof.chain.genesisHash.toLowerCase() === chain.genesisHash.toLowerCase(), `${id} creationProof has a different chain.`);
    assert(proof.address.toLowerCase() === resource.address.toLowerCase() && proof.codeHash.toLowerCase() === resource.codeHash?.toLowerCase(), `${id} creationProof has a different deployment.`);
    if (resource.initcodeHash !== null) assert(proof.initcodeHash.toLowerCase() === resource.initcodeHash?.toLowerCase(), `${id} creationProof has a different initcode.`);
    if (proof.kind === 'create2') assert(proof.salt.toLowerCase() === resource.salt?.toLowerCase(), `${id} creationProof has a different salt.`);
  }
  if (resource.provenance !== undefined) {
    assert(isObject(resource.provenance), `State resource ${id} provenance must be an object.`);
    assert(['apply', 'import', 'observed'].includes(resource.provenance.kind), `State resource ${id} has invalid provenance kind.`);
    assert(Object.keys(resource.provenance).every(key => key === 'kind' || key === 'creationTransactionHash'), `State resource ${id} provenance has unknown fields.`);
    if (resource.provenance.creationTransactionHash !== undefined && resource.provenance.creationTransactionHash !== null) {
      assert(resource.provenance.kind === 'import', `State resource ${id} can name a creation transaction only for import.`);
      assertHash(resource.provenance.creationTransactionHash, `${id} creationTransactionHash`);
    }
  }
  if (resource.inputs !== undefined) canonicalJson(resource.inputs);
  if (resource.priorInputs !== undefined) canonicalJson(resource.priorInputs);
  assert(Array.isArray(resource.transactions), `State resource ${id} needs transactions.`);
  resource.transactions.forEach((transaction, index) => assertHash(transaction, `${id} transactions[${index}]`));
}

export function validateState(state) {
  assert(isObject(state), 'State must be an object.');
  assertNoSecrets(state);
  assert(Object.keys(state).every(key => key === 'formatVersion' || key === 'chain' || key === 'resources'), 'State has unknown fields.');
  assert(state.formatVersion === 1, 'State must have formatVersion: 1.');
  validateChain(state.chain);
  assert(isObject(state.resources), 'State resources must be an object.');
  for (const [id, resource] of Object.entries(state.resources)) validateResource(id, resource, state.chain);
  canonicalJson(state);
  return JSON.parse(JSON.stringify(state));
}

export async function readState(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let state;
  try {
    state = JSON.parse(text);
  } catch (error) {
    throw new Error(`State file ${file} is not valid JSON: ${error.message}`);
  }
  return validateState(state);
}

export async function writeStateAtomic(file, stateInput) {
  const state = validateState(stateInput);
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
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
      if (cleanupError.code !== 'ENOENT') throw cleanupError;
    });
    throw error;
  }
}

function sameChain(left, right) {
  return left.id === right.id && left.genesisHash.toLowerCase() === right.genesisHash.toLowerCase();
}

export function importResource({ resource, verification, state: stateInput, chain, creationTransactionHash = null }) {
  assert(resource?.kind === 'contract', 'Only a contract resource can be imported.');
  assert(verification?.id === resource.id && verification.address?.toLowerCase() === resource.address.toLowerCase(), 'Verification identity does not match the imported resource.');
  assert(verification.status === 'verified', `Cannot import ${resource.id} without verified live evidence.`);
  assert(typeof verification.codeHash === 'string' && HASH.test(verification.codeHash), `Cannot import ${resource.id} without a live code hash.`);
  if (creationTransactionHash !== null) {
    assertHash(creationTransactionHash, `${resource.id} creationTransactionHash`);
    assert(verification.evidence?.creation?.status === 'verified' && verification.evidence.creation.transactionHash?.toLowerCase() === creationTransactionHash.toLowerCase(), `Cannot record an unverified creation transaction for ${resource.id}.`);
  }
  validateChain(chain);

  const state = stateInput === null || stateInput === undefined
    ? { formatVersion: 1, chain: { ...chain }, resources: {} }
    : validateState(stateInput);
  assert(sameChain(state.chain, chain), 'State belongs to a different chain.');
  const existing = state.resources[resource.id];
  if (existing) {
    assert(existing.address.toLowerCase() === resource.address.toLowerCase(), `${resource.id} already has a different state address.`);
    assert(existing.artifactHash === resource.artifactHash, `${resource.id} already has a different artifact identity.`);
  }

  const record = {
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
  const sourceHash = resource.artifact?.buildIdentity?.sourceHash;
  if (sourceHash !== undefined) record.sourceHash = sourceHash;
  const imported = {
    formatVersion: 1,
    chain: { ...state.chain },
    resources: { ...state.resources, [resource.id]: record },
  };
  return validateState(imported);
}

function desiredInputs(resource) {
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

function mergeTransactions(previous = [], current = []) {
  assert(Array.isArray(current), 'Resource transactions must be an array.');
  const transactions = [];
  const seen = new Set();
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

export function recordResource({ resource, verification, state: stateInput, chain, transactions = [] }) {
  assert(['contract', 'call', 'external'].includes(resource?.kind), 'State can record only a prepared contract, call, or external resource.');
  assert(verification?.id === resource.id && verification.address?.toLowerCase() === resource.address.toLowerCase(), 'Verification identity does not match the recorded resource.');
  assert(verification.status === 'verified', `Cannot record ${resource.id} without a verified postcondition.`);
  if (resource.kind === 'call') {
    assert(verification.bindingChecks?.length > 0 && verification.bindingChecks.every(check => check.observed === 'after'), `Cannot record ${resource.id} before its desired binding is verified.`);
  }
  assert(typeof verification.codeHash === 'string' && HASH.test(verification.codeHash), `Cannot record ${resource.id} without a live code hash.`);
  validateChain(chain);

  const state = stateInput === null || stateInput === undefined
    ? { formatVersion: 1, chain: { ...chain }, resources: {} }
    : validateState(stateInput);
  assert(sameChain(state.chain, chain), 'State belongs to a different chain.');
  const existing = state.resources[resource.id];
  const inputs = desiredInputs(resource);
  const inputsHash = hashJson(inputs);
  const artifact = resource.artifact ?? resource.targetArtifact;
  const artifactHash = resource.artifactHash ?? artifact?.artifactHash;
  const identityChanged = Boolean(existing) && (
    existing.address.toLowerCase() !== resource.address.toLowerCase() ||
    existing.artifactHash !== artifactHash ||
    existing.inputsHash !== inputsHash ||
    (existing.initcodeHash ?? null) !== (resource.initcodeHash ?? null)
  );
  const record = {
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
  if (resource.kind === 'contract' || resource.kind === 'call') {
    record.initcodeHash = resource.initcodeHash ?? null;
    record.salt = resource.salt ?? null;
  }
  const sourceHash = artifact?.buildIdentity?.sourceHash;
  if (sourceHash !== undefined) record.sourceHash = sourceHash;
  return validateState({
    formatVersion: 1,
    chain: { ...state.chain },
    resources: { ...state.resources, [resource.id]: record },
  });
}
