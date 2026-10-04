# AWS permissions

Part of [Shared deployment operations](index.md).

Grant each runner access to the resources it needs. Scope policies by resource ARN and deployment key prefix, and deny destructive S3 and DynamoDB actions to normal runners.

| Role | Required access |
| --- | --- |
| Initializer | DynamoDB `DescribeTable`, `DescribeContinuousBackups`, `GetItem`, `Query`, `ConditionCheckItem`, and `PutItem` on the backend table; S3 `ListBucket` and `GetBucketVersioning` on the plan bucket; KMS `DescribeKey` on the journal key. |
| Planner | Chain read access; DynamoDB `GetItem` for state and journal head plus `Query` for the scoped journal; S3 `PutObject` and `GetObject` on its plan prefix; the KMS permission required for S3 server-side encryption. |
| Apply runner | DynamoDB `GetItem`, `Query`, `ConditionCheckItem`, `PutItem`, and `UpdateItem` on scoped keys; S3 `GetObject` on plans; KMS `GenerateDataKey` and `Decrypt` on the journal key. |
| Auditor | DynamoDB `GetItem` and `Query` only. |

After initialization, CLI state commands also use DynamoDB `DescribeTable` and KMS `DescribeKey` to confirm resource identities. Planning reads journal metadata without decrypting signed bytes.

A planner that loads a [KMS signer module](kms-signers.md) also needs `kms:GetPublicKey` on its signing keys. An apply runner using an in-process KMS signer needs `kms:GetPublicKey` and `kms:Sign` on those keys. With a separate signer service, give that service signing permission and let the apply runner call it.

[Previous: KMS transaction signers](kms-signers.md) · [Next: Programmatic apply](programmatic-apply.md) · [AWS CLI setup](aws-cli.md)
