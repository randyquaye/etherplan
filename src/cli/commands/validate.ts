import { prepareResources } from '../../planning/index.ts';
import { dependencyWarnings, usesDependencyPlan } from '../../spec/index.ts';
import { print } from '../shared.ts';
import type { ArtifactCommandContext } from './context.ts';
export function validate({ spec, ordered, artifacts }: ArtifactCommandContext): void {
  const { resources } = prepareResources(spec, ordered, artifacts);
  print({
    status: 'valid',
    resources: resources.map((resource) => resource.id),
    ...(usesDependencyPlan(spec) ? { warnings: dependencyWarnings(spec, ordered) } : {}),
  });
}
