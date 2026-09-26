import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { GetPublicKeyCommand, SignCommand } from '@aws-sdk/client-kms';
import { keccak256, parseTransaction, recoverTransactionAddress, serializeTransaction, toHex } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { createKmsSignerProvider } from '../src/execution/kms-signer.mjs';
import { signEnvelope } from '../src/execution/transactions.mjs';

const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const transaction = {
  type: 'eip1559', chainId: 31337, nonce: 7, to: '0x000000000000000000000000000000000000dEaD',
  data: '0x1234', value: 5n, gas: 25_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n,
};

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const secret = toHex(Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url'));
  return { secret, address: privateKeyToAccount(secret).address, publicKey: publicKey.export({ format: 'der', type: 'spki' }) };
}

function derInteger(number) {
  const hex = number.toString(16);
  let bytes = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
  while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.subarray(1);
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return Buffer.concat([Buffer.from([2, bytes.length]), bytes]);
}

function derSignature(r, s) {
  const parts = Buffer.concat([derInteger(r), derInteger(s)]);
  return Buffer.concat([Buffer.from([0x30, parts.length]), parts]);
}

function fakeKms(keys, { highS = false, malformed = false } = {}) {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command);
      if (command instanceof GetPublicKeyCommand) {
        const key = keys[command.input.KeyId];
        if (!key) throw new Error('Unknown fake key');
        return {
          KeyId: key.keyId ?? command.input.KeyId,
          KeySpec: key.keySpec ?? 'ECC_SECG_P256K1', KeyUsage: 'SIGN_VERIFY',
          SigningAlgorithms: ['ECDSA_SHA_256'], PublicKey: key.publicKey,
        };
      }
      if (command instanceof SignCommand) {
        const key = keys[command.input.KeyId];
        if (!key) throw new Error('Unknown fake key');
        assert.equal(command.input.MessageType, 'DIGEST');
        assert.equal(command.input.SigningAlgorithm, 'ECDSA_SHA_256');
        const signature = await sign({ hash: toHex(command.input.Message), privateKey: key.secret });
        const s = BigInt(signature.s);
        return {
          KeyId: command.input.KeyId, SigningAlgorithm: 'ECDSA_SHA_256',
          Signature: malformed ? Buffer.from([0x30, 0x00]) : derSignature(BigInt(signature.r), highS ? CURVE_ORDER - s : s),
        };
      }
      throw new Error('Unexpected KMS command');
    },
  };
}

test('KMS provider pins aliases, maps multiple roles, and signs the Ethereum digest with low-s', async () => {
  const first = keyPair();
  const second = keyPair();
  const keys = {
    'alias/first': { ...first, keyId: 'arn:aws:kms:eu-west-2:123456789012:key/first' },
    'arn:aws:kms:eu-west-2:123456789012:key/first': first,
    'arn:aws:kms:eu-west-2:123456789012:key/second': second,
  };
  const kms = fakeKms(keys, { highS: true });
  const provider = await createKmsSignerProvider({
    keys: { primary: 'alias/first', secondary: 'arn:aws:kms:eu-west-2:123456789012:key/second' }, kms,
  });
  assert.equal(await provider.address('primary'), first.address);
  assert.equal(await provider.address('secondary'), second.address);
  for (const [role, account] of [['primary', first], ['secondary', second]]) {
    const raw = await provider.signTransaction(role, transaction);
    assert.equal(await recoverTransactionAddress({ serializedTransaction: raw }), account.address);
    assert.ok(BigInt(parseTransaction(raw).s) <= CURVE_ORDER / 2n);
  }
  const signs = kms.calls.filter(command => command instanceof SignCommand);
  assert.equal(signs[0].input.KeyId, 'arn:aws:kms:eu-west-2:123456789012:key/first');
  assert.equal(toHex(signs[0].input.Message), keccak256(serializeTransaction(transaction)));
  const signed = await signEnvelope({ address: first.address, signTransaction: tx => provider.signTransaction('primary', tx) }, transaction);
  assert.equal(signed.transactionHash, keccak256(signed.rawTransaction));
});

test('KMS provider rejects wrong key type, region, malformed signatures, and unknown roles', async () => {
  const key = keyPair();
  const arn = 'arn:aws:kms:eu-west-2:123456789012:key/first';
  await assert.rejects(createKmsSignerProvider({ keys: { deployer: arn }, region: 'us-east-1' }), /one AWS region/);
  await assert.rejects(createKmsSignerProvider({ keys: { deployer: arn }, kms: fakeKms({ [arn]: { ...key, keySpec: 'ECC_NIST_P256' } }) }), /ECC_SECG_P256K1/);
  const provider = await createKmsSignerProvider({ keys: { deployer: arn }, kms: fakeKms({ [arn]: key }, { malformed: true }) });
  await assert.rejects(provider.address('owner'), /Unknown KMS signer role/);
  await assert.rejects(provider.signTransaction('deployer', transaction), /invalid DER signature/);
  await assert.rejects(provider.signTransaction('deployer', { ...transaction, type: 'legacy' }), /EIP-1559/);
});

test('KMS provider rejects a signature made by a different key', async () => {
  const claimed = keyPair();
  const actual = keyPair();
  const arn = 'arn:aws:kms:eu-west-2:123456789012:key/first';
  const kms = {
    async send(command) {
      if (command instanceof GetPublicKeyCommand) return { KeyId: arn, KeySpec: 'ECC_SECG_P256K1', KeyUsage: 'SIGN_VERIFY', SigningAlgorithms: ['ECDSA_SHA_256'], PublicKey: claimed.publicKey };
      const signature = await sign({ hash: toHex(command.input.Message), privateKey: actual.secret });
      return { KeyId: arn, Signature: derSignature(BigInt(signature.r), BigInt(signature.s)) };
    },
  };
  const provider = await createKmsSignerProvider({ keys: { deployer: arn }, kms });
  await assert.rejects(provider.signTransaction('deployer', transaction), /does not recover/);
});
