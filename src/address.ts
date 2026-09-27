import { isAddress } from 'viem';

/** Accept unchecksummed single-case addresses, but verify the checksum of mixed-case input. */
export function isUserAddress(value: unknown): value is `0x${string}` {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) return false;
  const hex = value.slice(2);
  return !(/[a-f]/.test(hex) && /[A-F]/.test(hex)) || isAddress(value);
}
