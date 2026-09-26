import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createAwsBackend } from '../execution/aws.ts';
import { deploymentScope } from '../execution/backends.ts';
import type { AwsBackend, DeploymentScope, SignerProvider, SignerRoles, Signers } from '../execution/types.ts';
import type { Address, ChainIdentity, Client, Hex } from '../types.ts';
import type { CliOptions } from './options.ts';

export type SignerModuleSource = { signerProvider: SignerProvider; signerRoles?: SignerRoles; signers?: never };
export type LocalSignerSource = { signers: Signers; signerProvider?: never; signerRoles?: never };
export type SignerSource = SignerModuleSource | LocalSignerSource;
export type Backend = AwsBackend & { scope: DeploymentScope; ttlMs?: number; confirmations?: number };
function isPrivateKey(value: string): value is Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}
export function publicClient(): Client {
  if (!process.env.ETH_RPC_URL) throw new Error('Set ETH_RPC_URL for plan, schedule, verify, import, or apply.');
  return createPublicClient({ transport: http(process.env.ETH_RPC_URL) });
}

export function stateFileFor(specFile: string, options: CliOptions): string {
  return path.resolve(options.state ?? path.join(path.dirname(specFile), '.etherplan/state.json'));
}

export function signersFromEnvironment(): Signers {
  const encoded = process.env.DEPLOYER_PRIVATE_KEYS ?? process.env.DEPLOYER_PRIVATE_KEY;
  if (!encoded) throw new Error('Set DEPLOYER_PRIVATE_KEYS to one or more comma-separated private keys for apply.');
  const keys = encoded.split(',').map(key => key.trim());
  if (!keys.every(isPrivateKey)) throw new Error('DEPLOYER_PRIVATE_KEYS contains an invalid private key.');
  const ownerKey = process.env.OWNER_PRIVATE_KEY;
  if (ownerKey && !isPrivateKey(ownerKey)) throw new Error('OWNER_PRIVATE_KEY is invalid.');
  return { deployer: keys.map(key => privateKeyToAccount(key as Hex)), ...(ownerKey ? { owner: privateKeyToAccount(ownerKey as Hex) } : {}) };
}

export async function backendFromFile(file: string, chain: ChainIdentity, { requireBucket = false }: { requireBucket?: boolean } = {}): Promise<Backend> {
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

export async function signerFromModule(file: string): Promise<SignerModuleSource> {
  const module = await import(pathToFileURL(path.resolve(file)).href);
  const signerProvider = module.signerProvider ?? module.default;
  if (typeof signerProvider?.address !== 'function' || typeof signerProvider?.signTransaction !== 'function') throw new Error('Signer module must export signerProvider with address(role) and signTransaction(role, request).');
  return { signerProvider: signerProvider as SignerProvider, ...(module.signerRoles ? { signerRoles: module.signerRoles as SignerRoles } : {}) };
}

export async function addressesFromModule(source: SignerModuleSource, needsOwner: boolean): Promise<{ deployers: Address[]; owner: Address | null }> {
  const roles = source.signerRoles ?? {};
  return {
    deployers: await Promise.all((roles.deployer ?? ['deployer']).map(role => source.signerProvider.address(role))),
    owner: needsOwner ? await source.signerProvider.address(roles.owner ?? 'owner') : null,
  };
}
