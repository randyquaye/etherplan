import { isAddress } from 'viem';
import type { JournalRecord, StoredJournalRecord } from '../execution/types.ts';
import type { Hash } from '../types.ts';
import type { CreationProof } from './types.ts';

const HASH = /^0x[0-9a-fA-F]{64}$/;
const BLOCK = /^(0|[1-9][0-9]*)$/;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isHash(value: unknown): value is Hash {
  return typeof value === 'string' && HASH.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Validate the persisted creation facts without treating them as trusted evidence. */
export function validateCreationProof(proof: unknown, label = 'Creation proof'): CreationProof {
  assert(isRecord(proof), `${label} must be an object.`);
  const create2 = proof.kind === 'create2';
  const keys = ['chain', 'transactionHash', 'blockNumber', 'blockHash', 'address', 'kind', 'initcodeHash', 'codeHash', ...(create2 ? ['factory', 'salt'] : [])];
  assert((proof.kind === 'create' || create2) && Object.keys(proof).length === keys.length && keys.every(key => Object.hasOwn(proof, key)), `${label} has invalid fields.`);
  const chain = proof.chain;
  assert(isRecord(chain) && Object.keys(chain).length === 2 &&
    typeof chain.id === 'number' && Number.isSafeInteger(chain.id) && chain.id > 0 && isHash(chain.genesisHash), `${label} has invalid chain identity.`);
  for (const key of ['transactionHash', 'blockHash', 'initcodeHash', 'codeHash']) assert(isHash(proof[key]), `${label} has invalid ${key}.`);
  assert(typeof proof.blockNumber === 'string' && BLOCK.test(proof.blockNumber), `${label} has invalid blockNumber.`);
  assert(typeof proof.address === 'string' && isAddress(proof.address), `${label} has invalid address.`);
  if (create2) {
    const factory = proof.factory;
    assert(isRecord(factory) && Object.keys(factory).length === 2 &&
      typeof factory.address === 'string' && isAddress(factory.address) && isHash(factory.codeHash), `${label} has invalid factory.`);
    assert(isHash(proof.salt), `${label} has invalid salt.`);
  }
  return proof as unknown as CreationProof;
}

export function validateJournalCreationProof(record: JournalRecord | StoredJournalRecord, label: string): void {
  // Records come from disk, so any phase may carry a creationProof even though the type allows it only on `verified`.
  const { creationProof } = record as { creationProof?: unknown };
  if (creationProof === undefined) return;
  assert(record.phase === 'verified', `${label} has a creationProof outside verified.`);
  const proof = validateCreationProof(creationProof, `${label} creationProof`);
  assert(proof.chain.id === record.chain.id && proof.chain.genesisHash.toLowerCase() === record.chain.genesisHash.toLowerCase() &&
    proof.address.toLowerCase() === record.address.toLowerCase() && proof.codeHash.toLowerCase() === record.codeHash?.toLowerCase(),
  `${label} creationProof differs from verified deployment.`);
}
