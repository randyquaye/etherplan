# AWS CLI backend setup

Part of [Shared deployment operations](index.md).

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

The DynamoDB table has string partition key `PK` and string sort key `SK`. Enable point-in-time recovery. Enable S3 bucket versioning and deny plan deletion or overwrite in IAM. The CLI uses the AWS SDK credential chain; do not place AWS credentials or private keys in this config. `plan` writes its hash-addressed plan object to S3. `apply` checks the archived plan before signing.

Run `etherplan init --backend backend.json` from the project directory before using the AWS CLI backend. `init` requires `ETH_RPC_URL`, checks that the connected chain matches the spec, and checks that the existing DynamoDB table is active with string `PK` and `SK` keys and point-in-time recovery, the S3 bucket is accessible with versioning enabled, and the KMS key is an enabled symmetric encryption key. It conditionally creates an empty state item for the configured deployment scope, or validates the existing item. It does not create the table, bucket, key, or contracts. Repeating it with unchanged configuration is safe.

`init` writes a non-secret configuration fingerprint and the resolved AWS table and KMS key ARNs to `.etherplan/<workspace>/backend-init.json`. `plan`, `apply`, `verify`, `schedule`, and `output` require this marker and a present remote state item; `status` remains available for read-only diagnosis. Run `init` once in each new checkout or runner before its first AWS command. After changing backend config, review the new target and run `etherplan init --reconfigure`. If local state, journal, or recovery plans exist for the selected workspace, `init` stops rather than silently switching to empty remote state. There is no automatic local-to-AWS migration yet; preserve that local recovery history until a migration path is available. Each remote workspace needs a distinct `scope` in its backend config; `--workspace` selects local inputs and marker location but does not change the configured AWS scope.

For an existing installation, stop all apply runners and reconcile every previously signed transaction to the chosen confirmation depth before upgrading all runners together. A custom remote `journalStore` must provide `signedForSigner(scope, address)` with consistent reads across all deployment scopes in its backend, and write each signed entry atomically with its journal append under the signer fence.

Run `plan` and `apply` from the project directory containing `main.ethp` and any other root-level `.ethp` files:

```sh
etherplan init --backend backend.json
etherplan plan --backend backend.json --deployers 0xYourDeployer --max-spend-wei 100000000000000000 --out plan.json
etherplan apply --plan plan.json --backend backend.json --signer-module signer.mjs
etherplan status --plan plan.json --backend backend.json
```

A signer module exports `signerProvider` (and optionally `signerRoles`). It can use `createSignerServiceProvider`, a hardware wallet, or an organization-specific signer. `status` is read-only: it reports lock holder and expiry, active or abandoned lease state, plan hash, last journal phase, sequence, and state version without decrypting signed bytes.

[Previous: Deployment scope](scope-and-recovery.md) · [Next: KMS transaction signers](kms-signers.md)
