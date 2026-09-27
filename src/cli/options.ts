import type { Address, Hash } from '../types.ts';

export type CommandName = keyof typeof COMMANDS;
export type CliOptions = {
  spec?: string; value?: string; out?: string; plan?: string; state?: string; journal?: string; backend?: string;
  'signer-module'?: string; id?: string; 'creation-tx'?: Hash; deployers?: string; owner?: Address;
  'max-spend-wei'?: string; 'replace-max-fee-per-gas'?: string; 'replace-priority-fee-per-gas'?: string;
  'replace-max-cost-wei'?: string; parallel?: boolean; pipeline?: boolean; rebaseline?: boolean;
  var?: string[]; 'var-file'?: string[]; workspace?: string;
};
export function isCommand(value: string | undefined): value is CommandName {
  return value !== undefined && Object.hasOwn(COMMANDS, value);
}
// Options that choose the spec's variable values and state. Every command that reads a spec takes them.
const INPUTS = ['var', 'var-file', 'workspace'];
export const COMMANDS = {
  validate: { description: 'Check the spec and artifacts without an RPC connection.', options: ['spec', ...INPUTS] },
  compile: { description: 'Print the canonical JSON spec for a .json or .ethp spec.', options: ['spec', ...INPUTS] },
  graph: { description: 'Show resource dependencies without loading artifacts.', options: ['spec', ...INPUTS] },
  impact: { description: 'Show resources affected by a named value.', options: ['spec', 'value', ...INPUTS] },
  plan: { description: 'Inspect the chain and save a reviewable plan.', options: ['spec', 'out', 'state', 'journal', 'backend', 'signer-module', 'pipeline', 'deployers', 'owner', 'parallel', 'max-spend-wei', ...INPUTS] },
  apply: { description: 'Create and approve a fresh plan, or apply one supplied with --plan.', options: ['spec', 'plan', 'state', 'journal', 'backend', 'signer-module', 'parallel', 'pipeline', 'max-spend-wei', 'replace-max-fee-per-gas', 'replace-priority-fee-per-gas', 'replace-max-cost-wei', ...INPUTS] },
  verify: { description: 'Verify desired state against the chain.', options: ['spec', 'state', 'backend', ...INPUTS] },
  schedule: { description: 'Preview signer assignments and execution waves.', options: ['spec', 'plan', 'state', 'backend', 'deployers', 'owner', 'parallel', 'pipeline', ...INPUTS] },
  import: { description: 'Record a verified existing contract in local state.', options: ['spec', 'state', 'id', 'creation-tx', 'rebaseline', ...INPUTS] },
  adapters: { description: 'Generate optional TypeScript artifact adapters.', options: ['spec', 'out', ...INPUTS] },
  status: { description: 'Inspect a deployment in the production backend.', options: ['plan', 'backend'] },
};
const OPTION_HELP = {
  spec: 'Specification file, .json or .ethp (default: the only .ethp file or spec.json here)',
  value: 'Value name for impact',
  out: 'Output path',
  plan: 'Saved plan file',
  state: 'State file (default: .etherplan/<workspace>/state.json beside the spec)',
  journal: 'Journal file (default: <state-file>.journal.jsonl)',
  backend: 'Production backend config file',
  'signer-module': 'Signer module for plan or apply',
  id: 'Contract resource ID, for example contract:registry',
  'creation-tx': 'Creation transaction hash used as import proof',
  rebaseline: 'Accept a rebuilt artifact for an existing imported contract',
  deployers: 'Comma-separated deployer addresses',
  owner: 'Owner signer address for planning or scheduling',
  'max-spend-wei': 'Reviewed maximum total cost in wei per signer for a write plan',
  'replace-max-fee-per-gas': 'Replacement transaction maximum fee per gas in wei',
  'replace-priority-fee-per-gas': 'Replacement transaction priority fee per gas in wei',
  'replace-max-cost-wei': 'Maximum cost in wei for each replacement transaction',
  parallel: 'Use eligible deployers concurrently (default: serial)',
  pipeline: 'Use a nonce-pinned pipeline plan',
  var: 'Set a declared variable, name=value; repeatable, and the last one wins',
  'var-file': 'Read variable values from an .ethpvars file; repeatable, later files win',
  workspace: 'Workspace for separate state and main.<name>.ethpvars (default: ETHP_WORKSPACE or default)',
};
const VALUE_OPTIONS = new Set(['spec', 'value', 'out', 'plan', 'state', 'journal', 'backend', 'signer-module', 'id', 'creation-tx', 'deployers', 'owner', 'max-spend-wei', 'replace-max-fee-per-gas', 'replace-priority-fee-per-gas', 'replace-max-cost-wei', 'workspace']);
const REPEATABLE_OPTIONS = new Set(['var', 'var-file']);
const BOOLEAN_OPTIONS = new Set(['parallel', 'pipeline', 'rebaseline']);
export const SPEC_COMMANDS = Object.fromEntries(Object.entries(COMMANDS).filter(([, details]) => details.options.includes('spec')).map(([name, details]) => [name, details.options]));

