import { isAddress } from 'viem';

const HASH = /^0x[0-9a-fA-F]{64}$/;
const BLOCK = /^(0|[1-9][0-9]*)$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Validate the persisted creation facts without treating them as trusted evidence. */
export function validateCreationProof(proof, label = 'Creation proof') {
  assert(proof && typeof proof === 'object' && !Array.isArray(proof), `${label} must be an object.`);
  const create2 = proof.kind === 'create2';
  const keys = ['chain', 'transactionHash', 'blockNumber', 'blockHash', 'address', 'kind', 'initcodeHash', 'codeHash', ...(create2 ? ['factory', 'salt'] : [])];
  assert(['create', 'create2'].includes(proof.kind) && Object.keys(proof).length === keys.length && keys.every(key => Object.hasOwn(proof, key)), `${label} has invalid fields.`);
  assert(proof.chain && typeof proof.chain === 'object' && !Array.isArray(proof.chain) && Object.keys(proof.chain).length === 2 &&
    Number.isSafeInteger(proof.chain.id) && proof.chain.id > 0 && HASH.test(proof.chain.genesisHash), `${label} has invalid chain identity.`);
  for (const key of ['transactionHash', 'blockHash', 'initcodeHash', 'codeHash']) assert(HASH.test(proof[key]), `${label} has invalid ${key}.`);
  assert(typeof proof.blockNumber === 'string' && BLOCK.test(proof.blockNumber), `${label} has invalid blockNumber.`);
  assert(isAddress(proof.address), `${label} has invalid address.`);
  if (create2) {
    assert(proof.factory && typeof proof.factory === 'object' && !Array.isArray(proof.factory) && Object.keys(proof.factory).length === 2 &&
      isAddress(proof.factory.address) && HASH.test(proof.factory.codeHash), `${label} has invalid factory.`);
    assert(HASH.test(proof.salt), `${label} has invalid salt.`);
  }
  return proof;
}

export function validateJournalCreationProof(record, label) {
  if (record.creationProof === undefined) return;
  assert(record.phase === 'verified', `${label} has a creationProof outside verified.`);
  const proof = validateCreationProof(record.creationProof, `${label} creationProof`);
  assert(proof.chain.id === record.chain.id && proof.chain.genesisHash.toLowerCase() === record.chain.genesisHash.toLowerCase() &&
    proof.address.toLowerCase() === record.address?.toLowerCase() && proof.codeHash.toLowerCase() === record.codeHash?.toLowerCase(),
  `${label} creationProof differs from verified deployment.`);
}
