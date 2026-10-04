# TypeScript artifact adapters

Part of [Working on Etherplan](index.md).

`etherplan adapters` reads the project's compiled artifacts and writes optional TypeScript wrappers:

```sh
etherplan adapters --out generated
```

Each wrapper exposes the artifact ABI, bytecode, build identity, and an `at(address, client)` helper. The command needs `main.ethp` and the artifact files, but no RPC URL. Planning, deployment, and verification do not need generated wrappers.

The default output directory is `generated/`. Review generated code like any other build output and regenerate it after rebuilding artifacts. The [package boundary](modules.md) explains what the `etherplan` library exports.

[Previous: Offline CI checks](ci.md) · [Next: Module map](modules.md)
