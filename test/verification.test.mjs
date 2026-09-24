import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { concatHex, encodeDeployData, keccak256, pad } from 'viem';
import { normalizeArtifact } from '../src/artifacts.mjs';
import { canonicalJson, hashJson } from '../src/identity.mjs';
import {
  PROBE_ADDRESS,
  abiArguments,
  create2Address,
  decodeMetadataTail,
  fillLibraryGuard,
  linkBytecode,
  verifyCreation,
  verifyResource,
} from '../src/verification/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(await readFile(path.join(here, 'verification-fixtures/sample-build.json'), 'utf8'));
const artifacts = Object.fromEntries(Object.keys(fixture.contracts).map(name => [name, normalizeArtifact({ ...fixture.contracts[name], ast: fixture.ast }, name)]));
const FACTORY_CODE = '0x6000';
const factory = { address: '0x4e59b44847b379578588920cA78FbF26c0B4956C', codeHash: keccak256(FACTORY_CODE) };
const ZERO = '0x0000000000000000000000000000000000000000';
const ONE = '0x0000000000000000000000000000000000000001';
const TWO = '0x0000000000000000000000000000000000000002';
const HERE = '0x00000000000000000000000000000000000000c1';
const LIBRARY = '0x00000000000000000000000000000000000000aa';
const OTHER_LIBRARY = '0x00000000000000000000000000000000000000bb';
const LABEL = `0x${'ab'.repeat(32)}`;
const SALT = `0x${'11'.repeat(32)}`;
const DOUBLER = `${fixture.sourceName}:Doubler`;

function word(value) {
  return (typeof value === 'bigint' ? value.toString(16) : value.slice(2)).toLowerCase().padStart(64, '0');
}

function runtime(name, { immutables = {}, libraries = {}, address } = {}) {
  const artifact = artifacts[name];
  let code = linkBytecode(artifact.deployedBytecode.object, artifact.deployedBytecode.linkReferences, libraries);
  if (address) code = fillLibraryGuard(code, address);
  let text = code.slice(2);
  for (const item of artifact.immutables) {
    const value = immutables[item.name];
    if (value === undefined) continue;
    for (const { start, length } of item.ranges) text = `${text.slice(0, start * 2)}${word(value)}${text.slice((start + length) * 2)}`;
  }
  return `0x${text}`;
}

function flip(code, offset) {
  const text = code.slice(2);
  const byte = (parseInt(text.slice(offset * 2, offset * 2 + 2), 16) ^ 0xff).toString(16).padStart(2, '0');
  return `0x${text.slice(0, offset * 2)}${byte}${text.slice(offset * 2 + 2)}`;
}

function mockClient({ codes = {}, reads = {}, call, transactions = {}, receipts = {} } = {}) {
  const calls = [];
  return {
    calls,
    getCode: async ({ address }) => codes[address.toLowerCase()] ?? '0x',
    readContract: async ({ address, functionName }) => {
      const value = reads[`${address.toLowerCase()}:${functionName}`];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`The contract function "${functionName}" returned no data.`);
      return value;
    },
    call: async request => {
      calls.push(request);
      if (!call) throw new Error('Method eth_call with state overrides is not supported at https://rpc.example/v2/secret-key');
      return call(request);
    },
    getTransaction: async ({ hash }) => {
      if (!transactions[hash]) throw new Error('Transaction not found. URL: https://rpc.example/v2/secret-key');
      return transactions[hash];
    },
    getTransactionReceipt: async ({ hash }) => receipts[hash],
  };
}

function imported(name, address, extra = {}) {
  const artifact = artifacts[name];
  return { id: `contract:${name.toLowerCase()}`, kind: 'contract', dependencies: [], address, artifact, artifactHash: artifact.artifactHash, inputs: [], checks: [], libraries: {}, expectedCodeHash: null, imported: true, ...extra };
}

function deployable(name, args, { libraries = {}, salt = SALT, ...extra } = {}) {
  const artifact = artifacts[name];
  const constructor = artifact.abi.find(item => item.type === 'constructor');
  const bytecode = linkBytecode(artifact.bytecode.object, artifact.bytecode.linkReferences, libraries);
  const initcode = encodeDeployData({ abi: artifact.abi, bytecode, args: abiArguments(constructor?.inputs ?? [], args) });
  const address = create2Address(factory.address, salt, initcode);
  return {
    id: `contract:${name.toLowerCase()}`, kind: 'contract', dependencies: [], address, artifact, artifactHash: artifact.artifactHash,
    inputs: args, checks: [], libraries, expectedCodeHash: null, imported: false, initcode, initcodeHash: keccak256(initcode), salt, factory: { ...factory }, ...extra,
  };
}

