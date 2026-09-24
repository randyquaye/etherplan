import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { hashJson } from '../src/identity.mjs';
import { generateAdapters, loadArtifacts, normalizeArtifact } from '../src/artifacts.mjs';
import { linkBytecode, linkPlaceholder } from '../src/verification/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(await readFile(path.join(here, 'verification-fixtures/sample-build.json'), 'utf8'));
const LIBRARY = '0x00000000000000000000000000000000000000aa';

function foundry(name, { ast = true } = {}) {
  return structuredClone({ ...fixture.contracts[name], ...(ast ? { ast: fixture.ast } : {}) });
}

function strip(hex) {
  return hex.replace(/^0x/, '');
}

function compilerOutput(name) {
  const artifact = fixture.contracts[name];
  return {
    abi: artifact.abi,
    metadata: artifact.rawMetadata,
    evm: {
      bytecode: { object: strip(artifact.bytecode.object), linkReferences: artifact.bytecode.linkReferences },
      deployedBytecode: { object: strip(artifact.deployedBytecode.object), linkReferences: artifact.deployedBytecode.linkReferences, immutableReferences: artifact.deployedBytecode.immutableReferences ?? {} },
    },
  };
}

function hardhat2(name) {
  const artifact = fixture.contracts[name];
  return {
    _format: 'hh-sol-artifact-1',
    contractName: name,
    sourceName: fixture.sourceName,
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    deployedBytecode: artifact.deployedBytecode.object,
    linkReferences: artifact.bytecode.linkReferences,
    deployedLinkReferences: artifact.deployedBytecode.linkReferences,
  };
}

function buildInfo(names, ast = fixture.ast) {
  return {
    _format: 'hh-sol-build-info-1',
    solcVersion: '0.8.30',
    solcLongVersion: fixture.toolchain.solc,
    input: { language: 'Solidity', sources: {}, settings: {} },
    output: {
      contracts: { [fixture.sourceName]: Object.fromEntries(names.map(name => [name, compilerOutput(name)])) },
      sources: { [fixture.sourceName]: { id: 0, ast } },
    },
  };
}

async function temporary() {
  return mkdtemp(path.join(os.tmpdir(), 'etherplan-artifacts-'));
}

function staleAst() {
  const ast = structuredClone(fixture.ast);
  const stack = [ast];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node && typeof node === 'object') {
      if (node.nodeType === 'VariableDeclaration' && node.name === 'UPSTREAM') node.id = 999999;
      else if (node.nodeType === 'VariableDeclaration' && node.name === 'binding') node.id = 16;
      stack.push(...Object.values(node));
    }
  }
  return ast;
}

test('a Foundry artifact normalizes to plain JSON with named immutables and a verified build identity', () => {
  const artifact = normalizeArtifact(foundry('Sample'), 'Sample');
  const { artifactHash, ...rest } = artifact;
  assert.equal(artifactHash, hashJson(rest));
  assert.equal(artifact.contractName, 'Sample');
  assert.equal(artifact.sourceName, 'src/Sample.sol');
  assert.deepEqual(artifact.immutables.map(({ name, visibility, getter }) => ({ name, visibility, getter })), [
    { name: 'UPSTREAM', visibility: 'public', getter: 'UPSTREAM' },
    { name: 'LABEL', visibility: 'public', getter: 'LABEL' },
    { name: 'SELF', visibility: 'private', getter: undefined },
  ]);
  assert.equal(artifact.buildIdentity.compiler, 'solc');
  assert.equal(artifact.buildIdentity.version, fixture.toolchain.solc);
  assert.equal(artifact.buildIdentity.metadataVerified, true);
  assert.match(artifact.buildIdentity.metadataHash, /^0x1220[0-9a-f]{64}$/);
  assert.match(artifact.buildIdentity.sourceHash, /^0x[0-9a-f]{64}$/);
  assert.match(artifact.buildIdentity.settingsHash, /^0x[0-9a-f]{64}$/);
  assert.equal(artifact.buildIdentity.compilationTarget, 'src/Sample.sol:Sample');
  assert.equal(JSON.stringify(artifact), JSON.stringify(JSON.parse(JSON.stringify(artifact))));
  assert.equal(normalizeArtifact(foundry('Sample'), 'again').artifactHash, artifactHash);
});

