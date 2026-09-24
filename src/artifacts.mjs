import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { keccak256, stringToHex } from 'viem';
import { hashJson } from './identity.mjs';
import { immutableEntries, normalizeCode } from './verification/bytecode.mjs';
import { decodeMetadataTail, ipfsMetadataHash } from './verification/metadata.mjs';

const SAFE_ID = /^[a-z][a-zA-Z0-9_]*$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function codeBody(object) {
  return typeof object === 'string' ? object.replace(/^0x/i, '').toLowerCase() : null;
}

function formatOf(raw) {
  if (typeof raw._format === 'string' && raw._format.startsWith('hh-sol-artifact')) return 'hardhat2';
  if (typeof raw._format === 'string' && raw._format.startsWith('hh3-artifact')) return 'hardhat3';
  if (plainObject(raw.evm)) return 'solc';
  if (plainObject(raw.bytecode)) return 'foundry';
  return 'flat';
}

function cleanLinkReferences(references, label) {
  assert(references === undefined || plainObject(references), `${label} link references must be an object.`);
  const out = {};
  for (const file of Object.keys(references ?? {}).sort()) {
    const names = references[file];
    assert(plainObject(names), `${label} link references for ${file} must be an object.`);
    out[file] = {};
    for (const name of Object.keys(names).sort()) {
      assert(Array.isArray(names[name]), `${label} link references for ${file}:${name} must be an array.`);
      out[file][name] = names[name].map(({ start, length }) => ({ start, length })).sort((left, right) => left.start - right.start);
    }
  }
  return out;
}

function cleanImmutableReferences(references, label) {
  assert(plainObject(references), `${label} immutable references must be an object.`);
  return Object.fromEntries(immutableEntries(references).map(([id, ranges]) => {
    assert(/^[0-9]+$/.test(id), `${label} immutable reference ${id} is not an AST ID.`);
    assert(Array.isArray(ranges) && ranges.length > 0, `${label} immutable reference ${id} needs ranges.`);
    return [id, ranges.map(({ start, length }) => ({ start, length }))];
  }));
}

function sameReferences(left, right) {
  return hashJson(left) === hashJson(right);
}

function bytecodeParts(raw, format, compilerOutput, label) {
  const outputDeployed = compilerOutput?.evm?.deployedBytecode;
  let creation;
  let deployed;
  let immutableReferences;
  if (format === 'foundry' || format === 'solc') {
    const source = format === 'foundry' ? raw : raw.evm;
    creation = source.bytecode;
    deployed = source.deployedBytecode;
    assert(plainObject(creation) && plainObject(deployed), `${label} has an incomplete artifact: bytecode objects are missing.`);
    immutableReferences = deployed.immutableReferences ?? outputDeployed?.immutableReferences ?? {};
  } else {
    creation = { object: raw.bytecode, linkReferences: raw.linkReferences };
    deployed = { object: raw.deployedBytecode, linkReferences: raw.deployedLinkReferences };
    immutableReferences = raw.immutableReferences ?? outputDeployed?.immutableReferences;
    assert(immutableReferences !== undefined, `${label} has an incomplete artifact: it has no immutable references. Supply its build-info file.`);
  }
  assert(typeof creation.object === 'string' && codeBody(creation.object).length > 0, `${label} has an incomplete artifact: it has no creation bytecode.`);
  assert(typeof deployed.object === 'string' && codeBody(deployed.object).length > 0, `${label} has an incomplete artifact: it has no runtime bytecode.`);
  if (compilerOutput?.evm) {
    assert(codeBody(compilerOutput.evm.bytecode?.object) === codeBody(creation.object) && codeBody(outputDeployed?.object) === codeBody(deployed.object), `${label} does not match the compiler output from its build-info.`);
    if (outputDeployed?.immutableReferences) assert(sameReferences(cleanImmutableReferences(outputDeployed.immutableReferences, label), cleanImmutableReferences(immutableReferences, label)), `${label} immutable references differ from its build-info.`);
  }
  return { creation, deployed, immutableReferences };
}

function linkRanges(references) {
  return Object.values(references).flatMap(names => Object.values(names).flat());
}

function checkImmutableRanges(object, immutableReferences, linkReferences, label) {
  const text = object.slice(2);
  const size = text.length / 2;
  const taken = linkRanges(linkReferences).map(({ start, length }) => ({ start, end: start + length, what: 'a link reference' }));
  for (const [id, ranges] of immutableEntries(immutableReferences)) {
    for (const { start, length } of ranges) {
      assert(Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(length) && length > 0 && length <= 32, `${label} immutable ${id} has an invalid range.`);
      assert(start + length <= size, `${label} immutable ${id} range exceeds the runtime bytecode.`);
      const clash = taken.find(range => start < range.end && range.start < start + length);
      assert(!clash, `${label} immutable ${id} range overlaps ${clash?.what}.`);
      assert(/^0*$/.test(text.slice(start * 2, (start + length) * 2)), `${label} immutable ${id} range is not zero-filled, so the runtime is not an unlinked compiler output.`);
      taken.push({ start, end: start + length, what: `immutable ${id}` });
    }
  }
}

