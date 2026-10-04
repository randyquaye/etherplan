# Install and prepare

Part of [Getting started](index.md).

Use Node.js 22.18 or newer. Install the current beta in the Solidity project where you will run Etherplan:

```sh
npm install --save-dev 'github:randyquaye/etherplan#v0.1.0-beta'
npx etherplan --version
```

The npm registry package has not been published. If you work from an Etherplan checkout instead, use [development setup](../internals/development.md).

Compile your contracts with your Solidity build tool. In `main.ethp`, `artifact` points to the compiled JSON file relative to that project file. `validate` needs the artifact but no RPC URL.

For `plan`, `apply`, and `verify`, set `ETH_RPC_URL` to the target chain. The project's `chain_id` must match that chain. An automated CREATE2 deployment also needs the canonical factory code at `0x4e59b44847b379578588920cA78FbF26c0B4956C`. Anvil normally enables its default CREATE2 deployer; if you disable it or use another chain, check that the required factory code is present before planning.

Foundry's `anvil` is needed for Etherplan's integration tests and is useful for local chain testing. It is not required for offline project validation.

[Previous: How Etherplan works](overview.md) · [Next: Quick start](quickstart.md) · [Environment variables](../reference/environment.md)
