import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getContractAddress, keccak256 } from 'viem';
import { applyPlan, readLocalJournal } from '../src/execution/index.ts';
import { readStoredJournal } from '../src/execution/backends.ts';
import { hashJson } from '../src/identity.ts';
import { compileSpec } from '../src/input/compile.ts';
import { parseHcl } from '../src/input/hcl.ts';
import { createPlan, prepareResources } from '../src/planning/index.ts';
import { graph, parseSpec } from '../src/spec/index.ts';
import { readState } from '../src/state/index.ts';
import { verifyResource } from '../src/verification/index.ts';
import { deployerA, startAnvil } from './execution/chain.ts';
import { memoryBackend } from './execution/memory-backend.ts';

// Constructor creates a child, writes its CREATE address into PUSH32, and returns
// a parent runtime whose implementation() getter always returns that address.
const RUNTIME = `0x7f${'00'.repeat(32)}60005260206000f3`;
const CHILD_INITCODE = '6002600c60003960026000f36000';
const INITCODE = `0x6029601d600039600e6046604039600e60406000f060015260296000f3${RUNTIME.slice(2)}${CHILD_INITCODE}`;
const CHILD_CODE = '0x6000';
const fields = {
  abi: [
    { type: 'constructor', stateMutability: 'nonpayable', inputs: [] },
    { type: 'function', name: 'implementation', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  ],
  bytecode: { object: INITCODE, linkReferences: {} },
  deployedBytecode: { object: RUNTIME, linkReferences: {}, immutableReferences: { '1': [{ start: 1, length: 32 }] } },
  buildIdentity: {},
};
const artifact = { ...fields, artifactHash: hashJson(fields) };
const salt = `0x${'37'.repeat(32)}`;

async function fixture() {
  const chain = await startAnvil();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'etherplan-pinned-'));
  const factoryAddress = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
  const factoryCode = await chain.client.getCode({ address: factoryAddress });
  assert.ok(factoryCode && factoryCode !== '0x');
  const spec = { schema: 1, chainId: 31337, values: {}, factory: { address: factoryAddress, codeHash: keccak256(factoryCode) },
    contracts: [{ id: 'parent', artifact: 'Parent.json', salt, args: [] }], calls: [] };
  const artifacts = new Map([['parent', artifact]]);
  const parent = prepareResources(spec, graph(parseSpec(spec)), artifacts).resources[0];
  assert.equal(parent.kind, 'contract');
  const childAddress = getContractAddress({ from: parent.address, nonce: 1n }).toLowerCase();
  const runtime = `0x7f${childAddress.slice(2).padStart(64, '0')}60005260206000f3`;
  const parentHash = keccak256(runtime);
  const childHash = keccak256(CHILD_CODE);
  const input = { spec, artifacts, client: chain.client, signers: { deployers: [deployerA.address] }, maxSpendWei: '1000000000000000000' };
  const stateFile = path.join(dir, 'state.json');
  const journalFile = path.join(dir, 'journal.jsonl');
  const apply = plan => applyPlan({ plan, spec, artifacts, client: chain.client, signers: { deployer: [deployerA] },
    stateFile, journalFile, pollIntervalMs: 20 });
  const close = async () => { await chain.stop(); await rm(dir, { recursive: true, force: true }); };
  return { chain, spec, artifacts, parent, childAddress, parentHash, childHash, input, stateFile, journalFile, apply, close };
}

