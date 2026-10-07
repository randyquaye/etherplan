// Derived CREATE2 salts. In .ethp, `salt = derive` hashes the project's mixer and `derive("label")` hashes
// `<mixer>:<label>`, so two deployments with identical initcode can still have different addresses. A contract's
// `generation` above zero appends ` generation <n>`; the space cannot appear in a mixer or label, so no label can
// produce the same string. The compiler lowers each to a concrete salt and records the derivation beside it;
// parseSpec and state check that they agree.
import { keccak256, stringToBytes } from 'viem';
import type { Hash } from '../types.ts';
import type { SaltDerivation } from './types.ts';

/** A mixer or label: printable ASCII without spaces, so a stray space or invisible character cannot change a salt. */
export const MIXER = /^[!-~]+$/;
export const MIXER_HINT = 'a nonempty string of printable ASCII characters without spaces';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The salt for a mixer, an optional label, and an optional generation: `cast keccak "<mixer>"`,
 * `cast keccak "<mixer>:<label>"`, or either followed by ` generation <n>` for a generation above zero.
 */
export function deriveSalt(mixer: string, label?: string, generation?: number): Hash {
  const base = label === undefined ? mixer : `${mixer}:${label}`;
  return keccak256(
    stringToBytes(generation === undefined ? base : `${base} generation ${generation}`),
  );
}

/** A generation is a whole number; zero is the default and is never recorded. */
export function isGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** Validates a saltDerivation object from a spec or a state record. */
export function assertSaltDerivation(value: unknown, location: string): SaltDerivation {
  assert(
    isObject(value) &&
      Object.keys(value).every((key) => key === 'mixer' || key === 'label' || key === 'generation'),
    `${location} must be an object with mixer and an optional label and generation.`,
  );
  assert(
    typeof value.mixer === 'string' && MIXER.test(value.mixer),
    `${location} mixer must be ${MIXER_HINT}.`,
  );
  assert(
    value.label === undefined || (typeof value.label === 'string' && MIXER.test(value.label)),
    `${location} label must be ${MIXER_HINT}.`,
  );
  assert(
    value.generation === undefined || isGeneration(value.generation),
    `${location} generation must be a whole number of at least 1; leave it out for generation 0.`,
  );
  return {
    mixer: value.mixer,
    ...(value.label === undefined ? {} : { label: value.label }),
    ...(value.generation === undefined ? {} : { generation: value.generation }),
  };
}

/** Checks that a salt is the one its derivation produces. */
export function assertDerivedSalt(
  salt: unknown,
  derivation: SaltDerivation,
  location: string,
): void {
  assert(
    typeof salt === 'string' &&
      salt.toLowerCase() === deriveSalt(derivation.mixer, derivation.label, derivation.generation),
    `${location} salt is not the salt derived from its saltDerivation.`,
  );
}
