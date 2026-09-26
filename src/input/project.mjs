import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSpec } from '../spec/index.mjs';
import { compileConfig, compileSpec, configOptions } from './compile.mjs';
import { parseHcl } from './hcl.mjs';

function isEthp(file) {
  return path.extname(file) === '.ethp';
}

function display(file) {
  const relative = path.relative(process.cwd(), file);
  return relative && !relative.startsWith('..') ? relative : file;
}

// main.ethp reads main.ethpvars and main.ethpconfig from the same directory.
function sibling(specFile, extension) {
  return path.join(path.dirname(specFile), `${path.basename(specFile, '.ethp')}${extension}`);
}

async function readOptional(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Returns the explicit spec path, or the only .ethp file or spec.json in the directory. */
export async function findSpecFile(explicit, directory = process.cwd()) {
  if (explicit) return path.resolve(explicit);
  const entries = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() || entry.isSymbolicLink());
  const ethp = entries.filter(entry => isEthp(entry.name)).map(entry => entry.name).sort();
  if (ethp.length > 1) throw new Error(`Found ${ethp.join(', ')}; pass --spec to choose one.`);
  if (ethp.length === 1 && entries.some(entry => entry.name === 'spec.json')) throw new Error(`Found spec.json and ${ethp[0]}; pass --spec to choose one.`);
  return path.resolve(directory, ethp[0] ?? 'spec.json');
}

/** Compiles an .ethp file and its optional .ethpvars file into an unvalidated JSON spec. */
export async function compileSpecFile(specFile) {
  const varsFile = sibling(specFile, '.ethpvars');
  const [source, vars] = await Promise.all([readFile(specFile, 'utf8'), readOptional(varsFile)]);
  const variables = vars === null ? null : parseHcl(display(varsFile), vars);
  return compileSpec(parseHcl(display(specFile), source), variables, display(varsFile));
}

/** Loads a JSON spec, or compiles an .ethp spec, and validates it with parseSpec. Engine errors name the .ethp file. */
export async function loadSpec(specFile) {
  if (!isEthp(specFile)) return parseSpec(JSON.parse(await readFile(specFile, 'utf8')));
  const compiled = await compileSpecFile(specFile);
  try {
    return parseSpec(compiled);
  } catch (error) {
    throw new Error(`${display(specFile)}: ${error.message}`, { cause: error });
  }
}

/** Loads the .ethpconfig beside an .ethp spec. JSON specs and missing files have no config. */
export async function loadConfig(specFile, commands) {
  if (!isEthp(specFile)) return null;
  const file = sibling(specFile, '.ethpconfig');
  const text = await readOptional(file);
  if (text === null) return null;
  return { file: display(file), ...compileConfig(parseHcl(display(file), text), commands, value => path.resolve(path.dirname(file), value)) };
}

/**
 * Applies config under the explicit CLI options. An explicit --signer-module replaces configured
 * signer addresses. Returns the merged options and the names that came from config.
 */
export function withConfig(options, config, command, accepted) {
  if (!config) return { options, configured: [] };
  const configured = configOptions(config, command, accepted);
  if (options['signer-module']) {
    delete configured.deployers;
    delete configured.owner;
  }
  for (const name of Object.keys(options)) delete configured[name];
  return { options: { ...configured, ...options }, configured: Object.keys(configured).sort() };
}
