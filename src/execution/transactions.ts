import { isAddress, isAddressEqual, keccak256, parseTransaction, recoverTransactionAddress } from 'viem';
import type { TransactionSerialized } from 'viem';
import type { PlannedResource } from '../planning/types.ts';
import type { Address, Client, DecimalString, Hash, Hex } from '../types.ts';
import type { BroadcastOutcome, EstimateGasInput, FeeOverride, IntentFields, IntentRecord, Receipt, ReceiptJson, ReceiptWait, SignedBytes, SignedRecord, SignerAccount, TransactionEnvelope, WaitForReceiptInput } from './types.ts';

/** What a thrown RPC error may carry; each level is read optionally. */
interface ErrorLike {
  cause?: unknown;
  details?: unknown;
  shortMessage?: unknown;
  message?: unknown;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function toBigInt(value: unknown, name: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new Error(`${name} must be a non-negative integer.`);
}

export async function feesFor(client: Client, override?: FeeOverride | null): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const fees = override ?? await client.estimateFeesPerGas();
  return {
    maxFeePerGas: toBigInt(fees.maxFeePerGas, 'maxFeePerGas'),
    maxPriorityFeePerGas: toBigInt(fees.maxPriorityFeePerGas, 'maxPriorityFeePerGas'),
  };
}

export async function estimateGasLimit(client: Client, { from, tx, gasMultiplier }: EstimateGasInput): Promise<bigint> {
  const estimate = await client.estimateGas({ account: from, to: tx.to, data: tx.data, value: toBigInt(tx.value, 'value') });
  const scale = BigInt(Math.round(gasMultiplier * 1000));
  return (estimate * scale + 999n) / 1000n;
}

export function maximumCost(envelope: Pick<TransactionEnvelope, 'gas' | 'maxFeePerGas' | 'value'>): bigint {
  return envelope.gas * envelope.maxFeePerGas + envelope.value;
}

// Signs with the supplied account, then decodes the bytes and recovers the sender, so a faulty signer cannot change the payload.
export async function signEnvelope(signer: SignerAccount, envelope: TransactionEnvelope): Promise<SignedBytes> {
  const result = await signer.signTransaction({ type: 'eip1559', ...envelope });
  const rawTransaction = typeof result === 'string' ? result : result?.rawTransaction;
  if (typeof rawTransaction !== 'string' || !/^0x[0-9a-fA-F]+$/.test(rawTransaction)) throw new Error('Signer did not return a raw transaction.');
  // parseTransaction rejects bytes that are not a typed or legacy transaction.
  const parsed = parseTransaction(rawTransaction as TransactionSerialized);
  const same = parsed.type === 'eip1559' &&
    parsed.chainId === envelope.chainId &&
    parsed.nonce === envelope.nonce &&
    parsed.to?.toLowerCase() === envelope.to.toLowerCase() &&
    (parsed.data ?? '0x').toLowerCase() === envelope.data.toLowerCase() &&
    (parsed.value ?? 0n) === envelope.value &&
    parsed.gas === envelope.gas &&
    parsed.maxFeePerGas === envelope.maxFeePerGas &&
    (parsed.maxPriorityFeePerGas ?? 0n) === envelope.maxPriorityFeePerGas;
  if (!same) throw new Error('Signed transaction differs from the requested envelope.');
  const sender = await recoverTransactionAddress({ serializedTransaction: rawTransaction as TransactionSerialized });
  if (!isAddressEqual(sender, signer.address)) throw new Error(`Signed transaction sender ${sender} is not ${signer.address}.`);
  return { rawTransaction, transactionHash: keccak256(rawTransaction) };
}

