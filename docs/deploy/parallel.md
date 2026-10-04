# Parallel deployers

Part of [Deploy contracts](index.md).

For shared recovery across runners, use the [production backend guide](../operations/aws-cli.md). Provision the AWS table, plan bucket, and symmetric KMS key, then run `etherplan init --backend backend.json` from the project before the first remote plan. Init checks the resources and chain, creates empty remote state once, and records the backend identity locally. It stops if local recovery files exist; state migration is not automatic. The guide also covers encrypted journal records, fenced signer locks, external signers, structured events, and the read-only `status` command.

Schedule and apply both use the primary deployer serially by default. Add `--parallel` to either command to assign eligible independent deployments across multiple funded deployers. A resource must declare `senderIndependent: true` before it can use a secondary deployer, and the factory must be recognized as permissionless. Owner calls use the owner signer. Use `schedule --deployers address,address` to inspect the proposed waves without sending transactions.

[Previous: Fees and pending transactions](fees.md) · [Next: Pipelining](pipeline.md)
