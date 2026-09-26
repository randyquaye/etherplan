#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { generateAdapters, loadArtifacts } from './artifacts.ts';
import { applyPlan, acquireLock } from './execution/index.ts';
import { createAwsBackend } from './execution/aws.ts';
import { deploymentScope, inspectDeployment } from './execution/backends.ts';
import { checkPlanIdentity } from './execution/preflight.ts';
import { hashJson } from './identity.ts';
import { findSpecFile, loadConfig, loadSpec, withConfig } from './input/project.ts';
import { createPlan, prepareResources, transactionFor } from './planning/index.ts';
import { createSchedule } from './scheduling/index.ts';
import { dependencyGraphs, dependencyWarnings, graph, impact, parseSpec, usesDependencyPlan } from './spec/index.ts';
import { importResource, readState, writeStateAtomic } from './state/index.ts';
import { validateState } from './state/index.ts';
import { verifyResource } from './verification/index.ts';
import type { Artifacts } from './artifacts/types.ts';
import type { AwsBackend, DeploymentScope, SignerProvider, SignerRoles, Signers } from './execution/types.ts';
import type { StateFile } from './state/types.ts';
import type { Plan } from './planning/types.ts';
import type { ReplacementFees } from './execution/types.ts';
import type { OrderedNode, ParsedSpec } from './spec/types.ts';
import type { Address, ChainIdentity, Client, Hash, Hex, ResourceId } from './types.ts';
import type { VerificationResult } from './verification/types.ts';

type CommandName = keyof typeof COMMANDS;
type CliOptions = {
  spec?: string; value?: string; out?: string; plan?: string; state?: string; journal?: string; backend?: string;
  'signer-module'?: string; id?: string; 'creation-tx'?: Hash; deployers?: string; owner?: Address;
  'max-spend-wei'?: string; 'replace-max-fee-per-gas'?: string; 'replace-priority-fee-per-gas'?: string;
  'replace-max-cost-wei'?: string; parallel?: boolean; pipeline?: boolean; rebaseline?: boolean;
};
type SignerModuleSource = { signerProvider: SignerProvider; signerRoles?: SignerRoles; signers?: never };
type LocalSignerSource = { signers: Signers; signerProvider?: never; signerRoles?: never };
type SignerSource = SignerModuleSource | LocalSignerSource;
type Backend = AwsBackend & { scope: DeploymentScope; ttlMs?: number; confirmations?: number };

function isCommand(value: string | undefined): value is CommandName {
  return value !== undefined && Object.hasOwn(COMMANDS, value);
}

function isPrivateKey(value: string): value is Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

const COMMANDS = {
  validate: { description: 'Check the spec and artifacts without an RPC connection.', options: ['spec'] },
  compile: { description: 'Print the canonical JSON spec for a .json or .ethp spec.', options: ['spec'] },
  graph: { description: 'Show resource dependencies without loading artifacts.', options: ['spec'] },
  impact: { description: 'Show resources affected by a named value.', options: ['spec', 'value'] },
  plan: { description: 'Inspect the chain and save a reviewable plan.', options: ['spec', 'out', 'state', 'backend', 'signer-module', 'pipeline', 'deployers', 'owner', 'parallel', 'max-spend-wei'] },
  apply: { description: 'Create and approve a fresh plan, or apply one supplied with --plan.', options: ['spec', 'plan', 'state', 'journal', 'backend', 'signer-module', 'parallel', 'pipeline', 'max-spend-wei', 'replace-max-fee-per-gas', 'replace-priority-fee-per-gas', 'replace-max-cost-wei'] },
  verify: { description: 'Verify desired state against the chain.', options: ['spec', 'state', 'backend'] },
  schedule: { description: 'Preview signer assignments and execution waves.', options: ['spec', 'plan', 'state', 'backend', 'deployers', 'owner', 'parallel', 'pipeline'] },
  import: { description: 'Record a verified existing contract in local state.', options: ['spec', 'state', 'id', 'creation-tx', 'rebaseline'] },
  adapters: { description: 'Generate optional TypeScript artifact adapters.', options: ['spec', 'out'] },
  status: { description: 'Inspect a deployment in the production backend.', options: ['plan', 'backend'] },
};
const OPTION_HELP = {
  spec: 'Specification file, .json or .ethp (default: the only .ethp file or spec.json here)',
  value: 'Value name for impact',
  out: 'Output path',
  plan: 'Saved plan file',
  state: 'State file (default: .etherplan/state.json beside the spec)',
  journal: 'Journal file (default: journal.jsonl beside the state file)',
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
};
const VALUE_OPTIONS = new Set(['spec', 'value', 'out', 'plan', 'state', 'journal', 'backend', 'signer-module', 'id', 'creation-tx', 'deployers', 'owner', 'max-spend-wei', 'replace-max-fee-per-gas', 'replace-priority-fee-per-gas', 'replace-max-cost-wei']);
const BOOLEAN_OPTIONS = new Set(['parallel', 'pipeline', 'rebaseline']);
const SPEC_COMMANDS = Object.fromEntries(Object.entries(COMMANDS).filter(([, details]) => details.options.includes('spec')).map(([name, details]) => [name, details.options]));

