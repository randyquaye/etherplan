import type { Artifacts } from '../../artifacts/types.ts';
import type { OrderedNode, ParsedSpec } from '../../spec/types.ts';
import type { Client } from '../../types.ts';
import type { CliOptions } from '../options.ts';

export interface CommandContext {
  options: CliOptions;
}
export interface SpecCommandContext extends CommandContext {
  specFile: string;
  spec: ParsedSpec;
  ordered: OrderedNode[];
}
export interface ArtifactCommandContext extends SpecCommandContext {
  artifacts: Artifacts;
}
export interface ChainCommandContext extends ArtifactCommandContext {
  client: Client;
  stateFile: string;
}