function sampleCode(address, overrides = {}) {
  return runtime('Sample', { immutables: { UPSTREAM: ONE, LABEL, SELF: address, ...overrides } });
}

function sampleReads(address, overrides = {}) {
  return { [`${address}:UPSTREAM`]: ONE, [`${address}:LABEL`]: LABEL, [`${address}:stored`]: 7n, ...overrides };
}

const SAMPLE_CHECKS = [{ functionName: 'UPSTREAM', expected: ONE }, { functionName: 'LABEL', expected: LABEL }];

test('an exact runtime with no immutables is verified, including a library call guard', async () => {
  const resource = imported('Doubler', HERE);
  const client = mockClient({ codes: { [HERE]: runtime('Doubler', { address: HERE }) } });
  const result = await verifyResource(resource, client);
  assert.equal(result.status, 'verified');
  assert.deepEqual(result.codeComparison, { mode: 'exact', matched: true });
  assert.equal(result.proofs[0].method, 'artifact-runtime');
  const copied = mockClient({ codes: { [HERE]: runtime('Doubler', { address: TWO }) } });
  const conflict = await verifyResource(resource, copied);
  assert.equal(conflict.status, 'conflict');
  assert.match(conflict.reasons[0], /library call guard holds a different address/);
});

test('a matching skeleton alone is unverified and names every unproved immutable', async () => {
  const client = mockClient({ codes: { [HERE]: sampleCode(HERE) }, reads: sampleReads(HERE) });
  const bare = await verifyResource(imported('Sample', HERE), client);
  assert.equal(bare.status, 'unverified');
  assert.deepEqual(bare.codeComparison, { mode: 'masked', matched: true });
  assert.equal(bare.missingProofs.length, 3);
  assert.match(bare.missingProofs[0], /UPSTREAM \(AST 16\).*declare a check on UPSTREAM\(\)/);
  assert.match(bare.missingProofs[2], /SELF \(AST 20\).*expected code hash or creation evidence/);

  const withGetters = await verifyResource(imported('Sample', HERE, { checks: [...SAMPLE_CHECKS, { functionName: 'stored', expected: '7' }] }), client);
  assert.deepEqual([withGetters.status, withGetters.codeComparison.mode], ['unverified', 'masked']);
  assert.deepEqual(withGetters.missingProofs.map(line => line.split(' at ')[0]), ['Immutable SELF (AST 20)']);
  assert.deepEqual(withGetters.proofs.filter(proof => proof.method === 'immutable-word').map(proof => [proof.name, proof.matched]), [['immutable:UPSTREAM', true], ['immutable:LABEL', true]]);
  assert.deepEqual(withGetters.evidence.immutables.map(item => [item.name, item.provenBy]), [['UPSTREAM', 'immutable-word'], ['LABEL', 'immutable-word'], ['SELF', null]]);
});

test('an expected code hash proves the whole runtime, and a different hash is a conflict', async () => {
  const code = sampleCode(HERE);
  const client = mockClient({ codes: { [HERE]: code }, reads: sampleReads(HERE) });
  const verified = await verifyResource(imported('Sample', HERE, { expectedCodeHash: keccak256(code).toUpperCase().replace('0X', '0x') }), client);
  assert.equal(verified.status, 'verified');
  assert.equal(verified.evidence.immutables.every(item => item.provenBy === 'expected-code-hash'), true);
  const wrong = await verifyResource(imported('Sample', HERE, { expectedCodeHash: keccak256('0x00') }), client);
  assert.equal(wrong.status, 'conflict');
  assert.match(wrong.reasons[0], /differs from the expected code hash/);
});

