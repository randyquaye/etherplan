import { concatHex, keccak256, stringToHex } from 'viem';
import { isUserAddress } from '../address.ts';
import { isRecord } from '../json.ts';
import { decodeMetadataTail } from './metadata.ts';
import type { ImmutableReferences, LinkReferences } from '../artifacts/types.ts';
import type { Address, DistributiveOmit, Hex } from '../types.ts';
import type {
  ImmutableEntry,
  ImmutableWord,
  RuntimeComparison,
  RuntimeDifference,
} from './types.ts';

const HEX = /^[0-9a-f]*$/;
const LIBRARY_GUARD = /^73(00){20}3014/;

/** One 20-byte link placeholder: `file:Library` and its byte offset. */
interface LinkRange {
  key: string;
  start: number;
  length: number;
}

/** A content difference without its offset, as `region` reports it. */
type ContentRegion = DistributiveOmit<
  Extract<RuntimeDifference, { reason: 'content' }>,
  'reason' | 'offset'
>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function body(hex: string): string {
  assert(typeof hex === 'string', 'Bytecode must be a string.');
  return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
}

/** Validates link references from an artifact and returns their ranges sorted by offset. */
function rangesOf(references: unknown, label: string): LinkRange[] {
  assert(isRecord(references), `${label} must be an object.`);
  const ranges: LinkRange[] = [];
  for (const [file, names] of Object.entries(references)) {
    assert(isRecord(names), `${label} for ${file} must be an object.`);
    for (const [name, positions] of Object.entries(names)) {
      assert(
        Array.isArray(positions) && positions.length > 0,
        `${label} for ${file}:${name} needs positions.`,
      );
      for (const position of positions as unknown[]) {
        assert(
          isRecord(position) &&
            typeof position.start === 'number' &&
            Number.isSafeInteger(position.start) &&
            position.start >= 0 &&
            position.length === 20,
          `${label} for ${file}:${name} has an invalid range.`,
        );
        ranges.push({ key: `${file}:${name}`, start: position.start, length: position.length });
      }
    }
  }
  return ranges.sort((left, right) => left.start - right.start);
}

/** Returns the solc link placeholder text for a fully qualified library name. */
export function linkPlaceholder(fullyQualifiedName: string): string {
  return `__$${keccak256(stringToHex(fullyQualifiedName)).slice(2, 36)}$__`;
}

function legacyPlaceholder(fullyQualifiedName: string): string {
  return `__${fullyQualifiedName.slice(0, 36).padEnd(36, '_')}__`;
}

/**
 * Validates a bytecode object against its link references. Each link reference must cover a solc placeholder for its
 * own library, and every non-hex character must be inside a declared link range. Returns `0x` code with lowercase hex
 * outside the placeholders.
 */
export function normalizeCode(
  object: string,
  linkReferences: LinkReferences = {},
  label = 'Bytecode',
): Hex {
  const text = body(object);
  assert(text.length > 0, `${label} is empty.`);
  assert(text.length % 2 === 0, `${label} has an odd number of hex characters.`);
  const ranges = rangesOf(linkReferences, `${label} link references`);
  let out = '';
  let cursor = 0;
  for (const range of ranges) {
    const from = range.start * 2;
    const to = from + range.length * 2;
    assert(from >= cursor, `${label} has overlapping link references at byte ${range.start}.`);
    assert(to <= text.length, `${label} link reference for ${range.key} exceeds the bytecode.`);
    const gap = text.slice(cursor, from).toLowerCase();
    assert(
      HEX.test(gap),
      `${label} has an unresolved link placeholder that no link reference covers.`,
    );
    const placeholder = text.slice(from, to);
    assert(
      placeholder === linkPlaceholder(range.key) || placeholder === legacyPlaceholder(range.key),
      `${label} link reference for ${range.key} does not cover its placeholder at byte ${range.start}.`,
    );
    out += gap + placeholder;
    cursor = to;
  }
  const rest = text.slice(cursor).toLowerCase();
  assert(
    HEX.test(rest),
    `${label} has an unresolved link placeholder that no link reference covers.`,
  );
  return `0x${out}${rest}`;
}

/** Replaces each declared link placeholder with the library address. Rejects missing or unknown libraries. */
export function linkBytecode(
  object: string,
  linkReferences: LinkReferences = {},
  libraries: Record<string, Address> = {},
): Hex {
  let text = body(object);
  const used = new Set<string>();
  for (const range of rangesOf(linkReferences, 'Link references')) {
    const address = libraries[range.key];
    assert(address !== undefined, `Missing linked library ${range.key}.`);
    assert(
      isUserAddress(address),
      `Linked library ${range.key} has an invalid address or checksum.`,
    );
    used.add(range.key);
    assert(
      (range.start + range.length) * 2 <= text.length,
      `Link reference for ${range.key} exceeds the bytecode.`,
    );
    text = `${text.slice(0, range.start * 2)}${address.slice(2).toLowerCase()}${text.slice((range.start + range.length) * 2)}`;
  }
  for (const key of Object.keys(libraries)) assert(used.has(key), `Unknown linked library ${key}.`);
  assert(
    HEX.test(text.toLowerCase()) && text.length % 2 === 0,
    'Linked bytecode has unresolved links.',
  );
  return `0x${text.toLowerCase()}`;
}