function parseMetadata(text, label) {
  try {
    const value = JSON.parse(text);
    assert(plainObject(value), `${label} metadata is not a JSON object.`);
    return value;
  } catch (error) {
    throw new Error(`${label} metadata is not valid JSON: ${error.message}`);
  }
}

function metadataOf(raw, compilerOutput, label) {
  const rawText = typeof raw.rawMetadata === 'string' ? raw.rawMetadata
    : typeof raw.metadata === 'string' ? raw.metadata
      : typeof compilerOutput?.metadata === 'string' ? compilerOutput.metadata
        : null;
  const parsed = rawText ? parseMetadata(rawText, label) : plainObject(raw.metadata) ? raw.metadata : null;
  return { rawText, parsed };
}

function sourceHash(sources) {
  return hashJson(Object.fromEntries(Object.keys(sources).sort().map(file => {
    const source = sources[file] ?? {};
    const digest = source.keccak256 ?? (typeof source.content === 'string' ? keccak256(stringToHex(source.content)) : null);
    return [file, digest];
  })));
}

function buildIdentityOf({ rawText, parsed }, runtime, label) {
  const identity = {};
  if (parsed) {
    if (parsed.language === 'Solidity') identity.compiler = 'solc';
    else if (parsed.language === 'Vyper') identity.compiler = 'vyper';
    if (typeof parsed.language === 'string') identity.language = parsed.language;
    if (typeof parsed.compiler?.version === 'string') identity.version = parsed.compiler.version;
    if (plainObject(parsed.settings)) {
      identity.settingsHash = hashJson(parsed.settings);
      if (typeof parsed.settings.evmVersion === 'string') identity.evmVersion = parsed.settings.evmVersion;
      if (plainObject(parsed.settings.optimizer)) identity.optimizer = parsed.settings.optimizer;
      if (typeof parsed.settings.viaIR === 'boolean') identity.viaIR = parsed.settings.viaIR;
      const [target] = Object.entries(parsed.settings.compilationTarget ?? {});
      if (target) identity.compilationTarget = `${target[0]}:${target[1]}`;
    }
    if (plainObject(parsed.sources)) identity.sourceHash = sourceHash(parsed.sources);
  }
  const tail = decodeMetadataTail(runtime);
  if (tail?.solc) {
    if (identity.version) {
      assert(identity.version === tail.solc || identity.version.startsWith(`${tail.solc}+`), `${label} metadata names compiler ${identity.version}, but its bytecode was built by solc ${tail.solc}.`);
    } else {
      identity.compiler ??= 'solc';
      identity.version = tail.solc;
    }
  }
  if (tail?.hash) {
    identity.metadataHash = tail.hash;
    identity.metadataHashKind = tail.hashKind;
    if (rawText && tail.hashKind === 'ipfs') {
      assert(ipfsMetadataHash(rawText) === tail.hash, `${label} metadata does not match the metadata hash in its bytecode, so its build identity cannot be reproduced.`);
      identity.metadataVerified = true;
    }
  }
  return identity;
}

function sourceUnits(sources) {
  if (!sources) return [];
  const list = Array.isArray(sources) ? sources : Object.entries(sources).map(([file, unit]) => (unit?.ast ? { ...unit.ast, absolutePath: unit.ast.absolutePath ?? file } : unit));
  return list.filter(unit => plainObject(unit) && unit.nodeType === 'SourceUnit');
}

function declarations(units) {
  const found = new Map();
  for (const unit of units) {
    const stack = [unit];
    while (stack.length > 0) {
      const node = stack.pop();
      if (Array.isArray(node)) {
        stack.push(...node);
        continue;
      }
      if (!plainObject(node)) continue;
      if (node.nodeType === 'VariableDeclaration' && node.stateVariable === true && Number.isSafeInteger(node.id)) {
        found.set(String(node.id), {
          name: node.name,
          mutability: node.mutability ?? (node.constant ? 'constant' : 'mutable'),
          visibility: node.visibility,
          type: node.typeDescriptions?.typeString,
          source: unit.absolutePath,
        });
      }
      for (const value of Object.values(node)) if (value && typeof value === 'object') stack.push(value);
    }
  }
  return found;
}