test('a wrong getter, a failed getter, and a wrong immutable word are conflicts', async () => {
  const code = sampleCode(HERE);
  const wrongValue = await verifyResource(imported('Sample', HERE, { checks: [{ functionName: 'UPSTREAM', expected: TWO }] }), mockClient({ codes: { [HERE]: code }, reads: sampleReads(HERE) }));
  assert.equal(wrongValue.status, 'conflict');
  assert.match(wrongValue.reasons[0], /Getter UPSTREAM returned 0x0+1; expected 0x0+2\./);
  assert.match(wrongValue.reasons[1], /Immutable UPSTREAM \(AST 16\) holds 0x0+1 in the live runtime; expected 0x0+2\./);

  const failed = await verifyResource(imported('Sample', HERE, { checks: SAMPLE_CHECKS }), mockClient({ codes: { [HERE]: code }, reads: sampleReads(HERE, { [`${HERE}:LABEL`]: new Error('execution reverted at https://rpc.example/v2/secret-key') }) }));
  assert.equal(failed.status, 'conflict');
  assert.match(failed.reasons[0], /Getter LABEL read failed: execution reverted at <url>/);
  assert.doesNotMatch(canonicalJson(failed), /secret-key/);

  const lyingGetter = await verifyResource(imported('Sample', HERE, { checks: SAMPLE_CHECKS }), mockClient({ codes: { [HERE]: sampleCode(HERE, { UPSTREAM: TWO }) }, reads: sampleReads(HERE) }));
  assert.equal(lyingGetter.status, 'conflict');
  assert.deepEqual(lyingGetter.reasons, [`Immutable UPSTREAM (AST 16) holds 0x${word(TWO)} in the live runtime; expected 0x${word(ONE)}.`]);

  await assert.rejects(verifyResource(imported('Sample', HERE, { checks: [{ functionName: 'missing', expected: '1' }] }), mockClient({ codes: { [HERE]: code } })), /no ABI function missing/);
});

test('changed bytecode, a different build, and a different length are conflicts with evidence', async () => {
  const code = sampleCode(HERE);
  const changed = await verifyResource(imported('Sample', HERE), mockClient({ codes: { [HERE]: flip(code, 10) } }));
  assert.equal(changed.status, 'conflict');
  assert.deepEqual(changed.codeComparison, { mode: 'mismatch', matched: false });
  assert.deepEqual({ region: changed.evidence.difference.region, offset: changed.evidence.difference.offset }, { region: 'code', offset: 10 });

  const tail = decodeMetadataTail(code);
  const rebuilt = await verifyResource(imported('Sample', HERE), mockClient({ codes: { [HERE]: flip(code, tail.start + 10) } }));
  assert.equal(rebuilt.status, 'conflict');
  assert.match(rebuilt.reasons[0], /only in its CBOR metadata, so it comes from a different build/);
  assert.deepEqual(rebuilt.proofs.find(proof => proof.method === 'cbor-metadata').expected, artifacts.Sample.buildIdentity.metadataHash);

  const longer = await verifyResource(imported('Sample', HERE), mockClient({ codes: { [HERE]: `${code}00` } }));
  assert.match(longer.reasons[0], /Live runtime is \d+ bytes; the artifact runtime is \d+ bytes\./);
});

test('an immutable with different values at its code ranges is a conflict', async () => {
  const slot = '00'.repeat(32);
  const artifact = normalizeArtifact({ abi: [], bytecode: { object: '0x6000', linkReferences: {} }, deployedBytecode: { object: `0x7f${slot}7f${slot}`, linkReferences: {}, immutableReferences: { 5: [{ start: 1, length: 32 }, { start: 34, length: 32 }] } } }, 'Twice');
  const resource = { id: 'contract:twice', kind: 'contract', address: HERE, artifact, checks: [], expectedCodeHash: null };
  const same = await verifyResource(resource, mockClient({ codes: { [HERE]: `0x7f${word(ONE)}7f${word(ONE)}` } }));
  assert.equal(same.status, 'unverified');
  const split = await verifyResource(resource, mockClient({ codes: { [HERE]: `0x7f${word(ONE)}7f${word(TWO)}` } }));
  assert.equal(split.status, 'conflict');
  assert.match(split.reasons[0], /AST 5 holds different values at its code ranges/);
});