export class UsageError extends Error {}

export function usage(command?: CommandName): string {
  if (!command) {
    return `Usage: etherplan <command> [options]\n\nCommands:\n${Object.entries(COMMANDS).map(([name, details]) => `  ${name.padEnd(10)} ${details.description}`).join('\n')}\n\nRun etherplan <command> --help for options.\nRun etherplan --version for the installed version.`;
  }
  const details = COMMANDS[command];
  const describe = (name: keyof typeof OPTION_HELP) => name === 'out' && command === 'plan' ? 'Local plan file (default: ./plan.json; - skips the local file)'
    : name === 'out' ? 'Adapter directory (default: ./generated)'
      : name === 'plan' && command === 'apply' ? 'Saved plan file; omit to create and approve a fresh plan'
        : name === 'plan' && command === 'status' ? 'Saved plan file (default: ./plan.json)'
          : OPTION_HELP[name];
  const environment = ['plan', 'apply', 'verify', 'schedule', 'import'].includes(command)
    ? '\n\nRequires ETH_RPC_URL.' : '';
  const signers = command === 'apply'
    ? ' Without --signer-module, local apply reads DEPLOYER_PRIVATE_KEY or DEPLOYER_PRIVATE_KEYS and, for owner calls, OWNER_PRIVATE_KEY.' : '';
  return `Usage: etherplan ${command} [options]\n\n${details.description}\n\nOptions:\n${details.options.map(name => `  --${name.padEnd(12)} ${describe(name as keyof typeof OPTION_HELP)}`).join('\n')}\n  --help         Show this help${environment}${signers}`;
}

export function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!flag?.startsWith('--')) throw new UsageError(`Invalid option ${flag}.`);
    const name = flag.slice(2);
    if (REPEATABLE_OPTIONS.has(name)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new UsageError(`Option ${flag} needs a value.`);
      ((options as Record<string, string[]>)[name] ??= []).push(value);
      continue;
    }
    if (Object.hasOwn(options, name)) throw new UsageError(`Duplicate option ${flag}.`);
    if (BOOLEAN_OPTIONS.has(name)) {
      (options as Record<string, string | boolean>)[name] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new UsageError(`Unknown option ${flag}.`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new UsageError(`Option ${flag} needs a value.`);
    (options as Record<string, string | boolean>)[name] = value;
  }
  return options;
}

export function validateOptions(command: CommandName, options: CliOptions): void {
  const allowed = new Set(COMMANDS[command].options);
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) throw new UsageError(`--${name} is not an option for ${command}.`);
  }
  if (command === 'impact' && !options.value) throw new UsageError('impact needs --value <name>.');
  for (const assignment of options.var ?? []) {
    if (!/^[a-z][a-zA-Z0-9_]*=/.test(assignment)) throw new UsageError(`--var ${assignment} must be name=value, for example --var owner=0x….`);
  }
  if (command === 'import' && !/^contract:[a-z][a-zA-Z0-9_]*$/.test(options.id ?? '')) {
    throw new UsageError('import needs --id contract:<name>.');
  }
}

// Checks option combinations after .ethpconfig options are merged in.
export function validateCombination(command: CommandName, options: CliOptions): void {
  if (command === 'plan') {
    if (options['signer-module'] && (options.deployers || options.owner)) throw new UsageError('plan --signer-module supplies signer addresses; omit --deployers and --owner.');
    if (options.pipeline && !options.deployers && !options['signer-module']) throw new UsageError('A pipeline plan needs --deployers <address,address> or --signer-module.');
    if (options.parallel && !options.deployers && !options['signer-module']) throw new UsageError('plan --parallel needs --deployers <address,address> or --signer-module.');
    if (options.owner && !options.deployers) throw new UsageError('plan --owner needs --deployers <address,address>.');
  }
  if (command === 'apply' && options.pipeline && options.parallel) {
    throw new UsageError('A pipeline apply reads the parallel setting from its saved plan; omit --parallel.');
  }
}
