# Import an existing contract

Part of [Verify contracts](index.md).

Declare the contract in `main.ethp` with its compiled artifact and existing `address`. Add getter checks for constructor-initialized or mutable values that must hold. Set `ETH_RPC_URL` to the intended chain. Validate the project, review the address, bytecode, artifact, and checks, then record the verified contract in local state:

```sh
etherplan validate
etherplan import --id contract:registry
etherplan verify
```

`import` sends no transaction. For a direct CREATE deployment with a private immutable, provide `--creation-tx 0x…` when creation transaction evidence is needed to prove its value. An imported contract carries import provenance; see [creation proof](creation-proof.md) for the distinction.

After rebuilding an artifact, use [`--rebaseline`](artifact-changes.md) deliberately. If an Etherplan CREATE2 transaction succeeded but replay verification stopped, follow the separate [review and import recovery path](../recovery/review-and-import.md). The CLI does not support production-backend import.

[Previous: Verify live contracts](existing-contracts.md) · [Next: Creation proof](creation-proof.md)