test('pinned runtime verifies a fresh constructor-created child and revalidates its journal lineage', async () => {
  const ws = await fixture();
  try {
    ws.spec.contracts[0].creationProofMode = 'pinned-runtime';
    ws.spec.contracts[0].codeHash = ws.parentHash;
    ws.spec.contracts[0].createdCode = [{ getter: 'implementation', createNonce: 1, codeHash: ws.childHash }];
    const plan = await createPlan(ws.input);
    assert.equal(plan.resources[0].action, 'deploy');
    assert.equal(plan.resources[0].createdCode[0].address, ws.childAddress);
    const result = await ws.apply(plan);
    assert.equal(result.status, 'applied');
    assert.equal(result.resources[0].verification.creation.method, 'pinned-runtime');
    const state = await readState(ws.stateFile);
    const proof = state.resources['contract:parent'].creationProof;
    assert.equal(proof.method, 'pinned-runtime');
    const records = await readLocalJournal(ws.journalFile);
    const intent = records.find(record => record.phase === 'intent');
    assert.equal(intent.pinnedCommitment, proof.intentCommitment);
    assert.ok(intent.sequence < records.find(record => record.phase === 'signed').sequence);
    const replanned = await createPlan({ ...ws.input, state, journalRecords: records });
    assert.equal(replanned.resources[0].action, 'reuse');
    const recovered = await createPlan({ ...ws.input, journalRecords: records });
    assert.equal(recovered.resources[0].action, 'reuse');
    assert.equal(recovered.resources[0].observation.creationProof.method, 'pinned-runtime');
    const storedRecords = records.map(record => {
      if (record.phase !== 'signed') return record;
      const { rawTransaction: _raw, ...stored } = record;
      return { ...stored, encryptedRawTransaction: { ciphertext: 'test-only' } };
    });
    const backendReplan = await createPlan({ ...ws.input, state, journalRecords: storedRecords });
    assert.equal(backendReplan.resources[0].action, 'reuse');
    assert.equal((await ws.apply(plan)).transactionsSigned, 0);
    const prepared = prepareResources(ws.spec, graph(parseSpec(ws.spec)), ws.artifacts).resources[0];
    const publicCheck = await verifyResource(prepared, ws.chain.client, { transactionHash: proof.transactionHash, journalRecords: records });
    assert.equal(publicCheck.status, 'unverified');
    const savedCheck = await verifyResource(prepared, ws.chain.client, { creationProof: proof, journalRecords: records });
    assert.equal(savedCheck.status, 'verified');
    const withoutJournal = await createPlan({ ...ws.input, state });
    assert.equal(withoutJournal.resources[0].action, 'unverified');
    const mutated = structuredClone(state);
    mutated.resources['contract:parent'].creationProof.createdCode[0].codeHash = `0x${'00'.repeat(32)}`;
    const tampered = await createPlan({ ...ws.input, state: mutated, journalRecords: records });
    assert.equal(tampered.resources[0].action, 'unverified');
    const brokenJournal = structuredClone(records);
    brokenJournal.find(record => record.phase === 'intent').pinnedCommitment = `0x${'22'.repeat(32)}`;
    const broken = await createPlan({ ...ws.input, state, journalRecords: brokenJournal });
    assert.equal(broken.resources[0].action, 'unverified');
  } finally { await ws.close(); }
});

test('a fresh plan recovers a signed pinned-runtime deployment under its original commitment', async () => {
  const ws = await fixture();
  try {
    ws.spec.contracts[0].creationProofMode = 'pinned-runtime';
    ws.spec.contracts[0].codeHash = ws.parentHash;
    ws.spec.contracts[0].createdCode = [{ getter: 'implementation', createNonce: 1, codeHash: ws.childHash }];
    const original = await createPlan(ws.input);
    await assert.rejects(applyPlan({ plan: original, spec: ws.spec, artifacts: ws.artifacts, client: ws.chain.client,
      signers: { deployer: [deployerA] }, stateFile: ws.stateFile, journalFile: ws.journalFile,
      hooks: { afterRecord(record: { phase: string }) {
        if (record.phase === 'signed') throw new Error('stop after signature');
      } } }), /stop after signature/);
    const history = await readLocalJournal(ws.journalFile);
    const fresh = await createPlan({ ...ws.input, journalRecords: history });
    assert.equal(fresh.resources[0]?.action, 'recover');
    const result = await ws.apply(fresh);
    assert.equal(result.status, 'applied');
    assert.equal(result.transactionsSigned, 0);
    assert.equal(result.resources[0]?.verification.creation.method, 'pinned-runtime');
    assert.equal((await readLocalJournal(ws.journalFile)).filter(record => record.phase === 'signed').length, 1);
  } finally { await ws.close(); }
});

