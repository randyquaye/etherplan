# KMS transaction signers

Part of [Shared deployment operations](index.md).

`createKmsSignerProvider` implements the signer-module interface using AWS KMS asymmetric secp256k1 keys. It calls `GetPublicKey` when the module loads, checks `ECC_SECG_P256K1`, `SIGN_VERIFY`, and `ECDSA_SHA_256`, derives the Ethereum address, and pins the resolved key ID so an alias change cannot silently change the signing key. For each EIP-1559 transaction it asks KMS to sign the Ethereum transaction digest with `MessageType: DIGEST`, normalizes the DER signature to Ethereum's low-s form, recovers the signature parity, and serializes the signed transaction. Apply independently checks the returned bytes against its requested envelope and pinned signer address.

## Set up a signer module

For example, save this as `signer.mjs` in a project that has Etherplan installed:

```js
import { createKmsSignerProvider } from 'etherplan';

export const signerRoles = { deployer: ['deployer-a', 'deployer-b'] };
export const signerProvider = await createKmsSignerProvider({
  keys: {
    'deployer-a': process.env.ETHERPLAN_KMS_DEPLOYER_A_ARN,
    'deployer-b': process.env.ETHERPLAN_KMS_DEPLOYER_B_ARN,
  },
});
```

Add an `owner` key and `owner: 'owner'` to `signerRoles` when owner actions need a separate signer. The role order must match the saved plan's deployer order. Full KMS key ARNs let the provider infer the region; for aliases or key IDs, use the AWS SDK's configured region or pass `region`. All keys in one provider must use the same region. The runner's AWS identity needs `kms:GetPublicKey` and `kms:Sign` on every signing key. No AWS credentials belong in the module or plan.

```sh
etherplan plan --signer-module signer.mjs --parallel --max-spend-wei 100000000000000000 --out plan.json
etherplan apply --plan plan.json --signer-module signer.mjs --parallel
```

## Shared recovery and pipelining

Add `--backend backend.json` to both commands when shared AWS recovery is needed. The backend's `kmsKeyId` remains a **separate symmetric encryption key** for the journal and S3; an `ECC_SECG_P256K1` signing key cannot replace it. An in-process KMS module means the apply runner itself has `kms:Sign` permission. A separate signer service can instead hold that permission and independently validate the supplied lease fencing tokens before signing. Local recovery stores signed transaction bytes in a mode-`0600` journal; it never stores KMS private key material.

Single-signer pipelining works with the backend. Pass `--pipeline --deployers <signer address>` to `plan`, and `--pipeline` to `apply`. Signed bytes for a nonce reservation are encrypted in the journal like any other signed record, and a replacement runner resumes the reservation without signing again. Apply checks the leases before each signature and once before the first broadcasts of a signer group, so a lost lease stops the group before it reaches the chain.

See [AWS permissions](permissions.md) for the initializer, planner, apply runner, signer, and auditor policies.

The local CLI remains available without `--backend`. The AWS path requires a shared table, plan bucket, symmetric KMS journal key, and signer provider. The provider can be an in-process KMS module or a separate signer service; local files are not copied to a replacement runner. Production `import` is not supported by the CLI.

[Previous: AWS CLI setup](aws-cli.md) · [Next: AWS permissions](permissions.md)
