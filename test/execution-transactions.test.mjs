import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { signEnvelope, validateSignedTransaction } from '../src/execution/transactions.mjs';
import { TEST_KEYS } from './execution/chain.mjs';

const account = privateKeyToAccount(TEST_KEYS[0]);
const other = privateKeyToAccount(TEST_KEYS[1]);
const planned = { tx: { to: '0x0000000000000000000000000000000000000001', data: '0x1234', value: '7' } };
const envelope = { type: 'eip1559', chainId: 31337, nonce: 0, to: planned.tx.to, data: planned.tx.data,
  value: 7n, gas: 50_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n };
const intent = { signer: account.address, nonce: '0', to: envelope.to, value: '7', dataHash: keccak256(envelope.data),
  gas: String(envelope.gas), maxFeePerGas: String(envelope.maxFeePerGas), maxPriorityFeePerGas: '1' };

async function saved(signer = account, changes = {}) {
  const rawTransaction = await signer.signTransaction({ ...envelope, ...changes });
  return { signer: account.address, nonce: '0', rawTransaction, transactionHash: keccak256(rawTransaction) };
}

test('recovery validates the signed payload against the plan and durable intent', async () => {
  const valid = await saved();
  await validateSignedTransaction(valid, intent, planned, envelope.chainId);
  const variants = [
    ['hash', { ...valid, transactionHash: `0x${'00'.repeat(32)}` }, intent],
    ['sender', await saved(other), intent],
    ['chain', await saved(account, { chainId: 1 }), intent],
    ['nonce', await saved(account, { nonce: 1 }), intent],
    ['gas', await saved(account, { gas: envelope.gas + 1n }), intent],
    ['max fee', await saved(account, { maxFeePerGas: envelope.maxFeePerGas + 1n }), intent],
    ['priority fee', await saved(account, { maxPriorityFeePerGas: 2n }), intent],
    ['destination', await saved(account, { to: other.address }), intent],
    ['value', await saved(account, { value: 8n }), intent],
    ['data', await saved(account, { data: '0x5678' }), intent],
    ['intent signer', valid, { ...intent, signer: other.address }],
    ['intent nonce', valid, { ...intent, nonce: '1' }],
    ['intent destination', valid, { ...intent, to: other.address }],
    ['intent value', valid, { ...intent, value: '8' }],
    ['intent data hash', valid, { ...intent, dataHash: keccak256('0x5678') }],
    ['malformed bytes', { ...valid, rawTransaction: '0xzz' }, intent],
    ['undecodable bytes', { ...valid, rawTransaction: '0xdead', transactionHash: keccak256('0xdead') }, intent],
  ];
  for (const [name, signed, savedIntent] of variants) {
    await assert.rejects(validateSignedTransaction(signed, savedIntent, planned, envelope.chainId), Error, name);
  }
});

test('pipeline copies of intent fields are checked, and zero priority fee is valid', async () => {
  const zero = { ...envelope, maxPriorityFeePerGas: 0n };
  const signedBytes = await signEnvelope(account, zero);
  const zeroIntent = { ...intent, maxPriorityFeePerGas: '0', reservationId: 'reservation', wave: 1,
    signerRole: 'deployer', pooled: false, nonceOffset: 0 };
  const signed = { ...zeroIntent, phase: 'signed', ...signedBytes };
  await validateSignedTransaction(signed, zeroIntent, planned, zero.chainId);
  await assert.rejects(validateSignedTransaction({ ...signed, pooled: true }, zeroIntent, planned, zero.chainId), /Signed pooled/);
  await assert.rejects(validateSignedTransaction({ ...signed, reservationId: undefined }, zeroIntent, planned, zero.chainId), /Signed reservationId/);
});