test('a CREATE2 simulation proves private immutables and reports context-dependent ones', async () => {
  const resource = deployable('Sample', [ONE, LABEL], { checks: SAMPLE_CHECKS });
  const live = sampleCode(resource.address);
  const codes = { [resource.address.toLowerCase()]: live, [factory.address.toLowerCase()]: FACTORY_CODE };
  const exact = mockClient({ codes, reads: sampleReads(resource.address.toLowerCase()), call: async () => ({ data: live }) });
  const verified = await verifyResource(resource, exact, { blockNumber: 12n });
  assert.deepEqual([verified.status, verified.codeComparison.mode], ['verified', 'exact']);
  assert.equal(verified.evidence.immutables.every(item => item.provenBy === 'create2-simulation'), true);
  const [request] = exact.calls;
  assert.equal(request.to, PROBE_ADDRESS);
  assert.equal(request.blockNumber, 12n);
  assert.equal(request.data, concatHex([pad(factory.address), pad(resource.address), SALT, resource.initcode]));
  assert.deepEqual(request.stateOverride[1], { address: resource.address, code: '0x', nonce: 0, state: [] });

  const drifted = mockClient({ codes, reads: sampleReads(resource.address.toLowerCase()), call: async () => ({ data: sampleCode(resource.address, { SELF: TWO }) }) });
  const partial = await verifyResource(resource, drifted);
  assert.equal(partial.status, 'unverified');
  assert.deepEqual(partial.evidence.simulation.differingImmutables, [{ id: '20', simulated: `0x${word(TWO)}` }]);
  assert.match(partial.missingProofs[0], /SELF \(AST 20\)/);

  const unsupported = await verifyResource(resource, mockClient({ codes, reads: sampleReads(resource.address.toLowerCase()) }));
  assert.equal(unsupported.status, 'unverified');
  assert.match(unsupported.proofs.find(proof => proof.method === 'create2-simulation').error, /not supported at <url>/);

  const wrongFactory = await verifyResource(resource, mockClient({ codes: { ...codes, [factory.address.toLowerCase()]: '0x6001' }, reads: sampleReads(resource.address.toLowerCase()), call: async () => ({ data: live }) }));
  assert.equal(wrongFactory.status, 'unverified');
  assert.match(wrongFactory.missingProofs[0], /factory code differs/);

  const disabled = await verifyResource(resource, exact, { simulate: false });
  assert.equal(disabled.status, 'unverified');
  await assert.rejects(verifyResource({ ...resource, address: HERE }, mockClient({ codes: { [HERE]: live } })), /not the CREATE2 address/);
});

test('linked library addresses come from the initcode or the declared libraries', async () => {
  const resource = deployable('Linked', ['21'], { libraries: { [DOUBLER]: LIBRARY }, checks: [{ functionName: 'SEED', expected: '42' }] });
  const address = resource.address.toLowerCase();
  const live = runtime('Linked', { immutables: { SEED: 42n }, libraries: { [DOUBLER]: LIBRARY } });
  const reads = { [`${address}:SEED`]: 42n };
  const verified = await verifyResource(resource, mockClient({ codes: { [address]: live }, reads }), { simulate: false });
  assert.equal(verified.status, 'verified');
  const fromInitcode = await verifyResource({ ...resource, libraries: undefined }, mockClient({ codes: { [address]: live }, reads }), { simulate: false });
  assert.equal(fromInitcode.status, 'verified');
  const otherLibrary = await verifyResource(resource, mockClient({ codes: { [address]: runtime('Linked', { immutables: { SEED: 42n }, libraries: { [DOUBLER]: OTHER_LIBRARY } }) }, reads }), { simulate: false });
  assert.equal(otherLibrary.status, 'conflict');
  assert.match(otherLibrary.reasons[0], /different address for library src\/Sample.sol:Doubler/);
  await assert.rejects(verifyResource({ ...resource, libraries: { [DOUBLER]: OTHER_LIBRARY } }, mockClient({ codes: { [address]: live } })), /declares library .* but its initcode links/);
});

test('an imported contract needs code and value proof, and a wrong contract is a conflict', async () => {
  const stamped = runtime('Stamped', { immutables: { CREATED_AT: 1700000000n, SEED: 5n } });
  const checks = [{ functionName: 'CREATED_AT', expected: '1700000000' }, { functionName: 'SEED', expected: '5' }];
  const reads = { [`${HERE}:CREATED_AT`]: 1700000000n, [`${HERE}:SEED`]: 5n };
  const verified = await verifyResource(imported('Stamped', HERE, { checks }), mockClient({ codes: { [HERE]: stamped }, reads }));
  assert.equal(verified.status, 'verified');
  assert.deepEqual(verified.evidence.immutables.map(item => item.provenBy), ['immutable-word', 'immutable-word']);
  const wrongContract = await verifyResource(imported('Stamped', HERE, { checks }), mockClient({ codes: { [HERE]: sampleCode(HERE) }, reads }));
  assert.equal(wrongContract.status, 'conflict');
  const absent = await verifyResource(imported('Stamped', HERE, { checks }), mockClient());
  assert.deepEqual([absent.status, absent.codeComparison.mode, absent.reasons[0]], ['conflict', 'absent', 'No code at the address.']);
});

