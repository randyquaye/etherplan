import type { LeaseFailure } from './types.ts';

/** RPC causes stay in memory. Only these fixed diagnostics may cross a persistence or output boundary. */
export type RpcFailure =
  'already-known' | 'nonce-too-low' | 'replacement-underpriced' | 'request-failed';

export function classifyRpcFailure(error: unknown): RpcFailure {
  const seen = new Set<unknown>();
  const statuses: string[] = [];
  for (
    let current = error;
    current && typeof current === 'object' && !seen.has(current);
    current = (current as { cause?: unknown }).cause
  ) {
    seen.add(current);
    const item = current as {
      code?: unknown;
      details?: unknown;
      shortMessage?: unknown;
      message?: unknown;
      name?: unknown;
    };
    for (const value of [item.code, item.name, item.details, item.shortMessage, item.message])
      if (typeof value === 'string') statuses.push(value.trim());
  }
  // Match the start of an individual status, never a keyword inside a URL, header or body dump.
  if (
    statuses.some((value) =>
      /^(?:(?:transaction )?already (?:known|imported)|known transaction|alreadyknown|TransactionAlreadyKnownError)(?:[.:\s]|$)/i.test(
        value,
      ),
    )
  )
    return 'already-known';
  if (
    statuses.some((value) =>
      /^(?:(?:the |transaction )?nonce(?: is)? too low|old nonce|noncetoolow(?:error)?|NONCE_TOO_LOW)(?:[.:\s]|$)/i.test(
        value,
      ),
    )
  )
    return 'nonce-too-low';
  if (
    statuses.some((value) =>
      /^(?:(?:replacement (?:transaction )?|transaction )?underpriced|ReplacementUnderpricedError)(?:[.:\s]|$)/i.test(
        value,
      ),
    )
  )
    return 'replacement-underpriced';
  return 'request-failed';
}

export function safeRpcMessage(
  failure: RpcFailure,
  operation: 'broadcast' | 'estimate' | 'request' = 'request',
): string {
  if (failure === 'already-known') return 'Transaction is already known to the RPC endpoint.';
  if (failure === 'nonce-too-low') return 'Transaction nonce is too low.';
  if (failure === 'replacement-underpriced') return 'Replacement transaction is underpriced.';
  if (operation === 'broadcast') return 'RPC broadcast request failed.';
  if (operation === 'estimate') return 'RPC gas estimation failed.';
  return 'RPC request failed.';
}

export function isRpcError(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (
    let current = error;
    current && typeof current === 'object' && !seen.has(current);
    current = (current as { cause?: unknown }).cause
  ) {
    seen.add(current);
    const item = current as { name?: unknown; details?: unknown; shortMessage?: unknown };
    if (
      typeof item.details === 'string' ||
      typeof item.shortMessage === 'string' ||
      (typeof item.name === 'string' &&
        /Rpc|HttpRequest|Timeout|RequestError|Transport/i.test(item.name))
    )
      return true;
  }
  return false;
}

/** Signer and lease providers are external boundaries; their error text may contain credentials. */
export function safeExternalError(_error: unknown): string {
  return 'External operation failed.';
}

const LEASE_TIMEOUT =
  /^(?:TimeoutError|RequestTimeout(?:Exception)?|ETIMEDOUT|ECONNABORTED|AbortError)$/i;
const LEASE_NETWORK =
  /^(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|NetworkingError|NetworkError|UND_ERR_[A-Z_]+)$/i;
const LEASE_THROTTLED =
  /^(?:ProvisionedThroughputExceededException|ThrottlingException|ThrottledException|RequestLimitExceeded|TooManyRequestsException)$/i;

/** Classify a lease renewal or check failure from error codes and names only, never message text. */
export function classifyLeaseFailure(error: unknown): LeaseFailure {
  const seen = new Set<unknown>();
  const statuses: string[] = [];
  for (
    let current = error;
    current && typeof current === 'object' && !seen.has(current);
    current = (current as { cause?: unknown }).cause
  ) {
    seen.add(current);
    const item = current as { code?: unknown; name?: unknown };
    for (const value of [item.code, item.name])
      if (typeof value === 'string') statuses.push(value.trim());
  }
  if (statuses.includes('lease-lost')) return 'lease-lost';
  if (statuses.includes('lease-expired')) return 'lease-expired';
  if (statuses.some((value) => LEASE_TIMEOUT.test(value))) return 'timeout';
  if (statuses.some((value) => LEASE_NETWORK.test(value))) return 'network';
  if (statuses.some((value) => LEASE_THROTTLED.test(value))) return 'throttled';
  return 'request-failed';
}

export function safeLeaseMessage(failure: LeaseFailure): string {
  switch (failure) {
    case 'lease-lost':
      return 'Writer lease is no longer held.';
    case 'lease-expired':
      return 'Writer lease expired before a renewal succeeded.';
    case 'timeout':
      return 'Writer lease renewal timed out.';
    case 'network':
      return 'Writer lease renewal could not reach the lock provider.';
    case 'throttled':
      return 'Writer lease renewal was throttled by the lock provider.';
    default:
      return 'Writer lease renewal failed.';
  }
}
