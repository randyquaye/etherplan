# CLI configuration defaults

Part of [Project files](index.md).

`main.ethpconfig`, beside `main.ethp`, sets defaults for command-line options:

```hcl
defaults {
  state   = "deploy/state.json"
  backend = "backend.json"
}

command "plan" {
  out       = "plan.json"
  pipeline  = true
  deployers = ["0x…"]
}

command "apply" {
  max-fee-per-gas      = "30000000000"
  priority-fee-per-gas = "1000000000"
  gas-multiplier       = "1.5"
}
```

Config can set `state`, `journal`, `backend`, `out`, `deployers`, `owner`, `parallel`, `pipeline`, `max-fee-per-gas`, `priority-fee-per-gas`, `gas-multiplier`, `receipt-timeout-ms`, and `verification-timeout-ms`, and a command block can set only the options that command accepts. `out` goes in a command block, because it names a plan file for `plan` and a directory for `adapters`. A flag on the command line overrides the command block, which overrides `defaults`. An explicit `--signer-module` replaces configured deployers and owner. Paths in config are relative to the config file; paths given as flags stay relative to the working directory. Write wei amounts and milliseconds as whole numbers or decimal strings, and quote a fractional `gas-multiplier`. A flag cannot turn off a boolean that config sets; set `parallel = false` in that command's block instead. Commands print the options they took from config on stderr.

Config never sets `--plan`, `--max-spend-wei`, the `--replace-*` fees, `--signer-module`, `--id`, `--creation-tx`, or `--rebaseline`, so `apply` without `--plan` still creates a fresh plan and asks for approval. Keep signer keys in the environment. Config options are not part of the spec hash; settings that a saved plan pins, such as signers and `parallel`, must still match it.

[Previous: Workspaces](workspaces.md) · [Next: Validate and plan](../deploy/validate-and-plan.md)
