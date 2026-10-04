import { canonicalJson } from './identity.ts';
import { pinnedJournalCommitment, samePinnedCommitments } from './verification/pinned-runtime.ts';
import type { PreparedContract } from './planning/types.ts';
import type { ChainIdentity } from './types.ts';
import type { JournalRecord, StoredJournalRecord } from './execution/types.ts';
import type { CreationProof } from './verification/types.ts';

export type RecoveryRecord = JournalRecord | StoredJournalRecord;

const same = (left: string | null | undefined, right: string | null | undefined): boolean =>
  left?.toLowerCase() === right?.toLowerCase();

/** A previous apply's verified deployment must have its own signed transaction and successful receipt. */
export function recoveryProof(
  records: readonly RecoveryRecord[],
  resource: PreparedContract,
  chain: ChainIdentity,
): CreationProof | null {
  if (!resource.initcodeHash || !resource.salt || !resource.factory) return null;
  for (let index = records.length - 1; index >= 0; index--) {
    const verified = records[index];
    if (
      !verified ||
      verified.phase !== 'verified' ||
      verified.actionId !== resource.id ||
      verified.outcome !== 'applied' ||
      verified.verification.status !== 'verified' ||
      !verified.creationProof ||
      !verified.transactionHash ||
      verified.chain.id !== chain.id ||
      !same(verified.chain.genesisHash, chain.genesisHash)
    )
      continue;
    const proof = verified.creationProof;
    if (
      proof.kind !== 'create2' ||
      proof.chain.id !== chain.id ||
      !same(proof.chain.genesisHash, chain.genesisHash) ||
      !same(proof.transactionHash, verified.transactionHash) ||
      !same(proof.address, resource.address) ||
      !same(verified.address, resource.address) ||
      !same(verified.codeHash, proof.codeHash) ||
      !same(proof.initcodeHash, resource.initcodeHash) ||
      !same(proof.salt, resource.salt) ||
      !same(proof.factory.address, resource.factory.address) ||
      !same(proof.factory.codeHash, resource.factory.codeHash)
    )
      continue;
    if ((proof.method === 'pinned-runtime') !== (resource.creationProofMode === 'pinned-runtime'))
      continue;
    if (proof.method === 'pinned-runtime') {
      const lineage = pinnedJournalCommitment(
        records,
        resource,
        proof.transactionHash,
        proof.originPlanHash,
        proof.creator,
        { blockHash: proof.blockHash, blockNumber: proof.blockNumber },
        chain,
      );
      if (
        !samePinnedCommitments(proof, resource) ||
        !lineage ||
        !same(lineage.commitment, proof.intentCommitment) ||
        !same(verified.planHash, proof.originPlanHash)
      )
        continue;
    }
    const earlier = records
      .slice(0, index)
      .filter(
        (record) =>
          record.planHash === verified.planHash &&
          record.actionId === resource.id &&
          record.chain.id === chain.id &&
          same(record.chain.genesisHash, chain.genesisHash),
      );
    const receipt = earlier.findLast(
      (record) => record.phase === 'receipt' && same(record.transactionHash, proof.transactionHash),
    );
    const signed = earlier.findLast(
      (record) => record.phase === 'signed' && same(record.transactionHash, proof.transactionHash),
    );
    if (
      !receipt ||
      receipt.phase !== 'receipt' ||
      receipt.receipt.status !== 'success' ||
      !same(receipt.receipt.transactionHash, proof.transactionHash) ||
      !same(receipt.receipt.blockHash, proof.blockHash) ||
      receipt.receipt.blockNumber !== proof.blockNumber ||
      !signed ||
      signed.phase !== 'signed' ||
      !same(signed.signer, proof.creator) ||
      signed.sequence >= receipt.sequence ||
      receipt.sequence >= verified.sequence
    )
      continue;
    return proof;
  }
  return null;
}

export function sameRecoveryProof(
  left: CreationProof | null | undefined,
  right: CreationProof | null | undefined,
): boolean {
  return Boolean(left && right && canonicalJson(left) === canonicalJson(right));
}
