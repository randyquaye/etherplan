# Review and import a stopped deployment

Part of [Recovery](index.md).

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

[Stateful constructors](stateful-constructors.md) · [Verify an existing contract](../verify/existing-contracts.md)
