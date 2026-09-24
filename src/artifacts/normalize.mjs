import { keccak256, stringToHex } from 'viem';
import { hashJson } from '../identity.mjs';
import { immutableEntries, normalizeCode } from '../verification/bytecode.mjs';
import { decodeMetadataTail, ipfsMetadataHash } from '../verification/metadata.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function codeBody(object) {
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

function sameAbi(left, right) {
  const normalize = abi => abi.map(item => item.type === 'function' ? { ...item, outputs: item.outputs ?? [] } : item);
  return hashJson(normalize(left)) === hashJson(normalize(right));
}

function assertAbiParameter(parameter, label) {
  assert(plainObject(parameter) && typeof parameter.type === 'string', `${label} needs an ABI type.`);
  const type = parameter.type;
  const base = type.replace(/(\[[0-9]*\])*$/, '');
  assert(!/[\[\]]/.test(base), `${label} has invalid ABI type ${type}.`);
  for (const [, length] of type.matchAll(/\[([0-9]*)\]/g)) {
    assert(length === '' || (Number.isSafeInteger(Number(length)) && Number(length) > 0), `${label} has invalid ABI array length in ${type}.`);
  }
  const integer = /^(u?int)([0-9]*)$/.exec(base);
  const fixedBytes = /^bytes([0-9]+)$/.exec(base);
  const fixed = /^(u?fixed)([0-9]+)x([0-9]+)$/.exec(base);
  const valid = ['address', 'bool', 'string', 'bytes', 'function', 'tuple'].includes(base)
    || (integer && (integer[2] === '' || (Number(integer[2]) >= 8 && Number(integer[2]) <= 256 && Number(integer[2]) % 8 === 0)))
    || (fixedBytes && Number(fixedBytes[1]) >= 1 && Number(fixedBytes[1]) <= 32)
    || (fixed && Number(fixed[2]) >= 8 && Number(fixed[2]) <= 256 && Number(fixed[2]) % 8 === 0 && Number(fixed[3]) >= 1 && Number(fixed[3]) <= 80);
  assert(valid, `${label} has invalid ABI type ${type}.`);
  if (base === 'tuple') {
    assert(Array.isArray(parameter.components), `${label} tuple needs components.`);
    parameter.components.forEach((component, index) => assertAbiParameter(component, `${label} component ${index}`));
  }
}

export function assertAbi(abi, label) {
  assert(Array.isArray(abi), `${label} has an incomplete artifact: it has no ABI.`);
  const kinds = new Set(['function', 'constructor', 'event', 'error', 'fallback', 'receive']);
  for (const [index, item] of abi.entries()) {
    const location = `${label} ABI item ${index}`;
    assert(plainObject(item) && kinds.has(item.type), `${location} has an invalid kind.`);
    if (['function', 'event', 'error'].includes(item.type)) {
      assert(typeof item.name === 'string' && item.name.length > 0, `${location} needs a name.`);
    }
    if (['function', 'constructor', 'event', 'error'].includes(item.type)) {
      assert(Array.isArray(item.inputs), `${location} needs inputs.`);
      item.inputs.forEach((input, position) => assertAbiParameter(input, `${location} input ${position}`));
    }
    if (item.outputs !== undefined) {
      assert(Array.isArray(item.outputs), `${location} outputs must be an array.`);
      item.outputs.forEach((output, position) => assertAbiParameter(output, `${location} output ${position}`));
    }
  }
  assert(abi.filter(item => item.type === 'constructor').length <= 1, `${label} ABI has more than one constructor.`);
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

function namesOf(raw, parsed, options, label) {
  const targets = Object.entries(parsed?.settings?.compilationTarget ?? {});
  assert(targets.length <= 1, `${label} metadata has more than one compilation target.`);
  const [target] = targets;
  function one(field, candidates) {
    const present = candidates.filter(value => value !== undefined);
    for (const value of present) assert(typeof value === 'string' && value.length > 0, `${label} has an invalid ${field}.`);
    assert(new Set(present).size <= 1, `${label} has conflicting ${field} declarations: ${present.join(', ')}.`);
    return present[0];
  }
  return {
    contractName: one('contract name', [raw.contractName, options.contractName, target?.[1]]),
    sourceName: one('source name', [raw.sourceName, raw.inputSourceName, options.sourceName, target?.[0]]),
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
  assertAbi(abi, label);
  if (raw.abi !== undefined && compilerOutput?.abi !== undefined) {
    assert(sameAbi(raw.abi, compilerOutput.abi), `${label} ABI differs from its build-info compiler output.`);
  }
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
  if (metadata.parsed?.output?.abi !== undefined) {
    assert(Array.isArray(metadata.parsed.output.abi) && sameAbi(abi, metadata.parsed.output.abi), `${label} ABI differs from its compiler metadata.`);
  }
  const buildIdentity = buildIdentityOf(metadata, deployedBytecode.object, label);
  const units = sourceUnits(options.sources);
  if (plainObject(raw.ast) && raw.ast.nodeType === 'SourceUnit') units.push(raw.ast);
  const { contractName, sourceName } = namesOf(raw, metadata.parsed, options, label);
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
