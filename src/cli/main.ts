import { readFile } from 'node:fs/promises';
import { loadArtifacts } from '../artifacts.ts';
import { findSpecFile, loadConfig, loadSpec, withConfig } from '../input/project.ts';
import { graph } from '../spec/index.ts';
import { adapters } from './commands/adapters.ts';
import { apply } from './commands/apply.ts';
import { compile } from './commands/compile.ts';
import { graphCommand } from './commands/graph.ts';
import { impact } from './commands/impact.ts';
import { importCommand } from './commands/import.ts';
import { plan } from './commands/plan.ts';
import { schedule } from './commands/schedule.ts';
import { status } from './commands/status.ts';
import { validate } from './commands/validate.ts';
import { verify } from './commands/verify.ts';
import { publicClient, stateFileFor } from './environment.ts';
import { COMMANDS, SPEC_COMMANDS, isCommand, parseOptions, usage, UsageError, validateCombination, validateOptions } from './options.ts';
import type { CliOptions, CommandName } from './options.ts';
import { print } from './shared.ts';

async function run(command: CommandName, options: CliOptions): Promise<void> {
  if (options.rebaseline && command !== 'import') throw new Error('--rebaseline applies only to import.');
  if (command === 'status') return status({ options });
  const specFile = await findSpecFile(options.spec);
  const config = await loadConfig(specFile, SPEC_COMMANDS);
  const merged = withConfig(options, config, command, COMMANDS[command].options);
  if (merged.configured.length && config) process.stderr.write(`Using ${merged.configured.map(name => `--${name}`).join(', ')} from ${config.file}.\n`);
  options = merged.options as CliOptions;
  validateCombination(command, options);
  const spec = await loadSpec(specFile);
  const ordered = graph(spec);
  const context = { options, specFile, spec, ordered };
  if (command === 'compile') return compile(context);
  if (command === 'graph') return graphCommand(context);
  if (command === 'impact') return impact(context);
  const artifacts = await loadArtifacts(spec, specFile);
  const withArtifacts = { ...context, artifacts };
  if (command === 'validate') return validate(withArtifacts);
  if (command === 'adapters') return adapters(withArtifacts);
  const client = publicClient();
  const stateFile = stateFileFor(specFile, options);
  const withChain = { ...withArtifacts, client, stateFile };
  if (command === 'import') return importCommand(withChain);
  if (command === 'apply') return apply(withChain);
  if (command === 'plan') return plan(withChain);
  if (command === 'verify') return verify(withChain);
  return schedule(withChain);
}

export async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--version' || command === '-V' || command === 'version') {
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    console.log(manifest.version);
  } else if (command === '--help' || command === '-h' || command === 'help') {
    const topic = command === 'help' ? args[0] : null;
    if (topic && !isCommand(topic)) {
      console.error(`Unknown command ${topic}.\n${usage()}`);
      process.exitCode = 2;
    } else {
      console.log(usage(isCommand(topic ?? undefined) ? topic as CommandName : undefined));
    }
  } else if (!isCommand(command)) {
    console.error(`${command ? `Unknown command ${command}.\n` : ''}${usage()}`);
    process.exitCode = 2;
  } else if (args.includes('--help') || args.includes('-h')) {
    console.log(usage(command));
  } else {
    try {
      const options = parseOptions(args);
      validateOptions(command, options);
      await run(command, options);
    } catch (error) {
      const failure = error as { result?: unknown; code?: string; message?: string };
      if (failure?.result) print(failure.result);
      console.error(`${failure?.code ? `${failure.code}: ` : ''}${failure?.message}${error instanceof UsageError ? `\n${usage(command)}` : ''}`);
      process.exitCode = error instanceof UsageError ? 2 : 1;
    }
  }
}
