# Inspect graphs and execution waves

Part of [Dependencies and execution order](index.md).

Run `etherplan graph` without an RPC connection to see resolution and execution edges with their reasons. In split mode it also reports warnings about constructor and library references. `etherplan validate` checks artifacts as well as the dependency graph.

After making a plan, use `schedule` to inspect signer assignments and execution waves without sending transactions:

```sh
etherplan graph
etherplan plan --deployers 0xYourDeployer --max-spend-wei 100000000000000000 --out plan.json
etherplan schedule --plan plan.json
```

`plan` and `schedule` need `ETH_RPC_URL`. With `--parallel`, eligible independent actions can use funded secondary deployers; otherwise the primary deployer is serial. In a pipeline plan, each ready wave is a receipt barrier. Apply rechecks completed execution dependencies on chain before signing a dependent batch.

Schema 2 plans pin both graphs, edge reasons, warnings, assumptions, and graph-level execution waves in the plan hash. Pipeline plans also pin the signer schedule. Changing pinned inputs after planning makes the saved plan stale.

[Previous: Ordering and assumptions](ordering-and-assumptions.md) · [Validate and plan](../deploy/validate-and-plan.md) · [Pipelining](../deploy/pipeline.md)
