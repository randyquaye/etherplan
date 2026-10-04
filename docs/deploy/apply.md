# Apply a plan and read addresses

Part of [Deploy contracts](index.md).

## Apply a saved plan

Set `ETH_RPC_URL` to the same chain used for planning. Put the deployer's key in `DEPLOYER_PRIVATE_KEY` (or use `DEPLOYER_PRIVATE_KEYS` for several deployers). If the plan has owner calls, set `OWNER_PRIVATE_KEY` too.

```sh
etherplan apply --plan plan.json
```

A saved plan already pins the signer addresses and spend ceiling. `apply --plan` does not ask for approval again. It checks the current spec, artifacts, signers, state, and live chain before signing; a stale or conflicting plan stops. If planning used `--signer-module`, pass the same module to apply. The [KMS signer provider](../operations/kms-signers.md) is one option.

## Create and approve a fresh plan

```sh
etherplan apply --max-spend-wei 100000000000000000
```

Without `--plan`, apply gets signer addresses from the configured keys or signer module, creates a fresh plan, prints it, and waits for you to type `yes`. It saves the approved plan under `plans/<planHash>.json` beside the state file for recovery. This mode does not read or overwrite `plan.json`. A pipeline apply needs an explicit saved [pipeline plan](pipeline.md).

## Check the result

```sh
etherplan verify
etherplan output
etherplan output --id contract:registry
```

`verify` checks current chain state. `output` reads recorded contract and external addresses without an RPC connection, unless you use `--backend`. It requires `main.ethp` in the current directory and reads the selected workspace's state by default. Its JSON has `chain` and an `addresses` map; call records are omitted because they repeat the target contract address. Use `--id` to select one resource, `--state path/to/state.json` to read a specific local file, or `--workspace sepolia` for another workspace. A backend read needs `ETH_RPC_URL`.

For a script, use `etherplan output --id contract:registry | jq -r '.addresses["contract:registry"]'`. These are recorded addresses; use `verify` for a live check.

Apply reports lock acquisition, signing, broadcast, receipts, and verification as they happen. It prints a "Still applying" line after 30 seconds without progress. `--quiet` keeps the final report and errors while hiding progress. `--json` puts structured output on stdout and progress on stderr.

[Previous: Validate and plan](validate-and-plan.md) · [Next: State and recovery](../recovery/journals-and-resume.md) · [Verify live state](../verify/existing-contracts.md)