test('Foundry, Hardhat 3, solc, and Hardhat 2 with build-info normalize to the same bytecode model', () => {
  const reference = normalizeArtifact(foundry('Sample', { ast: false }), 'Foundry');
  const flat = hardhat2('Sample');
  delete flat._format;
  flat.immutableReferences = fixture.contracts.Sample.deployedBytecode.immutableReferences;
  flat.rawMetadata = fixture.contracts.Sample.rawMetadata;
  const hardhat3 = { ...flat, _format: 'hh3-artifact-1', inputSourceName: fixture.sourceName };
  const solc = { abi: fixture.contracts.Sample.abi, metadata: fixture.contracts.Sample.rawMetadata, evm: compilerOutput('Sample').evm };
  const withBuildInfo = normalizeArtifact(hardhat2('Sample'), 'Hardhat 2', { compilerOutput: compilerOutput('Sample') });
  for (const artifact of [normalizeArtifact(flat, 'flat'), normalizeArtifact(hardhat3, 'Hardhat 3'), normalizeArtifact(solc, 'solc'), withBuildInfo]) {
    assert.deepEqual(artifact.bytecode, reference.bytecode);
    assert.deepEqual(artifact.deployedBytecode, reference.deployedBytecode);
    assert.deepEqual(artifact.buildIdentity, reference.buildIdentity);
  }
});

test('an artifact with no immutable references or no bytecode is incomplete', () => {
  assert.throws(() => normalizeArtifact(hardhat2('Sample'), 'Hardhat 2'), /no immutable references. Supply its build-info/);
  assert.throws(() => normalizeArtifact({ ...foundry('Sample'), abi: undefined }, 'NoAbi'), /no ABI/);
  const empty = foundry('Sample');
  empty.bytecode.object = '0x';
  assert.throws(() => normalizeArtifact(empty, 'Interface'), /no creation bytecode/);
  const odd = foundry('Sample');
  odd.deployedBytecode.object += '0';
  assert.throws(() => normalizeArtifact(odd, 'Odd'), /odd number/);
});

test('link placeholders are allowed only where a link reference covers them', () => {
  const linked = normalizeArtifact(foundry('Linked'), 'Linked');
  const key = `${fixture.sourceName}:Doubler`;
  assert.ok(linked.bytecode.object.includes(linkPlaceholder(key)));
  const initcode = linkBytecode(linked.bytecode.object, linked.bytecode.linkReferences, { [key]: LIBRARY });
  assert.match(initcode, /^0x[0-9a-f]+$/);
  assert.ok(initcode.includes(strip(LIBRARY)));
  assert.throws(() => linkBytecode(linked.bytecode.object, linked.bytecode.linkReferences, {}), /Missing linked library/);
  assert.throws(() => linkBytecode(linked.bytecode.object, linked.bytecode.linkReferences, { [key]: LIBRARY, 'Other.sol:Lib': LIBRARY }), /Unknown linked library/);

  const stray = foundry('Linked');
  stray.bytecode.linkReferences = {};
  assert.throws(() => normalizeArtifact(stray, 'Stray'), /unresolved link placeholder/);
  const shifted = foundry('Linked');
  shifted.bytecode.linkReferences[fixture.sourceName].Doubler[0].start += 1;
  assert.throws(() => normalizeArtifact(shifted, 'Shifted'), /does not cover its placeholder|unresolved link placeholder/);
  const renamed = foundry('Linked');
  renamed.deployedBytecode.linkReferences = { 'Other.sol': { Doubler: renamed.deployedBytecode.linkReferences[fixture.sourceName].Doubler } };
  assert.throws(() => normalizeArtifact(renamed, 'Renamed'), /does not cover its placeholder/);
});

test('immutable ranges must be zero-filled, in range, and clear of link references', () => {
  const filled = foundry('Sample');
  const { start } = filled.deployedBytecode.immutableReferences['16'][0];
  filled.deployedBytecode.object = `${filled.deployedBytecode.object.slice(0, 2 + start * 2)}ff${filled.deployedBytecode.object.slice(4 + start * 2)}`;
  assert.throws(() => normalizeArtifact(filled, 'Filled'), /not zero-filled/);
  const outside = foundry('Sample');
  outside.deployedBytecode.immutableReferences['16'] = [{ start: 100000, length: 32 }];
  assert.throws(() => normalizeArtifact(outside, 'Outside'), /exceeds the runtime/);
  const overlap = foundry('Linked');
  const link = overlap.deployedBytecode.linkReferences[fixture.sourceName].Doubler[0];
  overlap.deployedBytecode.immutableReferences['92'] = [{ start: link.start, length: 20 }];
  assert.throws(() => normalizeArtifact(overlap, 'Overlap'), /overlaps a link reference/);
});

test('metadata that does not match the bytecode is a build mismatch', () => {
  const edited = foundry('Sample');
  edited.rawMetadata = edited.rawMetadata.replace('"runs":200', '"runs":201');
  assert.throws(() => normalizeArtifact(edited, 'Edited'), /does not match the metadata hash in its bytecode/);
  const compiler = foundry('Sample');
  compiler.rawMetadata = compiler.rawMetadata.replace(fixture.toolchain.solc, '0.8.29+commit.ab55807c');
  assert.throws(() => normalizeArtifact(compiler, 'Compiler'), /names compiler 0.8.29\+commit.ab55807c, but its bytecode was built by solc 0.8.30/);
  const unverifiable = foundry('Sample');
  delete unverifiable.rawMetadata;
  const identity = normalizeArtifact(unverifiable, 'ObjectOnly').buildIdentity;
  assert.equal(identity.metadataVerified, undefined);
  assert.equal(identity.version, fixture.toolchain.solc);
});