test('HCL pins lower to the same validated JSON commitments', () => {
  const hash = `0x${'ab'.repeat(32)}`;
  const source = `variable "parent_hash" {
  type = bytes32
  default = "${hash}"
}
variable "child_hash" {
  type = bytes32
  default = "${hash}"
}
chain_id = 1
resource "contract" "parent" {
  artifact = "Parent.json"
  salt = "${salt}"
  args = []
  creation_proof_mode = "pinned_runtime"
  code_hash = var.parent_hash
  created_code = [{ getter = "implementation", create_nonce = 1, code_hash = var.child_hash }]
}`;
  const spec = parseSpec(compileSpec(parseHcl('pinned.ethp', source)));
  assert.equal(spec.contracts[0].creationProofMode, 'pinned-runtime');
  assert.deepEqual(spec.contracts[0].createdCode, [{ getter: 'implementation', createNonce: 1, codeHash: hash }]);
  const { codeHash: _codeHash, ...withoutParentPin } = spec.contracts[0];
  assert.throws(() => parseSpec({ ...spec, contracts: [withoutParentPin] }), /requires a parent codeHash/);
  assert.throws(() => parseSpec({ ...spec, contracts: [{ ...spec.contracts[0], createdCode: [{ getter: 'implementation', createNonce: 0, codeHash: hash }] }] }), /positive safe integer/);
});

test('constructor replay remains the default and cannot be upgraded after signing', async () => {
  const ws = await fixture();
  try {
    const plan = await createPlan(ws.input);
    await assert.rejects(ws.apply(plan), error => {
      assert.equal(error.code, 'postcondition');
      return true;
    });
    const records = await readLocalJournal(ws.journalFile);
    assert.equal(records.filter(record => record.phase === 'verified').length, 0);
    assert.equal((await readState(ws.stateFile)), null);
    ws.spec.contracts[0].creationProofMode = 'pinned-runtime';
    ws.spec.contracts[0].codeHash = ws.parentHash;
    ws.spec.contracts[0].createdCode = [{ getter: 'implementation', createNonce: 1, codeHash: ws.childHash }];
    const result = await createPlan({ ...ws.input, journalRecords: records });
    assert.equal(result.resources[0].action, 'conflict');
    assert.equal(result.resources[0].observation.creationProof, undefined);
  } finally { await ws.close(); }
});

test('pin edits after planning stop before signing', async () => {
  const ws = await fixture();
  try {
    ws.spec.contracts[0].creationProofMode = 'pinned-runtime';
    ws.spec.contracts[0].codeHash = ws.parentHash;
    ws.spec.contracts[0].createdCode = [{ getter: 'implementation', createNonce: 1, codeHash: ws.childHash }];
    const plan = await createPlan(ws.input);
    ws.spec.contracts[0].createdCode[0].codeHash = `0x${'11'.repeat(32)}`;
    await assert.rejects(ws.apply(plan), error => error.code === 'stale-spec');
    assert.equal(await ws.chain.client.getTransactionCount({ address: deployerA.address }), 0);
    assert.equal((await readLocalJournal(ws.journalFile).catch(() => [])).filter(record => record.phase === 'signed').length, 0);
  } finally { await ws.close(); }
});

