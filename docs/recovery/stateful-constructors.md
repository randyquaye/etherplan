# Stateful constructors and pinned runtime

Part of [Recovery](index.md).

A constructor is *stateful* when its result depends on another contract's state or when it creates another contract. For example, an account factory may create its account implementation while the factory itself is being deployed.

By default, after a CREATE2 deployment, Etherplan runs the constructor again without sending a transaction. It compares that simulated result with the code deployed on chain. The simulation reads the state at the **end of the receipt block**. The real constructor ran earlier, during its transaction. If the transaction changed state that the constructor uses, the second run can revert or produce different code. Etherplan then stops without recording a verified creation proof, even if the transaction succeeded. If another check also fails, such as a `code_hash` mismatch, the result can be `conflict` rather than `unverified`.

This is a limit of receipt-block replay. A replay failure does **not** by itself establish that the constructor is stateful. It can also mean that the RPC cannot run the simulation, the artifact or inputs are wrong, or the deployed code differs from the spec. Etherplan does not automatically accept code at the predicted address as proof that its planned transaction created it.

## Pin the runtime before a new deployment

For a constructor that creates a child with `CREATE`, opt into a different creation proof before planning or signing:

```hcl
resource "contract" "accountFactory" {
  artifact = "path/to/OxideAccountFactory.json"
  salt = "0x...64 hex digits..."
  args = []
  creation_proof_mode = "pinned_runtime"
  code_hash = "0x...parent runtime Keccak-256..."
  created_code = [{
    getter = "implementation"
    create_nonce = 1
    code_hash = "0x...child runtime Keccak-256..."
  }]
}
```

The JSON fields are `creationProofMode: "pinned-runtime"`, `codeHash`, and `createdCode: [{ getter, createNonce, codeHash }]`. The getter must take no arguments and return one address. For the first child created by a new parent, `create_nonce = 1`; Etherplan derives the child's address from the planned parent address and nonce. The mode requires the bundled atomic CREATE2 factory, a salt, a parent hash, and at least one child. It is unavailable for direct CREATE and address-only resources.

Compute the pins **offline from the exact build and constructor inputs before apply**. Build the initcode with its resolved arguments and linked libraries, derive the parent CREATE2 address from the factory, salt, and initcode hash, then derive each child `CREATE(parent, create_nonce)` address. Fill every compiler-marked immutable reference in the compiled parent and child runtime with the value that construction will set, including address-dependent child immutables. Hash the complete resulting runtime bytes with Keccak-256; an initcode hash or a hash copied from live code is not a runtime pin. Review the build identity, chain, factory code hash, salt, constructor inputs, derived addresses, immutable values, and hashes. Keep the reviewed spec and plan hash with the deployment record.

On apply, Etherplan checks that parent and declared child addresses have no code at the plan block and again before signing. It journals the plan's pin commitment before the signature. After the canonical successful transaction, it checks the exact factory calldata, signer, predicted address, factory code, parent code, each declared getter address, and every pinned parent and child runtime hash at the receipt and verification blocks. It then records a `pinned-runtime` creation proof without running receipt-block constructor replay. Later verification and recovery require the originating journal commitment and repeat those chain checks. Losing that journal evidence leaves the pinned proof unverified.

This proves the declared runtime bytes and getter addresses against hashes committed before signing. It does not prove arbitrary constructor storage writes, outside calls, undeclared children, or that the reviewed pins were calculated correctly. A previously signed transaction without the pin commitment cannot be upgraded to this proof mode. Use the [review and import path](review-and-import.md) for such a deployment.

[RPC replay recovery](rpc-replay.md) · [Review and import](review-and-import.md)
