# Pipelining

Part of [Deploy contracts](index.md).

Create a pipeline plan with the signer address, then apply that saved plan with `--pipeline`:

```sh
etherplan plan --pipeline --deployers 0xYourDeployer --max-spend-wei 100000000000000000 --out plan.json
etherplan schedule --plan plan.json --pipeline
etherplan apply --plan plan.json --pipeline
```

Set `DEPLOYER_PRIVATE_KEY` or `DEPLOYER_PRIVATE_KEYS` for apply as usual. Add `--owner 0xYourOwner` at plan time if the plan contains owner calls; the apply signer must match it. A pipeline plan pins signer assignments, dependency waves, and each action's nonce offset in plan order. Absolute nonces are read under the writer lock at apply time. Each ready wave is a receipt barrier: Etherplan reserves consecutive nonces per signer, checks the whole signer group's maximum cost, syncs all signed transactions to the journal, then broadcasts in nonce order and waits for receipts concurrently. For a `schema: 2` spec, the waves follow the execution graph, so contracts that only store a predicted address share a wave. Apply rechecks completed execution dependencies on chain before it reserves nonces for a wave, and before it signs or resends an unmined transaction on resume. The final report includes `timings.submitMs`, `timings.receiptMs`, and `timings.verificationMs`.

Use `--parallel` when creating a pipeline plan to distribute eligible deployments across multiple deployers. Apply reads that choice from the saved plan. Keep the journal with the state file: after interruption, apply validates and resends the signed bytes, or uses the [reviewed replacement fees](fees.md). If an unknown transaction consumes a reserved nonce, apply stops with `nonce-conflict` and requires operator reconciliation; it does not assign another nonce to that action.

[Previous: Parallel deployers](parallel.md) · [State and recovery](../recovery/journals-and-resume.md)
