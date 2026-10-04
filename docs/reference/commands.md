# Command matrix

Part of [CLI reference](index.md).

| Command | RPC needed | Sends transactions | Main result |
| --- | --- | --- | --- |
| `compile` | No | No | Canonical JSON spec from `.ethp` files. |
| `graph` | No | No | Resource dependency graph and warnings. |
| `impact --value name` | No | No | Resources affected by a compiled value. |
| `validate` | No | No | Spec, artifact, ABI, and argument checks. |
| `adapters` | No | No | Optional TypeScript artifact wrappers. |
| `plan` | Yes | No | Live-chain comparison and saved plan. |
| `schedule` | Yes | No | Signer lanes and execution waves. |
| `verify` | Yes | No | Live-chain verification. |
| `import` | Yes | No | Verified existing contract recorded in local state. |
| `apply` | Yes | **Yes** | Approved writes and verified state. |
| `output` | Local: no; backend: yes | No | Recorded contract and external addresses. |
| `init` | Yes | No | Initialized AWS backend scope and local marker. |
| `status` | No | No | Read-only AWS deployment status. |

`graph`, `impact`, and `compile` check structure without loading artifacts. `validate` and `adapters` also load artifacts and ABIs. Live commands check all of those plus the chain. `output` reports saved addresses, so use `verify` when you need a current on-chain check. `import` updates local state but does not broadcast a transaction.

For options, run `etherplan <command> --help`. Continue with [project files](../project/index.md), [plan and apply](../deploy/index.md), or [environment variables](environment.md).

[Next: Environment variables](environment.md)
