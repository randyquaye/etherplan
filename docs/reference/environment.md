# Environment variables

Part of [CLI reference](index.md).

| Variable | Used for |
| --- | --- |
| `ETH_RPC_URL` | Target RPC for `init`, `plan`, `schedule`, `verify`, `import`, and `apply`; also `output --backend`. |
| `ETH_VERIFICATION_RPC_URL` | Optional second RPC for creation verification during `apply`. It must be on the same chain. |
| `DEPLOYER_PRIVATE_KEY` | One local deployer key for `apply`. |
| `DEPLOYER_PRIVATE_KEYS` | One or more comma-separated local deployer keys for `apply`; takes precedence over the singular form. |
| `OWNER_PRIVATE_KEY` | Local owner key when planned actions need an owner signer. |
| `ETHP_WORKSPACE` | Workspace name when `--workspace` is omitted; default is `default`. |
| `ETHP_VAR_<name>` | Value for a declared HCL variable, overridden by vars files and `--var`. |

Keep private keys out of `.ethp`, `.ethpvars`, and `.ethpconfig`. A `--signer-module` can provide signer addresses and signatures instead of local key variables. The AWS backend uses the AWS SDK credential chain; its config file contains resource names, not credentials.

For full variable precedence, see [Variable inputs](../project/variables.md). For RPC replay behavior, see [RPC replay recovery](../recovery/rpc-replay.md).

[Previous: Command matrix](commands.md)
