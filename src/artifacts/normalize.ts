import { keccak256, stringToHex } from 'viem';
import { canonicalJson, hashJson } from '../identity.ts';
import { immutableEntries, normalizeCode } from '../verification/bytecode.ts';
import { decodeMetadataTail, ipfsMetadataHash } from '../verification/metadata.ts';
import type { Abi, Hash, JsonObject } from '../types.ts';
import type { ArtifactFormat, BuildIdentity, ByteRange, ImmutableReferences, LinkReferences, NamedImmutable, NormalizedArtifact, NormalizeOptions } from './types.ts';

type ObjectValue = Record<string, unknown>;
type Metadata = { rawText: string | null; parsed: ObjectValue | null };
type BytecodeSource = ObjectValue & { object: string };
type BytecodeParts = { creation: BytecodeSource; deployed: BytecodeSource; immutableReferences: unknown };
type SourceUnit = ObjectValue;
type Declaration = { name?: string; mutability?: string; visibility?: string; type?: string; source?: string };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function plainObject(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function codeBody(object: unknown): string | null {
  return typeof object === 'string' ? object.replace(/^0x/i, '').toLowerCase() : null;
}

function formatOf(raw: ObjectValue): ArtifactFormat {
  if (typeof raw._format === 'string' && raw._format.startsWith('hh-sol-artifact')) return 'hardhat2';
  if (typeof raw._format === 'string' && raw._format.startsWith('hh3-artifact')) return 'hardhat3';
  if (plainObject(raw.evm)) return 'solc';
  if (plainObject(raw.bytecode)) return 'foundry';
  return 'flat';
}

function cleanLinkReferences(references: unknown, label: string): LinkReferences {
  assert(references === undefined || plainObject(references), `${label} link references must be an object.`);
  const byFile = plainObject(references) ? references : {};
  const out: LinkReferences = {};
  for (const file of Object.keys(byFile).sort()) {
    const names = byFile[file];
    assert(plainObject(names), `${label} link references for ${file} must be an object.`);
    out[file] = {};
    for (const name of Object.keys(names).sort()) {
      assert(Array.isArray(names[name]), `${label} link references for ${file}:${name} must be an array.`);
      out[file]![name] = names[name].map((range: unknown) => {
        assert(plainObject(range), `${label} link reference for ${file}:${name} must be an object.`);
        return { start: range.start as number, length: range.length as number };
      }).sort((left: ByteRange, right: ByteRange) => left.start - right.start);
    }
  }
  return out;
}

function cleanImmutableReferences(references: unknown, label: string): ImmutableReferences {
  assert(plainObject(references), `${label} immutable references must be an object.`);
  return Object.fromEntries(immutableEntries(references as ImmutableReferences).map(([id, ranges]) => {
    assert(/^[0-9]+$/.test(id), `${label} immutable reference ${id} is not an AST ID.`);
    assert(Array.isArray(ranges) && ranges.length > 0, `${label} immutable reference ${id} needs ranges.`);
    return [id, ranges.map(({ start, length }) => ({ start, length }))];
  }));
}

function sameReferences(left: ImmutableReferences, right: ImmutableReferences): boolean {
  return hashJson(left) === hashJson(right);
}

function canonicalAbi(abi: Abi): string[] {
  return abi
    .map(item => item.type === 'function' ? { ...item, outputs: item.outputs ?? [] } : item)
    .map(canonicalJson)
    .sort();
}

function sameAbi(left: Abi, right: Abi): boolean {
  return hashJson(canonicalAbi(left)) === hashJson(canonicalAbi(right));
}

function assertAbiParameter(parameter: unknown, label: string): void {
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
    parameter.components.forEach((component: unknown, index: number) => assertAbiParameter(component, `${label} component ${index}`));
  }
}

