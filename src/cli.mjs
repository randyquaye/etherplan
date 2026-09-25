#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { generateAdapters, loadArtifacts } from './artifacts.mjs';
import { applyPlan, acquireLock } from './execution/index.mjs';
import { createAwsBackend } from './execution/aws.mjs';
import { deploymentScope, inspectDeployment } from './execution/backends.mjs';
import { hashJson } from './identity.mjs';
import { createPlan, prepareResources } from './planning/index.mjs';
import { createSchedule } from './scheduling/index.mjs';
import { dependencyGraphs, dependencyWarnings, graph, impact, parseSpec, usesDependencyPlan } from './spec/index.mjs';
import { importResource, readState, writeStateAtomic } from './state/index.mjs';
import { verifyResource } from './verification/index.mjs';

const USAGE = 'Usage: etherplan <adapters|graph|impact|validate|plan|schedule|verify|import|apply|status> [--spec file.json] [--value name] [--out path] [--plan file] [--state file] [--journal file] [--backend file.json] [--signer-module file.mjs] [--id contract:name] [--creation-tx hash] [--deployers address,address] [--owner address] [--parallel] [--pipeline] [--rebaseline]';
const OPTIONS = new Set(['spec', 'value', 'out', 'plan', 'state', 'journal', 'backend', 'signer-module', 'id', 'creation-tx', 'deployers', 'owner']);

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--parallel' || flag === '--pipeline' || flag === '--rebaseline') {
      const name = flag.slice(2);
      if (options[name]) throw new Error(`Duplicate option ${flag}.`);
      options[name] = true;
      continue;
    }
    const value = args[++index];
    if (!flag?.startsWith('--') || !OPTIONS.has(flag.slice(2)) || !value || value.startsWith('--')) {
      throw new Error(`Invalid option ${flag ?? '<missing>'}.\n${USAGE}`);
    }
    const name = flag.slice(2);
    if (Object.hasOwn(options, name)) throw new Error(`Duplicate option ${flag}.`);
    options[name] = value;
  }
  return options;
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function writeJsonAtomic(file, value) {
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

function stateFileFor(specFile, options) {
  return path.resolve(options.state ?? path.join(path.dirname(specFile), '.etherplan/state.json'));
}

function signersFromEnvironment() {
  const encoded = process.env.DEPLOYER_PRIVATE_KEYS ?? process.env.DEPLOYER_PRIVATE_KEY;
  if (!encoded) throw new Error('Set DEPLOYER_PRIVATE_KEYS to one or more comma-separated private keys for apply.');
  const keys = encoded.split(',').map(key => key.trim());
  if (!keys.every(key => /^0x[0-9a-fA-F]{64}$/.test(key))) throw new Error('DEPLOYER_PRIVATE_KEYS contains an invalid private key.');
  const ownerKey = process.env.OWNER_PRIVATE_KEY;
  if (ownerKey && !/^0x[0-9a-fA-F]{64}$/.test(ownerKey)) throw new Error('OWNER_PRIVATE_KEY is invalid.');
  return { deployer: keys.map(key => privateKeyToAccount(key)), ...(ownerKey ? { owner: privateKeyToAccount(ownerKey) } : {}) };
}

async function backendFromFile(file, chain, { requireBucket = false } = {}) {
  const config = JSON.parse(await readFile(path.resolve(file), 'utf8'));
  if (config.kind !== 'aws') throw new Error('Backend config kind must be aws.');
  if (requireBucket && !config.bucket) throw new Error('AWS plan and apply need an immutable plan bucket in backend config.');
  const scope = deploymentScope(config.scope, chain);
  return { ...createAwsBackend({ tableName: config.tableName, kmsKeyId: config.kmsKeyId, bucket: config.bucket, prefix: config.prefix }), scope, ttlMs: config.ttlMs };
}

async function signerFromModule(file) {
  const module = await import(pathToFileURL(path.resolve(file)).href);
  const signerProvider = module.signerProvider ?? module.default;
  if (typeof signerProvider?.address !== 'function' || typeof signerProvider?.signTransaction !== 'function') throw new Error('Signer module must export signerProvider with address(role) and signTransaction(role, request).');
  return { signerProvider, signerRoles: module.signerRoles };
}

async function importOne({ spec, ordered, artifacts, client, options, stateFile }) {
  if (!options.id?.startsWith('contract:')) throw new Error('import needs --id contract:<name>.');
  const { resources } = prepareResources(spec, ordered, artifacts);
  const byId = new Map(resources.map(resource => [resource.id, resource]));
  const selected = byId.get(options.id);
  if (!selected || selected.kind !== 'contract') throw new Error(`Unknown contract resource ${options.id}.`);
  const lock = await acquireLock(`${stateFile}.lock`, { planHash: 'import' });
  try {
    const chainId = await client.getChainId();
    if (chainId !== spec.chainId) throw new Error(`Connected to chain ${chainId}; spec requires ${spec.chainId}.`);
    const genesis = await client.getBlock({ blockNumber: 0n });
    const observed = await client.getBlock({ blockTag: 'latest' });
    const chain = { id: chainId, genesisHash: genesis.hash };
    const current = await readState(stateFile);
    // A rebaseline can reuse the recorded creation transaction as immutable proof for the new artifact.
    const creationTransaction = options['creation-tx'] ??
      (options.rebaseline ? current?.resources?.[options.id]?.provenance?.creationTransactionHash : null) ?? null;
    const checked = new Map();
    async function verifyDependency(id) {
      if (checked.has(id)) return checked.get(id);
      const resource = byId.get(id);
      if (!resource) throw new Error(`Missing dependency ${id}.`);
      for (const dependency of resource.dependencies) await verifyDependency(dependency);
      const verification = await verifyResource(resource, client, {
        blockNumber: observed.number,
        ...(id === options.id && creationTransaction ? { transactionHash: creationTransaction } : {}),
      });
      if (verification.status !== 'verified') throw new Error(`Cannot import ${options.id}: ${id} is ${verification.status}. ${[...verification.reasons ?? [], ...verification.missingProofs ?? []].join(' ')}`);
      checked.set(id, verification);
      return verification;
    }
    const verification = await verifyDependency(options.id);
    if (options['creation-tx'] && verification.evidence?.creation?.status !== 'verified') {
      throw new Error(`Creation transaction ${options['creation-tx']} did not prove ${options.id}.`);
    }
    const anchor = await client.getBlock({ blockNumber: observed.number });
    if (anchor.hash !== observed.hash) throw new Error('The verification block changed before import. Retry on the current chain.');
    const state = importResource({ resource: selected, verification, state: current, chain, creationTransactionHash: options['creation-tx'] ?? null, rebaseline: options.rebaseline ?? false });
    await writeStateAtomic(stateFile, state);
    const record = state.resources[selected.id];
    print({
      status: options.rebaseline ? 'rebaselined' : 'imported', chain, id: selected.id, address: selected.address, codeHash: verification.codeHash, proofHash: record.proofHash,
      ...(options.rebaseline ? { artifactHash: record.artifactHash, previousArtifactHash: record.artifactRevisions.at(-1).artifactHash } : {}), stateFile,
    });
  } finally {
    await lock.release();
  }
}

async function run(command, options) {
  if (options.rebaseline && command !== 'import') throw new Error('--rebaseline applies only to import.');
  if (command === 'status') {
    if (!options.backend) throw new Error('status needs --backend file.json.');
    const plan = JSON.parse(await readFile(path.resolve(options.plan ?? 'plan.json'), 'utf8'));
    const { planHash, ...fields } = plan;
    if (hashJson(fields) !== planHash) throw new Error('Plan content does not match planHash.');
    const backend = await backendFromFile(options.backend, plan.chain);
    print(await inspectDeployment({ ...backend, chain: plan.chain, planHash: plan.planHash }));
    return;
  }
  const specFile = path.resolve(options.spec ?? 'spec.json');
  const spec = parseSpec(JSON.parse(await readFile(specFile, 'utf8')));
  const ordered = graph(spec);
  if (command === 'graph') {
    print(usesDependencyPlan(spec)
      ? { ...dependencyGraphs(ordered), warnings: dependencyWarnings(spec, ordered) }
      : ordered.map(node => ({ id: node.id, deps: node.dependencies })));
    return;
  }
  if (command === 'impact') {
    if (!options.value) throw new Error('impact needs --value <name>.');
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
    const plan = JSON.parse(await readFile(path.resolve(options.plan ?? 'plan.json'), 'utf8'));
    if (options.backend) {
      if (!options['signer-module']) throw new Error('AWS apply needs --signer-module file.mjs.');
      const backend = await backendFromFile(options.backend, plan.chain, { requireBucket: true });
      if (backend.planStore) await backend.planStore.read(backend.scope, plan.planHash);
      print(await applyPlan({ plan, spec, artifacts, client, ...backend, ...await signerFromModule(options['signer-module']), parallel: options.parallel ?? false, pipeline: options.pipeline ?? false }));
      return;
    }
    const journalFile = path.resolve(options.journal ?? path.join(path.dirname(stateFile), 'journal.jsonl'));
    print(await applyPlan({ plan, spec, artifacts, client, signers: signersFromEnvironment(), stateFile, journalFile, parallel: options.parallel ?? false, pipeline: options.pipeline ?? false }));
    return;
  }
  let state;
  let backend;
  if (options.backend) {
    const chainId = await client.getChainId();
    const genesis = await client.getBlock({ blockNumber: 0n });
    backend = await backendFromFile(options.backend, { id: chainId, genesisHash: genesis.hash }, { requireBucket: command === 'plan' });
    state = (await backend.stateStore.read(backend.scope))?.value ?? null;
  } else state = await readState(stateFile);
  const pipeline = options.pipeline ? {
    deployers: options.deployers?.split(',') ?? [], owner: options.owner ?? null, parallel: options.parallel ?? false,
  } : null;
  const plan = command === 'schedule' && options.plan
    ? JSON.parse(await readFile(path.resolve(options.plan), 'utf8'))
    : await createPlan({ spec, artifacts, client, state, pipeline });
  if (command === 'schedule' && options.plan) {
    const { planHash, ...fields } = plan;
    if (hashJson(fields) !== planHash) throw new Error('Saved plan content does not match its planHash.');
  }
  if (command === 'plan') {
    if (backend?.planStore) await backend.planStore.put(backend.scope, plan);
    if (options.out) await writeJsonAtomic(path.resolve(options.out), plan);
    print(plan);
    if (plan.resources.some(resource => resource.action === 'conflict' || resource.action === 'unverified')) process.exitCode = 1;
    return;
  }
  if (command === 'verify') {
    const resources = plan.resources.map(resource => ({ id: resource.id, kind: resource.kind, address: resource.address, action: resource.action, ...resource.observation }));
    const status = resources.every(resource => resource.status === 'verified' && resource.action === 'reuse') ? 'verified'
      : resources.some(resource => resource.status === 'conflict' || resource.action === 'conflict') ? 'conflict' : 'unverified';
    print({ formatVersion: 1, chain: plan.chain, observed: plan.observed, status, resources });
    if (status !== 'verified') process.exitCode = 1;
    return;
  }
  const deployers = options.deployers?.split(',') ?? plan.pipeline?.deployers;
  if (!deployers) throw new Error('schedule needs --deployers <address,address>.');
  const schedule = createSchedule(plan, deployers, { owner: options.owner ?? plan.pipeline?.owner ?? null, parallel: options.parallel ?? plan.pipeline?.parallel ?? true, pipeline: options.pipeline ?? Boolean(plan.pipeline) });
  if (plan.pipeline && hashJson(schedule.waves) !== hashJson(plan.pipeline.waves)) throw new Error('The requested schedule differs from the saved pipeline plan.');
  const funding = await Promise.all(deployers.map(async address => ({ address, balanceWei: (await client.getBalance({ address })).toString() })));
  if (funding.some(account => account.balanceWei === '0')) throw new Error('Every supplied deployer must have a nonzero native-token balance.');
  const requested = new Map(deployers.map(address => [address.toLowerCase(), address]));
  const waves = schedule.waves.map(wave => ({ ...wave, batches: wave.batches.map(batch => batch.map(entry => ({
    ...entry,
    ...(entry.kind === 'contract' ? { deployer: requested.get(entry.signer) ?? entry.signer } : {}),
  }))) }));
  print({ chain: plan.chain, observed: plan.observed, deployers: funding, ...schedule, waves });
}

const [command, ...args] = process.argv.slice(2);
if (!['adapters', 'graph', 'impact', 'validate', 'plan', 'schedule', 'verify', 'import', 'apply', 'status'].includes(command)) {
  console.error(USAGE);
  process.exitCode = 2;
} else {
  try {
    await run(command, parseOptions(args));
  } catch (error) {
    if (error.result) print(error.result);
    console.error(`${error.code ? `${error.code}: ` : ''}${error.message}`);
    process.exitCode = 1;
  }
}
