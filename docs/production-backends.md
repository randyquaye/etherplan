# Production recovery backends

Etherplan's local state file, journal, and process lock remain the default for development. A production apply passes a shared deployment scope and implementations of `stateStore`, `journalStore`, `lockProvider`, `journalCipher`, and `signerProvider` to `applyPlan`. The AWS reference implementation uses DynamoDB for conditional state, journal, and lease writes; KMS envelope encryption for signed bytes; and S3 for immutable plans. The signer service adapter sends transaction requests to a separate signer process and receives only an address or signed transaction.

## Deployment scope

A scope contains `project`, `environment`, `chainId`, `genesisHash`, and `label`. The chain values must match the saved plan. A deployment lock covers the complete scope. Signer locks cover the project, environment, chain, and signer address, regardless of deployment label. The lock provider returns monotonically increasing fencing tokens. Every DynamoDB state or journal transaction checks the deployment and signer tokens, holder identity, and live expiry. A lease renewal failure stops the next signature, broadcast, or state write.

Journal records include sequence, predecessor hash, plan hash, chain identity, action ID, phase, write time, and applying principal. Signed transaction bytes are encrypted before the journal store sees them. Recovery validates the complete ordered hash chain, decrypts signed records, checks the signed envelope against the pinned plan and durable intent, and resends the exact persisted bytes. An unfinished transaction for another plan stops a production apply before any write. Each signed append also writes a signer-wide index entry in the same fenced DynamoDB transaction. Before signing, apply checks indexed transactions from other labels for a canonical receipt at the configured confirmation depth. A missing or orphaned receipt stops the new label until the earlier label is resolved.

Production applies require an explicit positive `confirmations` value in deployment policy. A receipt is verified and released to dependent waves only after that many canonical blocks. On restart and before later batches or state writes, apply rechecks recorded receipts and stops on a reorganization. Local file applies use one confirmation unless `confirmations` is supplied. Confirmation depth is chain-specific and does not guarantee permanent finality.

## Programmatic apply

```js
import { applyPlan, createAwsBackend, createSignerServiceProvider } from './src/core.mjs';

const backend = createAwsBackend({
  tableName: 'etherplan-deployments',
  kmsKeyId: 'arn:aws:kms:REGION:ACCOUNT:key/KEY_ID',
  bucket: 'etherplan-plans',
});
const scope = {
  project: 'my-app', environment: 'testnet', label: 'blue',
  chainId: plan.chain.id, genesisHash: plan.chain.genesisHash,
};
const signerProvider = createSignerServiceProvider({ url: 'https://signer.example.test/' });
await backend.planStore.put(scope, plan);
const result = await applyPlan({
  plan, spec, artifacts, client, signerProvider,
  stateStore: backend.stateStore, journalStore: backend.journalStore,
  lockProvider: backend.lockProvider, journalCipher: backend.journalCipher,
  scope, principal: 'ci-role/my-app-deploy', confirmations: 12,
  reporter: event => deploymentLog.write(event),
});
```

`signerProvider.address(role)` and `signerProvider.signTransaction(role, request, authorization)` are the only required signer methods. The default roles are `deployer` and, when the plan needs it, `owner`. Pass `signerRoles: { deployer: ['role-a', 'role-b'], owner: 'owner-role' }` for multiple deployers. The optional third argument contains the scope and current fencing tokens. A production signer service should validate these tokens against the lock table before signing, so an expired runner cannot sign while its old request is still in flight. Etherplan decodes every returned EIP-1559 transaction and verifies chain ID, sender, nonce, destination, value, calldata, gas, and fees before persisting it. The signer service adapter calls `GET /address?role=...` and `POST /sign` with `{ role, transaction, authorization }`; the latter returns `{ rawTransaction }`. Use HTTPS except for local loopback testing.

The reporter receives JSON-safe events with plan and chain identity, scope, principal, action, sequence, and phase. Events include lock acquisition and renewal, intent, signed, broadcast attempt and result, receipt, verification, recovery, rebroadcast, conflict, and terminal failure. Timing fields include lock wait, journal append, signer, broadcast, and receipt latency. The reporter must not log raw signed bytes.

## AWS CLI

Create a non-secret backend config file:

```json
{
  "kind": "aws",
  "tableName": "etherplan-deployments",
  "kmsKeyId": "arn:aws:kms:REGION:ACCOUNT:key/KEY_ID",
  "bucket": "etherplan-plans",
  "confirmations": 12,
  "scope": { "project": "my-app", "environment": "testnet", "label": "blue" }
}
```

