import { jsonSafe } from './preflight.ts';
import type { Address, Hex } from '../types.ts';
import type { SignerProvider, SignerServiceOptions } from './types.ts';

// A signing service owns its keys. Etherplan receives only addresses and signed envelopes.
export function createSignerServiceProvider({
  url,
  headers = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
}: SignerServiceOptions): SignerProvider {
  if (typeof url !== 'string') throw new Error('Signer service needs a URL.');
  let endpoint: URL;
  try {
    endpoint = new URL(url.endsWith('/') ? url : `${url}/`);
  } catch {
    throw new Error('Signer service URL is invalid.');
  }
  if (
    endpoint.protocol !== 'https:' &&
    !(
      endpoint.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
    )
  )
    throw new Error('Signer service requires HTTPS outside loopback.');
  if (endpoint.username || endpoint.password)
    throw new Error('Signer service URL cannot contain credentials; use headers.');
  if (typeof fetchImpl !== 'function') throw new Error('Signer service needs fetch.');
  async function request<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(new URL(route, endpoint), {
        method,
        headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(jsonSafe(body)) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error('Signer service request failed.');
    }
    if (!response.ok)
      throw new Error(
        Number.isInteger(response.status)
          ? `Signer service returned HTTP ${response.status}.`
          : 'Signer service returned an HTTP error.',
      );
    try {
      return (await response.json()) as T;
    } catch {
      throw new Error('Signer service returned invalid JSON.');
    }
  }
  return {
    async address(role) {
      const result = await request<{ address: Address }>(
        'GET',
        `address?role=${encodeURIComponent(role)}`,
      );
      return result.address;
    },
    async signTransaction(role, transaction, authorization) {
      const result = await request<{ rawTransaction: Hex }>('POST', 'sign', {
        role,
        transaction,
        authorization,
      });
      return result.rawTransaction;
    },
  };
}