test('an external needs code and an expected code hash', async () => {
  const code = runtime('Doubler', { address: HERE });
  const external = { id: 'external:feed', kind: 'external', dependencies: [], address: HERE, expectedCodeHash: keccak256(code), checks: [] };
  assert.equal((await verifyResource(external, mockClient({ codes: { [HERE]: code } }))).status, 'verified');
  const wrong = await verifyResource({ ...external, expectedCodeHash: keccak256('0x01') }, mockClient({ codes: { [HERE]: code } }));
  assert.deepEqual([wrong.status, wrong.codeComparison.mode], ['conflict', 'mismatch']);
  const absent = await verifyResource(external, mockClient());
  assert.deepEqual([absent.status, absent.reasons[0]], ['conflict', 'External has no code at its address.']);
  const presence = await verifyResource({ ...external, expectedCodeHash: null }, mockClient({ codes: { [HERE]: code } }));
  assert.deepEqual([presence.status, presence.codeComparison.mode], ['unverified', 'presence']);
  const checked = { ...external, abi: artifacts.Sample.abi, checks: [{ functionName: 'UPSTREAM', expected: ONE }] };
  assert.equal((await verifyResource(checked, mockClient({ codes: { [HERE]: code }, reads: { [`${HERE}:UPSTREAM`]: TWO } }))).status, 'conflict');
});

test('binding checks report before, after, other, read-failed, and an absent target', async () => {
  const call = {
    id: 'call:bind', kind: 'call', dependencies: ['contract:sample'], address: HERE, targetId: 'contract:sample', abi: artifacts.Sample.abi, method: 'bind', args: [ONE],
    before: { functionName: 'binding', expected: ZERO }, after: { functionName: 'binding', expected: ONE }, signerRole: 'owner',
  };
  const codes = { [HERE]: sampleCode(HERE) };
  const observe = async value => verifyResource(call, mockClient({ codes, reads: { [`${HERE}:binding`]: value } }));
  const before = await observe(ZERO);
  assert.deepEqual(before.bindingChecks, [{ name: 'call:bind', functionName: 'binding', expectedBefore: ZERO, expectedAfter: ONE, actual: ZERO, observed: 'before' }]);
  assert.equal(before.status, 'unverified');
  assert.deepEqual([(await observe(ONE.toUpperCase().replace('0X', '0x'))).bindingChecks[0].observed, (await observe(ONE)).status], ['after', 'verified']);
  const other = await observe(TWO);
  assert.deepEqual([other.bindingChecks[0].observed, other.status], ['other', 'conflict']);
  const failed = await observe(new Error('execution reverted'));
  assert.deepEqual([failed.bindingChecks[0].observed, failed.bindingChecks[0].actual, failed.status], ['read-failed', null, 'conflict']);
  const absent = await verifyResource(call, mockClient());
  assert.deepEqual([absent.bindingChecks[0].observed, absent.bindingChecks[0].targetAbsent, absent.status], ['read-failed', true, 'unverified']);
});

