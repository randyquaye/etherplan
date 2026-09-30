# Stateful constructor limitation

A constructor is *stateful* when its result depends on another contract's state or when it creates another contract. For example, an account factory may create its account implementation while the factory itself is being deployed.

By default, after a CREATE2 deployment, Etherplan runs the constructor again without sending a transaction. It compares that simulated result with the code deployed on chain. The simulation reads the state at the **end of the receipt block**. The real constructor ran earlier, during its transaction. If the transaction changed state that the constructor uses, the second run can revert or produce different code. Etherplan then stops without recording a verified creation proof, even if the transaction succeeded. If another check also fails, such as a `code_hash` mismatch, the result can be `conflict` rather than `unverified`.

This is a limit of receipt-block replay. A replay failure does **not** by itself establish that the constructor is stateful. It can also mean that the RPC cannot run the simulation, the artifact or inputs are wrong, or the deployed code differs from the spec. Etherplan does not automatically accept code at the predicted address as proof that its planned transaction created it.

## Recover from an RPC replay error

Before signing a CREATE2 deployment, apply tests historical code, nonce, and storage overrides on the configured RPC. This probe can detect unsupported overrides, but it cannot guarantee that a provider will accept every real constructor replay. An incompatible endpoint stops before a transaction is signed. After a successful receipt, transient provider failures during creation verification are retried for up to five minutes, starting at 500 ms between attempts and capping the delay at 10 seconds. `etherplan apply --verification-timeout-ms <milliseconds>` changes that window. Each retry keeps the original receipt's canonical block as its anchor; a different runtime or an EVM constructor revert is not treated as a provider failure.

For a second RPC provider, set `ETH_VERIFICATION_RPC_URL` before `etherplan apply`. Apply checks its chain identity and replay overrides before signing. If the primary RPC cannot verify a deployment, including when its replay reports a revert or different runtime, apply checks that the second provider agrees on the receipt block and asks it to verify the original transaction. The primary RPC still sends the transaction and tracks its receipt. A second provider cannot resolve a constructor that genuinely replays differently against end-of-block state. A failed fallback or a provider outage lasting beyond the retry window leaves the transaction recoverable from the saved plan and journal; no RPC configuration can guarantee that provider failures never happen.

If one RPC reports a provider failure while the other reports a replay revert or different runtime, apply treats that disagreement as inconclusive and retries within the verification window. A transient fallback revert can then recover without another apply. If neither RPC verifies before the deadline, apply stops with a retryable failure and preserves the original transaction for saved-plan recovery.

If the endpoint remains unavailable, the saved plan can retry verification of the same signed transaction. Keep the original plan and journal, set `ETH_RPC_URL` to an endpoint that supports historical state overrides, and run `etherplan apply --plan path/to/plan.json` with the same local `--state` and `--journal` options, or the same production `--backend` and `--signer-module` options. Include `--pipeline` if the saved plan used a pipeline. A successful retry validates the journaled signature and canonical receipt, runs creation verification again, and records the original transaction without signing or broadcasting another deployment.

This path also works for a prior terminal `postcondition` failure when the journal contains the signed deployment and its successful receipt. If the receipt is no longer canonical, the transaction evidence disagrees, or replay still cannot prove the runtime, apply stops without adopting the address. A constructor that replays to different code remains subject to the limitation below and [issue #28](https://github.com/randyquaye/etherplan/issues/28).

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

This proves the declared runtime bytes and getter addresses against hashes committed before signing. It does not prove arbitrary constructor storage writes, outside calls, undeclared children, or that the reviewed pins were calculated correctly. A previously signed transaction without the pin commitment cannot be upgraded to this proof mode. Use the review and import path below for such a deployment.

## Review a stopped deployment

1. Keep the state file and journal from the failed apply. Record the transaction hash and target address shown in the output. Do not change the salt or start another deployment to get past the error.
2. Check the transaction and receipt on the intended chain. Confirm the receipt succeeded and remains canonical, the sender is the intended deployer, and the transaction called the expected CREATE2 factory with the intended salt, creation code, and constructor arguments. Confirm that the target address has code.
3. Compare the live code with the intended compiled artifact. Review any immutable values, relevant getter results, and contracts the constructor created. If the spec has a `code_hash` pin, investigate a mismatch. Derive a corrected pin from the reviewed build and intended deployment; do not copy the observed hash into the spec solely to make verification pass.
4. If any of those checks fails or cannot be completed, leave the resource unverified and investigate. A successful receipt and code at the address are not enough for automatic recovery.

## Adopt a reviewed deployment in local state

After the review, a local-state operator can explicitly adopt the contract. Run from the same project directory containing `main.ethp`, using the same state file as the failed apply, with the reviewed `code_hash` and getter checks needed to verify the runtime:

```sh
etherplan import --id contract:accountFactory --state path/to/state.json
```

Set `ETH_RPC_URL` to the intended chain before running the command. Omit `--creation-tx`: that option requires the creation replay that failed. `import` sends no transaction and succeeds only if Etherplan can verify the live code and declared checks. It records **import provenance**, not a verified creation-transaction proof. Keep the transaction and your review evidence separately. Then create a fresh plan with the same state and journal and confirm that the imported resource is `reuse` before applying any remaining actions.

The CLI `import` command does not currently support the production backend. Do not copy local import state into a production backend as a substitute for its recovery process.

This limitation is tracked in [issue #28](https://github.com/randyquaye/etherplan/issues/28).
