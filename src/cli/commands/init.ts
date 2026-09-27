import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { initializeAwsBackend } from '../../execution/aws-init.ts';
import { deploymentScope } from '../../execution/backends.ts';
import { DEFAULT_WORKSPACE } from '../../input/project.ts';
import type { ParsedSpec } from '../../spec/types.ts';
import type { ChainIdentity, Client } from '../../types.ts';
import { awsBackendConfigHash, readAwsBackendConfig } from '../environment.ts';
import type { CliOptions } from '../options.ts';
import { defaultJournalFile, print, writeJsonAtomic } from '../shared.ts';

async function exists(file: string): Promise<boolean> {
  try { await stat(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function localRecoveryFiles(stateFile: string, journalFile: string): Promise<string[]> {
  const paths = [stateFile, journalFile];
  const planDirectory = path.join(path.dirname(stateFile), 'plans');
  const found = (await Promise.all(paths.map(async file => await exists(file) ? file : null))).filter((file): file is string => file !== null);
  try {
    if ((await readdir(planDirectory)).length > 0) found.push(planDirectory);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return found;
}

export async function init({ options, specFile, spec, client, stateFile, workspace = DEFAULT_WORKSPACE, initialize = initializeAwsBackend, report = print }: {
  options: CliOptions; specFile: string; spec: ParsedSpec; client: Client; stateFile: string; workspace?: string;
  initialize?: typeof initializeAwsBackend; report?: typeof print;
}): Promise<void> {
  if (!options.backend) throw new Error('init needs --backend backend.json or backend in main.ethpconfig.');
  const projectDirectory = path.dirname(specFile);
  const markerFile = path.join(projectDirectory, '.etherplan', workspace, 'backend-init.json');
  const journalFile = path.resolve(options.journal ?? defaultJournalFile(stateFile));
  const local = await localRecoveryFiles(stateFile, journalFile);
  if (local.length) throw new Error(`Local recovery files exist: ${local.join(', ')}. Migrate them before initializing AWS state; init will not bypass them.`);

  const config = await readAwsBackendConfig(options.backend);
  if (!config.bucket) throw new Error('AWS init needs bucket in backend config for the plan archive.');
  if (!Number.isSafeInteger(config.confirmations) || (config.confirmations ?? 0) < 1) throw new Error('AWS init needs positive confirmations in backend config.');
  if (config.ttlMs !== undefined && (!Number.isSafeInteger(config.ttlMs) || config.ttlMs < 3_000)) throw new Error('AWS init ttlMs must be at least 3000.');
  const chainId = await client.getChainId();
  if (chainId !== spec.chainId) throw new Error(`Connected to chain ${chainId}; spec requires ${spec.chainId}.`);
  const genesis = await client.getBlock({ blockNumber: 0n });
  if (!genesis.hash) throw new Error('Genesis block has no hash.');
  const chain: ChainIdentity = { id: chainId, genesisHash: genesis.hash };
  const scope = deploymentScope(config.scope, chain);
  const configHash = awsBackendConfigHash(config, scope);
  let previous: { formatVersion?: number; configHash?: string; identity?: { tableArn: string; kmsKeyArn: string; bucketRegion: string } } | null = null;
  try { previous = JSON.parse(await readFile(markerFile, 'utf8')) as { formatVersion?: number; configHash?: string; identity?: { tableArn: string; kmsKeyArn: string; bucketRegion: string } }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (previous && (previous.formatVersion !== 1 || previous.configHash !== configHash || !previous.identity) && !options.reconfigure) {
    throw new Error('Backend configuration changed. Review the target and rerun init --reconfigure.');
  }
  const result = await initialize({ tableName: config.tableName, kmsKeyId: config.kmsKeyId, bucket: config.bucket, scope,
    ...(previous && !options.reconfigure && previous.identity ? { expectedIdentity: previous.identity } : {}) });
  await writeJsonAtomic(markerFile, { formatVersion: 1, configHash, chain, scope, identity: result.identity });
  report({ status: result.status, backend: 'aws', scope, tableName: config.tableName, bucket: config.bucket,
    identity: result.identity, resources: Object.keys(result.state.resources).length, markerFile });
}