test('direct CREATE and CREATE2 transactions are creation evidence only when they created this resource', async () => {
  const create2 = deployable('Sample', [ONE, LABEL]);
  const address = create2.address.toLowerCase();
  const live = sampleCode(create2.address);
  const deployer = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
  const transactions = {
    '0xc2': { to: factory.address, from: deployer, input: concatHex([SALT, create2.initcode]) },
    '0xc1': { to: null, from: deployer, input: create2.initcode },
    '0xbad': { to: null, from: deployer, input: `${create2.initcode}00` },
    '0xelse': { to: HERE, from: deployer, input: '0x' },
    '0xfail': { to: factory.address, from: deployer, input: concatHex([SALT, create2.initcode]) },
  };
  const receipts = {
    '0xc2': { status: 'success', contractAddress: null, blockNumber: 9n },
    '0xc1': { status: 'success', contractAddress: create2.address, blockNumber: 9n },
    '0xbad': { status: 'success', contractAddress: create2.address, blockNumber: 9n },
    '0xelse': { status: 'success', contractAddress: null, blockNumber: 9n },
    '0xfail': { status: 'reverted', contractAddress: null, blockNumber: 9n },
  };
  const codes = { [address]: live, [factory.address.toLowerCase()]: FACTORY_CODE };
  const replaying = mockClient({ codes, transactions, receipts, call: async () => ({ data: live }) });

  const viaFactory = await verifyCreation(replaying, create2, '0xc2');
  assert.deepEqual([viaFactory.kind, viaFactory.status, viaFactory.exactRuntime, viaFactory.blockNumber], ['create2', 'verified', true, '9']);
  assert.deepEqual([replaying.calls[0].blockNumber, replaying.calls[0].account], [8n, deployer]);
  const verified = await verifyResource(create2, replaying, { transactionHash: '0xc2', simulate: false });
  assert.equal(verified.status, 'verified');
  assert.equal(verified.proofs.find(proof => proof.name === 'creation').method, 'create2-transaction');

  const direct = await verifyCreation(replaying, create2, '0xc1');
  assert.deepEqual([direct.kind, direct.status], ['create', 'verified']);
  const importedByReplay = await verifyResource({ ...create2, salt: undefined, factory: undefined, imported: true }, replaying, { transactionHash: '0xc1' });
  assert.equal(importedByReplay.status, 'verified');
  const importedWithoutInitcode = { ...create2, salt: undefined, factory: undefined, initcode: undefined, initcodeHash: undefined, imported: true };
  const derived = await verifyResource(importedWithoutInitcode, replaying, { transactionHash: '0xc1' });
  assert.deepEqual([derived.status, derived.codeComparison.mode], ['verified', 'exact']);
  assert.equal(derived.proofs.find(proof => proof.name === 'creation').expected, create2.initcodeHash);
  const noInputs = await verifyCreation(replaying, { ...importedWithoutInitcode, inputs: [] }, '0xc1');
  assert.deepEqual([noInputs.status, noInputs.reasons[0]], ['unverified', 'Resource inputs do not encode its constructor, so there is no expected initcode to compare with the creation transaction.']);

  const wrongInput = await verifyResource({ ...create2, salt: undefined, factory: undefined, imported: true }, replaying, { transactionHash: '0xbad' });
  assert.equal(wrongInput.status, 'conflict');
  assert.match(wrongInput.reasons[0], /different creation code or constructor arguments/);
  assert.equal((await verifyCreation(replaying, create2, '0xelse')).status, 'unverified');
  assert.equal((await verifyCreation(replaying, create2, '0xfail')).status, 'unverified');
  const missing = await verifyCreation(replaying, create2, '0xmissing');
  assert.equal(missing.status, 'unverified');
  assert.doesNotMatch(missing.reasons[0], /secret-key/);

  const different = mockClient({ codes, transactions, receipts, call: async () => ({ data: sampleCode(create2.address, { SELF: TWO }) }) });
  const replayDiffers = await verifyCreation(different, create2, '0xc2');
  assert.deepEqual([replayDiffers.status, replayDiffers.matched, replayDiffers.exactRuntime], ['unverified', true, false]);
});

test('verification results are plain JSON and deterministic', async () => {
  const resource = deployable('Sample', [ONE, LABEL], { checks: SAMPLE_CHECKS });
  const live = sampleCode(resource.address);
  const client = () => mockClient({ codes: { [resource.address.toLowerCase()]: live, [factory.address.toLowerCase()]: FACTORY_CODE }, reads: sampleReads(resource.address.toLowerCase()), call: async () => ({ data: live }) });
  const first = await verifyResource(resource, client(), { blockNumber: '5' });
  const second = await verifyResource(resource, client(), { blockNumber: 5n });
  assert.equal(hashJson(first), hashJson(second));
  for (const key of ['id', 'address', 'codeHash', 'codeComparison', 'proofs', 'missingProofs', 'bindingChecks', 'status']) assert.ok(Object.hasOwn(first, key), key);
  assert.equal(canonicalJson(JSON.parse(JSON.stringify(first))), canonicalJson(first));
});
