import { impact as resourceImpact } from '../../spec/index.ts';
import { print } from '../shared.ts';
import type { SpecCommandContext } from './context.ts';
export function impact({ spec, ordered, options }: SpecCommandContext): void {
  print(resourceImpact(spec, ordered, `values.${options.value}`));
}
