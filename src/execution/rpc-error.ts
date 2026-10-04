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
