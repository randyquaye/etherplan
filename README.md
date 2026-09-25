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

The package uses `viem` and the AWS SDK packages for its production backend. It is private and is not published to npm.

## Describe desired state

A specification has `schema: 1` or `schema: 2`, a numeric `chainId`, and at least one contract. It can also have `values`, `externals`, `calls`, and a CREATE2 `factory`. A contract points to a compiled JSON artifact and has either an existing address or a CREATE2 salt. A deployable contract has constructor `args`. A call declares its target, method, arguments, an allowed `before` getter value, and a desired getter value in `check`.

`schema: 2` separates references needed to resolve values from dependencies that require a verified on-chain resource before submission. A reference such as `{ "ref": "contracts.registry.address" }` resolves an address without waiting for the registry deployment receipt. Declare an execution barrier with `"after": ["contract:registry"]` on the dependent contract or call, or use `{ "ref": "contracts.registry.address", "requiresLive": true }`. Etherplan always makes a call depend on its target contract and makes writes that reference an external depend on verification of that external. It does not infer whether a constructor calls a referenced contract.

Mark owner-only configuration calls with `"ownerOnly": true`. A call with method `transferOwnership`, or one marked `"transfersOwnership": true`, waits for all owner-only calls on the same target. Use `after` for ordering across targets or for other state dependencies. When a constructor safely stores a predicted address, add an assumption for that exact use, for example `"executionAssumptions": [{ "consumer": "contract:portal", "location": "args[0]", "reference": "contracts.registry.address", "reason": "Constructor only stores the address." }]`. Library locations use `libraries.<artifact name>`. An assumption must identify a real constructor or library reference and suppresses only that warning. `validate`, `graph`, `plan`, and `schedule` show the remaining warnings.

