import { canonicalJson } from './identity.ts';
import { keccak256 } from 'viem';
import { intentForSigned } from './execution/journal.ts';
import { transactionFor } from './planning/resources.ts';
import { pinnedCommitment, pinnedJournalCommitment, samePinnedCommitments } from './verification/pinned-runtime.ts';
import type { PlannedRecovery, PreparedContract, PreparedResource } from './planning/types.ts';
import type { ChainIdentity } from './types.ts';
import type { JournalRecord, SignedRecord, StoredJournalRecord } from './execution/types.ts';
import type { CreationProof } from './verification/types.ts';

export type RecoveryRecord = JournalRecord | StoredJournalRecord;

/** Return only attempts that still have a signed transaction to settle or verify. */
export function pendingRecovery(records: readonly RecoveryRecord[], resource: PreparedResource, chain: ChainIdentity):
  { recovery: PlannedRecovery; matches: boolean } | null {
  if (resource.kind === 'external') return null;
  const groups = new Map<string, RecoveryRecord[]>();
  for (const record of records) {
    if (record.actionId !== resource.id || record.chain.id !== chain.id || !same(record.chain.genesisHash, chain.genesisHash)) continue;
    const group = groups.get(record.planHash) ?? [];
    group.push(record);
    groups.set(record.planHash, group);
  }
  const candidates = [...groups.values()].flatMap(group => {
    const latest = group.at(-1);
    if (!latest || latest.phase === 'verified' ||
      (latest.phase === 'failed' && !['postcondition', 'nonce-race'].includes(latest.code))) return [];
    const signed = group.filter(record => record.phase === 'signed').at(-1);
    if (!signed || signed.phase !== 'signed') return [];
    return [{ group, signed }];
  }).sort((a, b) => b.signed.sequence - a.signed.sequence);
  const candidate = candidates[0];
  if (!candidate) return null;
  const { signed } = candidate;
  const recovery: PlannedRecovery = { originPlanHash: signed.planHash, signedSequence: signed.sequence,
    transactionHash: signed.transactionHash, signer: signed.signer, nonce: signed.nonce };
  try {
    const intent = intentForSigned(records as JournalRecord[], signed as SignedRecord);
    const tx = transactionFor(resource);
    const pinnedMatches = resource.kind !== 'contract' ? !intent.pinnedCommitment :
      resource.creationProofMode === 'pinned-runtime'
        ? same(intent.pinnedCommitment, pinnedCommitment(signed.planHash, resource))
        : !intent.pinnedCommitment;
    return { recovery, matches: candidates.length === 1 && same(intent.to, tx.to) && intent.value === tx.value &&
      same(intent.dataHash, keccak256(tx.data)) && pinnedMatches };
  } catch {
    return { recovery, matches: false };
  }
}

const same = (left: string | null | undefined, right: string | null | undefined): boolean =>
  left?.toLowerCase() === right?.toLowerCase();

/** A previous apply's verified deployment must have its own signed transaction and successful receipt. */
export function recoveryProof(records: readonly RecoveryRecord[], resource: PreparedContract, chain: ChainIdentity): CreationProof | null {
  if (!resource.initcodeHash || !resource.salt || !resource.factory) return null;
  for (let index = records.length - 1; index >= 0; index--) {
    const verified = records[index];
    if (!verified || verified.phase !== 'verified' || verified.actionId !== resource.id || verified.outcome !== 'applied' ||
      verified.verification.status !== 'verified' || !verified.creationProof || !verified.transactionHash ||
      verified.chain.id !== chain.id || !same(verified.chain.genesisHash, chain.genesisHash)) continue;
    const proof = verified.creationProof;
    if (proof.kind !== 'create2' || proof.chain.id !== chain.id || !same(proof.chain.genesisHash, chain.genesisHash) ||
      !same(proof.transactionHash, verified.transactionHash) || !same(proof.address, resource.address) ||
      !same(verified.address, resource.address) || !same(verified.codeHash, proof.codeHash) ||
      !same(proof.initcodeHash, resource.initcodeHash) || !same(proof.salt, resource.salt) ||
      !same(proof.factory.address, resource.factory.address) || !same(proof.factory.codeHash, resource.factory.codeHash)) continue;
    if ((proof.method === 'pinned-runtime') !== (resource.creationProofMode === 'pinned-runtime')) continue;
    if (proof.method === 'pinned-runtime') {
      const lineage = pinnedJournalCommitment(records, resource, proof.transactionHash, proof.originPlanHash, proof.creator,
        { blockHash: proof.blockHash, blockNumber: proof.blockNumber }, chain);
      if (!samePinnedCommitments(proof, resource) || !lineage || !same(lineage.commitment, proof.intentCommitment) ||
        !same(verified.planHash, proof.originPlanHash)) continue;
    }
    const earlier = records.slice(0, index).filter(record => record.planHash === verified.planHash && record.actionId === resource.id &&
      record.chain.id === chain.id && same(record.chain.genesisHash, chain.genesisHash));
    const receipt = earlier.findLast(record => record.phase === 'receipt' && same(record.transactionHash, proof.transactionHash));
    const signed = earlier.findLast(record => record.phase === 'signed' && same(record.transactionHash, proof.transactionHash));
    if (!receipt || receipt.phase !== 'receipt' || receipt.receipt.status !== 'success' ||
      !same(receipt.receipt.transactionHash, proof.transactionHash) ||
      !same(receipt.receipt.blockHash, proof.blockHash) || receipt.receipt.blockNumber !== proof.blockNumber ||
      !signed || signed.phase !== 'signed' || !same(signed.signer, proof.creator) || signed.sequence >= receipt.sequence ||
      receipt.sequence >= verified.sequence) continue;
    return proof;
  }
  return null;
}

export function sameRecoveryProof(left: CreationProof | null | undefined, right: CreationProof | null | undefined): boolean {
  return Boolean(left && right && canonicalJson(left) === canonicalJson(right));
}
