import { concatHex, getContractAddress, keccak256 } from 'viem';
import { hashJson } from '../identity.ts';
import { intentForSigned } from '../execution/journal.ts';
import type { PreparedContract } from '../planning/types.ts';
import type { PreparedAction, SignedRecord } from '../execution/types.ts';
import type { ChainIdentity, Client, Hash } from '../types.ts';
import type { RecoveryRecord } from '../recovery.ts';
import type { CreationProof } from './types.ts';
import type { JournalRecord } from '../execution/types.ts';

const same = (left: string | null | undefined, right: string | null | undefined): boolean => left?.toLowerCase() === right?.toLowerCase();

/** Hash only values that existed in the plan before its transaction was signed. */
export function pinnedCommitment(planHash: Hash, resource: PreparedContract): Hash {
  if (resource.creationProofMode !== 'pinned-runtime' || !resource.factory || !resource.salt || !resource.initcodeHash ||
    !resource.expectedCodeHash || !resource.createdCode?.length) throw new Error(`${resource.id} has no complete pinned-runtime commitment.`);
  return hashJson({ planHash, id: resource.id, address: resource.address, artifactHash: resource.artifactHash,
    initcodeHash: resource.initcodeHash, inputsHash: resource.inputsHash, salt: resource.salt, factory: resource.factory,
    codeHash: resource.expectedCodeHash, createdCode: resource.createdCode });
}

export function pinnedIntentFields(planHash: Hash, item: PreparedAction): { pinnedCommitment?: Hash } {
  return item.resource.kind === 'contract' && item.resource.creationProofMode === 'pinned-runtime'
    ? { pinnedCommitment: pinnedCommitment(planHash, item.resource) } : {};
}

export function assertPinnedSignedIntent(records: JournalRecord[], planHash: Hash, item: PreparedAction, signed: SignedRecord): void {
  if (item.resource.kind !== 'contract' || item.resource.creationProofMode !== 'pinned-runtime') return;
  const intent = intentForSigned(records, signed);
  if (!same(signed.planHash, planHash) || !same(intent.pinnedCommitment, pinnedCommitment(planHash, item.resource))) {
    throw new Error(`${item.planned.id} has no matching pre-sign pinned-runtime intent.`);
  }
}

export function pinnedChildAddress(parent: PreparedContract['address'], nonce: number): PreparedContract['address'] {
  return getContractAddress({ from: parent, nonce: BigInt(nonce) }).toLowerCase() as PreparedContract['address'];
}

export async function assertPinnedAbsent(client: Client, resource: PreparedContract, blockNumber?: bigint): Promise<void> {
  if (resource.creationProofMode !== 'pinned-runtime') return;
  for (const address of [resource.address, ...(resource.createdCode ?? []).map(child => child.address)]) {
    const code = await client.getCode({ address, ...(blockNumber === undefined ? {} : { blockNumber }) });
    if (code && code !== '0x') throw new Error(`Pinned-runtime deployment requires no existing code at ${address}.`);
  }
}

/** Require a durable intent, signature, and receipt for the exact planned deployment. */
export function pinnedJournalCommitment(records: readonly RecoveryRecord[] | undefined, resource: PreparedContract,
  transactionHash: Hash, originPlanHash: Hash | undefined, transactionFrom: string,
  canonicalReceipt: { blockHash: Hash; blockNumber: bigint | string }, chain: ChainIdentity): { planHash: Hash; commitment: Hash } | null {
  if (!records || !resource.factory || !resource.salt || !resource.initcode || resource.creationProofMode !== 'pinned-runtime') return null;
  const signed = records.findLast(record => record.phase === 'signed' && record.actionId === resource.id &&
    same(record.transactionHash, transactionHash) && (!originPlanHash || same(record.planHash, originPlanHash)));
  if (!signed || signed.phase !== 'signed' || !same(signed.signer, transactionFrom) ||
    signed.chain.id !== chain.id || !same(signed.chain.genesisHash, chain.genesisHash)) return null;
  // Production read-only journal loads retain encrypted signed bytes. The
  // stored record hash chain covers their ciphertext and transaction hash;
  // an open apply journal additionally lets us check the plaintext bytes.
  if ('rawTransaction' in signed && typeof signed.rawTransaction === 'string') {
    if (!same(keccak256(signed.rawTransaction), transactionHash)) return null;
  } else if (!('encryptedRawTransaction' in signed) || !signed.encryptedRawTransaction) return null;
  let intent;
  try { intent = intentForSigned(records as JournalRecord[], signed as JournalRecord & { phase: 'signed' } & import('../execution/types.ts').SignedFields); }
  catch { return null; }
  const receipt = records.findLast(record => record.phase === 'receipt' && record.actionId === resource.id &&
    same(record.planHash, signed.planHash) && same(record.transactionHash, transactionHash));
  if (!receipt || receipt.phase !== 'receipt' || receipt.receipt.status !== 'success' ||
    !same(receipt.receipt.blockHash, canonicalReceipt.blockHash) ||
    BigInt(receipt.receipt.blockNumber) !== BigInt(canonicalReceipt.blockNumber) ||
    receipt.chain.id !== signed.chain.id || !same(receipt.chain.genesisHash, signed.chain.genesisHash) ||
    intent.sequence >= signed.sequence || signed.sequence >= receipt.sequence ||
    !same(intent.signer, signed.signer) || !same(intent.to, resource.factory.address) ||
    intent.value !== '0' || !same(intent.dataHash, keccak256(concatHex([resource.salt, resource.initcode])))) return null;
  const commitment = pinnedCommitment(signed.planHash, resource);
  if (!same(intent.pinnedCommitment, commitment)) return null;
  return { planHash: signed.planHash, commitment };
}

export function samePinnedCommitments(saved: CreationProof, resource: PreparedContract): boolean {
  if (saved.kind !== 'create2' || saved.method !== 'pinned-runtime' || resource.creationProofMode !== 'pinned-runtime' ||
    !resource.expectedCodeHash || !resource.createdCode || !same(saved.codeHash, resource.expectedCodeHash) ||
    saved.createdCode.length !== resource.createdCode.length) return false;
  return saved.createdCode.every((child, index) => {
    const expected = resource.createdCode![index];
    return expected && child.getter === expected.getter && child.createNonce === expected.createNonce &&
      same(child.address, expected.address) && same(child.codeHash, expected.codeHash) &&
      same(child.address, pinnedChildAddress(resource.address, child.createNonce));
  });
}
