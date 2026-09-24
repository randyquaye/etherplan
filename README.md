# Etherplan

Etherplan is a command-line tool for desired EVM contract state. It reads a JSON specification and compiled Solidity artifacts, compares them with a chain, writes a reviewable plan, applies that saved plan, and verifies the result. The chain is the source of observed truth. A local state file records identity and provenance.

Etherplan can deploy through the canonical `0x4e59…4956` CREATE2 proxy, verify existing contracts and explicit externals, link libraries, and run declared post-deployment calls. It does not destroy contracts, mutate immutables in place, infer an upgrade policy, or deploy L2 contracts.

## Install and test

Use Node.js 20 or newer. The test suite also needs Foundry's `anvil` on `PATH`.

```sh
npm ci
npm run check
npm test
```

The package has one runtime dependency, `viem`. It is private and is not published to npm.

## Describe desired state

A specification has `schema: 1`, a numeric `chainId`, and at least one contract. It can also have `values`, `externals`, `calls`, and a CREATE2 `factory`. A contract points to a compiled JSON artifact and has either an existing address or a CREATE2 salt. A deployable contract has constructor `args`. References such as `{ "ref": "values.owner" }` and `{ "ref": "contracts.registry.address" }` create dependencies. A call declares its target, method, arguments, an allowed `before` getter value, and a desired getter value in `check`.

See [the neutral state fixture](test/fixtures/state-fixture.json) for the schema and [the parallel fixture](test/fixtures/parallel-lab.json) for dependent CREATE2 contracts. These are local test inputs, not network deployment recommendations. Keep signer secrets out of the specification.

## Validate, plan, apply, and verify

Run offline validation in CI without an RPC URL or signer keys:

```sh
node src/cli.mjs graph --spec path/to/spec.json
node src/cli.mjs impact --spec path/to/spec.json --value owner
node src/cli.mjs validate --spec path/to/spec.json
```

When the working directory contains `spec.json`, you can omit `--spec` for any command. For example, run `etherplan validate` from that directory. An explicit `--spec` path takes precedence.

`validate` checks the complete spec, dependency graph, artifacts, declared source and contract names, ABI getters and expected values, constructor arguments, linked libraries, and every call method and argument. Declared `source` and `name` must exactly match identities present in the artifact; missing identities are errors. An external with checks must provide an ABI. Validation checks all declarations even when the desired chain state might already be satisfied.

Set `ETH_RPC_URL` to the target RPC endpoint for a live plan. Plan reads the chain and writes no transactions:

```sh
node src/cli.mjs plan --spec path/to/spec.json --out plan.json
```

| Command | Structural checks | Artifact and ABI checks | Live-chain checks |
| --- | --- | --- | --- |
| `graph`, `impact` | Yes | No | No |
| `validate`, `adapters` | Yes | Yes | No |
| `plan`, `schedule`, `verify`, `import`, `apply` | Yes | Yes | Yes |

`apply` repeats offline validation and checks the saved plan against current inputs before it signs or sends a transaction. `graph` reports structure and dependencies only; it does not load artifacts.

Review the plan before apply. Each resource has an action: `reuse`, `deploy`, `call`, `conflict`, or `unverified`. The plan includes exact transaction destinations and data for writes, plus spec and artifact hashes, chain identity, and an observed block hash. A plan with a conflict or missing proof cannot be applied.

For apply, set `DEPLOYER_PRIVATE_KEYS` to one key or a comma-separated list of keys in the process environment. Set `OWNER_PRIVATE_KEY` if the plan has owner calls. A single key can also be supplied as `DEPLOYER_PRIVATE_KEY`.

```sh
node src/cli.mjs apply --spec path/to/spec.json --plan plan.json
node src/cli.mjs verify --spec path/to/spec.json
```

`apply` also reads `plan.json` from the working directory when `--plan` is omitted. With both files there, `etherplan apply` needs neither path. Use `--plan` to select a different saved plan.

Apply rechecks the plan and live preconditions. It takes one writer lock, signs each needed transaction, syncs signed bytes to an append-only journal, then broadcasts. On restart, it checks the journal and chain before it resends the same bytes or starts another action. State and journal default to `.etherplan/` beside the spec; keep them together for recovery. The journal contains signed raw transactions and is written with file mode `0600`.

For shared recovery across runners, use the [production backend guide](docs/production-backends.md). It covers the AWS reference backend, encrypted journal records, fenced signer locks, external signers, structured events, and the read-only `status` command.

Add `--parallel` to apply independent deployments from multiple funded deployers. A resource must declare `senderIndependent: true` before it can use a secondary deployer, and the factory must be recognized as permissionless. Owner calls use the owner signer. Use `schedule --deployers address,address` to inspect the proposed waves without sending transactions.

## Existing contracts and proof

`verify` rereads live code, immutables, declared getter values, external code hashes, and binding state. Matching bytecode outside compiler-marked immutable regions is not enough when an immutable has no value proof. Incomplete proof is `unverified`; a mismatch is `conflict`.

Use `import --spec path/to/spec.json --id contract:name` to adopt a verified existing contract into local state. For a direct CREATE deployment with a private immutable, pass `--creation-tx 0x…` when the creation transaction is needed as proof. Import sends no transaction.

`adapters --spec path/to/spec.json --out generated` optionally writes TypeScript wrappers. Planning and deployment do not need generated wrappers.
