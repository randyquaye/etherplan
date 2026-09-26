// Shared primitives. Every other types.ts builds on these. Types only; nothing here exists at run time.
import type { Abi, Address, Hex, PublicClient } from 'viem';

export type { Abi, Address, Hex };

/** 32-byte hex: `0x` followed by 64 hex characters. The spec, state, and journal validators check this shape. */
export type Hash = Hex;

export type ResourceKind = 'contract' | 'external' | 'call';

/** `<kind>:<name>`, where the name matches `/^[a-z][a-zA-Z0-9_]*$/`. */
export type ResourceId = `contract:${string}` | `external:${string}` | `call:${string}`;

/** The chain a plan, state file, journal, or scope belongs to. `genesisHash` is the hash of block 0. */
export interface ChainIdentity {
  id: number;
  genesisHash: Hash;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** A non-negative integer as a decimal string. Disk shapes store every bigint quantity this way. */
export type DecimalString = string;

/**
 * The read-only chain client the planner, verifier, and executor call. Enumerated from call sites so a
 * fake in tests needs only these methods. `client.send` in kms-signer.ts is the AWS KMS client, not this.
 */
export type Client = Pick<PublicClient,
  | 'getBlock'
  | 'getCode'
  | 'getTransactionCount'
  | 'getChainId'
  | 'getTransaction'
  | 'getBalance'
  | 'getTransactionReceipt'
  | 'call'
  | 'readContract'
  | 'estimateGas'
  | 'estimateFeesPerGas'
  | 'request'>;

/**
 * What jsonSafe (execution/preflight.ts) returns for a value: bigint becomes a decimal string, undefined
 * properties are dropped, and everything else keeps its shape. Hex is lowercased at run time; the type cannot say so.
 */
export type JsonSafe<T> =
  T extends bigint ? DecimalString :
  T extends string | number | boolean | null ? T :
  T extends readonly (infer U)[] ? JsonSafe<U>[] :
  T extends object ? { [K in keyof T]: JsonSafe<Exclude<T[K], undefined>> } :
  T;

/** `Omit` that distributes over a union instead of collapsing it to the shared keys. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
