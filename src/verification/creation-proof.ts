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
  const pinned = create2 && proof.method === 'pinned-runtime';
  const keys = ['chain', 'transactionHash', 'creator', 'blockNumber', 'blockHash', 'address', 'kind', 'initcodeHash', 'codeHash', ...(create2 ? ['factory', 'salt'] : []), ...(pinned ? ['method', 'originPlanHash', 'intentCommitment', 'createdCode'] : [])];
  assert((proof.kind === 'create' || create2) && Object.keys(proof).length === keys.length && keys.every(key => Object.hasOwn(proof, key)), `${label} has invalid fields.`);
  const chain = proof.chain;
  assert(isRecord(chain) && Object.keys(chain).length === 2 &&
    typeof chain.id === 'number' && Number.isSafeInteger(chain.id) && chain.id > 0 && isHash(chain.genesisHash), `${label} has invalid chain identity.`);
  for (const key of ['transactionHash', 'blockHash', 'initcodeHash', 'codeHash']) assert(isHash(proof[key]), `${label} has invalid ${key}.`);
  assert(typeof proof.blockNumber === 'string' && BLOCK.test(proof.blockNumber), `${label} has invalid blockNumber.`);
  assert(typeof proof.address === 'string' && isAddress(proof.address), `${label} has invalid address.`);
  assert(typeof proof.creator === 'string' && isAddress(proof.creator), `${label} has invalid creator.`);
  if (create2) {
    const factory = proof.factory;
    assert(isRecord(factory) && Object.keys(factory).length === 2 &&
      typeof factory.address === 'string' && isAddress(factory.address) && isHash(factory.codeHash), `${label} has invalid factory.`);
    assert(isHash(proof.salt), `${label} has invalid salt.`);
  }
  if (pinned) {
    assert(isHash(proof.originPlanHash) && isHash(proof.intentCommitment), `${label} has invalid pinned commitment.`);
    assert(Array.isArray(proof.createdCode) && proof.createdCode.length > 0, `${label} needs createdCode.`);
    const getters = new Set<string>();
    const addresses = new Set<string>();
    for (const child of proof.createdCode) {
      assert(isRecord(child) && Object.keys(child).length === 4 && ['getter', 'createNonce', 'address', 'codeHash'].every(key => Object.hasOwn(child, key)), `${label} has invalid child fields.`);
      assert(typeof child.getter === 'string' && child.getter.length > 0 && typeof child.createNonce === 'number' &&
        Number.isSafeInteger(child.createNonce) && child.createNonce > 0 && typeof child.address === 'string' && isAddress(child.address) && isHash(child.codeHash), `${label} has invalid child commitment.`);
      assert(!getters.has(child.getter) && !addresses.has(child.address.toLowerCase()), `${label} has duplicate children.`);
      getters.add(child.getter);
      addresses.add(child.address.toLowerCase());
    }
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
  if (proof.kind === 'create2' && proof.method === 'pinned-runtime' && record.outcome === 'applied') {
    assert(proof.originPlanHash.toLowerCase() === record.planHash.toLowerCase() &&
      proof.transactionHash.toLowerCase() === record.transactionHash?.toLowerCase(),
    `${label} pinned creationProof differs from the originating plan or transaction.`);
  }
}
