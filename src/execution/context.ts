import { isUserAddress } from '../address.ts';
import { validateState } from '../state/index.ts';
import { loadDependencies } from './dependencies.ts';
import { acquireLocalApplyLocks } from './lock.ts';
import { acquireLeases, deploymentScope, openStoredJournal } from './backends.ts';
import { openJournal } from './journal.ts';
import { ApplyError } from './errors.ts';
import { safeExternalError } from './rpc-error.ts';
import { roleOf } from './shared.ts';
import type { Plan } from '../planning/types.ts';
import type { Artifacts } from '../artifacts/types.ts';
import type { Schedule } from '../scheduling/types.ts';
import type { StateFile } from '../state/types.ts';
import type { Address, Client, Hash, ResourceId } from '../types.ts';
import type { ApplyConfig, ApplyDependencies, ApplyInput, ApplyTimings, DeploymentScope, Journal, JournalStore, Lock, PreparedAction, ReportEvent, ResourceOutcome, SentTransaction, SignerAccount, SignerAuthorization, SignerLanes, SignerProvider, SignerRoles, Signers, StateWriteResult } from './types.ts';

/** Initialized once after the lock and journal are open; run fills the preflight fields. */
export interface ApplyContext {
  plan: Plan;
  spec: unknown;
  artifacts: Artifacts;
  client: Client;
  verificationClient: Client | null;
  lanes: SignerLanes;
  deps: ApplyDependencies;
  journal: Journal;
  journalStore: JournalStore | undefined;
  lock: Lock;
  config: ApplyConfig;
  scope: DeploymentScope | null;
  remote: boolean;
  principal: string | undefined;
  readState(): Promise<{ version: unknown; value: StateFile | null }>;
  writeState(version: unknown, state: StateFile): Promise<unknown>;
  stateFile: string | null;
  parallel: boolean;
  pipeline: boolean;
  sent: SentTransaction[];
  rebroadcasts: { actionId: ResourceId; transactionHash: Hash }[];
  outcomes: Map<ResourceId, ResourceOutcome>;
  timings: ApplyTimings;
  state: StateWriteResult;
  prepared: Map<ResourceId, PreparedAction>;
  stateSnapshot: StateFile | null;
  schedule: Schedule | null;
}

const DEFAULTS = { pollIntervalMs: 250, receiptTimeoutMs: 120_000, verificationTimeoutMs: 300_000, gasMultiplier: 1.2, fees: null, budgets: {}, hooks: {}, dependencies: {} };

function lanesFrom(signers: Signers | undefined, parallel: boolean): SignerLanes {
  if (!signers || !Array.isArray(signers.deployer) || signers.deployer.length === 0) throw new ApplyError('signer', 'Apply needs signers.deployer with at least one account.');
  const accounts = [...signers.deployer, ...(signers.owner ? [signers.owner] : [])];
  for (const account of accounts) {
    if (!isUserAddress(account?.address ?? '') || typeof account.signTransaction !== 'function') throw new ApplyError('signer', 'Every signer needs an address with a valid mixed-case checksum and signTransaction(request).');
  }
  const deployers = signers.deployer.map(account => account.address.toLowerCase());
  if (new Set(deployers).size !== deployers.length) throw new ApplyError('signer', 'Deployer accounts must be distinct.');
  const byAddress = new Map(accounts.map((account): [string, SignerAccount] => [account.address.toLowerCase(), account]));
  return { pool: parallel ? signers.deployer : [signers.deployer[0]!], owner: signers.owner ?? null, byAddress };
}

