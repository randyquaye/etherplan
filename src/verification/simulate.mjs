import { concatHex, keccak256, pad, stringToHex } from 'viem';

/**
 * Probe runtime that only exists inside an `eth_call` state override. Call data is `factory (32 bytes) || target
 * (32 bytes) || payload`. The probe calls the factory with the payload, reverts with the factory's revert data if
 * that call fails, and otherwise returns the runtime code at the target address.
 */
export const PROBE_CODE = `0x${[
  '6040', '36', '03', '80', '6040', '6000', '37',
  '6000', '6000', '82', '6000', '6000', '6000', '35', '5a', 'f1',
  '6025', '57',
  '3d', '6000', '6000', '3e', '3d', '6000', 'fd',
  '5b', '50',
  '6020', '35', '80', '3b', '90', '81', '6000', '6000', '83', '3c', '50', '6000', 'f3',
].join('')}`;

export const PROBE_ADDRESS = `0x${keccak256(stringToHex('etherplan.verification.create2-probe')).slice(-40)}`;

function at(blockNumber) {
  return blockNumber === undefined ? {} : { blockNumber };
}

/**
 * Runs `salt || initcode` through the CREATE2 factory inside `eth_call` and returns the runtime that the constructor
 * produces at `address`. The state override empties the target first, so the simulation also works after deployment.
 * Nothing is signed or sent.
 */
export async function simulateCreate2(client, { factory, salt, initcode, address, blockNumber, account }) {
  const request = {
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
  return data.toLowerCase();
}

/** Replays a direct CREATE transaction with `eth_call` and returns the runtime that its constructor returns. */
export async function simulateCreate(client, { from, initcode, blockNumber }) {
  const { data } = await client.call({ account: from, data: initcode, ...at(blockNumber) });
  if (!data || data === '0x') throw new Error('Creation replay returned no runtime code.');
  return data.toLowerCase();
}
