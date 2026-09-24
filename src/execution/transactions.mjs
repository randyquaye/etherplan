import { isAddressEqual, keccak256, parseTransaction, recoverTransactionAddress } from 'viem';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function toBigInt(value, name) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return BigInt(value);
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new Error(`${name} must be a non-negative integer.`);
}

export async function feesFor(client, override) {
  const fees = override ?? await client.estimateFeesPerGas();
  return {
    maxFeePerGas: toBigInt(fees.maxFeePerGas, 'maxFeePerGas'),
    maxPriorityFeePerGas: toBigInt(fees.maxPriorityFeePerGas, 'maxPriorityFeePerGas'),
  };
}

export async function estimateGasLimit(client, { from, tx, gasMultiplier }) {
  const estimate = await client.estimateGas({ account: from, to: tx.to, data: tx.data, value: toBigInt(tx.value, 'value') });
  const scale = BigInt(Math.round(gasMultiplier * 1000));
  return (estimate * scale + 999n) / 1000n;
}

export function maximumCost(envelope) {
  return envelope.gas * envelope.maxFeePerGas + envelope.value;
}

// Signs with the supplied account, then decodes the bytes and recovers the sender, so a faulty signer cannot change the payload.
export async function signEnvelope(signer, envelope) {
  const rawTransaction = await signer.signTransaction({ type: 'eip1559', ...envelope });
  if (typeof rawTransaction !== 'string' || !/^0x[0-9a-fA-F]+$/.test(rawTransaction)) throw new Error('Signer did not return a raw transaction.');
  const parsed = parseTransaction(rawTransaction);
  const same = parsed.type === 'eip1559' &&
    parsed.chainId === envelope.chainId &&
    parsed.nonce === envelope.nonce &&
    parsed.to?.toLowerCase() === envelope.to.toLowerCase() &&
    (parsed.data ?? '0x').toLowerCase() === envelope.data.toLowerCase() &&
    (parsed.value ?? 0n) === envelope.value &&
    parsed.gas === envelope.gas &&
    parsed.maxFeePerGas === envelope.maxFeePerGas &&
    parsed.maxPriorityFeePerGas === envelope.maxPriorityFeePerGas;
  if (!same) throw new Error('Signed transaction differs from the requested envelope.');
  const sender = await recoverTransactionAddress({ serializedTransaction: rawTransaction });
  if (!isAddressEqual(sender, signer.address)) throw new Error(`Signed transaction sender ${sender} is not ${signer.address}.`);
  return { rawTransaction, transactionHash: keccak256(rawTransaction) };
}

function errorText(error) {
  const parts = [];
  for (let item = error; item; item = item.cause) parts.push(item.details, item.shortMessage, item.message);
  return parts.filter(Boolean).join(' ');
}

export async function broadcast(client, rawTransaction) {
  try {
    await client.request({ method: 'eth_sendRawTransaction', params: [rawTransaction] });
    return { accepted: true };
  } catch (error) {
    const text = errorText(error);
    if (/already known|known transaction|already imported|alreadyknown/i.test(text)) return { accepted: true, known: true };
    if (/nonce too low|nonce is too low|noncetoolow|old nonce/i.test(text)) return { accepted: false, nonceTooLow: true, error: text };
    if (/underpriced/i.test(text)) return { accepted: false, replacementUnderpriced: true, error: text };
    return { accepted: false, error: text };
  }
}

export async function findReceipt(client, hash) {
  try {
    return await client.getTransactionReceipt({ hash });
  } catch (error) {
    if (error.name === 'TransactionReceiptNotFoundError') return null;
    throw error;
  }
}

export async function nonceConsumed(client, signer, nonce) {
  const latest = await client.getTransactionCount({ address: signer, blockTag: 'latest' });
  return BigInt(latest) > BigInt(nonce);
}

// Waits until the transaction has a receipt, another transaction uses its nonce, or the timeout passes.
export async function waitForReceipt(client, { hash, signer, nonce, pollIntervalMs, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await findReceipt(client, hash);
    if (receipt) return { receipt };
    if (await nonceConsumed(client, signer, nonce)) {
      const late = await findReceipt(client, hash);
      return late ? { receipt: late } : { dead: true };
    }
    if (Date.now() >= deadline) return { timeout: true };
    await sleep(pollIntervalMs);
  }
}

export function receiptJson(receipt) {
  return {
    transactionHash: receipt.transactionHash,
    status: receipt.status,
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice?.toString() ?? null,
  };
}
