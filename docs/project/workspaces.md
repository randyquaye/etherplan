# Workspaces

Part of [Project files](index.md).

Local state is tied to one chain, so each deployment of a shared spec needs its own state. `--workspace <name>`, or `ETHP_WORKSPACE`, selects a workspace; without either, the workspace is `default`. A workspace reads `main.<name>.ethpvars` after `main.ethpvars` and keeps its state, journal, and recovery plans under `.etherplan/<name>/` beside the spec. A `state` or `journal` path from `main.ethpconfig` gets a `<name>/` directory beside the configured file. An explicit `--state` or `--journal` flag is used as given. With `--backend`, the backend config's scope separates state; the workspace still selects the vars overlay.

```sh
etherplan plan --workspace sepolia --deployers 0x… --max-spend-wei 100000000000000000 --out sepolia-plan.json
etherplan apply --workspace sepolia --plan sepolia-plan.json
```

Pass the same workspace and variable inputs to `apply --plan` that you gave `plan`; a different compiled spec stops apply with `stale-spec`.

[Previous: Conditions](conditions.md) · [Next: Configuration defaults](configuration.md)
