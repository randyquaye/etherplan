import { createPublicKey } from 'node:crypto';
import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { getAddress, hexToBytes, keccak256, recoverAddress, serializeTransaction, toHex } from 'viem';

const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_ORDER = CURVE_ORDER / 2n;
const SIGNING_ALGORITHM = 'ECDSA_SHA_256';

function regionOf(keyId) {
  return /^arn:[^:]+:kms:([^:]+):[^:]+:(?:key|alias)\/.+$/.exec(keyId)?.[1] ?? null;
}

function addressFromPublicKey(bytes) {
  let key;
  try {
    key = createPublicKey({ key: Buffer.from(bytes), format: 'der', type: 'spki' });
  } catch {
    throw new Error('KMS returned an invalid DER public key.');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'secp256k1') {
    throw new Error('KMS public key is not secp256k1.');
  }
  const { x, y } = key.export({ format: 'jwk' });
  const coordinates = Buffer.concat([Buffer.from(x, 'base64url'), Buffer.from(y, 'base64url')]);
  if (coordinates.length !== 64) throw new Error('KMS public key has invalid secp256k1 coordinates.');
  return getAddress(`0x${keccak256(coordinates).slice(-40)}`);
}

function derSignature(bytes) {
  const der = Buffer.from(bytes);
  if (der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2) throw new Error('KMS returned an invalid DER signature.');
  let offset = 2;
  function integer() {
    if (der[offset++] !== 0x02) throw new Error('KMS returned an invalid DER signature.');
    const length = der[offset++];
    if (!length || offset + length > der.length) throw new Error('KMS returned an invalid DER signature.');
    const value = der.subarray(offset, offset + length);
    offset += length;
    if (value[0] & 0x80 || (length > 1 && value[0] === 0 && !(value[1] & 0x80))) {
      throw new Error('KMS returned a noncanonical DER signature.');
    }
    const positive = value[0] === 0 ? value.subarray(1) : value;
    if (positive.length > 32) throw new Error('KMS returned an out-of-range DER signature.');
    const number = BigInt(`0x${positive.toString('hex') || '0'}`);
    if (number <= 0n || number >= CURVE_ORDER) throw new Error('KMS returned an out-of-range DER signature.');
    return number;
  }
  const r = integer();
  let s = integer();
  if (offset !== der.length) throw new Error('KMS returned an invalid DER signature.');
  if (s > HALF_ORDER) s = CURVE_ORDER - s;
  return { r: toHex(r, { size: 32 }), s: toHex(s, { size: 32 }) };
}

/** Create a signer provider for role-to-KMS-key mappings. Keys must share one AWS region. */
export async function createKmsSignerProvider({ keys, region, kms } = {}) {
  if (!keys || Array.isArray(keys) || typeof keys !== 'object' || Object.keys(keys).length === 0 ||
    Object.entries(keys).some(([role, keyId]) => !role || typeof keyId !== 'string' || !keyId.trim())) {
    throw new Error('KMS signer needs a nonempty keys mapping from roles to KMS key IDs or ARNs.');
  }
  const regions = [...new Set(Object.values(keys).map(regionOf).filter(Boolean))];
  if (regions.length > 1 || (region && regions.length && region !== regions[0])) {
    throw new Error('KMS signer keys and configured region must agree on one AWS region.');
  }
  const client = kms ?? new KMSClient({ region: region ?? regions[0] });
  const accounts = new Map();
  for (const [role, requestedKeyId] of Object.entries(keys)) {
    const publicKey = await client.send(new GetPublicKeyCommand({ KeyId: requestedKeyId }));
    if (publicKey.KeySpec !== 'ECC_SECG_P256K1' || publicKey.KeyUsage !== 'SIGN_VERIFY' ||
      !publicKey.SigningAlgorithms?.includes(SIGNING_ALGORITHM) || !publicKey.PublicKey || !publicKey.KeyId) {
      throw new Error(`KMS key for ${role} must have ECC_SECG_P256K1, SIGN_VERIFY, ECDSA_SHA_256, and a public key.`);
    }
    accounts.set(role, { keyId: publicKey.KeyId, address: addressFromPublicKey(publicKey.PublicKey) });
  }

  function accountFor(role) {
    const account = accounts.get(role);
    if (!account) throw new Error(`Unknown KMS signer role: ${role}`);
    return account;
  }

  return {
    async address(role) { return accountFor(role).address; },
    async signTransaction(role, transaction) {
      const { keyId, address } = accountFor(role);
      if (transaction?.type !== 'eip1559') throw new Error('KMS signer requires an EIP-1559 transaction.');
      const digest = keccak256(serializeTransaction(transaction));
      const result = await client.send(new SignCommand({
        KeyId: keyId, Message: hexToBytes(digest), MessageType: 'DIGEST', SigningAlgorithm: SIGNING_ALGORITHM,
      }));
      if (!result.Signature || (result.KeyId && result.KeyId !== keyId) ||
        (result.SigningAlgorithm && result.SigningAlgorithm !== SIGNING_ALGORITHM)) {
        throw new Error(`KMS returned no valid signature for ${role}.`);
      }
      const { r, s } = derSignature(result.Signature);
      for (const yParity of [0, 1]) {
        const signature = { r, s, yParity };
        const recovered = await recoverAddress({ hash: digest, signature });
        if (recovered.toLowerCase() === address.toLowerCase()) {
          return serializeTransaction(transaction, signature);
        }
      }
      throw new Error(`KMS signature for ${role} does not recover to its public key address.`);
    },
  };
}
