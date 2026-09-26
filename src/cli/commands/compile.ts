import { print } from '../shared.ts';
import type { SpecCommandContext } from './context.ts';
export function compile({ spec }: SpecCommandContext): void { print(spec); }
