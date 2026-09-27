import { concatHex, getContractAddress, getCreate2Address, keccak256, pad, stringToHex } from 'viem';
import type { Address, Client, Hex } from '../types.ts';
import type { SimulateCreate2Input, SimulateCreateInput } from './types.ts';

/**
 * Probe runtime that only exists inside an `eth_call` state override. Call data is `factory (32 bytes) || target
 * (32 bytes) || payload`. The probe calls the factory with the payload, reverts with the factory's revert data if
 * that call fails, and otherwise returns the runtime code at the target address.
 */
export const PROBE_CODE: Hex = `0x${[
  '6040', '36', '03', '80', '6040', '6000', '37',
  '6000', '6000', '82', '6000', '6000', '6000', '35', '5a', 'f1',
  '6025', '57',
  '3d', '6000', '6000', '3e', '3d', '6000', 'fd',
  '5b', '50',
  '6020', '35', '80', '3b', '90', '81', '6000', '6000', '83', '3c', '50', '6000', 'f3',
].join('')}`;

export const PROBE_ADDRESS: Address = `0x${keccak256(stringToHex('etherplan.verification.create2-probe')).slice(-40)}`;

// A CREATE from an account whose nonce is overridden to zero returns this account's nonce-0 child address.
// This probes code, nonce, and empty-storage overrides on an existing factory without sending a transaction.
const OVERRIDE_PROBE_CODE: Hex = '0x600060006000f060005260206000f3';
const REPLAY_PROBE_INITCODE: Hex = '0x6002600c60003960026000f36000';
const REPLAY_PROBE_SALT: Hex = keccak256(stringToHex('etherplan.verification.override-probe'));

type CallRequest = Parameters<Client['call']>[0];

/** A failed RPC request is inconclusive; an EVM execution revert is a replay result. */
export function replayProviderFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  let provider = false;
  for (let current = error; current && typeof current === 'object' && !seen.has(current); current = (current as { cause?: unknown }).cause) {
    seen.add(current);
    const { name, code } = current as { name?: unknown; code?: unknown };
    if (name === 'ExecutionRevertedError' || code === 3) return false;
    if (typeof name === 'string' && /(?:RpcError|HttpRequestError|WebSocketRequestError|TimeoutError|SocketClosedError|ConnectionError|NetworkError|TransportError|FetchError|AbortError)$/.test(name)) provider = true;
    if (typeof code === 'number' && code < 0) provider = true;
  }
  return provider;
}

function at(blockNumber: bigint | undefined): { blockNumber?: bigint } {
  return blockNumber === undefined ? {} : { blockNumber };
}

/** Check the historical override combination needed to replay a deployed CREATE2 target. */
export async function checkCreate2ReplayOverrides(client: Client, factory: Address): Promise<void> {
  const latest = await client.getBlock({ blockTag: 'latest' });
  const previous = latest.number > 0n ? latest.number - 1n : latest.number;
  const earlierCode = await client.getCode({ address: factory, blockNumber: previous });
  const blockNumber = earlierCode && earlierCode !== '0x' ? previous : latest.number;
  const { data } = await client.call({
    to: factory,
    data: '0x',
    blockNumber,
    stateOverride: [{ address: factory, code: OVERRIDE_PROBE_CODE, nonce: 0, state: [] }],
  });
  const expected = getContractAddress({ opcode: 'CREATE', from: factory, nonce: 0n }).toLowerCase();
  if (!data || data.length !== 66 || `0x${data.slice(-40)}`.toLowerCase() !== expected) {
    throw new Error('RPC did not apply the historical CREATE2 replay overrides.');
  }
  const target = getCreate2Address({ from: factory, salt: REPLAY_PROBE_SALT, bytecodeHash: keccak256(REPLAY_PROBE_INITCODE) });
  const runtime = await simulateCreate2(client, { factory, salt: REPLAY_PROBE_SALT, initcode: REPLAY_PROBE_INITCODE, address: target, blockNumber });
  if (runtime !== '0x6000') throw new Error('RPC did not apply the CREATE2 replay overrides.');
}

/**
 * Runs `salt || initcode` through the CREATE2 factory inside `eth_call` and returns the runtime that the constructor
 * produces at `address`. The state override empties the target first, so the simulation also works after deployment.
 * Nothing is signed or sent.
 */
export async function simulateCreate2(client: Client, { factory, salt, initcode, address, blockNumber, account }: SimulateCreate2Input): Promise<Hex> {
  const request: CallRequest = {
    to: PROBE_ADDRESS,
    data: concatHex([pad(factory), pad(address), salt, initcode]),
    stateOverride: [
      { address: PROBE_ADDRESS, code: PROBE_CODE },
      { address, code: '0x', nonce: 0, state: [] },
    ],
    ...at(blockNumber),
  };
  if (account) request.account = account;
  const { data } = await client.call(request);
  if (!data || data === '0x') throw new Error('CREATE2 simulation returned no runtime code.');
  return data.toLowerCase() as Hex;
}

/** Replays a direct CREATE transaction with `eth_call` and returns the runtime that its constructor returns. */
export async function simulateCreate(client: Client, { from, initcode, blockNumber }: SimulateCreateInput): Promise<Hex> {
  const { data } = await client.call({ account: from, data: initcode, ...at(blockNumber) });
  if (!data || data === '0x') throw new Error('Creation replay returned no runtime code.');
  return data.toLowerCase() as Hex;
}
