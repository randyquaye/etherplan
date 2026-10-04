# Development

Part of [Working on Etherplan](index.md).

Use Node.js 22.18 or newer. From a checkout:

```sh
npm ci
npm run typecheck
npm run lint
npm test
```

`npm ci` builds `dist/` through the package's `prepare` script. The CLI, integration tests, and package run from `dist/`; unit tests import `src/`. The integration suite needs Foundry's `anvil` on `PATH`. Run `npm pack --dry-run` to inspect the release contents.

The public library entry point is `etherplan`; internal modules are not exported. See [Architecture](modules.md) for the module map, durable records, and API boundary.

The `typecheck` script checks production source. `lint` checks source and tests with type information. `npm test` runs test files one at a time because chain tests share local Anvil resources. Test fixtures use loose shapes and sit outside the strict compiler project.

[Next: Offline CI checks](ci.md) · [Module map](modules.md)
