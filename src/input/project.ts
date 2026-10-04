import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSpec } from '../spec/index.ts';
import { compileConfig, compileProject, configOptions } from './compile.ts';
import { fail, parseHcl } from './hcl.ts';
import type { CompiledProject } from './compile.ts';
import type { ParsedSpec } from '../spec/types.ts';
import type {
  CommandOptions,
  CompiledSpec,
  ConfigOptions,
  HclDocument,
  LoadedConfig,
} from './types.ts';
import type { VariableFile, VariableValue } from './variables.ts';

export const DEFAULT_WORKSPACE = 'default';
const WORKSPACE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Where variable values come from besides the .ethpvars file beside the spec. */
export interface ProjectInputs {
  /** Selects main.<workspace>.ethpvars; default when omitted. */
  workspace?: string;
  /** --var-file paths, in order. */
  varFiles?: string[];
  /** --var flags as name=value, in order. */
  vars?: string[];
  /** The process environment, read for ETHP_VAR_<name>. */
  env?: Record<string, string | undefined>;
}

/** A validated spec with each variable's value and source. JSON specs have no variables. */
export interface LoadedProject {
  spec: ParsedSpec;
  variables: VariableValue[];
}

function isEthp(file: string): boolean {
  return path.extname(file) === '.ethp';
}

function display(file: string): string {
  const relative = path.relative(process.cwd(), file);
  return relative && !relative.startsWith('..') ? relative : file;
}

// main.ethp reads main.ethpvars and main.ethpconfig from the same directory.
function sibling(specFile: string, extension: string): string {
  return path.join(path.dirname(specFile), `${path.basename(specFile, '.ethp')}${extension}`);
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** A project's required entry point is main.ethp in the working directory. */
export async function findSpecFile(directory: string = process.cwd()): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  if (
    !entries.some(
      (entry) => entry.name === 'main.ethp' && (entry.isFile() || entry.isSymbolicLink()),
    )
  ) {
    throw new Error(
      `No main.ethp in ${directory}. Run Etherplan from a directory containing main.ethp.`,
    );
  }
  return path.resolve(directory, 'main.ethp');
}

/** Returns the selected workspace: the option, then ETHP_WORKSPACE, then default. */
export function selectWorkspace(
  option: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  // As with TF_WORKSPACE, an empty ETHP_WORKSPACE counts as unset.
  const workspace = option ?? (env.ETHP_WORKSPACE || DEFAULT_WORKSPACE);
  if (!WORKSPACE.test(workspace))
    throw new Error(
      `Workspace ${JSON.stringify(workspace)} must start with a letter or digit and contain only letters, digits, - and _.`,
    );
  return workspace;
}

/**
 * Compiles every root-level .ethp file into one unvalidated JSON spec. Var files apply in order: main.ethpvars beside
 * main.ethp, then main.<workspace>.ethpvars, then each --var-file. The first two are optional.
 */
export async function compileProjectFile(
  specFile: string,
  inputs: ProjectInputs = {},
): Promise<CompiledProject> {
  const varsFile = sibling(specFile, '.ethpvars');
  const optional = [
    varsFile,
    sibling(specFile, `.${inputs.workspace ?? DEFAULT_WORKSPACE}.ethpvars`),
  ];
  const directory = path.dirname(specFile);
  const ethpFiles =
    path.basename(specFile) === 'main.ethp'
      ? (await readdir(directory, { withFileTypes: true }))
          .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && isEthp(entry.name))
          .map((entry) => path.join(directory, entry.name))
          .sort()
      : [specFile];
  const [sources, texts] = await Promise.all([
    Promise.all(ethpFiles.map((file) => readFile(file, 'utf8'))),
    Promise.all([
      ...optional.map(readOptional),
      ...(inputs.varFiles ?? []).map((file) => readFile(path.resolve(file), 'utf8')),
    ]),
  ]);
  const documents = sources.map((source, index) => parseHcl(display(ethpFiles[index]!), source));
  const main = documents.find((document) => document.at.file === display(specFile));
  if (!main) throw new Error(`No main.ethp in ${directory}.`);
  const document: HclDocument = { kind: 'body', at: main.at, attributes: new Map(), blocks: [] };
  for (const part of documents) {
    for (const [name, attribute] of part.attributes) {
      const first = document.attributes.get(name);
      if (first)
        fail(
          attribute,
          `${name} is already set at ${first.at.file}:${first.at.line}:${first.at.column}.`,
        );
      document.attributes.set(name, attribute);
    }
    document.blocks.push(...part.blocks);
  }
  const files: VariableFile[] = [
    ...optional,
    ...(inputs.varFiles ?? []).map((file) => path.resolve(file)),
  ].flatMap((file, index) =>
    texts[index] == null
      ? []
      : [{ file: display(file), document: parseHcl(display(file), texts[index]) }],
  );
  return compileProject(document, {
    files,
    env: inputs.env ?? {},
    vars: inputs.vars ?? [],
    varsFile: display(varsFile),
  });
}

/** Compiles an .ethp file and its variable inputs into an unvalidated JSON spec. */
export async function compileSpecFile(
  specFile: string,
  inputs: ProjectInputs = {},
): Promise<CompiledSpec> {
  return (await compileProjectFile(specFile, inputs)).spec;
}

/** Loads a JSON spec, or compiles an .ethp spec, and validates it with parseSpec. Engine errors name the .ethp file. */
export async function loadProject(
  specFile: string,
  inputs: ProjectInputs = {},
): Promise<LoadedProject> {
  if (!isEthp(specFile)) {
    if (inputs.vars?.length || inputs.varFiles?.length)
      throw new Error('--var and --var-file apply only to .ethp specs.');
    return { spec: parseSpec(JSON.parse(await readFile(specFile, 'utf8'))), variables: [] };
  }
  const { spec, variables } = await compileProjectFile(specFile, inputs);
  try {
    return { spec: parseSpec(spec), variables };
  } catch (error) {
    throw new Error(`${display(specFile)}: ${(error as Error).message}`, { cause: error });
  }
}

/** loadProject without the variable report. */
export async function loadSpec(specFile: string, inputs: ProjectInputs = {}): Promise<ParsedSpec> {
  return (await loadProject(specFile, inputs)).spec;
}

/** Loads the .ethpconfig beside an .ethp spec. JSON specs and missing files have no config. */
export async function loadConfig(
  specFile: string,
  commands: CommandOptions,
): Promise<LoadedConfig | null> {
  if (!isEthp(specFile)) return null;
  const file = sibling(specFile, '.ethpconfig');
  const text = await readOptional(file);
  if (text === null) return null;
  return {
    file: display(file),
    ...compileConfig(parseHcl(display(file), text), commands, (value) =>
      path.resolve(path.dirname(file), value),
    ),
  };
}

/**
 * Applies config under the explicit CLI options. An explicit --signer-module replaces configured
 * signer addresses. Returns the merged options and the names that came from config.
 */
export function withConfig(
  options: Record<string, string | boolean | string[]>,
  config: LoadedConfig | null,
  command: string,
  accepted: string[],
): { options: Record<string, string | boolean | string[]>; configured: string[] } {
  if (!config) return { options, configured: [] };
  const configured = configOptions(config, command, accepted);
  if (options['signer-module']) {
    delete configured.deployers;
    delete configured.owner;
  }
  for (const name of Object.keys(options)) delete configured[name as keyof ConfigOptions];
  return { options: { ...configured, ...options }, configured: Object.keys(configured).sort() };
}
