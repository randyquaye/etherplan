import { isUserAddress } from '../address.ts';
import type { Address, ResourceId } from '../types.ts';
import type { ExecutionWaves, Lane, LaneRole, SchedulableResource, Schedule, ScheduleEntry, ScheduleLane, ScheduleOptions, SchedulePlan, ScheduleWave, SignerGroup } from './types.ts';

// Factories whose runtime lets any account deploy, so the paying account cannot change the result.
export const PERMISSIONLESS_FACTORY_CODE_HASHES = new Set([
  '0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989',
]);
const APPLICABLE = new Set(['reuse', 'deploy', 'call', 'recover']);
const OWNER_LANE = 'owner';

/** An action with its lane and plan position, before a batch assigns its signer. */
type PendingAction = Omit<ScheduleEntry, 'signer' | 'nonceOffset'> & { lane: Lane; order: number };

/** A pending action placed in a batch. */
type PlacedAction = PendingAction & { signer: Lane; nonceOffset?: number };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function poolable(resource: SchedulableResource): boolean {
  return resource.kind === 'contract' && resource.action === 'deploy' && resource.senderIndependent === true &&
    (resource.signerRole ?? 'deployer') === 'deployer' &&
    PERMISSIONLESS_FACTORY_CODE_HASHES.has(resource.factory?.codeHash?.toLowerCase() ?? '');
}

export function executionWaves(resources: SchedulableResource[]): ExecutionWaves {
  const satisfied = new Set(resources.filter(resource => resource.action === 'reuse' || resource.action === 'recover').map(resource => resource.id));
  const remaining = new Map(resources.filter(resource => ['deploy', 'call'].includes(resource.action)).map((resource): [ResourceId, SchedulableResource] => [resource.id, resource]));
  const waves: ResourceId[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter(resource => resource.dependencies.every(id => satisfied.has(id)));
    if (ready.length === 0) break;
    waves.push(ready.map(resource => resource.id));
    for (const resource of ready) {
      remaining.delete(resource.id);
      satisfied.add(resource.id);
    }
  }
  return { waves, deferred: [...remaining.values()].map(resource => ({ id: resource.id, waitingFor: resource.dependencies.filter(id => !satisfied.has(id)) })) };
}

function laneFor(resource: SchedulableResource, primary: Address, owner: Address | null): { role: LaneRole; lane: Lane } {
  const role = resource.signerRole ?? (resource.kind === 'call' ? 'owner' : 'deployer');
  if (role === 'deployer') return { role, lane: primary };
  if (role === 'owner') return { role, lane: owner ?? OWNER_LANE };
  throw new Error(`${resource.id} needs signer role ${role}, which has no lane.`);
}

// Packs one wave into batches. A batch has at most one transaction per account. Pinned actions go first, then pooled deploys fill free lanes.
function pack(actions: PendingAction[], pool: Address[], parallel: boolean, pipeline: boolean): PlacedAction[][] {
  if (pipeline) {
    let next = 0;
    const entries = actions.map((action): PlacedAction => ({ ...action, signer: action.pooled ? pool[next++ % pool.length] ?? action.lane : action.lane }));
    const offsets = new Map<Lane, number>();
    return [entries.map(entry => {
      const nonceOffset = offsets.get(entry.signer) ?? 0;
      offsets.set(entry.signer, nonceOffset + 1);
      return { ...entry, nonceOffset };
    })];
  }
  const batches: PlacedAction[][] = [];
  const place = (action: PendingAction, candidates: Lane[]): void => {
    for (const batch of batches) {
      const lane = candidates.find(candidate => !batch.some(entry => entry.signer === candidate));
      if (lane) {
        batch.push({ ...action, signer: lane });
        return;
      }
    }
    batches.push([{ ...action, signer: candidates[0] ?? action.lane }]);
  };
  if (!parallel) return actions.map(action => [{ ...action, signer: action.lane }]);
  for (const action of actions.filter(item => !item.pooled)) place(action, [action.lane]);
  for (const action of actions.filter(item => item.pooled)) place(action, pool);
  return batches.map(batch => batch.sort((a, b) => a.order - b.order));
}

/** A placed action without the scheduling bookkeeping: what the schedule reports. */
function strip({ lane: _lane, order: _order, ...entry }: PlacedAction): ScheduleEntry {
  return entry;
}

