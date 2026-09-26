// The executor uses the planner's and verifier's own functions, so apply and plan cannot disagree about a resource.
// `override` replaces any of them; tests inject a failing verifier this way.
import { prepareResources, transactionFor } from '../planning/index.ts';
import { graph, parseSpec } from '../spec/index.ts';
import { readState, recordResource, writeStateAtomic } from '../state/index.ts';
import { verifyResource } from '../verification/index.ts';
import type { ApplyDependencies } from './types.ts';

export function loadDependencies(override: Partial<ApplyDependencies> = {}): ApplyDependencies {
  return {
    parseSpec: override.parseSpec ?? parseSpec,
    graph: override.graph ?? graph,
    prepareResources: override.prepareResources ?? prepareResources,
    transactionFor: override.transactionFor ?? transactionFor,
    verifyResource: override.verifyResource ?? verifyResource,
    readState: override.readState ?? readState,
    writeStateAtomic: override.writeStateAtomic ?? writeStateAtomic,
    recordResource: override.recordResource ?? recordResource,
  };
}
