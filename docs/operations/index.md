# Shared deployment operations

Local state and journals suit one host. For apply runners on different hosts that share a signer, use a coordinated backend.

- [Deployment scope and recovery](scope-and-recovery.md): leases, fencing, journals, and confirmations.
- [AWS CLI setup](aws-cli.md): configure and initialize DynamoDB, S3, and KMS.
- [KMS transaction signers](kms-signers.md): signer modules and permissions.
- [AWS permissions](permissions.md): resource access for each runner role.
- [Programmatic apply](programmatic-apply.md): integrate custom backends and signer services.

Start with [plan and apply](../deploy/index.md) for the ordinary CLI flow.