test('production backend revalidates pinned proof from encrypted journal history', async () => {
  const ws = await fixture();
  try {
    ws.spec.contracts[0].creationProofMode = 'pinned-runtime';
    ws.spec.contracts[0].codeHash = ws.parentHash;
    ws.spec.contracts[0].createdCode = [{ getter: 'implementation', createNonce: 1, codeHash: ws.childHash }];
    const genesisHash = (await ws.chain.client.getBlock({ blockNumber: 0n })).hash;
    const scope = { project: 'test', environment: 'dev', label: 'pinned', chainId: 31337, genesisHash };
    const backend = memoryBackend(scope);
    const plan = await createPlan(ws.input);
    const result = await applyPlan({ plan, spec: ws.spec, artifacts: ws.artifacts, client: ws.chain.client,
      signers: { deployer: [deployerA] }, ...backend, scope, confirmations: 1, pollIntervalMs: 20 });
    assert.equal(result.status, 'applied');
    const state = (await backend.stateStore.read(scope)).value;
    const records = await readStoredJournal(backend.journalStore, scope);
    assert.equal(records.find(record => record.phase === 'signed').rawTransaction, undefined);
    const reused = await createPlan({ ...ws.input, state, journalRecords: records });
    assert.equal(reused.resources[0].action, 'reuse');
  } finally { await ws.close(); }
});

test('pipeline signing records the pinned commitment before its signature', async () => {
  const ws = await fixture();
  try {
    ws.spec.contracts[0].creationProofMode = 'pinned-runtime';
    ws.spec.contracts[0].codeHash = ws.parentHash;
    ws.spec.contracts[0].createdCode = [{ getter: 'implementation', createNonce: 1, codeHash: ws.childHash }];
    const plan = await createPlan({ ...ws.input, signers: null, pipeline: { deployers: [deployerA.address], parallel: false } });
    const result = await applyPlan({ plan, spec: ws.spec, artifacts: ws.artifacts, client: ws.chain.client,
      signers: { deployer: [deployerA] }, stateFile: ws.stateFile, journalFile: ws.journalFile, pipeline: true, pollIntervalMs: 20 });
    assert.equal(result.status, 'applied');
    const records = await readLocalJournal(ws.journalFile);
    const intent = records.find(record => record.phase === 'intent');
    const signed = records.find(record => record.phase === 'signed');
    assert.ok(intent.pinnedCommitment);
    assert.ok(intent.sequence < signed.sequence);
  } finally { await ws.close(); }
});

test('incorrect parent hash, child nonce, or child hash cannot produce a verified creation proof', async () => {
  for (const variant of ['parent', 'nonce', 'hash']) {
    const ws = await fixture();
    try {
      ws.spec.contracts[0].creationProofMode = 'pinned-runtime';
      ws.spec.contracts[0].codeHash = variant === 'parent' ? `0x${'00'.repeat(32)}` : ws.parentHash;
      ws.spec.contracts[0].createdCode = [{ getter: 'implementation', createNonce: variant === 'nonce' ? 2 : 1,
        codeHash: variant === 'hash' ? `0x${'00'.repeat(32)}` : ws.childHash }];
      const plan = await createPlan(ws.input);
      await assert.rejects(ws.apply(plan), error => error.code === 'postcondition');
      const records = await readLocalJournal(ws.journalFile);
      assert.equal(records.filter(record => record.phase === 'verified').length, 0, variant);
      assert.equal(await readState(ws.stateFile), null);
    } finally { await ws.close(); }
  }
});

test('saved pinned proof fails when child runtime changes after deployment', async () => {
  const ws = await fixture();
  try {
    ws.spec.contracts[0].creationProofMode = 'pinned-runtime';
    ws.spec.contracts[0].codeHash = ws.parentHash;
    ws.spec.contracts[0].createdCode = [{ getter: 'implementation', createNonce: 1, codeHash: ws.childHash }];
    const plan = await createPlan(ws.input);
    await ws.apply(plan);
    const state = await readState(ws.stateFile);
    const records = await readLocalJournal(ws.journalFile);
    await ws.chain.rpc('anvil_setCode', [ws.childAddress, '0x6001']);
    const drifted = await createPlan({ ...ws.input, state, journalRecords: records });
    assert.equal(drifted.resources[0].action, 'unverified');
    assert.equal(drifted.resources[0].observation.creationProof, undefined);
  } finally { await ws.close(); }
});
