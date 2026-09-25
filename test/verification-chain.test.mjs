import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { concatHex, createPublicClient, createWalletClient, encodeDeployData, encodeFunctionData, http, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { normalizeArtifact } from '../src/artifacts.mjs';
import { abiArguments, create2Address, linkBytecode, verifyCreation, verifyResource } from '../src/verification/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(await readFile(path.join(here, 'verification-fixtures/sample-build.json'), 'utf8'));
const artifacts = Object.fromEntries(Object.keys(fixture.contracts).map(name => [name, normalizeArtifact({ ...fixture.contracts[name], ast: fixture.ast }, name)]));
const ANVIL = process.env.ETHERPLAN_ANVIL ?? 'anvil';
const available = spawnSync(ANVIL, ['--version'], { stdio: 'ignore' }).status === 0;
const skip = available ? false : `${ANVIL} is not installed`;
const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const factory = { address: '0x4e59b44847b379578588920cA78FbF26c0B4956C', codeHash: '0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989' };
const ZERO = '0x0000000000000000000000000000000000000000';
const ONE = '0x0000000000000000000000000000000000000001';
const LABEL = `0x${'ab'.repeat(32)}`;
const DOUBLER = `${fixture.sourceName}:Doubler`;

let anvil;
let client;
let wallet;

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function send(request) {
  const hash = await wallet.sendTransaction({ ...request, chain: null });
  const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 50 });
  assert.equal(receipt.status, 'success');
  return { hash, receipt };
}

function salt(label) {
  return keccak256(`0x${Buffer.from(label).toString('hex')}`);
}

function prepared(name, args, { label = name, libraries = {}, checks = [] } = {}) {
  const artifact = artifacts[name];
  const constructor = artifact.abi.find(item => item.type === 'constructor');
  const initcode = encodeDeployData({ abi: artifact.abi, bytecode: linkBytecode(artifact.bytecode.object, artifact.bytecode.linkReferences, libraries), args: abiArguments(constructor?.inputs ?? [], args) });
  const resourceSalt = salt(label);
  return {
    id: `contract:${label}`, kind: 'contract', dependencies: [], address: create2Address(factory.address, resourceSalt, initcode), artifact, artifactHash: artifact.artifactHash,
    inputs: args, checks, libraries, expectedCodeHash: null, imported: false, initcode, initcodeHash: keccak256(initcode), salt: resourceSalt, factory,
  };
}

async function deploy(resource) {
  return send({ to: factory.address, data: concatHex([resource.salt, resource.initcode]) });
}