The DynamoDB table has string partition key `PK` and string sort key `SK`. Enable point-in-time recovery. Configure the S3 bucket with versioning or Object Lock and deny plan deletion or overwrite in IAM. The CLI uses the AWS SDK credential chain; do not place AWS credentials or private keys in this config. `plan` writes its hash-addressed plan object to S3. `apply` checks the archived plan before signing.

For an existing installation, stop all apply runners and reconcile every previously signed transaction to the chosen confirmation depth before upgrading all runners together. Older journal entries have no signer index entry; mixed-version runners cannot safely share a signer across labels. A custom remote `journalStore` must provide `signedForSigner(scope, address)` with consistent reads and write each signed entry atomically with its journal append under the signer fence.

```sh
node src/cli.mjs plan --spec spec.json --backend backend.json --deployers 0xYourDeployer --max-spend-wei 100000000000000000 --out plan.json
node src/cli.mjs apply --spec spec.json --plan plan.json --backend backend.json --signer-module signer.mjs
node src/cli.mjs status --plan plan.json --backend backend.json
```

A signer module exports `signerProvider` (and optionally `signerRoles`). It can use `createSignerServiceProvider`, a hardware wallet, or an organization-specific signer. `status` is read-only: it reports lock holder and expiry, active or abandoned lease state, plan hash, last journal phase, sequence, and state version without decrypting signed bytes.

## KMS transaction signers

`createKmsSignerProvider` implements the signer-module interface using AWS KMS asymmetric secp256k1 keys. It calls `GetPublicKey` when the module loads, checks `ECC_SECG_P256K1`, `SIGN_VERIFY`, and `ECDSA_SHA_256`, derives the Ethereum address, and pins the resolved key ID so an alias change cannot silently change the signing key. For each EIP-1559 transaction it asks KMS to sign the Ethereum transaction digest with `MessageType: DIGEST`, normalizes the DER signature to Ethereum's low-s form, recovers the signature parity, and serializes the signed transaction. Apply independently checks the returned bytes against its requested envelope and pinned signer address.

For example, save this as `signer.mjs` in a project that has Etherplan installed:

```js
import { createKmsSignerProvider } from 'etherplan/src/core.mjs';

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
etherplan plan --spec spec.json --signer-module signer.mjs --parallel --max-spend-wei 100000000000000000 --out plan.json
etherplan apply --spec spec.json --plan plan.json --signer-module signer.mjs --parallel
```

Add `--backend backend.json` to both commands when shared AWS recovery is needed. The backend's `kmsKeyId` remains a **separate symmetric encryption key** for the journal and S3; an `ECC_SECG_P256K1` signing key cannot replace it. An in-process KMS module means the apply runner itself has `kms:Sign` permission. A separate signer service can instead hold that permission and independently validate the supplied lease fencing tokens before signing. Local recovery stores signed transaction bytes in a mode-`0600` journal; it never stores KMS private key material.

Single-signer pipelining works with the backend. Pass `--pipeline --deployers <signer address>` to `plan`, and `--pipeline` to `apply`. Signed bytes for a nonce reservation are encrypted in the journal like any other signed record, and a replacement runner resumes the reservation without signing again. Apply checks the leases before each signature and once before the first broadcasts of a signer group, so a lost lease stops the group before it reaches the chain.

Grant the planner only chain read access, DynamoDB `GetItem` for state, S3 `PutObject`/`GetObject` on its plan prefix, and the KMS permission required for S3 server-side encryption. A planner that loads a KMS signer module also needs `kms:GetPublicKey` on its signing keys. Grant the apply runner DynamoDB `GetItem`, `Query`, `UpdateItem`, and `TransactWriteItems` on its scoped keys, S3 `GetObject` on plans, and KMS `GenerateDataKey`/`Decrypt` for the journal key. With an in-process KMS signer, the apply runner also needs `kms:GetPublicKey` and `kms:Sign` on the signing keys. With a separate signer service, give that service the signing permission and let the apply runner call it. An auditor needs DynamoDB `GetItem`/`Query` only. Scope all policies by resource ARN and deployment key prefix; deny destructive S3 and DynamoDB actions to normal runners.

The local CLI remains available without `--backend`. The AWS path requires a shared table, bucket, KMS key, and signer service; local files are not copied to a replacement runner. Production `import` is not supported by the CLI.