function namedImmutables(immutableReferences, units, abi, label) {
  const found = units.length > 0 ? declarations(units) : new Map();
  return immutableEntries(immutableReferences).map(([id, ranges]) => {
    const entry = { id, ranges };
    const declaration = found.get(id);
    if (!declaration) return entry;
    assert(declaration.mutability === 'immutable', `${label} AST does not match its immutable references: AST node ${id} is not immutable, so the AST comes from a different compilation.`);
    entry.name = declaration.name;
    if (declaration.type) entry.type = declaration.type;
    if (declaration.visibility) entry.visibility = declaration.visibility;
    if (declaration.source) entry.source = declaration.source;
    const getter = abi.find(item => item.type === 'function' && item.name === declaration.name && (item.inputs ?? []).length === 0 && (item.outputs ?? []).length === 1);
    if (declaration.visibility === 'public' && getter) entry.getter = declaration.name;
    return entry;
  });
}

function namesOf(raw, parsed, options) {
  const [target] = Object.entries(parsed?.settings?.compilationTarget ?? {});
  return {
    contractName: raw.contractName ?? options.contractName ?? target?.[1],
    sourceName: raw.sourceName ?? raw.inputSourceName ?? options.sourceName ?? target?.[0],
  };
}

/**
 * Normalizes a Foundry, Hardhat 2, Hardhat 3, or solc standard-JSON contract artifact.
 * `options.sources` holds source-unit ASTs from the same compilation (an array, or solc `output.sources`), so each
 * immutable reference gets its variable name and public getter. `options.compilerOutput` is the solc contract output
 * from the matching build-info file. The result is plain JSON; `artifactHash` covers every other field.
 */
export function normalizeArtifact(raw, id, options = {}) {
  const label = id ?? 'Artifact';
  assert(plainObject(raw), `${label} is not a JSON object.`);
  const compilerOutput = options.compilerOutput ?? null;
  const format = formatOf(raw);
  const abi = raw.abi ?? compilerOutput?.abi;
  assert(Array.isArray(abi), `${label} has an incomplete artifact: it has no ABI.`);
  const { creation, deployed, immutableReferences } = bytecodeParts(raw, format, compilerOutput, label);
  const creationLinks = cleanLinkReferences(creation.linkReferences, `${label} creation bytecode`);
  const deployedLinks = cleanLinkReferences(deployed.linkReferences, `${label} runtime bytecode`);
  const bytecode = { object: normalizeCode(creation.object, creationLinks, `${label} creation bytecode`), linkReferences: creationLinks };
  const deployedBytecode = {
    object: normalizeCode(deployed.object, deployedLinks, `${label} runtime bytecode`),
    linkReferences: deployedLinks,
    immutableReferences: cleanImmutableReferences(immutableReferences, label),
  };
  checkImmutableRanges(deployedBytecode.object, deployedBytecode.immutableReferences, deployedLinks, label);
  const metadata = metadataOf(raw, compilerOutput, label);
  const buildIdentity = buildIdentityOf(metadata, deployedBytecode.object, label);
  const units = sourceUnits(options.sources);
  if (plainObject(raw.ast) && raw.ast.nodeType === 'SourceUnit') units.push(raw.ast);
  const { contractName, sourceName } = namesOf(raw, metadata.parsed, options);
  const normalized = {
    ...(contractName ? { contractName } : {}),
    ...(sourceName ? { sourceName } : {}),
    abi,
    bytecode,
    deployedBytecode,
    immutables: namedImmutables(deployedBytecode.immutableReferences, units, abi, label),
    buildIdentity,
  };
  return { ...normalized, artifactHash: hashJson(normalized) };
}

