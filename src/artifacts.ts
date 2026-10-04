import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hashJson } from './identity.ts';
import { field, isRecord } from './json.ts';
import { assertAbi, codeBody, normalizeArtifact } from './artifacts/normalize.ts';
import type { Artifacts, BuildContext, NormalizedArtifact } from './artifacts/types.ts';
import type { ParsedSpec } from './spec/types.ts';

export { assertAbi, normalizeArtifact };

const SAFE_ID = /^[a-z][a-zA-Z0-9_]*$/;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function readJson(file: string, cache: Map<string, Promise<unknown>>): Promise<unknown> {
  let pending = cache.get(file);
  if (!pending) {
    pending = readFile(file, 'utf8').then(JSON.parse);
    cache.set(file, pending);
  }
  return pending;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

async function upward(start: string, relative: string, levels = 4): Promise<string | null> {
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

async function buildInfoDirectory(
  start: string,
  levels = 4,
): Promise<{ directory: string; files: string[] } | null> {
  let directory = start;
  for (let level = 0; level <= levels; level++) {
    const candidate = path.join(directory, 'build-info');
    try {
      return {
        directory: candidate,
        files: (await readdir(candidate)).filter((file) => file.endsWith('.json')).sort(),
      };
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

// The build output is the artifact's own only when its runtime code and immutable references agree with the artifact.
function contextFrom(
  output: unknown,
  sourceName: unknown,
  contractName: unknown,
  raw: unknown,
): BuildContext | null {
  if (typeof sourceName !== 'string' || typeof contractName !== 'string') return null;
  const compilerOutput = field(field(field(output, 'contracts'), sourceName), contractName);
  const evm = field(compilerOutput, 'evm');
  if (!evm) return null;
  const deployedBytecode = field(raw, 'deployedBytecode');
  const deployed =
    field(deployedBytecode, 'object') ??
    deployedBytecode ??
    field(field(field(raw, 'evm'), 'deployedBytecode'), 'object');
  if (codeBody(field(field(evm, 'deployedBytecode'), 'object')) !== codeBody(deployed)) return null;
  const references =
    field(deployedBytecode, 'immutableReferences') ?? field(raw, 'immutableReferences');
  const outputReferences = field(field(evm, 'deployedBytecode'), 'immutableReferences');
  if (references && outputReferences && hashJson(references) !== hashJson(outputReferences))
    return null;
  return { compilerOutput, sources: field(output, 'sources') ?? {} };
}

function compilationTarget(raw: unknown): { sourceName: string; contractName: string } | null {
  let metadata = field(raw, 'metadata');
  const rawMetadata = field(raw, 'rawMetadata');
  try {
    if (typeof rawMetadata === 'string') metadata = JSON.parse(rawMetadata);
    else if (typeof metadata === 'string') metadata = JSON.parse(metadata);
  } catch {
    return null;
  }
  const target = field(field(metadata, 'settings'), 'compilationTarget');
  const [entry] = Object.entries(isRecord(target) ? target : {});
  return entry && typeof entry[1] === 'string'
    ? { sourceName: entry[0], contractName: entry[1] }
    : null;
}

/** Finds the build-info compiler output and ASTs from the same compilation as an artifact file, or returns null. */
export async function findBuildContext(
  file: string,
  raw: unknown,
  cache: Map<string, Promise<unknown>> = new Map(),
): Promise<BuildContext | null> {
  const directory = path.dirname(file);
  const format = field(raw, '_format');
  if (typeof format === 'string' && format.startsWith('hh-sol-artifact')) {
    const debugFile = file.replace(/\.json$/, '.dbg.json');
    if (!(await exists(debugFile))) return null;
    const buildInfoPath = field(await readJson(debugFile, cache), 'buildInfo');
    if (typeof buildInfoPath !== 'string') return null;
    const buildInfo = await readJson(path.resolve(path.dirname(debugFile), buildInfoPath), cache);
    return contextFrom(
      field(buildInfo, 'output'),
      field(raw, 'sourceName'),
      field(raw, 'contractName'),
      raw,
    );
  }
  const buildInfoId = field(raw, 'buildInfoId');
  if (typeof buildInfoId === 'string') {
    const outputFile = await upward(
      directory,
      path.join('build-info', `${buildInfoId}.output.json`),
    );
    if (!outputFile) return null;
    const buildOutput = await readJson(outputFile, cache);
    return contextFrom(
      field(buildOutput, 'output'),
      field(raw, 'inputSourceName') ?? field(raw, 'sourceName'),
      field(raw, 'contractName'),
      raw,
    );
  }
  const target = compilationTarget(raw);
  if (!target) return null;
  const found = await buildInfoDirectory(directory);
  if (!found) return null;
  for (const name of found.files) {
    const buildInfo = await readJson(path.join(found.directory, name), cache);
    const context = contextFrom(
      field(buildInfo, 'output'),
      target.sourceName,
      target.contractName,
      raw,
    );
    if (context) return context;
  }
  return null;
}

/** Loads and normalizes every contract artifact named by a spec. Returns a Map keyed by contract ID. */
export async function loadArtifacts(spec: ParsedSpec, specFile: string): Promise<Artifacts> {
  const artifacts: Artifacts = new Map();
  const normalized = new Map<string, NormalizedArtifact>();
  const cache = new Map<string, Promise<unknown>>();
  for (const item of spec.contracts) {
    const file = path.resolve(path.dirname(specFile), item.artifact);
    try {
      let artifact = normalized.get(file);
      if (!artifact) {
        const raw = await readJson(file, cache);
        const context = await findBuildContext(file, raw, cache);
        artifact = normalizeArtifact(raw, `contract:${item.id} at ${file}`, context ?? {});
        normalized.set(file, artifact);
      }
      if (item.name !== undefined) {
        assert(
          artifact.contractName !== undefined,
          `Declared name ${item.name} cannot be checked: the artifact has no contract name.`,
        );
        assert(
          item.name === artifact.contractName,
          `Artifact expects ${item.name}, but it holds ${artifact.contractName}.`,
        );
      }
      if (item.source !== undefined) {
        assert(
          artifact.sourceName !== undefined,
          `Declared source ${item.source} cannot be checked: the artifact has no source name.`,
        );
        assert(
          item.source === artifact.sourceName,
          `Declared source ${item.source} differs from artifact source name ${artifact.sourceName}.`,
        );
      }
      artifacts.set(item.id, artifact);
    } catch (error) {
      throw new Error(`contract:${item.id} artifact ${file}: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }
  return artifacts;
}

function constant(value: unknown): string {
  return `${JSON.stringify(value, null, 2)} as const`;
}

/** Writes one optional viem TypeScript adapter per artifact. Planning and deployment do not need these files. */
export async function generateAdapters(
  artifacts: Artifacts,
  outputDirectory: string,
): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  for (const [id, artifact] of [...artifacts].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
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