/** Reads the library addresses that a linked bytecode contains at the declared link ranges. */
export function linkedLibraries(
  linked: string,
  linkReferences: LinkReferences = {},
): Record<string, Address> {
  const text = body(linked).toLowerCase();
  const libraries: Record<string, Address> = {};
  for (const range of rangesOf(linkReferences, 'Link references')) {
    const address: Address = `0x${text.slice(range.start * 2, (range.start + range.length) * 2)}`;
    assert(
      HEX.test(address.slice(2)) && address.length === 42,
      `Linked bytecode has no address for ${range.key}.`,
    );
    assert(
      libraries[range.key] === undefined || libraries[range.key] === address,
      `Linked bytecode has two addresses for ${range.key}.`,
    );
    libraries[range.key] = address;
  }
  return libraries;
}

/** Returns true when runtime code starts with the solc library call guard (`PUSH20 0 ADDRESS EQ`). */
export function hasLibraryGuard(runtime: string): boolean {
  return LIBRARY_GUARD.test(body(runtime).toLowerCase());
}

/** Writes the deployed library address into the solc library call guard, as the library constructor does. */
export function fillLibraryGuard(runtime: string, address: Address): Hex {
  const text = body(runtime).toLowerCase();
  if (!LIBRARY_GUARD.test(text)) return `0x${text}`;
  return `0x73${address.slice(2).toLowerCase()}${text.slice(42)}`;
}

export function create2Address(factory: Address, salt: Hex, initcode: Hex): Address {
  return `0x${keccak256(concatHex(['0xff', factory, salt, keccak256(initcode)])).slice(-40)}`;
}

/** Returns immutable reference entries sorted by numeric AST ID, with sorted ranges. */
export function immutableEntries(immutableReferences: ImmutableReferences = {}): ImmutableEntry[] {
  return Object.entries(immutableReferences)
    .map(([id, ranges]): ImmutableEntry => [
      id,
      [...ranges].sort((left, right) => left.start - right.start),
    ])
    .sort(([left], [right]) => Number(left) - Number(right) || left.localeCompare(right));
}

function masked(text: string, immutableReferences: ImmutableReferences): string {
  const chars = text.split('');
  for (const [, ranges] of immutableEntries(immutableReferences)) {
    for (const { start, length } of ranges) {
      for (let index = start * 2; index < (start + length) * 2 && index < chars.length; index++)
        chars[index] = '0';
    }
  }
  return chars.join('');
}

function region(
  offset: number,
  expected: string,
  live: string,
  immutableReferences: ImmutableReferences,
  linkReferences: LinkReferences,
): ContentRegion {
  for (const range of rangesOf(linkReferences, 'Link references')) {
    if (offset >= range.start && offset < range.start + range.length)
      return { region: 'library', library: range.key };
  }
  const expectedTail = decodeMetadataTail(`0x${expected}`);
  if (expectedTail && offset >= expectedTail.start) {
    const liveTail = decodeMetadataTail(`0x${live}`);
    return {
      region: 'metadata',
      expectedMetadataHash: expectedTail.hash ?? null,
      liveMetadataHash: liveTail?.hash ?? null,
    };
  }
  for (const [id, ranges] of immutableEntries(immutableReferences)) {
    if (ranges.some(({ start, length }) => offset >= start && offset < start + length))
      return { region: 'immutable', immutable: id };
  }
  return { region: 'code' };
}

/**
 * Compares live runtime code with the expected linked runtime.
 * `mode` is `exact` (every byte equal), `masked` (equal outside compiler-marked immutable ranges), or `mismatch`.
 * Each immutable reports the live 32-byte word and whether all of its ranges hold the same word.
 */
export function compareRuntime(
  expectedRuntime: string,
  liveRuntime: string,
  immutableReferences: ImmutableReferences = {},
  linkReferences: LinkReferences = {},
): RuntimeComparison {
  const expected = body(expectedRuntime).toLowerCase();
  const live = body(liveRuntime).toLowerCase();
  const immutables = immutableEntries(immutableReferences).map(([id, ranges]): ImmutableWord => {
    const words = ranges.map(({ start, length }) => live.slice(start * 2, (start + length) * 2));
    return {
      id,
      ranges,
      value: `0x${words[0] ?? ''}`,
      consistent: words.every((word) => word === words[0]),
    };
  });
  const result = {
    expectedSkeletonHash: keccak256(`0x${masked(expected, immutableReferences)}`),
    liveSkeletonHash: keccak256(`0x${masked(live, immutableReferences)}`),
    immutables,
  };
  if (expected === live) return { ...result, mode: 'exact' };
  if (expected.length !== live.length) {
    return {
      ...result,
      mode: 'mismatch',
      difference: {
        reason: 'length',
        expectedBytes: expected.length / 2,
        liveBytes: live.length / 2,
      },
    };
  }
  const maskedExpected = masked(expected, immutableReferences);
  const maskedLive = masked(live, immutableReferences);
  if (maskedExpected === maskedLive) return { ...result, mode: 'masked' };
  let index = 0;
  while (maskedExpected[index] === maskedLive[index]) index++;
  const offset = Math.floor(index / 2);
  return {
    ...result,
    mode: 'mismatch',
    difference: {
      reason: 'content',
      offset,
      ...region(offset, expected, live, immutableReferences, linkReferences),
    },
  };
}
