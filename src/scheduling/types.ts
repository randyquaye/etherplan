// Execution waves and signer batches. Source of truth: executionWaves and createSchedule in index.ts.
import type { DependencyEdge, DependencyGraphs, Factory } from '../spec/types.ts';
import type { Address, ResourceId, ResourceKind } from '../types.ts';

/** An action whose dependencies the plan cannot satisfy. */
export interface DeferredAction {
  id: ResourceId;
  waitingFor: ResourceId[];
}

/** Dependency-ordered waves of resource IDs, saved in a format 2 plan as `executionWaves`. */
export interface ExecutionWaves {
  waves: ResourceId[][];
  deferred: DeferredAction[];
}

/** The fields createSchedule and poolable read from a planned resource. */
export interface SchedulableResource {
  id: ResourceId;
  kind: ResourceKind;
  action: string;
  address: Address;
  dependencies: ResourceId[];
  signerRole?: string | null;
  senderIndependent?: boolean;
  factory?: Factory;
  executionEdges?: DependencyEdge[];
}

export interface SchedulePlan {
  resources: SchedulableResource[];
  graphs?: DependencyGraphs;
  warnings?: string[];
}

export interface ScheduleOptions {
  owner?: string | null;
  /** Defaults to `true` here; the CLI and applyPlan pass an explicit value. */
  parallel?: boolean;
  pipeline?: boolean;
}

/** The only roles with a lane. Any other spec `signerRole` makes createSchedule throw. */
export type LaneRole = 'deployer' | 'owner';

/** A lowercase signer address, or the literal `owner` when owner actions exist and no owner address was supplied. */
export type Lane = Address | 'owner';

export interface ScheduleEntry {
  id: ResourceId;
  action: 'deploy' | 'call';
  kind: ResourceKind;
  address: Address;
  signerRole: LaneRole;
  signer: Lane;
  pooled: boolean;
  after?: DependencyEdge[];
  /** Pipeline schedules only: position in the signer's nonce sequence for this wave. */
  nonceOffset?: number;
}

export interface SignerGroup {
  signer: Lane;
  actions: { id: ResourceId; nonceOffset: number | undefined }[];
}

export interface ScheduleWave {
  wave: number;
  /** A batch holds at most one transaction per signer. */
  batches: ScheduleEntry[][];
  /** Pipeline schedules only. */
  signerGroups?: SignerGroup[];
  receiptBarrier?: true;
}

export interface ScheduleLane {
  address: Lane;
  roles: LaneRole[];
  actions: number;
}

export interface OwnerAction {
  id: ResourceId;
  action: 'deploy' | 'call';
  wave: number;
  signer: Lane;
}

export interface Schedule {
  parallel: boolean;
  pipeline: boolean;
  graphs?: DependencyGraphs;
  warnings?: string[];
  lanes: ScheduleLane[];
  waves: ScheduleWave[];
  deferred: DeferredAction[];
  ownerActions: OwnerAction[];
}