async function readJson(file, cache) {
  if (!cache.has(file)) cache.set(file, readFile(file, 'utf8').then(JSON.parse));
  return cache.get(file);
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

async function upward(start, relative, levels = 4) {
  let directory = start;
  for (let level = 0; level <= levels; level++) {
    const candidate = path.join(directory, relative);
    if (await exists(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

async function buildInfoDirectory(start, levels = 4) {
  let directory = start;
  for (let level = 0; level <= levels; level++) {
    const candidate = path.join(directory, 'build-info');
    try {
      return { directory: candidate, files: (await readdir(candidate)).filter(file => file.endsWith('.json')).sort() };
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function contextFrom(output, sourceName, contractName, raw) {
  const compilerOutput = output?.contracts?.[sourceName]?.[contractName];
  if (!compilerOutput?.evm) return null;
  const deployed = raw.deployedBytecode?.object ?? raw.deployedBytecode ?? raw.evm?.deployedBytecode?.object;
  if (codeBody(compilerOutput.evm.deployedBytecode?.object) !== codeBody(deployed)) return null;
  const references = raw.deployedBytecode?.immutableReferences ?? raw.immutableReferences;
  const outputReferences = compilerOutput.evm.deployedBytecode?.immutableReferences;
  if (references && outputReferences && hashJson(references) !== hashJson(outputReferences)) return null;
  return { compilerOutput, sources: output.sources ?? {} };
}

function compilationTarget(raw) {
  let metadata = raw.metadata;
  try {
    if (typeof raw.rawMetadata === 'string') metadata = JSON.parse(raw.rawMetadata);
    else if (typeof metadata === 'string') metadata = JSON.parse(metadata);
  } catch {
    return null;
  }
  const [target] = Object.entries(metadata?.settings?.compilationTarget ?? {});
  return target ? { sourceName: target[0], contractName: target[1] } : null;
}

/** Finds the build-info compiler output and ASTs from the same compilation as an artifact file, or returns null. */
export async function findBuildContext(file, raw, cache = new Map()) {
  const directory = path.dirname(file);
  if (typeof raw._format === 'string' && raw._format.startsWith('hh-sol-artifact')) {
    const debugFile = file.replace(/\.json$/, '.dbg.json');
    if (!(await exists(debugFile))) return null;
    const debug = await readJson(debugFile, cache);
    const buildInfo = await readJson(path.resolve(path.dirname(debugFile), debug.buildInfo), cache);
    return contextFrom(buildInfo.output, raw.sourceName, raw.contractName, raw);
  }
  if (typeof raw.buildInfoId === 'string') {
    const outputFile = await upward(directory, path.join('build-info', `${raw.buildInfoId}.output.json`));
    if (!outputFile) return null;
    const buildOutput = await readJson(outputFile, cache);
    return contextFrom(buildOutput.output, raw.inputSourceName ?? raw.sourceName, raw.contractName, raw);
  }
  const target = compilationTarget(raw);
  if (!target) return null;
  const found = await buildInfoDirectory(directory);
  if (!found) return null;
  for (const name of found.files) {
    const buildInfo = await readJson(path.join(found.directory, name), cache);
    const context = contextFrom(buildInfo.output, target.sourceName, target.contractName, raw);
    if (context) return context;
  }
  return null;
}

/** Loads and normalizes every contract artifact named by a spec. Returns a Map keyed by contract ID. */
export async function loadArtifacts(spec, specFile) {
  const artifacts = new Map();
  const normalized = new Map();
  const cache = new Map();
  for (const item of spec.contracts) {
    const file = path.resolve(path.dirname(specFile), item.artifact);
    if (!normalized.has(file)) {
      const raw = await readJson(file, cache);
      const context = await findBuildContext(file, raw, cache);
      normalized.set(file, normalizeArtifact(raw, `${item.id} at ${file}`, context ?? {}));
    }
    const artifact = normalized.get(file);
    if (item.name !== undefined && artifact.contractName !== undefined) {
      assert(item.name === artifact.contractName, `contract:${item.id} expects ${item.name}, but ${file} holds ${artifact.contractName}.`);
    }
    artifacts.set(item.id, artifact);
  }
  return artifacts;
}

function constant(value) {
  return `${JSON.stringify(value, null, 2)} as const`;
}

/** Writes one optional viem TypeScript adapter per artifact. Planning and deployment do not need these files. */
export async function generateAdapters(artifacts, outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  for (const [id, artifact] of [...artifacts].sort(([left], [right]) => left.localeCompare(right))) {
    assert(SAFE_ID.test(id), `Adapter ID ${id} is not a safe file name.`);
    const body = [
      `// Generated by etherplan from artifact ${artifact.artifactHash}. Do not edit.`,
      "import { getContract, type Address, type PublicClient } from 'viem';",
      '',
      `export const artifactHash = ${JSON.stringify(artifact.artifactHash)} as const;`,
      `export const buildIdentity = ${constant(artifact.buildIdentity ?? {})};`,
      `export const abi = ${constant(artifact.abi)};`,
      `export const bytecode = ${JSON.stringify(artifact.bytecode.object)} as const;`,
      `export const deployedBytecode = ${JSON.stringify(artifact.deployedBytecode.object)} as const;`,
      `export const linkReferences = ${constant(artifact.bytecode.linkReferences ?? {})};`,
      `export const deployedLinkReferences = ${constant(artifact.deployedBytecode.linkReferences ?? {})};`,
      `export const immutableReferences = ${constant(artifact.deployedBytecode.immutableReferences ?? {})};`,
      `export const immutables = ${constant(artifact.immutables ?? [])};`,
      '',
      'export function at(address: Address, client: PublicClient) {',
      '  return getContract({ address, abi, client });',
      '}',
      '',
    ].join('\n');
    await writeFile(path.join(outputDirectory, `${id}.ts`), body);
  }
}
