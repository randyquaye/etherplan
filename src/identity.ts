// @ts-nocheck
import { keccak256, stringToHex } from 'viem';
import type { Hash } from './types.ts';

export function canonicalJson(value: unknown): string {
  function normalize(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object' && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)) {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]));
    }
    throw new TypeError('Canonical JSON accepts only finite numbers, strings, booleans, null, arrays, and plain objects.');
  }

  return JSON.stringify(normalize(value));
}

export function hashJson(value: unknown): Hash {
  return keccak256(stringToHex(canonicalJson(value)));
}