before(async () => {
  if (!available) return;
  const port = await freePort();
  anvil = spawn(ANVIL, ['--port', String(port), '--silent'], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  client = createPublicClient({ transport: http(url) });
  wallet = createWalletClient({ account: privateKeyToAccount(DEV_KEY), transport: http(url) });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await client.getChainId();
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error(`${ANVIL} did not start.`);
});

after(() => {
  anvil?.kill();
});

test('a CREATE2 proxy deployment is verified by simulation and by its transaction', { skip }, async () => {
  assert.equal(keccak256(await client.getCode({ address: factory.address })), factory.codeHash);
  const resource = prepared('Sample', [ONE, LABEL], { label: 'sample', checks: [{ functionName: 'UPSTREAM', expected: ONE }] });
  const before = await verifyResource(resource, client);
  assert.deepEqual([before.status, before.codeComparison.mode], ['conflict', 'absent']);
  const { hash, receipt } = await deploy(resource);
  const bySimulation = await verifyResource(resource, client, { blockNumber: receipt.blockNumber });
  assert.equal(bySimulation.status, 'verified', JSON.stringify(bySimulation.missingProofs));
  assert.deepEqual(bySimulation.evidence.immutables.map(item => [item.name, item.provenBy]), [['UPSTREAM', 'create2-simulation'], ['LABEL', 'create2-simulation'], ['SELF', 'create2-simulation']]);
  const byTransaction = await verifyResource(resource, client, { transactionHash: hash, simulate: false });
  assert.equal(byTransaction.status, 'verified', JSON.stringify(byTransaction.missingProofs));
  assert.equal((await verifyCreation(client, resource, hash)).kind, 'create2');
  const wrongContract = await verifyResource({ ...prepared('Stamped', ['1'], { label: 'wrong' }), address: resource.address, salt: undefined, factory: undefined, initcode: undefined, imported: true }, client);
  assert.equal(wrongContract.status, 'conflict');
});

test('an immutable read from block context needs a declared value once the context changes', { skip }, async () => {
  const resource = prepared('Stamped', ['9'], { label: 'stamped' });
  const { hash, receipt } = await deploy(resource);
  const atDeployment = await verifyResource(resource, client, { blockNumber: receipt.blockNumber, transactionHash: hash });
  assert.equal(atDeployment.status, 'verified', JSON.stringify(atDeployment.missingProofs));
  assert.equal(atDeployment.creationProof.blockHash, receipt.blockHash.toLowerCase());
  assert.equal(atDeployment.creationProof.kind, 'create2');
  await client.request({ method: 'evm_increaseTime', params: [3600] });
  await client.request({ method: 'evm_mine', params: [] });
  const later = await verifyResource(resource, client);
  assert.equal(later.status, 'unverified');
  assert.deepEqual(later.evidence.immutables.map(item => [item.name, item.provenBy]), [['CREATED_AT', null], ['SEED', 'create2-simulation']]);
  const anchored = await verifyResource(resource, client, { creationProof: atDeployment.creationProof });
  assert.equal(anchored.status, 'verified', JSON.stringify(anchored.missingProofs));
  assert.deepEqual(anchored.evidence.immutables.map(item => item.provenBy), ['create2-transaction', 'create2-transaction']);
  const rebuilt = await verifyResource({ ...resource, artifactHash: `0x${'44'.repeat(32)}` }, client, { creationProof: atDeployment.creationProof });
  assert.equal(rebuilt.status, 'verified');
  const withClient = (method, replacement) => Object.assign(Object.create(client), { [method]: replacement });
  const prunedCode = withClient('getCode', async request => {
    if (request.blockNumber === receipt.blockNumber) throw new Error('historical code pruned');
    return client.getCode(request);
  });
  assert.equal((await verifyResource(resource, prunedCode, { creationProof: atDeployment.creationProof })).status, 'verified');
  const stale = withClient('getBlock', async request => request.blockNumber === receipt.blockNumber
    ? { ...(await client.getBlock(request)), hash: `0x${'22'.repeat(32)}` } : client.getBlock(request));
  assert.equal((await verifyResource(resource, stale, { creationProof: atDeployment.creationProof, simulate: false })).status, 'unverified');
  const missing = withClient('getTransactionReceipt', async () => { throw new Error('receipt unavailable'); });
  assert.equal((await verifyResource(resource, missing, { creationProof: atDeployment.creationProof, simulate: false })).status, 'unverified');
  const wrongTransaction = withClient('getTransaction', async request => ({ ...(await client.getTransaction(request)), input: '0x00' }));
  assert.equal((await verifyResource(resource, wrongTransaction, { creationProof: atDeployment.creationProof, simulate: false })).status, 'unverified');
  const changedFactory = withClient('getCode', async request => request.address.toLowerCase() === factory.address.toLowerCase() && request.blockNumber === undefined
    ? '0x6000' : client.getCode(request));
  assert.equal((await verifyResource(resource, changedFactory, { creationProof: atDeployment.creationProof, simulate: false })).status, 'unverified');
  const liveCode = await client.getCode({ address: resource.address });
  let alteredWord = liveCode;
  for (const range of resource.artifact.immutables[0].ranges) {
    alteredWord = `0x${alteredWord.slice(2, 2 + range.start * 2)}${'00'.repeat(range.length)}${alteredWord.slice(2 + (range.start + range.length) * 2)}`;
  }
  const changedCode = withClient('getCode', async request => request.address.toLowerCase() === resource.address.toLowerCase()
    ? alteredWord : client.getCode(request));
  const changedRuntime = await verifyResource(resource, changedCode, { creationProof: atDeployment.creationProof, simulate: false });
  assert.equal(changedRuntime.status, 'unverified', JSON.stringify(changedRuntime.reasons));
  const changedSkeleton = withClient('getCode', async request => request.address.toLowerCase() === resource.address.toLowerCase()
    ? `0x00${liveCode.slice(4)}` : client.getCode(request));
  assert.equal((await verifyResource(resource, changedSkeleton, { creationProof: atDeployment.creationProof, simulate: false })).status, 'conflict');
  assert.equal((await verifyResource({ ...resource, salt: `0x${'33'.repeat(32)}` }, client, { creationProof: atDeployment.creationProof, simulate: false })).status, 'unverified');
  const changedBlock = await verifyResource(resource, client, { creationProof: { ...atDeployment.creationProof, blockHash: `0x${'11'.repeat(32)}` }, simulate: false });
  assert.equal(changedBlock.status, 'unverified');
  const wrongGetter = await verifyResource({ ...resource, checks: [{ functionName: 'CREATED_AT', expected: '0' }] }, client, { creationProof: atDeployment.creationProof });
  assert.equal(wrongGetter.status, 'conflict');
  const wrongInitcode = await verifyResource({ ...resource, inputs: ['10'], initcode: undefined }, client, { creationProof: atDeployment.creationProof, simulate: false });
  assert.equal(wrongInitcode.status, 'unverified');
  const createdAt = await client.readContract({ address: resource.address, abi: artifacts.Stamped.abi, functionName: 'CREATED_AT' });
  const declared = await verifyResource({ ...resource, checks: [{ functionName: 'CREATED_AT', expected: createdAt.toString() }] }, client);
  assert.equal(declared.status, 'verified', JSON.stringify(declared.missingProofs));
});

test('a direct CREATE deployment is verified only with its creation replay or value proofs', { skip }, async () => {
  const resource = prepared('Sample', [ONE, LABEL], { label: 'direct' });
  const { hash, receipt } = await send({ data: resource.initcode });
  const importedResource = { ...resource, address: receipt.contractAddress, salt: undefined, factory: undefined, initcode: undefined, initcodeHash: undefined, imported: true };
  const bare = await verifyResource(importedResource, client);
  assert.equal(bare.status, 'unverified');
  assert.equal(bare.missingProofs.length, 3);
  const replayed = await verifyResource(importedResource, client, { transactionHash: hash });
  assert.equal(replayed.status, 'verified', JSON.stringify(replayed.missingProofs));
  assert.equal(replayed.evidence.creation.kind, 'create');
});

test('a direct CREATE import retains receipt proof after its timestamp changes', { skip }, async () => {
  const resource = prepared('Stamped', ['12'], { label: 'direct-stamped' });
  const { hash, receipt } = await send({ data: resource.initcode });
  const imported = { ...resource, address: receipt.contractAddress, salt: undefined, factory: undefined, initcode: undefined, initcodeHash: undefined, imported: true };
  const captured = await verifyResource(imported, client, { transactionHash: hash });
  assert.equal(captured.status, 'verified');
  assert.equal(captured.creationProof.kind, 'create');
  await client.request({ method: 'evm_increaseTime', params: [3600] });
  await client.request({ method: 'evm_mine', params: [] });
  const reused = await verifyResource(imported, client, { creationProof: captured.creationProof });
  assert.equal(reused.status, 'verified', JSON.stringify(reused.missingProofs));
});

test('a linked library and its user are verified on chain', { skip }, async () => {
  const library = prepared('Doubler', [], { label: 'doubler' });
  await deploy(library);
  const libraryResult = await verifyResource(library, client);
  assert.deepEqual([libraryResult.status, libraryResult.codeComparison.mode], ['verified', 'exact']);
  const linked = prepared('Linked', ['21'], { label: 'linked', libraries: { [DOUBLER]: library.address } });
  await deploy(linked);
  const linkedResult = await verifyResource(linked, client);
  assert.equal(linkedResult.status, 'verified', JSON.stringify(linkedResult.missingProofs));
  assert.equal(await client.readContract({ address: linked.address, abi: artifacts.Linked.abi, functionName: 'doubled', args: [4n] }), 8n);
  const wrongLibrary = await verifyResource({ ...linked, initcode: undefined, salt: undefined, factory: undefined, libraries: { [DOUBLER]: ONE } }, client);
  assert.equal(wrongLibrary.status, 'conflict');
});

test('a binding moves from before to after only through its call', { skip }, async () => {
  const target = prepared('Sample', [ONE, LABEL], { label: 'bound' });
  await deploy(target);
  const call = {
    id: 'call:bind', kind: 'call', dependencies: [target.id], address: target.address, targetId: target.id, abi: artifacts.Sample.abi, method: 'bind', args: [ONE],
    before: { functionName: 'binding', expected: ZERO }, after: { functionName: 'binding', expected: ONE }, signerRole: 'owner',
  };
  const pending = await verifyResource(call, client);
  assert.deepEqual([pending.bindingChecks[0].observed, pending.status], ['before', 'unverified']);
  await send({ to: target.address, data: encodeFunctionData({ abi: artifacts.Sample.abi, functionName: 'bind', args: [ONE] }) });
  const done = await verifyResource(call, client);
  assert.deepEqual([done.bindingChecks[0].observed, done.status], ['after', 'verified']);
});
