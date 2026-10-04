# Offline checks in CI

Part of [Working on Etherplan](index.md).

A project can be checked before any RPC URL or signer key is available. Run these commands from the directory containing `main.ethp`:

```sh
npx etherplan graph
npx etherplan validate
```

`graph` checks structural dependencies and shows split-mode warnings. `validate` also loads artifacts and checks ABI methods, getters, constructor arguments, libraries, and call arguments. When a declared value matters to a change, run `npx etherplan impact --value owner` with that value's name to list affected resources.

For an Etherplan source checkout, run `npm ci`, `npm run typecheck`, `npm run lint`, and `npm test`. The runtime suite needs Foundry's `anvil` on `PATH`. Keep RPC and signing credentials out of an offline validation job.

[Previous: Development](development.md) · [Next: Artifact adapters](adapters.md) · [Command matrix](../reference/commands.md)
