import { dependencyGraphs, dependencyWarnings, usesDependencyPlan } from '../../spec/index.ts';
import { print } from '../shared.ts';
import type { SpecCommandContext } from './context.ts';
export function graphCommand({ spec, ordered }: SpecCommandContext): void {
  print(usesDependencyPlan(spec) ? { ...dependencyGraphs(ordered), warnings: dependencyWarnings(spec, ordered) } : ordered.map(node => ({ id: node.id, deps: node.dependencies })));
}
