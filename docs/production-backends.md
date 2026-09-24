# Production recovery backends

Etherplan's local state file, journal, and process lock remain the default for development. A production apply passes a shared deployment scope and implementations of `stateStore`, `journalStore`, `lockProvider`, `journalCipher`, and `signerProvider` to `applyPlan`. The AWS reference implementation uses DynamoDB for conditional state, journal, and lease writes; KMS envelope encryption for signed bytes; and S3 for immutable plans. The signer service adapter sends transaction requests to a separate signer process and receives only an address or signed transaction.

## Deployment scope

A scope contains `project`, `environment`, `chainId`, `genesisHash`, and `label`. The chain values must match the saved plan. A deployment lock covers the complete scope. Signer locks cover the project, environment, chain, and signer address, regardless of deployment label. The lock provider returns monotonically increasing fencing tokens. Every DynamoDB state or journal transaction checks the deployment and signer tokens, holder identity, and live expiry. A lease renewal failure stops the next signature, broadcast, or state write.

Journal records include sequence, predecessor hash, plan hash, chain identity, action ID, phase, write time, and applying principal. Signed transaction bytes are encrypted before the journal store sees them. Recovery validates the complete ordered hash chain, decrypts signed records, checks the signed envelope against the pinned plan and durable intent, and resends the exact persisted bytes. An unfinished transaction for another plan stops a production apply before any write.

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
  scope, principal: 'ci-role/my-app-deploy',
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
  "scope": { "project": "my-app", "environment": "testnet", "label": "blue" }
}
```

The DynamoDB table has string partition key `PK` and string sort key `SK`. Enable point-in-time recovery. Configure the S3 bucket with versioning or Object Lock and deny plan deletion or overwrite in IAM. The CLI uses the AWS SDK credential chain; do not place AWS credentials or private keys in this config. `plan` writes its hash-addressed plan object to S3. `apply` checks the archived plan before signing.

```sh
node src/cli.mjs plan --spec spec.json --backend backend.json --out plan.json
node src/cli.mjs apply --spec spec.json --plan plan.json --backend backend.json --signer-module signer.mjs
node src/cli.mjs status --plan plan.json --backend backend.json
```

A signer module exports `signerProvider` (and optionally `signerRoles`). It can use `createSignerServiceProvider`, a hardware wallet, or an organization-specific signer. `status` is read-only: it reports lock holder and expiry, active or abandoned lease state, plan hash, last journal phase, sequence, and state version without decrypting signed bytes.

Grant the planner only chain read access, DynamoDB `GetItem` for state, S3 `PutObject`/`GetObject` on its plan prefix, and the KMS permission required for S3 server-side encryption. Grant the apply runner DynamoDB `GetItem`, `Query`, `UpdateItem`, and `TransactWriteItems` on its scoped keys, S3 `GetObject` on plans, and KMS `GenerateDataKey`/`Decrypt` for the journal key. Give the signer service its own signing permission; the apply runner needs permission to call it, not to read its keys. An auditor needs DynamoDB `GetItem`/`Query` only. Scope all policies by resource ARN and deployment key prefix; deny destructive S3 and DynamoDB actions to normal runners.

The local CLI remains available without `--backend`. The AWS path requires a shared table, bucket, KMS key, and signer service; local files are not copied to a replacement runner. Production `import` is not supported by the CLI.