// Recovery must validate bytes from disk before resending them. The saved plan supplies
// the payload, while the intent supplies the live nonce, gas and fee choices.
export async function validateSignedTransaction(signed: SignedRecord, intent: IntentRecord, planned: PlannedResource, chainId: number): Promise<bigint> {
  if (typeof signed.rawTransaction !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(signed.rawTransaction)) throw new Error('Saved signed transaction has malformed raw bytes.');
  if (typeof signed.transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(signed.transactionHash) ||
    keccak256(signed.rawTransaction).toLowerCase() !== signed.transactionHash.toLowerCase()) throw new Error('Signed transaction hash differs from its raw bytes.');
  if (!isAddress(intent.signer ?? '') || !isAddress(signed.signer ?? '') ||
    !isAddressEqual(intent.signer, signed.signer)) throw new Error('Signed signer differs from the durable intent.');
  // Pipeline records copy the full intent; serial records copy only signer and nonce.
  const duplicateFields: (keyof IntentFields)[] = ['wave', 'reservationId', 'signerRole', 'pooled', 'nonceOffset', 'nonce', 'to', 'value', 'dataHash', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'replacement', 'replacesTransactionHash', 'maxCostWei'];
  for (const field of duplicateFields) {
    if ((intent.reservationId || field === 'nonce' || field in signed) &&
      String(signed[field]).toLowerCase() !== String(intent[field]).toLowerCase()) throw new Error(`Signed ${field} differs from the durable intent.`);
  }
  const tx = planned.tx;
  if (tx === undefined) throw new Error('Saved plan entry has no transaction payload.');
  if (intent.to?.toLowerCase() !== tx.to.toLowerCase() ||
    String(intent.value) !== String(tx.value) ||
    intent.dataHash?.toLowerCase() !== keccak256(tx.data).toLowerCase()) throw new Error('Durable intent differs from the saved plan.');
  let parsed: ReturnType<typeof parseTransaction>;
  try { parsed = parseTransaction(signed.rawTransaction as TransactionSerialized); }
  catch { throw new Error('Saved signed transaction cannot be decoded.'); }
  let sender: Address;
  try { sender = await recoverTransactionAddress({ serializedTransaction: signed.rawTransaction as TransactionSerialized }); }
  catch { throw new Error('Saved signed transaction sender cannot be recovered.'); }
  const nonce = Number(intent.nonce);
  if (!Number.isSafeInteger(nonce) || nonce < 0 || String(nonce) !== String(intent.nonce)) throw new Error('Durable intent has an invalid nonce.');
  const expected = {
    chainId,
    nonce,
    to: tx.to.toLowerCase(),
    data: tx.data.toLowerCase(),
    value: toBigInt(tx.value, 'Plan value'),
    gas: toBigInt(intent.gas, 'Intent gas'),
    maxFeePerGas: toBigInt(intent.maxFeePerGas, 'Intent maxFeePerGas'),
    maxPriorityFeePerGas: toBigInt(intent.maxPriorityFeePerGas, 'Intent maxPriorityFeePerGas'),
  };
  if (parsed.type !== 'eip1559' || parsed.chainId !== expected.chainId || parsed.nonce !== expected.nonce ||
    parsed.to?.toLowerCase() !== expected.to || (parsed.data ?? '0x').toLowerCase() !== expected.data ||
    (parsed.value ?? 0n) !== expected.value || parsed.gas !== expected.gas ||
    parsed.maxFeePerGas !== expected.maxFeePerGas || (parsed.maxPriorityFeePerGas ?? 0n) !== expected.maxPriorityFeePerGas ||
    !isAddressEqual(sender, intent.signer)) throw new Error('Saved signed transaction differs from its plan or intent.');
  if (intent.replacement && maximumCost(expected) > toBigInt(intent.maxCostWei, 'Replacement maxCostWei')) throw new Error('Signed replacement exceeds its reviewed spend ceiling.');
  return maximumCost(expected);
}

function errorText(error: unknown): string {
  const parts: unknown[] = [];
  for (let item: unknown = error; item; item = (item as ErrorLike).cause) {
    const { details, shortMessage, message } = item as ErrorLike;
    parts.push(details, shortMessage, message);
  }
  return parts.filter(Boolean).join(' ').replace(/0x[0-9a-fA-F]{64,}/g, '[redacted hex]');
}

export async function broadcast(client: Client, rawTransaction: Hex): Promise<BroadcastOutcome> {
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

export async function findReceipt(client: Client, hash: Hash): Promise<Receipt | null> {
  try {
    return await client.getTransactionReceipt({ hash });
  } catch (error) {
    if ((error as Error).name === 'TransactionReceiptNotFoundError') return null;
    throw error;
  }
}

export async function findKnownReceipt(client: Client, signedVariants: { transactionHash: Hash }[]): Promise<Receipt | null> {
  for (const signed of signedVariants) {
    const receipt = await findReceipt(client, signed.transactionHash);
    if (receipt) return receipt;
  }
  return null;
}

export async function nonceConsumed(client: Client, signer: Address, nonce: DecimalString | number | bigint): Promise<boolean> {
  const latest = await client.getTransactionCount({ address: signer, blockTag: 'latest' });
  return BigInt(latest) > BigInt(nonce);
}

// Waits until the transaction has a receipt, another transaction uses its nonce, or the timeout passes.
export async function waitForReceipt(client: Client, { hash, signedVariants, signer, nonce, pollIntervalMs, timeoutMs }: WaitForReceiptInput): Promise<ReceiptWait> {
  const deadline = Date.now() + timeoutMs;
  const variants = signedVariants ?? (hash === undefined ? [] : [{ transactionHash: hash }]);
  for (;;) {
    const receipt = await findKnownReceipt(client, variants);
    if (receipt) return { receipt };
    if (await nonceConsumed(client, signer, nonce)) {
      const late = await findKnownReceipt(client, variants);
      return late ? { receipt: late } : { dead: true };
    }
    if (Date.now() >= deadline) return { timeout: true };
    await sleep(pollIntervalMs);
  }
}

export function receiptJson(receipt: Receipt): ReceiptJson {
  return {
    transactionHash: receipt.transactionHash,
    status: receipt.status,
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice?.toString() ?? null,
  };
}