test('an AST from another compilation is rejected, and a missing AST leaves immutables unnamed', () => {
  const unnamed = normalizeArtifact(foundry('Sample', { ast: false }), 'Unnamed');
  assert.deepEqual(unnamed.immutables.map(item => item.name), [undefined, undefined, undefined]);
  assert.throws(() => normalizeArtifact(foundry('Sample', { ast: false }), 'Stale', { sources: [staleAst()] }), /AST node 16 is not immutable/);
});

test('loadArtifacts reads Foundry build-info from the same compilation and ignores stale build-info', async () => {
  const root = await temporary();
  try {
    await mkdir(path.join(root, 'out/Sample.sol'), { recursive: true });
    await mkdir(path.join(root, 'out/build-info'), { recursive: true });
    await writeFile(path.join(root, 'out/Sample.sol/Sample.json'), JSON.stringify(foundry('Sample', { ast: false })));
    const stale = buildInfo(['Sample']);
    stale.output.contracts[fixture.sourceName].Sample.evm.deployedBytecode.object = strip(fixture.contracts.Stamped.deployedBytecode.object);
    await writeFile(path.join(root, 'out/build-info/0-stale.json'), JSON.stringify(stale));
    await writeFile(path.join(root, 'out/build-info/1-minimal.json'), JSON.stringify({ id: 'x', source_id_to_path: {}, language: 'Solidity' }));
    await writeFile(path.join(root, 'out/build-info/2-match.json'), JSON.stringify(buildInfo(['Sample'])));
    const spec = { contracts: [{ id: 'first', name: 'Sample', artifact: '../out/Sample.sol/Sample.json' }, { id: 'second', artifact: '../out/Sample.sol/Sample.json' }] };
    const artifacts = await loadArtifacts(spec, path.join(root, 'specs/spec.json'));
    assert.deepEqual([...artifacts.keys()], ['first', 'second']);
    assert.equal(artifacts.get('first'), artifacts.get('second'));
    assert.deepEqual(artifacts.get('first').immutables.map(item => item.getter ?? null), ['UPSTREAM', 'LABEL', null]);
    await assert.rejects(loadArtifacts({ contracts: [{ id: 'wrong', name: 'Stamped', artifact: '../out/Sample.sol/Sample.json' }] }, path.join(root, 'specs/spec.json')), /expects Stamped, but .* holds Sample/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loadArtifacts reads Hardhat 2 immutable references and ASTs through the debug file', async () => {
  const root = await temporary();
  try {
    await mkdir(path.join(root, 'artifacts/contracts/Sample.sol'), { recursive: true });
    await mkdir(path.join(root, 'artifacts/build-info'), { recursive: true });
    await writeFile(path.join(root, 'artifacts/contracts/Sample.sol/Stamped.json'), JSON.stringify(hardhat2('Stamped')));
    await writeFile(path.join(root, 'artifacts/contracts/Sample.sol/Stamped.dbg.json'), JSON.stringify({ _format: 'hh-sol-dbg-1', buildInfo: '../../build-info/abc.json' }));
    await writeFile(path.join(root, 'artifacts/build-info/abc.json'), JSON.stringify(buildInfo(['Stamped'])));
    const artifacts = await loadArtifacts({ contracts: [{ id: 'stamped', artifact: 'artifacts/contracts/Sample.sol/Stamped.json' }] }, path.join(root, 'spec.json'));
    const stamped = artifacts.get('stamped');
    assert.deepEqual(stamped.immutables.map(item => item.getter), ['CREATED_AT', 'SEED']);
    assert.equal(stamped.buildIdentity.metadataVerified, true);
    assert.deepEqual(stamped.deployedBytecode, normalizeArtifact(foundry('Stamped'), 'Stamped').deployedBytecode);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('adapters are deterministic, typed, and refuse unsafe file names', async () => {
  const root = await temporary();
  try {
    const artifacts = new Map([['sample', normalizeArtifact(foundry('Sample'), 'Sample')]]);
    await generateAdapters(artifacts, root);
    const first = await readFile(path.join(root, 'sample.ts'), 'utf8');
    await generateAdapters(artifacts, root);
    assert.equal(await readFile(path.join(root, 'sample.ts'), 'utf8'), first);
    assert.match(first, new RegExp(`artifactHash = "${artifacts.get('sample').artifactHash}" as const`));
    assert.match(first, /export const immutables = /);
    assert.match(first, /export function at\(address: Address, client: PublicClient\)/);
    await assert.rejects(generateAdapters(new Map([['../escape', artifacts.get('sample')]]), root), /not a safe file name/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
