# Validate and review a plan

Part of [Deploy contracts](index.md).

Run offline validation in CI without an RPC URL or signer keys:

```sh
etherplan graph
etherplan impact --value owner
etherplan validate
```

Run these commands from the project root containing `main.ethp`. Etherplan loads every root-level `.ethp` file together, in filename order, regardless of how many there are.

`validate` checks the complete spec, dependency graph, artifacts, declared source and contract names, ABI getters and expected values, constructor arguments, linked libraries, and every call method and argument. Declared `source` and `name` must exactly match identities present in the artifact; missing identities are errors. An external with checks must provide an ABI. Validation checks all declarations even when the desired chain state might already be satisfied.

Set `ETH_RPC_URL` to the target RPC endpoint for a live plan. Plan reads the chain and writes no transactions:

```sh
etherplan plan --deployers 0xYourDeployer --owner 0xYourOwner --max-spend-wei 100000000000000000 --out plan.json
```

`plan` saves `plan.json` in the working directory by default and also prints it as JSON. Use `--out path/to/plan.json` to choose a file, or `--out -` to print without saving.

| Command | Structural checks | Artifact and ABI checks | Live-chain checks |
| --- | --- | --- | --- |
| `graph`, `impact`, `compile` | Yes | No | No |
| `validate`, `adapters` | Yes | Yes | No |
| `plan`, `schedule`, `verify`, `import`, `apply` | Yes | Yes | Yes |

`apply` repeats offline validation and checks the plan against current inputs before it signs or sends a transaction. `graph` reports structure and dependencies only; it does not load artifacts.

Review the plan before apply. Each resource has an action: `reuse`, `deploy`, `call`, `conflict`, or `unverified`. The plan includes exact transaction destinations and data for writes, plus spec and artifact hashes, chain identity, an observed block hash, signer addresses, and `maxSpendWei`. Supply `--owner` when the plan has owner actions. The ceiling is in wei per signer and covers the total maximum cost of its signed transactions across all waves and restarts. Apply checks live fees and gas against it before signing; a later CLI flag cannot raise it. A plan with a conflict or missing proof cannot be applied.

[Next: Apply a plan](apply.md) · [Project files](../project/index.md)
