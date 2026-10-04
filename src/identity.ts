import { keccak256, stringToHex } from 'viem';
import type { Hash, JsonValue } from './types.ts';

export function canonicalJson(value: unknown): string {
  function normalize(item: unknown): JsonValue {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(normalize);
    if (
      item &&
      typeof item === 'object' &&
      (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)
    ) {
      const record = item as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key): [string, JsonValue] => [key, normalize(record[key])]),
      );
    }
    throw new TypeError(
      'Canonical JSON accepts only finite numbers, strings, booleans, null, arrays, and plain objects.',
    );
  }

  return JSON.stringify(normalize(value));
}

export function hashJson(value: unknown): Hash {
  return keccak256(stringToHex(canonicalJson(value)));
}
