import { jsonSafe } from './preflight.mjs';

// A signing service owns its keys. Etherplan receives only addresses and signed envelopes.
export function createSignerServiceProvider({ url, headers = {}, fetchImpl = globalThis.fetch, timeoutMs = 30_000 }) {
  const endpoint = new URL(url.endsWith('/') ? url : `${url}/`);
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))) throw new Error('Signer service requires HTTPS outside loopback.');
  if (typeof fetchImpl !== 'function') throw new Error('Signer service needs fetch.');
  async function request(method, route, body) {
    const response = await fetchImpl(new URL(route, endpoint), {
      method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(jsonSafe(body)) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Signer service returned HTTP ${response.status}.`);
    return response.json();
  }
  return {
    async address(role) {
      const result = await request('GET', `address?role=${encodeURIComponent(role)}`);
      return result.address;
    },
    async signTransaction(role, transaction, authorization) {
      const result = await request('POST', 'sign', { role, transaction, authorization });
      return result.rawTransaction;
    },
  };
}