async function signersFromProvider(provider: SignerProvider, roles: SignerRoles | undefined, plan: Plan, control: SignerAuthorization & { assertHeld: (() => Promise<void>) | null }): Promise<Signers> {
  if (typeof provider?.address !== 'function' || typeof provider?.signTransaction !== 'function') throw new ApplyError('signer', 'Signer provider needs address(role) and signTransaction(role, request).');
  const deployerRoles = roles?.deployer ?? ['deployer'];
  if (!Array.isArray(deployerRoles) || deployerRoles.length === 0 || deployerRoles.some(role => typeof role !== 'string')) throw new ApplyError('signer', 'signerRoles.deployer must be a nonempty role list.');
  const account = async (role: string): Promise<SignerAccount> => {
    let address: Address;
    try { address = await provider.address(role); }
    catch (error) { throw new ApplyError('signer', safeExternalError(error)); }
    return { address, async signTransaction(request) {
      await control.assertHeld?.();
      return provider.signTransaction(role, request, { scope: control.scope, fence: control.fence });
    } };
  };
  const deployer = await Promise.all(deployerRoles.map(account));
  const needsOwner = plan?.resources?.some(resource => ['deploy', 'call'].includes(resource.action) && roleOf(resource) === 'owner');
  return { deployer, ...(needsOwner ? { owner: await account(roles?.owner ?? 'owner') } : {}) };
}

/** Owns the acquired lock and open journal until close is called. */
export interface OpenedApplyContext {
  ctx: ApplyContext;
  lockStarted: number;
  close(): Promise<void>;
}

