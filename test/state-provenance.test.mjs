import assert from 'node:assert/strict';
import test from 'node:test';
import { importResource, recordResource, validateState } from '../src/state/index.mjs';
import { plan, preparedResource, verificationResult } from './interface-fixtures.mjs';

const creationTransactionHash = `0x${'44'.repeat(32)}`;
const replacementTransactionHash = `0x${'55'.repeat(32)}`;
const replacementAddress = '0x0000000000000000000000000000000000000002';

test('import provenance needs creation evidence and replacement state retains the prior address and proof', () => {
  const evidence = {
    ...verificationResult,
    evidence: { creation: { status: 'verified', transactionHash: creationTransactionHash } },
  };
  assert.throws(() => importResource({
    resource: preparedResource,
    verification: verificationResult,
    state: null,
    chain: plan.chain,
    creationTransactionHash,
  }), /unverified creation transaction/);

  const imported = importResource({
    resource: preparedResource,
    verification: evidence,
    state: null,
    chain: plan.chain,
    creationTransactionHash,
  });
  const prior = imported.resources[preparedResource.id];
  assert.deepEqual(prior.provenance, { kind: 'import', creationTransactionHash });

  const replacement = { ...preparedResource, address: replacementAddress };
  const verifiedReplacement = { ...verificationResult, address: replacementAddress };
  const recorded = recordResource({
    resource: replacement,
    verification: verifiedReplacement,
    state: imported,
    chain: plan.chain,
    transactions: [replacementTransactionHash],
  }).resources[preparedResource.id];
  assert.equal(recorded.priorAddress, preparedResource.address);
  assert.equal(recorded.priorCodeHash, prior.codeHash);
  assert.equal(recorded.priorProofHash, prior.proofHash);
  assert.deepEqual(recorded.provenance, { kind: 'apply' });
  assert.deepEqual(recorded.transactions, [replacementTransactionHash]);
});

test('state accepts a structured creation proof, validates identity, and drops it on replacement', () => {
  const creationProof = {
    chain: plan.chain,
    transactionHash: creationTransactionHash,
    blockNumber: '7',
    blockHash: `0x${'66'.repeat(32)}`,
    address: preparedResource.address,
    kind: 'create2',
    initcodeHash: preparedResource.initcodeHash,
    codeHash: verificationResult.codeHash,
    factory: preparedResource.factory,
    salt: preparedResource.salt,
  };
  const state = recordResource({ resource: preparedResource, verification: { ...verificationResult, creationProof }, state: null, chain: plan.chain, transactions: [creationTransactionHash] });
  assert.deepEqual(state.resources[preparedResource.id].creationProof, creationProof);
  assert.throws(() => validateState({ ...state, resources: { [preparedResource.id]: { ...state.resources[preparedResource.id], creationProof: { ...creationProof, codeHash: `0x${'77'.repeat(32)}` } } } }), /different deployment/);
  assert.throws(() => validateState({ ...state, resources: { [preparedResource.id]: { ...state.resources[preparedResource.id], creationProof: { ...creationProof, extra: true } } } }), /invalid fields/);
  const replacement = { ...preparedResource, address: replacementAddress };
  const replaced = recordResource({ resource: replacement, verification: { ...verificationResult, address: replacementAddress }, state, chain: plan.chain, transactions: [replacementTransactionHash] });
  assert.equal(replaced.resources[preparedResource.id].creationProof, undefined);
});