export function assertAbi(abi: unknown, label: string): asserts abi is Abi {
  assert(Array.isArray(abi), `${label} has an incomplete artifact: it has no ABI.`);
  const kinds = new Set(['function', 'constructor', 'event', 'error', 'fallback', 'receive']);
  for (const [index, item] of abi.entries()) {
    const location = `${label} ABI item ${index}`;
    assert(plainObject(item) && typeof item.type === 'string' && kinds.has(item.type), `${location} has an invalid kind.`);
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

function bytecodeParts(raw: ObjectValue, format: ArtifactFormat, compilerOutput: ObjectValue | null, label: string): BytecodeParts {
  const outputEvm = plainObject(compilerOutput?.evm) ? compilerOutput.evm : null;
  const outputDeployed = plainObject(outputEvm?.deployedBytecode) ? outputEvm.deployedBytecode : null;
  let creation: ObjectValue;
  let deployed: ObjectValue;
  let immutableReferences: unknown;
  if (format === 'foundry' || format === 'solc') {
    const source = format === 'foundry' ? raw : raw.evm;
    assert(plainObject(source), `${label} has an incomplete artifact: bytecode objects are missing.`);
    creation = source.bytecode as ObjectValue;
    deployed = source.deployedBytecode as ObjectValue;
    assert(plainObject(creation) && plainObject(deployed), `${label} has an incomplete artifact: bytecode objects are missing.`);
    immutableReferences = deployed.immutableReferences ?? outputDeployed?.immutableReferences ?? {};
  } else {
    creation = { object: raw.bytecode, linkReferences: raw.linkReferences };
    deployed = { object: raw.deployedBytecode, linkReferences: raw.deployedLinkReferences };
    immutableReferences = raw.immutableReferences ?? outputDeployed?.immutableReferences;
    assert(immutableReferences !== undefined, `${label} has an incomplete artifact: it has no immutable references. Supply its build-info file.`);
  }
  assert(typeof creation.object === 'string' && (codeBody(creation.object)?.length ?? 0) > 0, `${label} has an incomplete artifact: it has no creation bytecode.`);
  assert(typeof deployed.object === 'string' && (codeBody(deployed.object)?.length ?? 0) > 0, `${label} has an incomplete artifact: it has no runtime bytecode.`);
  if (outputEvm) {
    const outputCreation = plainObject(outputEvm.bytecode) ? outputEvm.bytecode : null;
    assert(codeBody(outputCreation?.object) === codeBody(creation.object) && codeBody(outputDeployed?.object) === codeBody(deployed.object), `${label} does not match the compiler output from its build-info.`);
    if (outputDeployed?.immutableReferences) assert(sameReferences(cleanImmutableReferences(outputDeployed.immutableReferences, label), cleanImmutableReferences(immutableReferences, label)), `${label} immutable references differ from its build-info.`);
  }
  return { creation: creation as BytecodeSource, deployed: deployed as BytecodeSource, immutableReferences };
}

function linkRanges(references: LinkReferences): ByteRange[] {
  return Object.values(references).flatMap(names => Object.values(names).flat());
}

function checkImmutableRanges(object: string, immutableReferences: ImmutableReferences, linkReferences: LinkReferences, label: string): void {
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

function parseMetadata(text: string, label: string): ObjectValue {
  try {
    const value = JSON.parse(text);
    assert(plainObject(value), `${label} metadata is not a JSON object.`);
    return value;
  } catch (error) {
    throw new Error(`${label} metadata is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function metadataOf(raw: ObjectValue, compilerOutput: ObjectValue | null, label: string): Metadata {
  const rawText = typeof raw.rawMetadata === 'string' ? raw.rawMetadata
    : typeof raw.metadata === 'string' ? raw.metadata
      : typeof compilerOutput?.metadata === 'string' ? compilerOutput.metadata
        : null;
  const parsed = rawText ? parseMetadata(rawText, label) : plainObject(raw.metadata) ? raw.metadata : null;
  return { rawText, parsed };
}

function sourceHash(sources: ObjectValue): Hash {
  return hashJson(Object.fromEntries(Object.keys(sources).sort().map(file => {
    const source = plainObject(sources[file]) ? sources[file] : {};
    const digest = source.keccak256 ?? (typeof source.content === 'string' ? keccak256(stringToHex(source.content)) : null);
    return [file, digest];
  })));
}

function buildIdentityOf({ rawText, parsed }: Metadata, runtime: string, label: string): BuildIdentity {
  const identity: BuildIdentity = {};
  if (parsed) {
    if (parsed.language === 'Solidity') identity.compiler = 'solc';
    else if (parsed.language === 'Vyper') identity.compiler = 'vyper';
    if (typeof parsed.language === 'string') identity.language = parsed.language;
    if (plainObject(parsed.compiler) && typeof parsed.compiler.version === 'string') identity.version = parsed.compiler.version;
    if (plainObject(parsed.settings)) {
      const settings = parsed.settings;
      identity.settingsHash = hashJson(settings);
      if (typeof settings.evmVersion === 'string') identity.evmVersion = settings.evmVersion;
      if (plainObject(settings.optimizer)) identity.optimizer = settings.optimizer as JsonObject;
      if (typeof settings.viaIR === 'boolean') identity.viaIR = settings.viaIR;
      const [target] = Object.entries(plainObject(settings.compilationTarget) ? settings.compilationTarget : {});
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
    if (tail.hashKind) identity.metadataHashKind = tail.hashKind;
    if (rawText && tail.hashKind === 'ipfs') {
      assert(ipfsMetadataHash(rawText) === tail.hash, `${label} metadata does not match the metadata hash in its bytecode, so its build identity cannot be reproduced.`);
      identity.metadataVerified = true;
    }
  }
  return identity;
}

function sourceUnits(sources: unknown): SourceUnit[] {
  if (!sources) return [];
  const list = Array.isArray(sources) ? sources : plainObject(sources) ? Object.entries(sources).map(([file, unit]) => {
    if (!plainObject(unit) || !plainObject(unit.ast)) return unit;
    return { ...unit.ast, absolutePath: unit.ast.absolutePath ?? file };
  }) : [];
  return list.filter((unit): unit is SourceUnit => plainObject(unit) && unit.nodeType === 'SourceUnit');
}

function declarations(units: SourceUnit[]): Map<string, Declaration> {
  const found = new Map<string, Declaration>();
  for (const unit of units) {
    const stack: unknown[] = [unit];
    while (stack.length > 0) {
      const node = stack.pop();
      if (Array.isArray(node)) {
        stack.push(...node);
        continue;
      }
      if (!plainObject(node)) continue;
      if (node.nodeType === 'VariableDeclaration' && node.stateVariable === true && typeof node.id === 'number' && Number.isSafeInteger(node.id)) {
        const descriptions = plainObject(node.typeDescriptions) ? node.typeDescriptions : null;
        found.set(String(node.id), {
          ...(typeof node.name === 'string' ? { name: node.name } : {}),
          mutability: typeof node.mutability === 'string' ? node.mutability : node.constant ? 'constant' : 'mutable',
          ...(typeof node.visibility === 'string' ? { visibility: node.visibility } : {}),
          ...(typeof descriptions?.typeString === 'string' ? { type: descriptions.typeString } : {}),
          ...(typeof unit.absolutePath === 'string' ? { source: unit.absolutePath } : {}),
        });
      }
      for (const value of Object.values(node)) if (value && typeof value === 'object') stack.push(value);
    }
  }
  return found;
}

function namedImmutables(immutableReferences: ImmutableReferences, units: SourceUnit[], abi: Abi, label: string): NamedImmutable[] {
  const found = units.length > 0 ? declarations(units) : new Map<string, Declaration>();
  return immutableEntries(immutableReferences).map(([id, ranges]) => {
    const entry: NamedImmutable = { id, ranges };
    const declaration = found.get(id);
    if (!declaration) return entry;
    assert(declaration.mutability === 'immutable', `${label} AST does not match its immutable references: AST node ${id} is not immutable, so the AST comes from a different compilation.`);
    if (declaration.name) entry.name = declaration.name;
    if (declaration.type) entry.type = declaration.type;
    if (declaration.visibility) entry.visibility = declaration.visibility;
    if (declaration.source) entry.source = declaration.source;
    const getter = abi.find(item => item.type === 'function' && item.name === declaration.name && (item.inputs ?? []).length === 0 && (item.outputs ?? []).length === 1);
    if (declaration.visibility === 'public' && getter && declaration.name) entry.getter = declaration.name;
    return entry;
  });
}

function namesOf(raw: ObjectValue, parsed: ObjectValue | null, options: NormalizeOptions, label: string): { contractName?: string; sourceName?: string } {
  const settings = plainObject(parsed?.settings) ? parsed.settings : null;
  const targets = Object.entries(plainObject(settings?.compilationTarget) ? settings.compilationTarget : {});
  assert(targets.length <= 1, `${label} metadata has more than one compilation target.`);
  const [target] = targets;
  function one(field: string, candidates: unknown[]): string | undefined {
    const present = candidates.filter(value => value !== undefined);
    for (const value of present) assert(typeof value === 'string' && value.length > 0, `${label} has an invalid ${field}.`);
    assert(new Set(present).size <= 1, `${label} has conflicting ${field} declarations: ${present.join(', ')}.`);
    return present[0] as string | undefined;
  }
  const contractName = one('contract name', [raw.contractName, options.contractName, target?.[1]]);
  const sourceName = one('source name', [raw.sourceName, raw.inputSourceName, options.sourceName, target?.[0]]);
  return { ...(contractName ? { contractName } : {}), ...(sourceName ? { sourceName } : {}) };
}

/**
 * Normalizes a Foundry, Hardhat 2, Hardhat 3, or solc standard-JSON contract artifact.
 * `options.sources` holds source-unit ASTs from the same compilation (an array, or solc `output.sources`), so each
 * immutable reference gets its variable name and public getter. `options.compilerOutput` is the solc contract output
 * from the matching build-info file. The result is plain JSON; `artifactHash` covers every other field,
 * with top-level ABI entries sorted for hashing while the returned ABI keeps its original order.
 */
export function normalizeArtifact(raw: unknown, id: string, options: NormalizeOptions = {}): NormalizedArtifact {
  const label = id ?? 'Artifact';
  assert(plainObject(raw), `${label} is not a JSON object.`);
  const compilerOutput = plainObject(options.compilerOutput) ? options.compilerOutput : null;
  const format = formatOf(raw);
  const abi = raw.abi ?? compilerOutput?.abi;
  assertAbi(abi, label);
  if (raw.abi !== undefined && compilerOutput?.abi !== undefined) {
    assertAbi(raw.abi, label);
    assertAbi(compilerOutput.abi, label);
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
  const metadataOutput = plainObject(metadata.parsed?.output) ? metadata.parsed.output : null;
  if (metadataOutput?.abi !== undefined) {
    assertAbi(metadataOutput.abi, label);
    assert(sameAbi(abi, metadataOutput.abi), `${label} ABI differs from its compiler metadata.`);
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
  return { ...normalized, artifactHash: hashJson({ ...normalized, abi: canonicalAbi(abi) }) };
}
