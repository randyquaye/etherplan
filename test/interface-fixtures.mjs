import { concatHex, keccak256 } from 'viem';
import { hashJson } from '../src/identity.mjs';

const salt = `0x${'11'.repeat(32)}`;
const initcode = '0x6002600c60003960026000f36000';
const runtime = '0x6000';
const factory = {
  address: '0x4e59b44847b379578588920cA78FbF26c0B4956C',
  codeHash: '0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989',
};
const address = `0x${keccak256(concatHex(['0xff', factory.address, salt, keccak256(initcode)])).slice(-40)}`;
const artifactFields = {
  abi: [],
  bytecode: { object: initcode, linkReferences: {} },
  deployedBytecode: { object: runtime, linkReferences: {}, immutableReferences: {} },
  buildIdentity: { compiler: 'solc', version: '0.8.30', sourceHash: `0x${'22'.repeat(32)}`, settingsHash: `0x${'33'.repeat(32)}` },
};

export const normalizedArtifact = { ...artifactFields, artifactHash: hashJson(artifactFields) };

export const exampleSpec = {
  schema: 1,
  chainId: 31337,
  values: {},
  externals: {},
  calls: [],
  factory,
  contracts: [{ id: 'example', artifact: 'Example.json', salt, args: [], senderIndependent: true }],
};

export const preparedResource = {
  id: 'contract:example',
  kind: 'contract',
  dependencies: [],
  address,
  artifact: normalizedArtifact,
  artifactHash: normalizedArtifact.artifactHash,
  initcode,
  initcodeHash: keccak256(initcode),
  inputs: [],
  inputsHash: hashJson([]),
  salt,
  factory,
  checks: [],
  signerRole: 'deployer',
  senderIndependent: true,
};

export const verificationResult = {
  id: preparedResource.id,
  address,
  codeHash: keccak256(runtime),
  codeComparison: { mode: 'exact', matched: true },
  proofs: [{ name: 'runtime', method: 'exact-runtime', expected: runtime, actual: runtime, matched: true }],
  missingProofs: [],
  bindingChecks: [],
  status: 'verified',
};

const planFields = {
  formatVersion: 1,
  chain: { id: 31337, genesisHash: `0x${'aa'.repeat(32)}` },
  observed: { blockNumber: '1', blockHash: `0x${'bb'.repeat(32)}` },
  stateHash: hashJson(null),
  specHash: hashJson(exampleSpec),
  artifactHashes: { 'contract:example': normalizedArtifact.artifactHash },
  resources: [{
    id: preparedResource.id,
    kind: preparedResource.kind,
    dependencies: [],
    address,
    artifactHash: preparedResource.artifactHash,
    initcodeHash: preparedResource.initcodeHash,
    inputsHash: preparedResource.inputsHash,
    salt,
    factory,
    checks: [],
    signerRole: 'deployer',
    senderIndependent: true,
    action: 'deploy',
    observation: { ...verificationResult, codeHash: null, codeComparison: { mode: 'absent', matched: false }, proofs: [], status: 'conflict' },
    tx: { to: factory.address, data: concatHex([salt, initcode]), value: '0' },
  }],
};

export const plan = { ...planFields, planHash: hashJson(planFields) };

export const state = {
  formatVersion: 1,
  chain: plan.chain,
  resources: {
    [preparedResource.id]: {
      address,
      priorAddress: null,
      artifactHash: preparedResource.artifactHash,
      sourceHash: normalizedArtifact.buildIdentity.sourceHash,
      initcodeHash: preparedResource.initcodeHash,
      inputs: [],
      inputsHash: preparedResource.inputsHash,
      priorInputs: null,
      priorInputsHash: null,
      salt,
      codeHash: verificationResult.codeHash,
      priorCodeHash: null,
      proofHash: hashJson(verificationResult),
      priorProofHash: null,
      transactions: [],
      provenance: { kind: 'import', creationTransactionHash: null },
    },
  },
};

const rawTransaction = '0x02c0';
export const journalEntry = {
  formatVersion: 1,
  planHash: plan.planHash,
  chain: plan.chain,
  actionId: preparedResource.id,
  sequence: 1,
  phase: 'signed',
  signer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  nonce: '0',
  rawTransaction,
  transactionHash: keccak256(rawTransaction),
};
