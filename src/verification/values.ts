import type { AbiParameter } from 'viem';
import { isUserAddress } from '../address.ts';
import type { JsonValue } from '../types.ts';

const HEX = /^0x[0-9a-fA-F]*$/;

function fail(label: string, value: unknown, type: string): never {
  throw new Error(
    `${label} is not a valid ${type}: ${typeof value === 'bigint' ? value.toString() : JSON.stringify(value)}.`,
  );
}

function integer(value: unknown, label: string, type: string): string {
  try {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value).toString();
    if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) return BigInt(value).toString();
    if (typeof value === 'string' && HEX.test(value) && value.length > 2)
      return BigInt(value).toString();
  } catch {
    // Fall through to the error below.
  }
  return fail(label, value, type);
}

function arrayType(type: string): { inner: string; length: number | null } | null {
  const match = /^(.*)\[(\d*)\]$/.exec(type);
  if (!match) return null;
  const [, inner = '', length = ''] = match;
  return { inner, length: length === '' ? null : Number(length) };
}

function components(parameter: AbiParameter): readonly AbiParameter[] {
  return 'components' in parameter ? parameter.components : [];
}

/** The item of a tuple value for one component: by position for arrays, by component name for objects. */
function tupleItem(value: unknown, component: AbiParameter, index: number): unknown {
  return Array.isArray(value)
    ? value[index]
    : (value as Record<string, unknown> | null | undefined)?.[component.name ?? ''];
}

/**
 * Converts an ABI value to a JSON value that compares by meaning: addresses and byte strings are lowercase hex,
 * integers are decimal strings, and tuples are objects keyed by component name (arrays when components are unnamed).
 */
export function normalizeAbiValue(
  parameter: AbiParameter,
  value: unknown,
  label: string = parameter?.name || 'value',
): JsonValue {
  const type = parameter?.type;
  const array = typeof type === 'string' ? arrayType(type) : null;
  if (array) {
    if (!Array.isArray(value) || (array.length !== null && value.length !== array.length))
      return fail(label, value, type);
    return value.map((item, index) =>
      normalizeAbiValue({ ...parameter, type: array.inner }, item, `${label}[${index}]`),
    );
  }
  if (type === 'address') {
    if (!isUserAddress(value)) return fail(label, value, type);
    return value.toLowerCase();
  }
  if (/^u?int(\d+)?$/.test(type ?? '')) return integer(value, label, type);
  if (type === 'bool') {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return fail(label, value, type);
  }
  if (/^bytes(\d+)?$/.test(type ?? '')) {
    if (typeof value !== 'string' || !HEX.test(value) || value.length % 2 !== 0)
      return fail(label, value, type);
    const size = Number(type.slice(5));
    if (size > 0 && value.length !== 2 + size * 2) return fail(label, value, type);
    return value.toLowerCase();
  }
  if (type === 'string') {
    if (typeof value !== 'string') return fail(label, value, type);
    return value;
  }
  if (type === 'tuple') {
    const parts = components(parameter);
    const named = parts.length > 0 && parts.every((component) => component.name);
    if (Array.isArray(value)) {
      if (value.length !== parts.length) return fail(label, value, type);
    } else if (
      !named ||
      !value ||
      typeof value !== 'object' ||
      Object.keys(value).length !== parts.length ||
      parts.some((component) => !Object.hasOwn(value, component.name ?? ''))
    ) {
      return fail(label, value, type);
    }
    const entries = parts.map((component, index): [string, JsonValue] => {
      const item = tupleItem(value, component, index);
      const itemLabel = `${label}.${component.name || index}`;
      if (item === undefined) return fail(itemLabel, item, component.type);
      return [component.name ?? '', normalizeAbiValue(component, item, itemLabel)];
    });
    return named ? Object.fromEntries(entries) : entries.map(([, item]) => item);
  }
  return toJson(value);
}

/** The value viem encodes for one parameter: bigint integers, nested arrays, and tuples as objects or arrays. */
function abiArgument(parameter: AbiParameter, value: unknown, label: string): unknown {
  const type = parameter?.type;
  const array = typeof type === 'string' ? arrayType(type) : null;
  if (array) {
    if (!Array.isArray(value) || (array.length !== null && value.length !== array.length))
      return fail(label, value, type);
    return value.map((item, index) =>
      abiArgument({ ...parameter, type: array.inner }, item, `${label}[${index}]`),
    );
  }
  if (/^u?int(\d+)?$/.test(type ?? '')) return BigInt(integer(value, label, type));
  if (type === 'tuple') {
    const parts = components(parameter);
    const named = parts.length > 0 && parts.every((component) => component.name);
    const entries = parts.map((component, index): [string, unknown] => [
      component.name ?? '',
      abiArgument(
        component,
        tupleItem(value, component, index),
        `${label}.${component.name || index}`,
      ),
    ]);
    return named ? Object.fromEntries(entries) : entries.map(([, item]) => item);
  }
  return normalizeAbiValue(parameter, value, label);
}

/** Converts JSON values (decimal-string integers, hex strings) to the argument values that viem encodes. */
export function abiArguments(
  parameters: readonly AbiParameter[],
  values: unknown,
  label = 'argument',
): unknown[] {
  if (!Array.isArray(values) || values.length !== parameters.length)
    throw new Error(
      `Expected ${parameters.length} ${label}(s); received ${Array.isArray(values) ? values.length : 'none'}.`,
    );
  return parameters.map((parameter, index) =>
    abiArgument(parameter, values[index], `${label} ${parameter.name || index}`),
  );
}

/** Normalizes a function result with its ABI outputs: one output gives one value, several give an array. */
export function normalizeOutputs(
  outputs: readonly AbiParameter[],
  value: unknown,
  label: string,
): JsonValue {
  const [single] = outputs;
  if (outputs.length === 1 && single) return normalizeAbiValue(single, value, label);
  if (!Array.isArray(value) || value.length !== outputs.length)
    return fail(label, value, 'output list');
  return outputs.map((output, index) =>
    normalizeAbiValue(output, value[index], `${label}[${index}]`),
  );
}

/** Converts viem results to JSON: BigInt becomes a decimal string and hex strings become lowercase. */
export function toJson(value: unknown): JsonValue {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number')
    return Number.isSafeInteger(value) ? value.toString() : String(value);
  if (typeof value === 'string') return HEX.test(value) ? value.toLowerCase() : value;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(toJson);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJson(item)]));
  return null;
}

export function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Fixed text for untrusted RPC failures in verification reports and plans. */
export function safeError(_error: unknown): string {
  return 'RPC request failed.';
}