export function createSchedule(plan: SchedulePlan, deployers: string[], options: ScheduleOptions = {}): Schedule {
  const { owner = null, parallel = true, pipeline = false } = options;
  assert(plan && Array.isArray(plan.resources), 'Schedule needs a plan with resources[].');
  assert(Array.isArray(deployers) && deployers.length > 0, 'Supply at least one deployer address.');
  assert(deployers.every(isUserAddress), 'Every deployer must be an Ethereum address with a valid mixed-case checksum.');
  const pool = deployers.map(address => address.toLowerCase() as Address);
  assert(new Set(pool).size === pool.length, 'Deployer addresses must be distinct.');
  assert(owner === null || isUserAddress(owner), 'Owner must be an Ethereum address with a valid mixed-case checksum.');
  const ownerLane = owner === null ? null : owner.toLowerCase() as Address;
  const blocked = plan.resources.filter(resource => !APPLICABLE.has(resource.action));
  assert(blocked.length === 0, `Cannot schedule a plan with conflict or unverified resources: ${blocked.map(resource => `${resource.id} (${resource.action})`).join(', ')}.`);

  const byId = new Map(plan.resources.map((resource): [ResourceId, SchedulableResource] => [resource.id, resource]));
  const dependenciesOf = (id: ResourceId): ResourceId[] => byId.get(id)?.dependencies ?? [];
  const satisfied = new Set(plan.resources.filter(resource => resource.action === 'reuse' || resource.action === 'recover').map(resource => resource.id));
  // Nonempty by the assert above.
  const primary = pool[0]!;
  const actions = plan.resources.flatMap((resource, order): PendingAction[] => {
    const { action } = resource;
    // Recovery is completed before the scheduled waves and consumes no new nonce.
    if (action !== 'deploy' && action !== 'call') return [];
    const { role, lane } = laneFor(resource, primary, ownerLane);
    const pooled = parallel && pool.length > 1 && poolable(resource);
    return [{ id: resource.id, action, kind: resource.kind, address: resource.address, signerRole: role, lane, pooled, order,
      ...(resource.executionEdges ? { after: resource.executionEdges } : {}) }];
  });

  const remaining = new Map(actions.map((action): [ResourceId, PendingAction] => [action.id, action]));
  const waves: ScheduleWave[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter(action => dependenciesOf(action.id).every(dep => satisfied.has(dep)));
    if (ready.length === 0) break;
    const batches = pack(ready, pool, parallel, pipeline).map(batch => batch.map(strip));
    const wave: ScheduleWave = { wave: waves.length + 1, batches };
    if (pipeline) {
      const groups = new Map<Lane, SignerGroup['actions']>();
      for (const entry of batches.flat()) {
        const group = groups.get(entry.signer);
        const item = { id: entry.id, nonceOffset: entry.nonceOffset };
        if (group) group.push(item);
        else groups.set(entry.signer, [item]);
      }
      wave.signerGroups = [...groups].map(([signer, actions]) => ({ signer, actions }));
      wave.receiptBarrier = true;
    }
    waves.push(wave);
    for (const action of ready) {
      remaining.delete(action.id);
      satisfied.add(action.id);
    }
  }

  const lanes = new Map<Lane, { address: Lane; roles: Set<LaneRole>; actions: number }>();
  for (const wave of waves) {
    for (const entry of wave.batches.flat()) {
      const lane = lanes.get(entry.signer) ?? { address: entry.signer, roles: new Set<LaneRole>(), actions: 0 };
      lane.roles.add(entry.signerRole);
      lane.actions += 1;
      lanes.set(entry.signer, lane);
    }
  }
  return {
    parallel,
    pipeline,
    ...(plan.graphs ? { graphs: plan.graphs, warnings: plan.warnings ?? [] } : {}),
    lanes: [...lanes.values()].map((lane): ScheduleLane => ({ ...lane, roles: [...lane.roles].sort() })),
    waves,
    deferred: [...remaining.values()].map(action => ({
      id: action.id,
      waitingFor: dependenciesOf(action.id).filter(dep => !satisfied.has(dep)),
    })),
    ownerActions: waves.flatMap(wave => wave.batches.flat().filter(entry => entry.signerRole === 'owner').map(entry => ({ id: entry.id, action: entry.action, wave: wave.wave, signer: entry.signer }))),
  };
}