`schema: 1` keeps the earlier behavior where references also create execution barriers. A schema 2 spec can select it with `"dependencyMode": "compatibility"`; a schema 1 spec can opt into the new behavior with `"dependencyMode": "split"`. Plans for specs that select a dependency mode, use schema 2, or declare assumptions include both graphs, edge reasons, graph-level execution waves, warnings, and assumptions in the plan hash. `graph` and `schedule` show the graphs. Apply recalculates resolved payloads and graphs before signing, then checks completed execution dependencies on chain before each dependent batch is signed.

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
node src/cli.mjs plan --spec path/to/spec.json --deployers 0xYourDeployer --owner 0xYourOwner --max-spend-wei 100000000000000000 --out plan.json
```

| Command | Structural checks | Artifact and ABI checks | Live-chain checks |
| --- | --- | --- | --- |
| `graph`, `impact` | Yes | No | No |
| `validate`, `adapters` | Yes | Yes | No |
| `plan`, `schedule`, `verify`, `import`, `apply` | Yes | Yes | Yes |

`apply` repeats offline validation and checks the plan against current inputs before it signs or sends a transaction. `graph` reports structure and dependencies only; it does not load artifacts.

Review the plan before apply. Each resource has an action: `reuse`, `deploy`, `call`, `conflict`, or `unverified`. The plan includes exact transaction destinations and data for writes, plus spec and artifact hashes, chain identity, an observed block hash, signer addresses, and `maxSpendWei`. Supply `--owner` when the plan has owner actions. The ceiling is in wei per signer and covers the total maximum cost of its signed transactions across all waves and restarts. Apply checks live fees and gas against it before signing; a later CLI flag cannot raise it. A plan with a conflict or missing proof cannot be applied.

For apply, set `DEPLOYER_PRIVATE_KEYS` to one key or a comma-separated list of keys in the process environment. Set `OWNER_PRIVATE_KEY` if the plan has owner calls. A single key can also be supplied as `DEPLOYER_PRIVATE_KEY`.

```sh
node src/cli.mjs apply --spec path/to/spec.json --max-spend-wei 100000000000000000
node src/cli.mjs apply --spec path/to/spec.json --plan plan.json
node src/cli.mjs verify --spec path/to/spec.json
```

Without `--plan`, `apply` gets signer addresses from the configured keys or signer module, creates a fresh plan with the required `--max-spend-wei` ceiling, shows the complete plan, and waits for you to type `yes` before applying it. A declined answer or closed input stops without signing. After approval, Etherplan saves the exact plan under `plans/<planHash>.json` beside the state file for crash recovery; use that path with `--plan` if a later run says to resume it. This mode does not read or overwrite `plan.json`, so an old file cannot silently control the run. With `--plan`, `apply` uses that saved plan and does not prompt; a stale spec, artifact, signer, or missing ceiling is rejected. Pipeline applies still require an explicit saved pipeline plan.

Apply rechecks the plan and live preconditions. It takes one writer lock, signs each needed transaction, syncs signed bytes to an append-only journal, then broadcasts. On restart, it checks the journal and chain before it resends the same bytes or starts another action. State and journal default to `.etherplan/` beside the spec; keep them together for recovery. The journal contains signed raw transactions and is written with file mode `0600`.

A saved plan pins the state it observed. Apply rejects it with `stale-state` if another plan or import changed that state; create a new plan from the current state to proceed. An interrupted apply can resume its own saved plan.

If a signed transaction remains unmined because its fee cap is too low, rerun the saved plan with `--replace-max-fee-per-gas`, `--replace-priority-fee-per-gas`, and `--replace-max-cost-wei` (all in wei). The two fee caps must each rise by at least 10%; the cost ceiling is the maximum gas cost plus value allowed for each replacement. For example: `etherplan apply --spec spec.json --plan plan.json --replace-max-fee-per-gas 20000000000 --replace-priority-fee-per-gas 4000000000 --replace-max-cost-wei 2000000000000000`. Apply checks the old transaction's receipt and nonce before signing at the same nonce, saves the replacement link before broadcast, and accepts a receipt from either signed variant. Rerunning with the same fees resends the saved replacement. Review the fee caps and ceiling against the plan's gas and payload before applying.

For shared recovery across runners, use the [production backend guide](docs/production-backends.md). It covers the AWS reference backend, encrypted journal records, fenced signer locks, external signers, structured events, and the read-only `status` command.

Schedule and apply both use the primary deployer serially by default. Add `--parallel` to either command to assign eligible independent deployments across multiple funded deployers. A resource must declare `senderIndependent: true` before it can use a secondary deployer, and the factory must be recognized as permissionless. Owner calls use the owner signer. Use `schedule --deployers address,address` to inspect the proposed waves without sending transactions.

## Single-signer pipelining

Create a pipeline plan with the signer address, then apply that saved plan with `--pipeline`:

```sh
node src/cli.mjs plan --spec path/to/spec.json --pipeline --deployers 0xYourDeployer --max-spend-wei 100000000000000000 --out plan.json
node src/cli.mjs schedule --spec path/to/spec.json --plan plan.json --pipeline
node src/cli.mjs apply --spec path/to/spec.json --plan plan.json --pipeline
```

Set `DEPLOYER_PRIVATE_KEY` or `DEPLOYER_PRIVATE_KEYS` for apply as usual. Add `--owner 0xYourOwner` at plan time if the plan contains owner calls; the apply signer must match it. A pipeline plan pins signer assignments, dependency waves, and each action's nonce offset in plan order. Absolute nonces are read under the writer lock at apply time. Each ready wave is a receipt barrier: Etherplan reserves consecutive nonces per signer, checks the whole signer group's maximum cost, syncs all signed transactions to the journal, then broadcasts in nonce order and waits for receipts concurrently. For a `schema: 2` spec, the waves follow the execution graph, so contracts that only store a predicted address share a wave. Apply rechecks completed execution dependencies on chain before it reserves nonces for a wave, and before it signs or resends an unmined transaction on resume. The final report includes `timings.submitMs`, `timings.receiptMs`, and `timings.verificationMs`.

Use `--parallel` when creating a pipeline plan to distribute eligible deployments across multiple deployers. Apply reads that choice from the saved plan. Keep the journal with the state file: after interruption, apply validates and resends the signed bytes, or uses the reviewed replacement fees above. If an unknown transaction consumes a reserved nonce, apply stops with `nonce-conflict` and requires operator reconciliation; it does not assign another nonce to that action.

## Existing contracts and proof

`verify` rereads live code, immutables, declared getter values, external code hashes, and binding state. Matching bytecode outside compiler-marked immutable regions is not enough when an immutable has no value proof. Incomplete proof is `unverified`; a mismatch is `conflict`.

Checks must name `view` or `pure` ABI functions. A check proves the declared return value at the block used for verification.

For a deployment with creation transaction evidence, Etherplan records a `creationProof` in the verified journal entry and state. It binds the transaction, canonical receipt block, initcode, address, and exact runtime hash; CREATE2 also binds the factory and salt. Later plan, verify, and apply recheck that identity, the current code and artifact runtime, and all declared getters. This keeps immutables derived from the deployment block verified after time or block number changes. An old state file without this field remains readable. If its creation transaction and receipt-block data are still available, Etherplan can reconstruct the proof; otherwise declare an expected code hash or getter checks for the missing immutable values. A legacy `proofHash` alone does not prove them.

Use `import --spec path/to/spec.json --id contract:name` to adopt a verified existing contract into local state. For a direct CREATE deployment with a private immutable, pass `--creation-tx 0x…` when the creation transaction is needed as proof. Import sends no transaction.

## Rebuilt artifacts

State separates a contract's deployment identity (address, initcode hash, and constructor inputs) from its artifact provenance (artifact and source hashes). A rebuild can change the artifact hash without changing the bytecode, for example when build metadata or settings change.

For a CREATE2 contract, the plan reuses the existing deployment and reports `observation.stateComparison.artifactDrift` with the old and new artifact hashes. This requires that the address, initcode, inputs, and salt match state, that the live code hash equals the saved code hash, and that the new artifact verifies the live contract. Otherwise the contract is a `conflict`, and `artifactDrift.reasons` says why. A deployment change is not drift: when the address and the initcode or inputs both change, it is a replacement; when only one changes, it is a `conflict`. For example, a salt change with the same initcode and inputs is a `conflict`, even after a rebuild. To deploy the same contract at a new address on purpose, remove its state record first. The plan still pins the new artifact hash. Apply signs no transaction for the drift. Under its lock, apply rechecks the saved record and the live code hash, and stops with `stale-state` or `drift` if either changed. It then records the new artifact and appends the previous artifact, source, proof, and code hashes to the record's `artifactRevisions`. Provenance, transactions, and prior-deployment fields are unchanged. A replacement starts a new revision list.

An imported contract is not rebaselined automatically. After rebuilding its artifact, run `import --spec path/to/spec.json --id contract:name --rebaseline`. The existing import record must have the same address, inputs, and code hash, and the new artifact must verify the live contract. The recorded creation transaction is reused as proof unless `--creation-tx` is given. The import provenance is kept and an artifact revision is appended. Without `--rebaseline`, import still rejects a changed artifact.

An artifact revision records provenance only. It does not show that mutable storage matches the constructor inputs; declare getter checks for values that must hold.

`adapters --spec path/to/spec.json --out generated` optionally writes TypeScript wrappers. Planning and deployment do not need generated wrappers.
