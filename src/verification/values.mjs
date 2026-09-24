import { isAddress } from 'viem';

const HEX = /^0x[0-9a-fA-F]*$/;

function fail(label, value, type) {
  throw new Error(`${label} is not a valid ${type}: ${typeof value === 'bigint' ? value.toString() : JSON.stringify(value)}.`);
}

function integer(value, label, type) {
  try {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value).toString();
    if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) return BigInt(value).toString();
    if (typeof value === 'string' && HEX.test(value) && value.length > 2) return BigInt(value).toString();
  } catch {
    // Fall through to the error below.
  }
  return fail(label, value, type);
}

function arrayType(type) {
  const match = /^(.*)\[(\d*)\]$/.exec(type);
  return match ? { inner: match[1], length: match[2] === '' ? null : Number(match[2]) } : null;
}

/**
 * Converts an ABI value to a JSON value that compares by meaning: addresses and byte strings are lowercase hex,
 * integers are decimal strings, and tuples are objects keyed by component name (arrays when components are unnamed).
 */
export function normalizeAbiValue(parameter, value, label = parameter?.name || 'value') {
  const type = parameter?.type;
  const array = typeof type === 'string' ? arrayType(type) : null;
  if (array) {
    if (!Array.isArray(value) || (array.length !== null && value.length !== array.length)) return fail(label, value, type);
    return value.map((item, index) => normalizeAbiValue({ ...parameter, type: array.inner }, item, `${label}[${index}]`));
  }
  if (type === 'address') {
    if (typeof value !== 'string' || !isAddress(value, { strict: false })) return fail(label, value, type);
    return value.toLowerCase();
  }
  if (/^u?int(\d+)?$/.test(type ?? '')) return integer(value, label, type);
  if (type === 'bool') {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return fail(label, value, type);
  }
  if (/^bytes(\d+)?$/.test(type ?? '')) {
    if (typeof value !== 'string' || !HEX.test(value) || value.length % 2 !== 0) return fail(label, value, type);
    const size = Number(type.slice(5));
    if (size > 0 && value.length !== 2 + size * 2) return fail(label, value, type);
    return value.toLowerCase();
  }
  if (type === 'string') {
    if (typeof value !== 'string') return fail(label, value, type);
    return value;
  }
  if (type === 'tuple') {
    const components = parameter.components ?? [];
    const named = components.length > 0 && components.every(component => component.name);
    const items = components.map((component, index) => {
      const item = Array.isArray(value) ? value[index] : value?.[component.name];
      if (item === undefined) return fail(`${label}.${component.name || index}`, item, component.type);
      return normalizeAbiValue(component, item, `${label}.${component.name || index}`);
    });
    return named ? Object.fromEntries(components.map((component, index) => [component.name, items[index]])) : items;
  }
  return toJson(value);
}

function abiArgument(parameter, value, label) {
  const type = parameter?.type;
  const array = typeof type === 'string' ? arrayType(type) : null;
  if (array) {
    if (!Array.isArray(value)) return fail(label, value, type);
    return value.map((item, index) => abiArgument({ ...parameter, type: array.inner }, item, `${label}[${index}]`));
  }
  if (/^u?int(\d+)?$/.test(type ?? '')) return BigInt(integer(value, label, type));
  if (type === 'tuple') {
    const components = parameter.components ?? [];
    const named = components.length > 0 && components.every(component => component.name);
    const items = components.map((component, index) => abiArgument(component, Array.isArray(value) ? value[index] : value?.[component.name], `${label}.${component.name || index}`));
    return named ? Object.fromEntries(components.map((component, index) => [component.name, items[index]])) : items;
  }
  return normalizeAbiValue(parameter, value, label);
}

/** Converts JSON values (decimal-string integers, hex strings) to the argument values that viem encodes. */
export function abiArguments(parameters, values, label = 'argument') {
  if (!Array.isArray(values) || values.length !== parameters.length) throw new Error(`Expected ${parameters.length} ${label}(s); received ${Array.isArray(values) ? values.length : 'none'}.`);
  return parameters.map((parameter, index) => abiArgument(parameter, values[index], `${label} ${parameter.name || index}`));
}

/** Normalizes a function result with its ABI outputs: one output gives one value, several give an array. */
export function normalizeOutputs(outputs, value, label) {
  if (outputs.length === 1) return normalizeAbiValue(outputs[0], value, label);
  if (!Array.isArray(value) || value.length !== outputs.length) return fail(label, value, 'output list');
  return outputs.map((output, index) => normalizeAbiValue(output, value[index], `${label}[${index}]`));
}

/** Converts viem results to JSON: BigInt becomes a decimal string and hex strings become lowercase. */
export function toJson(value) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value.toString() : String(value);
  if (typeof value === 'string') return HEX.test(value) ? value.toLowerCase() : value;
  if (Array.isArray(value)) return value.map(toJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJson(item)]));
  return value ?? null;
}

export function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Returns a short error message for reports. It removes RPC URLs and request bodies, because an RPC URL can contain
 * an access key and must not enter a plan or report.
 */
export function safeError(error) {
  const text = String(error?.shortMessage ?? error?.message ?? error ?? 'Unknown error.').split('\n')[0];
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').slice(0, 300);
}
