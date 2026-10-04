// Derived CREATE2 salts. In .ethp, `salt = derive` hashes the project's mixer and `derive("label")` hashes
// `<mixer>:<label>`, so two deployments with identical initcode can still have different addresses. The compiler
// lowers both to a concrete salt and records the derivation beside it; parseSpec and state check that they agree.
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

/** The salt for a mixer, or a mixer and label: `cast keccak "<mixer>"` or `cast keccak "<mixer>:<label>"`. */
export function deriveSalt(mixer: string, label?: string): Hash {
  return keccak256(stringToBytes(label === undefined ? mixer : `${mixer}:${label}`));
}

/** Validates a saltDerivation object from a spec or a state record. */
export function assertSaltDerivation(value: unknown, location: string): SaltDerivation {
  assert(
    isObject(value) && Object.keys(value).every((key) => key === 'mixer' || key === 'label'),
    `${location} must be an object with mixer and an optional label.`,
  );
  assert(
    typeof value.mixer === 'string' && MIXER.test(value.mixer),
    `${location} mixer must be ${MIXER_HINT}.`,
  );
  assert(
    value.label === undefined || (typeof value.label === 'string' && MIXER.test(value.label)),
    `${location} label must be ${MIXER_HINT}.`,
  );
  return value.label === undefined
    ? { mixer: value.mixer }
    : { mixer: value.mixer, label: value.label };
}

/** Checks that a salt is the one its derivation produces. */
export function assertDerivedSalt(
  salt: unknown,
  derivation: SaltDerivation,
  location: string,
): void {
  assert(
    typeof salt === 'string' &&
      salt.toLowerCase() === deriveSalt(derivation.mixer, derivation.label),
    `${location} salt is not the salt derived from its saltDerivation.`,
  );
}