class UsageError extends Error {}

function usage(command?: CommandName): string {
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

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!flag?.startsWith('--')) throw new UsageError(`Invalid option ${flag}.`);
    const name = flag.slice(2);
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

function validateOptions(command: CommandName, options: CliOptions): void {
  const allowed = new Set(COMMANDS[command].options);
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) throw new UsageError(`--${name} is not an option for ${command}.`);
  }
  if (command === 'impact' && !options.value) throw new UsageError('impact needs --value <name>.');
  if (command === 'import' && !/^contract:[a-z][a-zA-Z0-9_]*$/.test(options.id ?? '')) {
    throw new UsageError('import needs --id contract:<name>.');
  }
}

// Checks option combinations after .ethpconfig options are merged in.
function validateCombination(command: CommandName, options: CliOptions): void {
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

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function approvePlan(plan: Plan): Promise<void> {
  process.stderr.write(`Proposed plan:\n${JSON.stringify(plan, null, 2)}\n\n`);
  const blocked = plan.resources.filter(resource => !['reuse', 'deploy', 'call'].includes(resource.action));
  if (blocked.length) throw new Error(`Plan cannot be applied: ${blocked.map(resource => `${resource.id} (${resource.action})`).join(', ')}.`);
  process.stderr.write("Apply this plan? Only 'yes' will be accepted: ");
  const answer = await new Promise<string | null>(resolve => {
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    input.once('line', line => {
      resolve(line);
      input.close();
    });
    input.once('close', () => resolve(null));
  });
  if (answer !== 'yes') throw new Error('Apply cancelled; no transactions were signed.');
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
    const directoryHandle = await open(directory, 'r');
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function publicClient() {
  if (!process.env.ETH_RPC_URL) throw new Error('Set ETH_RPC_URL for plan, schedule, verify, import, or apply.');
  return createPublicClient({ transport: http(process.env.ETH_RPC_URL) });
}

function stateFileFor(specFile: string, options: CliOptions): string {
  return path.resolve(options.state ?? path.join(path.dirname(specFile), '.etherplan/state.json'));
}

function signersFromEnvironment(): Signers {
  const encoded = process.env.DEPLOYER_PRIVATE_KEYS ?? process.env.DEPLOYER_PRIVATE_KEY;
  if (!encoded) throw new Error('Set DEPLOYER_PRIVATE_KEYS to one or more comma-separated private keys for apply.');
  const keys = encoded.split(',').map(key => key.trim());
  if (!keys.every(isPrivateKey)) throw new Error('DEPLOYER_PRIVATE_KEYS contains an invalid private key.');
  const ownerKey = process.env.OWNER_PRIVATE_KEY;
  if (ownerKey && !isPrivateKey(ownerKey)) throw new Error('OWNER_PRIVATE_KEY is invalid.');
  return { deployer: keys.map(key => privateKeyToAccount(key as Hex)), ...(ownerKey ? { owner: privateKeyToAccount(ownerKey as Hex) } : {}) };
}

async function backendFromFile(file: string, chain: ChainIdentity, { requireBucket = false }: { requireBucket?: boolean } = {}): Promise<Backend> {
  const config = JSON.parse(await readFile(path.resolve(file), 'utf8')) as {
    kind: string; tableName: string; kmsKeyId: string; bucket?: string; prefix?: string;
    scope: unknown; ttlMs?: number; confirmations?: number;
  };
  if (config.kind !== 'aws') throw new Error('Backend config kind must be aws.');
  if (requireBucket && !config.bucket) throw new Error('AWS plan and apply need an immutable plan bucket in backend config.');
  const scope = deploymentScope(config.scope, chain);
  return { ...createAwsBackend({ tableName: config.tableName, kmsKeyId: config.kmsKeyId, ...(config.bucket ? { bucket: config.bucket } : {}), ...(config.prefix ? { prefix: config.prefix } : {}) }), scope,
    ...(config.ttlMs !== undefined ? { ttlMs: config.ttlMs } : {}), ...(config.confirmations !== undefined ? { confirmations: config.confirmations } : {}) };
}

async function signerFromModule(file: string): Promise<SignerModuleSource> {
  const module = await import(pathToFileURL(path.resolve(file)).href);
  const signerProvider = module.signerProvider ?? module.default;
  if (typeof signerProvider?.address !== 'function' || typeof signerProvider?.signTransaction !== 'function') throw new Error('Signer module must export signerProvider with address(role) and signTransaction(role, request).');
  return { signerProvider: signerProvider as SignerProvider, ...(module.signerRoles ? { signerRoles: module.signerRoles as SignerRoles } : {}) };
}

async function addressesFromModule(source: SignerModuleSource, needsOwner: boolean): Promise<{ deployers: Address[]; owner: Address | null }> {
  const roles = source.signerRoles ?? {};
  return {
    deployers: await Promise.all((roles.deployer ?? ['deployer']).map(role => source.signerProvider.address(role))),
    owner: needsOwner ? await source.signerProvider.address(roles.owner ?? 'owner') : null,
  };
}

async function importOne({ spec, ordered, artifacts, client, options, stateFile }: {
  spec: ParsedSpec; ordered: OrderedNode[]; artifacts: Artifacts; client: Client; options: CliOptions; stateFile: string;
}): Promise<void> {
  if (!options.id?.startsWith('contract:')) throw new Error('import needs --id contract:<name>.');
  const { resources } = prepareResources(spec, ordered, artifacts);
  const byId = new Map(resources.map(resource => [resource.id, resource]));
  const selected = byId.get(options.id as ResourceId);
  if (!selected || selected.kind !== 'contract') throw new Error(`Unknown contract resource ${options.id}.`);
  const lock = await acquireLock(`${stateFile}.lock`, { planHash: 'import' });
  try {
    const chainId = await client.getChainId();
    if (chainId !== spec.chainId) throw new Error(`Connected to chain ${chainId}; spec requires ${spec.chainId}.`);
    const genesis = await client.getBlock({ blockNumber: 0n });
    const observed = await client.getBlock({ blockTag: 'latest' });
    if (!genesis.hash || !observed.hash || observed.number === null) throw new Error('Chain block is missing its hash or number.');
    const chain: ChainIdentity = { id: chainId, genesisHash: genesis.hash };
    const current = await readState(stateFile);
    const checked = new Map<ResourceId, VerificationResult>();
    async function verifyDependency(id: ResourceId): Promise<VerificationResult> {
      const previous = checked.get(id);
      if (previous) return previous;
      const resource = byId.get(id);
      if (!resource) throw new Error(`Missing dependency ${id}.`);
      for (const dependency of resource.dependencies) await verifyDependency(dependency);
      const verification = await verifyResource(resource, client, {
        blockNumber: observed.number,
        chain,
        ...(current?.resources?.[id]?.creationProof ? { creationProof: current.resources[id].creationProof } : {}),
        ...(id === options.id && options['creation-tx'] ? { transactionHash: options['creation-tx'] } :
          current?.resources?.[id]?.provenance?.creationTransactionHash ? { transactionHash: current.resources[id].provenance.creationTransactionHash } : {}),
      });
      if (verification.status !== 'verified') throw new Error(`Cannot import ${options.id}: ${id} is ${verification.status}. ${[...verification.reasons ?? [], ...verification.missingProofs ?? []].join(' ')}`);
      checked.set(id, verification);
      return verification;
    }
    const verification = await verifyDependency(selected.id);
    if (options['creation-tx'] && verification.evidence?.creation?.status !== 'verified') {
      throw new Error(`Creation transaction ${options['creation-tx']} did not prove ${options.id}.`);
    }
    const anchor = await client.getBlock({ blockNumber: observed.number });
    if (anchor.hash !== observed.hash) throw new Error('The verification block changed before import. Retry on the current chain.');
    const state = importResource({ resource: selected, verification, state: current, chain, creationTransactionHash: options['creation-tx'] ?? null, rebaseline: options.rebaseline ?? false });
    await writeStateAtomic(stateFile, state);
    const record = state.resources[selected.id];
    if (!record) throw new Error(`Imported resource ${selected.id} is missing from state.`);
    const lastRevision = record.artifactRevisions?.at(-1);
    if (options.rebaseline && !lastRevision) throw new Error(`Rebaselined resource ${selected.id} has no artifact revision.`);
    print({
      status: options.rebaseline ? 'rebaselined' : 'imported', chain, id: selected.id, address: selected.address, codeHash: verification.codeHash, proofHash: record.proofHash,
      ...(options.rebaseline ? { artifactHash: record.artifactHash, previousArtifactHash: lastRevision?.artifactHash } : {}), stateFile,
    });
  } finally {
    await lock.release();
  }
}

async function run(command: CommandName, options: CliOptions): Promise<void> {
  if (options.rebaseline && command !== 'import') throw new Error('--rebaseline applies only to import.');
  if (command === 'status') {
    if (!options.backend) throw new Error('status needs --backend file.json.');
    const plan = JSON.parse(await readFile(path.resolve(options.plan ?? 'plan.json'), 'utf8')) as Plan;
    const { planHash, ...fields } = plan;
    if (hashJson(fields) !== planHash) throw new Error('Plan content does not match planHash.');
    const backend = await backendFromFile(options.backend, plan.chain);
    print(await inspectDeployment({ ...backend, chain: plan.chain, planHash: plan.planHash }));
    return;
  }
  const specFile = await findSpecFile(options.spec);
  const config = await loadConfig(specFile, SPEC_COMMANDS);
  const merged = withConfig(options, config, command, COMMANDS[command].options);
  if (merged.configured.length && config) process.stderr.write(`Using ${merged.configured.map(name => `--${name}`).join(', ')} from ${config.file}.\n`);
  options = merged.options as CliOptions;
  validateCombination(command, options);
  const spec = await loadSpec(specFile);
  const ordered = graph(spec);
  if (command === 'compile') {
    print(spec);
    return;
  }
  if (command === 'graph') {
    print(usesDependencyPlan(spec)
      ? { ...dependencyGraphs(ordered), warnings: dependencyWarnings(spec, ordered) }
      : ordered.map(node => ({ id: node.id, deps: node.dependencies })));
    return;
  }
  if (command === 'impact') {
    print(impact(spec, ordered, `values.${options.value}`));
    return;
  }

  const artifacts = await loadArtifacts(spec, specFile);
  if (command === 'validate') {
    const { resources } = prepareResources(spec, ordered, artifacts);
    print({ status: 'valid', resources: resources.map(resource => resource.id), ...(usesDependencyPlan(spec) ? { warnings: dependencyWarnings(spec, ordered) } : {}) });
    return;
  }
  if (command === 'adapters') {
    prepareResources(spec, ordered, artifacts);
    const output = path.resolve(options.out ?? 'generated');
    await generateAdapters(artifacts, output);
    print({ artifacts: [...artifacts.keys()], adapters: output });
    return;
  }

  const client = publicClient();
  const stateFile = stateFileFor(specFile, options);
  if (command === 'import') {
    if (options.backend) throw new Error('import with a production backend is not yet supported.');
    await importOne({ spec, ordered, artifacts, client, options, stateFile });
    return;
  }
  if (command === 'apply') {
    const replacementFlags = ['replace-max-fee-per-gas', 'replace-priority-fee-per-gas', 'replace-max-cost-wei'] as const;
    const replacementFees = replacementFlags.some(flag => options[flag] !== undefined) ? {
      maxFeePerGas: options['replace-max-fee-per-gas'], maxPriorityFeePerGas: options['replace-priority-fee-per-gas'],
      maxCostWei: options['replace-max-cost-wei'],
    } as ReplacementFees : undefined;
    if (!options.plan && options.pipeline) throw new Error('A pipeline apply needs an explicit saved plan with --plan.');
    if (options.backend && !options['signer-module']) throw new Error('AWS apply needs --signer-module file.mjs.');
    if (options.plan && options['max-spend-wei']) throw new Error('A saved plan already pins maxSpendWei; omit --max-spend-wei.');
    const signerSource: SignerSource = options['signer-module'] ? await signerFromModule(options['signer-module']) : { signers: signersFromEnvironment() };
    let plan: Plan;
    let planningBackend: Backend | undefined;
    if (options.plan) {
      plan = JSON.parse(await readFile(path.resolve(options.plan), 'utf8')) as Plan;
    } else {
      let state: StateFile | null;
      if (options.backend) {
        const chainId = await client.getChainId();
        const genesis = await client.getBlock({ blockNumber: 0n });
        planningBackend = await backendFromFile(options.backend, { id: chainId, genesisHash: genesis.hash }, { requireBucket: true });
        const stored = (await planningBackend.stateStore.read(planningBackend.scope))?.value;
        state = stored == null ? null : validateState(stored);
      } else state = await readState(stateFile);
      if (!options['max-spend-wei']) throw new Error('Fresh apply needs --max-spend-wei <amount>.');
      const addresses = signerSource.signerProvider ? await addressesFromModule(signerSource as SignerModuleSource, spec.calls.length > 0) : {
        deployers: signerSource.signers.deployer.map(account => account.address), owner: signerSource.signers.owner?.address ?? null,
      };
      plan = await createPlan({ spec, artifacts, client, state, signers: { ...addresses, parallel: options.parallel ?? false }, maxSpendWei: options['max-spend-wei'] });
      await approvePlan(plan);
      if (planningBackend?.planStore) {
        await planningBackend.planStore.put(planningBackend.scope, plan);
      } else {
        const recoveryPlanFile = path.join(path.dirname(stateFile), 'plans', `${plan.planHash}.json`);
        await writeJsonAtomic(recoveryPlanFile, plan);
        process.stderr.write(`Approved plan saved for recovery: ${recoveryPlanFile}\n`);
      }
    }
    if (options.backend) {
      const backend = planningBackend ?? await backendFromFile(options.backend, plan.chain, { requireBucket: true });
      if (backend.planStore) await backend.planStore.read(backend.scope, plan.planHash);
      print(await applyPlan({ plan, spec, artifacts, client, ...backend, ...signerSource, parallel: options.parallel ?? false, pipeline: options.pipeline ?? false, replacementFees }));
      return;
    }
    const journalFile = path.resolve(options.journal ?? path.join(path.dirname(stateFile), 'journal.jsonl'));
    print(await applyPlan({ plan, spec, artifacts, client, ...signerSource, stateFile, journalFile, parallel: options.parallel ?? false, pipeline: options.pipeline ?? false, replacementFees }));
    return;
  }
  let plan: Plan;
  let backend: Backend | undefined;
  if (command === 'schedule' && options.plan) {
    plan = JSON.parse(await readFile(path.resolve(options.plan), 'utf8')) as Plan;
    await checkPlanIdentity({ plan, spec, artifacts, client, deps: { parseSpec, graph, prepareResources, transactionFor } });
  } else {
    let state: StateFile | null;
    if (options.backend) {
      const chainId = await client.getChainId();
      const genesis = await client.getBlock({ blockNumber: 0n });
      backend = await backendFromFile(options.backend, { id: chainId, genesisHash: genesis.hash }, { requireBucket: command === 'plan' });
      const stored = (await backend.stateStore.read(backend.scope))?.value;
      state = stored == null ? null : validateState(stored);
    } else state = await readState(stateFile);
    const moduleAddresses = command === 'plan' && options['signer-module']
      ? await addressesFromModule(await signerFromModule(options['signer-module']), spec.calls.length > 0) : null;
    const deployers = moduleAddresses?.deployers ?? options.deployers?.split(',');
    const owner = moduleAddresses?.owner ?? options.owner ?? null;
    const pipeline = options.pipeline ? {
      deployers: deployers ?? [], owner, parallel: options.parallel ?? false,
    } : null;
    const signers = command === 'plan' && !pipeline && deployers ? {
      deployers, owner, parallel: options.parallel ?? false,
    } : null;
    plan = await createPlan({ spec, artifacts, client, state, pipeline, signers, maxSpendWei: command === 'plan' ? options['max-spend-wei'] ?? null : null });
  }
  if (command === 'plan') {
    if (plan.resources.some(resource => ['deploy', 'call'].includes(resource.action)) &&
      ((!options.deployers && !options['signer-module']) || !options['max-spend-wei'])) {
      throw new Error('A write plan needs --deployers <address,address> or --signer-module, and --max-spend-wei <amount>.');
    }
    if (backend?.planStore) await backend.planStore.put(backend.scope, plan);
    if (options.out !== '-') await writeJsonAtomic(path.resolve(options.out ?? 'plan.json'), plan);
    print(plan);
    if (plan.resources.some(resource => resource.action === 'conflict' || resource.action === 'unverified')) process.exitCode = 1;
    return;
  }
  if (command === 'verify') {
    const resources = plan.resources.map(resource => Object.assign({ id: resource.id, kind: resource.kind, address: resource.address, action: resource.action }, resource.observation));
    const status = resources.every(resource => resource.status === 'verified' && resource.action === 'reuse') ? 'verified'
      : resources.some(resource => resource.status === 'conflict' || resource.action === 'conflict') ? 'conflict' : 'unverified';
    print({ formatVersion: 1, chain: plan.chain, observed: plan.observed, status, resources });
    if (status !== 'verified') process.exitCode = 1;
    return;
  }
  const blocked = plan.resources.filter(resource => !['reuse', 'deploy', 'call'].includes(resource.action));
  if (options.plan && blocked.length) {
    print({ chain: plan.chain, observed: plan.observed, applicable: false, snapshot: 'plan-observed',
      resources: plan.resources.map(({ id, kind, address, action, observation }) => ({ id, kind, address, action, observation })) });
    return;
  }
  const pinned = plan.pipeline ?? plan.signers;
  const deployers = options.deployers?.split(',') ?? pinned?.deployers;
  if (!deployers) throw new Error('schedule needs --deployers <address,address>.');
  if (plan.pipeline && options.parallel && !plan.pipeline.parallel) throw new Error('The saved pipeline plan pins serial scheduling; omit --parallel.');
  if (pinned && (hashJson(deployers.map(address => address.toLowerCase())) !== hashJson(pinned.deployers) ||
    (options.owner?.toLowerCase() ?? pinned.owner) !== pinned.owner || (options.parallel ?? pinned.parallel) !== pinned.parallel)) {
    throw new Error('The requested signers or parallel setting differ from the saved plan.');
  }
  const schedule = createSchedule(plan, deployers, { owner: options.owner ?? pinned?.owner ?? null, parallel: options.parallel ?? pinned?.parallel ?? false, pipeline: options.pipeline ?? Boolean(plan.pipeline) });
  if (plan.pipeline && hashJson(schedule.waves) !== hashJson(plan.pipeline.waves)) throw new Error('The requested schedule differs from the saved pipeline plan.');
  const funding = await Promise.all(deployers.map(async address => ({ address, balanceWei: (await client.getBalance({ address: address as Address })).toString() })));
  if (funding.some(account => account.balanceWei === '0')) throw new Error('Every supplied deployer must have a nonzero native-token balance.');
  const requested = new Map(deployers.map(address => [address.toLowerCase(), address]));
  const waves = schedule.waves.map(wave => ({ ...wave, batches: wave.batches.map(batch => batch.map(entry => ({
    ...entry,
    ...(entry.kind === 'contract' ? { deployer: requested.get(entry.signer) ?? entry.signer } : {}),
  }))) }));
  print({ chain: plan.chain, observed: plan.observed, applicable: true, snapshot: 'plan-observed', deployers: funding, ...schedule, waves });
}

const [command, ...args] = process.argv.slice(2);
if (command === '--version' || command === '-V' || command === 'version') {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
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
