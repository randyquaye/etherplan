import path from 'node:path';
import { generateAdapters } from '../../artifacts.ts';
import { prepareResources } from '../../planning/index.ts';
import { print } from '../shared.ts';
import type { ArtifactCommandContext } from './context.ts';
export async function adapters({ spec, ordered, artifacts, options }: ArtifactCommandContext): Promise<void> {
  prepareResources(spec, ordered, artifacts);
  const output = path.resolve(options.out ?? 'generated');
  await generateAdapters(artifacts, output);
  print({ artifacts: [...artifacts.keys()], adapters: output });
}
