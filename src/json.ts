// Reading untrusted JSON one field at a time. The spec, state, artifact, and journal validators narrow further.

/** A plain object or array-free record: what JSON.parse gives for `{...}`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `value[key]` when `value` is a record; `undefined` for anything else, as optional chaining would give. */
export function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}