export async function openApplyContext({ plan, spec, artifacts, client, verificationClient, signers, signerProvider, signerRoles, stateStore, journalStore, lockProvider, journalCipher, scope: scopeInput, principal, ttlMs, stateFile, journalFile, parallel = false, pipeline = false, ...options }: ApplyInput): Promise<OpenedApplyContext> {
  for (const name of ['receiptTimeoutMs', 'verificationTimeoutMs'] as const) {
    const value = options[name];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new ApplyError('config', `${name} must be a non-negative integer in milliseconds.`);
    }
  }
  if (options.gasMultiplier !== undefined && (!Number.isFinite(options.gasMultiplier) || options.gasMultiplier < 1)) {
    throw new ApplyError('config', 'gasMultiplier must be a number no less than 1.');
  }
  if (options.fees) {
    const wei = (value: unknown) => /^[0-9]+$/.test(String(value)) && (typeof value !== 'number' || Number.isSafeInteger(value)) ? BigInt(value as string) : null;
    const maxFee = wei(options.fees.maxFeePerGas);
    const priorityFee = wei(options.fees.maxPriorityFeePerGas);
    if (maxFee === null || priorityFee === null || maxFee === 0n || priorityFee > maxFee) {
      throw new ApplyError('config', 'fees needs a positive maxFeePerGas and a maxPriorityFeePerGas no greater than it, as wei integers.');
    }
  }
  if (pipeline && plan?.pipeline) parallel = plan.pipeline.parallel;
  if (options.replacementFees !== undefined && (!options.replacementFees ||
    (['maxFeePerGas', 'maxPriorityFeePerGas', 'maxCostWei'] as const).some(field => !/^[0-9]+$/.test(String(options.replacementFees?.[field] ?? ''))))) {
    throw new ApplyError('config', 'replacementFees needs maxFeePerGas, maxPriorityFeePerGas, and maxCostWei as non-negative wei integers.');
  }
  const config: ApplyConfig = { ...DEFAULTS, ...options, confirmations: options.confirmations ?? 1,
    verificationTimeoutMs: options.verificationTimeoutMs ?? DEFAULTS.verificationTimeoutMs,
    hooks: { ...options.hooks }, budgets: Object.fromEntries(Object.entries(options.budgets ?? {}).map(([address, wei]) => [address.toLowerCase(), wei])) };
  const remote = Boolean(stateStore || journalStore || lockProvider || journalCipher || scopeInput);
  if (remote && (!stateStore || !journalStore || !lockProvider || !journalCipher || !scopeInput)) throw new ApplyError('config', 'Production apply needs stateStore, journalStore, lockProvider, journalCipher, and scope together.');
  if (remote && typeof journalStore?.signedForSigner !== 'function') throw new ApplyError('config', 'Production journalStore needs signedForSigner(scope, address).');
  if (remote && options.confirmations === undefined) throw new ApplyError('config', 'Production apply needs an explicit confirmations policy.');
  if (!Number.isSafeInteger(config.confirmations) || config.confirmations < 1) throw new ApplyError('config', 'Confirmations must be a positive integer.');
  if (!remote && (typeof stateFile !== 'string' || typeof journalFile !== 'string')) throw new ApplyError('config', 'Apply needs stateFile and journalFile paths.');
  const backend = remote ? { stateStore: stateStore!, journalStore: journalStore!, lockProvider: lockProvider!, journalCipher: journalCipher!, scope: deploymentScope(scopeInput, plan.chain) } : null;
  const scope = backend?.scope ?? null;
  const signerControl: SignerAuthorization & { assertHeld: (() => Promise<void>) | null } = { scope, fence: null, assertHeld: null };
  const lanes = lanesFrom(signerProvider ? await signersFromProvider(signerProvider, signerRoles, plan, signerControl) : signers, parallel);
  const deps = loadDependencies(config.dependencies);
  const lockStarted = Date.now();
  const emitLeaseEvent = (event: ReportEvent) => typeof config.reporter === 'function' ? config.reporter(event) : config.reporter?.emit(event);
  const localLocks = backend ? null : await acquireLocalApplyLocks(stateFile!, journalFile!, typeof plan.planHash === 'string' ? plan.planHash : null,
    plan.chain, [...lanes.byAddress.keys()] as Address[]);
  const lock = backend
    ? await acquireLeases({ lockProvider: backend.lockProvider, scope: backend.scope, addresses: [...lanes.byAddress.keys()] as Address[], planHash: plan.planHash, principal, ttlMs,
      onRenew: event => emitLeaseEvent({ type: 'lock-renewal', at: new Date().toISOString(), planHash: plan.planHash, chain: plan.chain, scope: backend.scope, principal: event.holder.principal }),
      onRenewFailure: event => emitLeaseEvent({ type: 'lock-renewal-failure', at: new Date().toISOString(), planHash: plan.planHash, chain: plan.chain, scope: backend.scope, principal: event.holder.principal, reason: safeExternalError(event.error) }),
    })
    : localLocks!.lock;
  const fence = 'fence' in lock ? lock.fence : null;
  signerControl.fence = fence;
  signerControl.assertHeld = () => lock.assertHeld();
  let journal: ApplyContext['journal'] | undefined;
  const close = async (): Promise<void> => {
    try { await journal?.close(); }
    finally { await lock.release(); }
  };
  try {
    journal = backend ? await openStoredJournal({ journalStore: backend.journalStore, journalCipher: backend.journalCipher, scope: backend.scope, fence, assertHeld: () => lock.assertHeld() }) : await openJournal(journalFile!, { writerLock: localLocks!.journalLock });
    const readState: ApplyContext['readState'] = backend
      ? async () => { const found = await backend.stateStore.read(backend.scope); return { version: found?.version ?? null, value: found ? validateState(found.value) : null }; }
      : async () => ({ version: null, value: await deps.readState(stateFile!) });
    const writeState: ApplyContext['writeState'] = backend
      ? (version, state) => backend.stateStore.compareAndSwap(backend.scope, version, validateState(state), { fence })
      : (_version, state) => deps.writeStateAtomic(stateFile!, state);
    const ctx: ApplyContext = { plan, spec, artifacts, client, verificationClient: verificationClient ?? null, lanes, deps, journal, journalStore: backend?.journalStore, lock, config, scope, remote,
      principal: 'principal' in lock.holder ? lock.holder.principal : principal, readState, writeState, stateFile: stateFile ?? null, parallel, pipeline,
      sent: [], rebroadcasts: [], outcomes: new Map<ResourceId, ResourceOutcome>(), timings: { submitMs: 0, receiptMs: 0, verificationMs: 0 },
      state: { file: stateFile ?? null, written: false }, prepared: new Map<ResourceId, PreparedAction>(), stateSnapshot: null, schedule: null };
    return {
      ctx,
      lockStarted,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
