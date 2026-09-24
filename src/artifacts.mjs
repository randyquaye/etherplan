import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hashJson } from './identity.mjs';
import { assertAbi, codeBody, normalizeArtifact } from './artifacts/normalize.mjs';

export { assertAbi, normalizeArtifact };

const SAFE_ID = /^[a-z][a-zA-Z0-9_]*$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
    try {
      if (!normalized.has(file)) {
        const raw = await readJson(file, cache);
        const context = await findBuildContext(file, raw, cache);
        normalized.set(file, normalizeArtifact(raw, `contract:${item.id} at ${file}`, context ?? {}));
      }
      const artifact = normalized.get(file);
      if (item.name !== undefined) {
        assert(artifact.contractName !== undefined, `Declared name ${item.name} cannot be checked: the artifact has no contract name.`);
        assert(item.name === artifact.contractName, `Artifact expects ${item.name}, but it holds ${artifact.contractName}.`);
      }
      if (item.source !== undefined) {
        assert(artifact.sourceName !== undefined, `Declared source ${item.source} cannot be checked: the artifact has no source name.`);
        assert(item.source === artifact.sourceName, `Declared source ${item.source} differs from artifact source name ${artifact.sourceName}.`);
      }
      artifacts.set(item.id, artifact);
    } catch (error) {
      throw new Error(`contract:${item.id} artifact ${file}: ${error.message}`, { cause: error });
    }
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
