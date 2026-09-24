import { isAddress } from 'viem';

// Factories whose runtime lets any account deploy, so the paying account cannot change the result.
export const PERMISSIONLESS_FACTORY_CODE_HASHES = new Set([
  '0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989',
]);
const APPLICABLE = new Set(['reuse', 'deploy', 'call']);
const OWNER_LANE = 'owner';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function poolable(resource) {
  return resource.kind === 'contract' && resource.action === 'deploy' && resource.senderIndependent === true &&
    (resource.signerRole ?? 'deployer') === 'deployer' &&
    PERMISSIONLESS_FACTORY_CODE_HASHES.has(resource.factory?.codeHash?.toLowerCase());
}

function laneFor(resource, primary, owner) {
  const role = resource.signerRole ?? (resource.kind === 'call' ? 'owner' : 'deployer');
  if (role === 'deployer') return { role, lane: primary };
  if (role === 'owner') return { role, lane: owner ?? OWNER_LANE };
  throw new Error(`${resource.id} needs signer role ${role}, which has no lane.`);
}

// Packs one wave into batches. A batch has at most one transaction per account. Pinned actions go first, then pooled deploys fill free lanes.
function pack(actions, pool, parallel) {
  const batches = [];
  const place = (action, candidates) => {
    for (const batch of batches) {
      const lane = candidates.find(candidate => !batch.some(entry => entry.signer === candidate));
      if (lane) return batch.push({ ...action, signer: lane });
    }
    batches.push([{ ...action, signer: candidates[0] }]);
  };
  if (!parallel) return actions.map(action => [{ ...action, signer: action.lane }]);
  for (const action of actions.filter(item => !item.pooled)) place(action, [action.lane]);
  for (const action of actions.filter(item => item.pooled)) place(action, pool);
  return batches.map(batch => batch.sort((a, b) => a.order - b.order));
}

export function createSchedule(plan, deployers, options = {}) {
  const { owner = null, parallel = true } = options;
  assert(plan && Array.isArray(plan.resources), 'Schedule needs a plan with resources[].');
  assert(Array.isArray(deployers) && deployers.length > 0, 'Supply at least one deployer address.');
  assert(deployers.every(address => isAddress(address, { strict: false })), 'Every deployer must be an Ethereum address.');
  const pool = deployers.map(address => address.toLowerCase());
  assert(new Set(pool).size === pool.length, 'Deployer addresses must be distinct.');
  assert(owner === null || isAddress(owner, { strict: false }), 'Owner must be an Ethereum address.');
  const ownerLane = owner?.toLowerCase() ?? null;
  const blocked = plan.resources.filter(resource => !APPLICABLE.has(resource.action));
  assert(blocked.length === 0, `Cannot schedule a plan with conflict or unverified resources: ${blocked.map(resource => `${resource.id} (${resource.action})`).join(', ')}.`);

  const byId = new Map(plan.resources.map(resource => [resource.id, resource]));
  const satisfied = new Set(plan.resources.filter(resource => resource.action === 'reuse').map(resource => resource.id));
  const actions = plan.resources.map((resource, order) => ({ resource, order })).filter(({ resource }) => resource.action !== 'reuse').map(({ resource, order }) => {
    const { role, lane } = laneFor(resource, pool[0], ownerLane);
    const pooled = parallel && pool.length > 1 && poolable(resource);
    return { id: resource.id, action: resource.action, kind: resource.kind, address: resource.address, signerRole: role, lane, pooled, order };
  });

  const remaining = new Map(actions.map(action => [action.id, action]));
  const waves = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter(action => byId.get(action.id).dependencies.every(dep => satisfied.has(dep)));
    if (ready.length === 0) break;
    waves.push({ wave: waves.length + 1, batches: pack(ready, pool, parallel) });
    for (const action of ready) {
      remaining.delete(action.id);
      satisfied.add(action.id);
    }
  }
  const strip = ({ lane, order, ...entry }) => entry;
  for (const wave of waves) wave.batches = wave.batches.map(batch => batch.map(strip));

  const lanes = new Map();
  for (const wave of waves) {
    for (const entry of wave.batches.flat()) {
      const lane = lanes.get(entry.signer) ?? { address: entry.signer, roles: new Set(), actions: 0 };
      lane.roles.add(entry.signerRole);
      lane.actions += 1;
      lanes.set(entry.signer, lane);
    }
  }
  return {
    parallel,
    lanes: [...lanes.values()].map(lane => ({ ...lane, roles: [...lane.roles].sort() })),
    waves,
    deferred: [...remaining.values()].map(action => ({
      id: action.id,
      waitingFor: byId.get(action.id).dependencies.filter(dep => !satisfied.has(dep)),
    })),
    ownerActions: waves.flatMap(wave => wave.batches.flat().filter(entry => entry.signerRole === 'owner').map(entry => ({ id: entry.id, action: entry.action, wave: wave.wave, signer: entry.signer }))),
  };
}
