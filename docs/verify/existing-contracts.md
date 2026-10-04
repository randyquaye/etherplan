# Verify or import an existing contract

Part of [Verify contracts](index.md).

`verify` rereads live code, immutables, declared getter values, external code hashes, and binding state. Matching bytecode outside compiler-marked immutable regions is not enough when an immutable has no value proof. Incomplete proof is `unverified`; a mismatch is `conflict`.

Checks must name `view` or `pure` ABI functions. A check proves the declared return value at the block used for verification.

Use `import --id contract:name` to adopt a verified existing contract into local state. For a direct CREATE deployment with a private immutable, pass `--creation-tx 0x…` when the creation transaction is needed as proof. Import sends no transaction.

[Next: Import an existing contract](import.md) · [Write checks](../project/syntax-and-resources.md)
