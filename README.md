# Etherplan

Etherplan is a command-line tool for desired EVM contract state. It reads `.ethp` project files and compiled Solidity artifacts, compares them with a chain, writes a reviewable plan, applies that saved plan, and verifies the result. The chain is the source of observed truth. A local state file records identity and provenance.

Etherplan can deploy through the canonical `0x4e59…4956` CREATE2 proxy, verify existing contracts and explicit externals, link libraries, and run declared post-deployment calls. It does not destroy contracts, mutate immutables in place, infer an upgrade policy, or deploy L2 contracts.

## Install

Use Node.js 22.18 or newer. Install this beta from its GitHub tag with `npm install --save-dev 'github:randyquaye/etherplan#v0.0.10-beta'`. The npm registry package is not published yet.

To work from a checkout instead, install it as a CLI with `npm install --global .`. The test suite also needs Foundry's `anvil` on `PATH`.

The source is TypeScript. `npm ci` compiles it into `dist/`, which the CLI, integration tests, and published package run; unit tests import `src/`. Signer modules import the library as `etherplan`. See [the architecture guide](docs/architecture.md) for the module map, durable records, and public API boundary.

```sh
npm ci
npm install --global .
etherplan --version
npm run typecheck
npm run lint
npm test
```

The package uses `viem` and the AWS SDK packages for its production backend. Run `npm pack --dry-run` to inspect the release contents. `etherplan --help` lists commands, and `etherplan <command> --help` lists each command's options.

`typecheck` strictly checks production source. `lint` uses type information for source and tests, including promise checks; `npm test` runs the runtime suite one file at a time because chain tests share local Anvil resources. Test fixtures use deliberately loose shapes, so they are outside the strict compiler project.

## Describe desired state

A specification has `schema: 1` or `schema: 2`, a numeric `chainId`, and at least one contract. It can also have `values`, `externals`, `calls`, and a CREATE2 `factory`. A contract points to a compiled JSON artifact and has either an existing address or a CREATE2 salt. A derived salt also carries a `saltDerivation` with its `mixer` and optional `label`, and must equal keccak256 of the mixer, or of `<mixer>:<label>`. A deployable contract has constructor `args`. A call declares its target, method, arguments, an allowed `before` getter value, and a desired getter value in `check`.

`schema: 2` separates references needed to resolve values from dependencies that require a verified on-chain resource before submission. A reference such as `{ "ref": "contracts.registry.address" }` resolves an address without waiting for the registry deployment receipt. Declare an execution barrier with `"after": ["contract:registry"]` on the dependent contract or call, or use `{ "ref": "contracts.registry.address", "requiresLive": true }`. Etherplan always makes a call depend on its target contract and makes writes that reference an external depend on verification of that external. It does not infer whether a constructor calls a referenced contract.

Mark owner-only configuration calls with `"ownerOnly": true`. A call with method `transferOwnership`, or one marked `"transfersOwnership": true`, waits for all owner-only calls on the same target. Use `after` for ordering across targets or for other state dependencies. When a constructor safely stores a predicted address, add an assumption for that exact use, for example `"executionAssumptions": [{ "consumer": "contract:portal", "location": "args[0]", "reference": "contracts.registry.address", "reason": "Constructor only stores the address." }]`. Library locations use `libraries.<artifact name>`. An assumption must identify a real constructor or library reference and suppresses only that warning. `validate`, `graph`, `plan`, and `schedule` show the remaining warnings.

`schema: 1` keeps the earlier behavior where references also create execution barriers. A schema 2 spec can select it with `"dependencyMode": "compatibility"`; a schema 1 spec can opt into the new behavior with `"dependencyMode": "split"`. Plans for specs that select a dependency mode, use schema 2, or declare assumptions include both graphs, edge reasons, graph-level execution waves, warnings, and assumptions in the plan hash. `graph` and `schedule` show the graphs. Apply recalculates resolved payloads and graphs before signing, then checks completed execution dependencies on chain before each dependent batch is signed.

See [the neutral state fixture](https://github.com/randyquaye/etherplan/blob/main/test/fixtures/state-fixture.json) for the schema and [the parallel fixture](https://github.com/randyquaye/etherplan/blob/main/test/fixtures/parallel-lab.json) for dependent CREATE2 contracts. These are local test inputs, not network deployment recommendations. Keep signer secrets out of the specification.

## Write the spec in HCL

Write a Terraform-style project with `main.ethp` in its root directory. Every other `.ethp` file directly in that directory joins the same project; files in subdirectories do not. Etherplan combines all declarations before resolving variables and references, so resources, variables, and locals can refer across files. It then compiles the project and optional `main.ethpvars` into a `schema: 2` JSON spec for validation, planning, hashing, and applying. Duplicate top-level attributes and resource declarations are errors. [The lab fixture](https://github.com/randyquaye/etherplan/blob/main/test/fixtures/ethp/lab.ethp) and [its JSON form](https://github.com/randyquaye/etherplan/blob/main/test/fixtures/ethp/lab.json) show a full example.

```hcl
chain_id = 31337
mixer    = "myorg/myproject"

variable "owner" {
  type = address
}

variable "previous_owner" {
  type    = address
  default = "0x0000000000000000000000000000000000000000"
}

resource "contract" "registry" {
  artifact = "Registry.json"
  salt     = derive
  args     = [var.owner]
}

resource "contract" "portal" {
  artifact = "Portal.json"
  salt     = "0x…" # an explicit salt works beside derived ones
  args     = [contracts.registry.address, "86400"]
  after    = [contracts.registry]
}

resource "check" "portalRefs" {
  target   = contracts.portal
  REGISTRY = contracts.registry.address
}

resource "call" "setOwner" {
  target = contracts.portal
  method = "setOwner"
  args   = [var.owner]
}

resource "check" "setOwnerResult" {
  target = calls.setOwner
  getter = "owner"
  before = var.previous_owner
  equals = var.owner
}
```

Each variable is declared in a `variable` block, and `main.ethpvars` sets values with literal assignments, such as `owner = "0x…"`. In a field that can hold references, such as `args`, `address`, `libraries`, or a check's expected value, each `var.owner` compiles to `{ "ref": "values.owner" }`, and `contracts.registry.address` and `externals.name.address` compile to the same references as JSON. Fields that must be constant, such as `chain_id`, `salt`, `code_hash`, `signer_role`, an external's `address`, or the factory, take the variable's value instead, so `salt = var.salt` and `chain_id = var.chain_id` work. An undeclared, unset, or unused variable is an error, and the vars file cannot reference contracts. Because the variables are part of the compiled spec, changing them after `plan` makes a saved-plan apply stop with `stale-spec`.

A top-level `mixer` attribute lets `salt = derive` replace a literal salt. The salt is keccak256 of the mixer, so every derived contract in the project shares one salt and gets its address from its initcode, and renaming a resource does not move it. Two contracts with identical initcode would share an address; `validate` and `plan` report the pair, and `salt = derive("second-instance")` hashes `<mixer>:<label>` for the second one. `derive` is valid only as a salt value, and `mixer` is a constant field, so `mixer = var.mixer` works. The compiled spec records the resulting `salt` beside a `saltDerivation` with the mixer and label, and the plan and state carry both. Rotating the mixer moves every derived contract, so `plan` reports each as a `conflict` with a `saltChange` reason, and a mixer edited after `plan` stops apply with `stale-spec`. A mixer or label is printable ASCII without spaces. Both are public, since the salt is in the factory transaction, and `cast keccak "<mixer>"` reproduces a derived salt.

Etherplan reads a subset of HCL syntax. A file can contain attributes, blocks, comments, quoted strings, whole numbers, `true`, `false`, `null`, lists, objects, references, and the conditions described below. `target` and `after` take resources such as `contracts.registry`, `externals.token`, or `calls.setOwner`. Heredocs, string templates, arithmetic, function calls other than `derive`, `for` expressions, and index expressions are errors that name the file, line, and column. Write `var.owner`, not `"${var.owner}"`. A number is a whole number within JavaScript's safe range (±9007199254740991), with no decimal point or exponent; quote larger integers, such as wei amounts, as decimal strings: `"1000000000000000000"`.

Resource types are `contract`, `external`, `call`, and `check`. Attributes are snake_case: `code_hash`, `creation_proof_mode`, `created_code`, `signer_role`, `sender_independent`, `owner_only`, and `transfers_ownership` in resources, and `chain_id`, `dependency_mode`, `execution_assumptions`, and `mixer` at the top level. Other names, such as `artifact`, `args`, `salt`, `method`, `libraries`, and `abi`, match the JSON fields. A top-level `factory` block with `address` and `code_hash` sets the CREATE2 factory. `args` are positional. A deployable contract or a call needs `args`, even `[]`. Block order has no effect: contracts and calls are sorted by ID, so the spec hash does not depend on the order of blocks in the file.

The compiled spec uses split dependencies. A reference such as `contracts.registry.address` resolves the predicted address but does not wait for the deployment; `after = [contracts.registry]` waits for the verified contract. Set `dependency_mode = "compatibility"` to make every reference an execution barrier. An entry in `execution_assumptions` names its consumer and reference directly: `{ consumer = contracts.portal, location = "args[0]", reference = contracts.registry.address, reason = "…" }`.

A check block is not a resource. A block that targets a contract or external lists getters and their expected values, and folds into that resource's `checks`. Several blocks can target one resource, but each getter can appear only once. For a getter named `target`, `getter`, `args`, `before`, `equals`, or `after`, write `getter = "target"` and `equals = …` instead. Each call needs exactly one check block that targets it, with `getter`, optional getter `args`, `before`, and `equals`; these become the call's `check` and `before`.

Run `etherplan compile` from the project root to print the canonical JSON spec that the other commands use. Every project command requires `main.ethp` in the current directory. There is no `--spec` option.

### One spec for several chains

Variables, conditions, and `enabled` let one `.ethp` file describe several deployments, such as a local chain with a mock token and a mainnet deployment that uses an existing token. Etherplan evaluates all of them when it compiles the file, so the JSON spec, its hash, the plan, and apply see only the result. Run `etherplan compile` with the same inputs to see it.

```hcl
variable "chain_id" {
  type    = number
  default = 31337
}

variable "owner" {
  type        = address
  description = "Owner of the vault"
}

variable "token" {
  type    = address
  default = null
}

variable "salt" {
  type    = bytes32
  default = "0x…"
}

locals {
  use_mock = var.token == null
}

chain_id = var.chain_id

resource "contract" "mockToken" {
  enabled  = local.use_mock
  artifact = "MockToken.json"
  salt     = var.salt
  args     = []
}

resource "external" "token" {
  enabled = !local.use_mock
  address = var.token
}

resource "contract" "vault" {
  artifact = "Vault.json"
  salt     = var.salt
  args     = [local.use_mock ? contracts.mockToken.address : externals.token.address, var.owner]
  after    = local.use_mock ? [contracts.mockToken] : [externals.token]
}
```

A `variable` block declares a variable with an optional `type`, `default`, and `description`. Types are `string`, `number` (a safe whole number), `bool`, `address`, `bytes32`, `list(<type>)`, and `any`, the default. Every value is checked against its type, and `null` is valid for any type, so a variable with `default = null` is optional. A variable with no default must get a value. Every variable the spec uses, and every name set in a vars file or with `--var`, must be declared.

A declared variable takes the last value from this list:

1. its `default`
2. the `ETHP_VAR_<name>` environment variable, such as `ETHP_VAR_owner`
3. `main.ethpvars`
4. `main.<workspace>.ethpvars`, for a workspace other than `default`
5. each `--var-file path.ethpvars`, in order
6. each `--var name=value`, in order

The environment and `--var` give strings. A `string` or `any` variable takes the string as written, a `number` or `bool` parses it, and a `list` parses it as an HCL list, such as `--var 'admins=["0x…","0x…"]'`. Only the input that wins is parsed, so a stale `ETHP_VAR_` value that a vars file or flag overrides does no harm. `ETHP_VAR_` names for undeclared variables are ignored. Commands print each variable's value and source on stderr.

A condition uses `condition ? a : b`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||`, `!`, and parentheses, with HCL's precedence. A condition must be `true` or `false`; strings and numbers are not truthy. `==` needs both sides to have the same type unless one is `null`, and compares hex strings such as addresses without regard to case. `<`, `<=`, `>`, and `>=` compare numbers. `&&` and `||` skip their right side once the left side decides, so `var.limit != null && var.limit > 0` is safe. Conditions can use only literals, variables, and locals; they cannot use a contract address, which is not known until planning. Only the chosen branch is evaluated, but every branch must name declared variables and resources. A conditional expression spans lines only inside parentheses or brackets.

A `locals` block names expressions, such as `use_mock` above, for use as `local.<name>`. A local is evaluated where it is used, so a local can hold a condition, a value, a contract address, or a resource for `after`. A local cannot refer to itself, and an unused local is an error.

`enabled = <condition>` on a resource block leaves that resource out of the compiled spec. Any reference that evaluation reaches, in `args`, `address`, `libraries`, `after`, `target`, a check value, or an execution assumption's `reference`, must not name a disabled resource; put it behind the same condition. A check block is dropped with its target, and an execution assumption is dropped with its consumer. A check block can also set its own `enabled`; to check a getter named `enabled`, write `getter = "enabled"`. Disabling a resource stops Etherplan from managing it; it does not remove the contract from the chain, and planning ignores its state record.

As in Terraform, an attribute that evaluates to `null` is left unset. One contract can adopt an existing deployment where one is given and deploy otherwise: `address = var.existing` with `salt = var.existing == null ? var.salt : null`.

The compiled spec keeps as `values` only the non-null variables that a reference field still uses. A variable used only in a condition, `enabled`, or a constant field is folded into the spec, so changing it changes the spec hash only when it changes the result. `impact --value` covers only the variables kept as values.

### Workspaces

Local state is tied to one chain, so each deployment of a shared spec needs its own state. `--workspace <name>`, or `ETHP_WORKSPACE`, selects a workspace; without either, the workspace is `default`. A workspace reads `main.<name>.ethpvars` after `main.ethpvars` and keeps its state, journal, and recovery plans under `.etherplan/<name>/` beside the spec. A `state` or `journal` path from `main.ethpconfig` gets a `<name>/` directory beside the configured file. An explicit `--state` or `--journal` flag is used as given. With `--backend`, the backend config's scope separates state; the workspace still selects the vars overlay.

```sh
etherplan plan --workspace sepolia --deployers 0x… --max-spend-wei 100000000000000000 --out sepolia-plan.json
etherplan apply --workspace sepolia --plan sepolia-plan.json
```

Pass the same workspace and variable inputs to `apply --plan` that you gave `plan`; a different compiled spec stops apply with `stale-spec`.

### Config defaults

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
```

Config can set `state`, `journal`, `backend`, `out`, `deployers`, `owner`, `parallel`, and `pipeline`, and a command block can set only the options that command accepts. `out` goes in a command block, because it names a plan file for `plan` and a directory for `adapters`. A flag on the command line overrides the command block, which overrides `defaults`. An explicit `--signer-module` replaces configured deployers and owner. Paths in config are relative to the config file; paths given as flags stay relative to the working directory. A flag cannot turn off a boolean that config sets; set `parallel = false` in that command's block instead. Commands print the options they took from config on stderr.

Config never sets `--plan`, `--max-spend-wei`, `--signer-module`, `--id`, `--creation-tx`, or `--rebaseline`, so `apply` without `--plan` still creates a fresh plan and asks for approval. Keep signer keys in the environment. Config options are not part of the spec hash; settings that a saved plan pins, such as signers and `parallel`, must still match it.

## Validate, plan, apply, and verify

Run offline validation in CI without an RPC URL or signer keys:

```sh
etherplan graph
etherplan impact --value owner
etherplan validate
```

Run these commands from the project root containing `main.ethp`. Etherplan loads every root-level `.ethp` file together, in filename order, regardless of how many there are.

`validate` checks the complete spec, dependency graph, artifacts, declared source and contract names, ABI getters and expected values, constructor arguments, linked libraries, and every call method and argument. Declared `source` and `name` must exactly match identities present in the artifact; missing identities are errors. An external with checks must provide an ABI. Validation checks all declarations even when the desired chain state might already be satisfied.

Set `ETH_RPC_URL` to the target RPC endpoint for a live plan. Plan reads the chain and writes no transactions:

```sh
etherplan plan --deployers 0xYourDeployer --owner 0xYourOwner --max-spend-wei 100000000000000000 --out plan.json
```

`plan` saves `plan.json` in the working directory by default and also prints it as JSON. Use `--out path/to/plan.json` to choose a file, or `--out -` to print without saving.

| Command | Structural checks | Artifact and ABI checks | Live-chain checks |
| --- | --- | --- | --- |
| `graph`, `impact`, `compile` | Yes | No | No |
| `validate`, `adapters` | Yes | Yes | No |
| `plan`, `schedule`, `verify`, `import`, `apply` | Yes | Yes | Yes |

`apply` repeats offline validation and checks the plan against current inputs before it signs or sends a transaction. `graph` reports structure and dependencies only; it does not load artifacts.

Review the plan before apply. Each resource has an action: `reuse`, `deploy`, `call`, `conflict`, or `unverified`. The plan includes exact transaction destinations and data for writes, plus spec and artifact hashes, chain identity, an observed block hash, signer addresses, and `maxSpendWei`. Supply `--owner` when the plan has owner actions. The ceiling is in wei per signer and covers the total maximum cost of its signed transactions across all waves and restarts. Apply checks live fees and gas against it before signing; a later CLI flag cannot raise it. A plan with a conflict or missing proof cannot be applied.

For apply, set `DEPLOYER_PRIVATE_KEYS` to one key or a comma-separated list of keys in the process environment. Set `OWNER_PRIVATE_KEY` if the plan has owner calls. A single key can also be supplied as `DEPLOYER_PRIVATE_KEY`. To use an external or KMS signer, pass `--signer-module` to both `plan` and `apply`; it works with local files and with the AWS backend. The built-in [KMS signer provider](docs/production-backends.md#kms-transaction-signers) supports multiple deployer and owner roles without placing their private keys in the runner.

```sh
etherplan apply --max-spend-wei 100000000000000000
etherplan apply --plan plan.json
etherplan verify
```

After apply or import records state, `output` prints saved contract and external addresses as JSON without an RPC connection:

```sh
etherplan output
etherplan output --id contract:registry
etherplan output --workspace sepolia
```

`output` also requires `main.ethp` in the current directory. The selected workspace determines the default state path. The JSON includes `chain` and an `addresses` map keyed by resource ID; `--id` filters it to one resource. Use `etherplan output --id contract:registry | jq -r '.addresses["contract:registry"]'` to extract the address in a shell script. `--state path/to/state.json` reads that file directly. `--backend backend.json` reads production state and requires `ETH_RPC_URL`. These are recorded addresses; run `verify` to check current on-chain state. Call records are omitted because they repeat the target contract address.

Without `--plan`, `apply` gets signer addresses from the configured keys or signer module, creates a fresh plan with the required `--max-spend-wei` ceiling, shows the complete plan, and waits for you to type `yes` before applying it. A declined answer or closed input stops without signing. After approval, Etherplan saves the exact plan under `plans/<planHash>.json` beside the state file for crash recovery; use that path with `--plan` if a later run says to resume it. This mode does not read or overwrite `plan.json`, so an old file cannot silently control the run. With `--plan`, `apply` uses that saved plan and does not prompt; a stale spec, artifact, signer, or missing ceiling is rejected. `plan --signer-module` obtains the addresses from the same module, so they need not be entered separately. Pipeline applies still require an explicit saved pipeline plan.

Apply streams progress to stderr as it acquires the lock, signs, broadcasts, receives receipts, and verifies resources. It prints a "Still applying" line every 30 seconds without other progress. The final JSON result remains on stdout for scripts. Pass `--quiet` to suppress progress lines; the final JSON, approval prompt, and errors still appear.

Apply rechecks the plan and live preconditions. It takes one writer lock, signs each needed transaction, syncs signed bytes to an append-only journal, then broadcasts. On restart, it checks the journal and chain before it resends the same bytes or starts another action. State and journal default to `.etherplan/<workspace>/` beside the spec, which is `.etherplan/default/` without `--workspace`; keep them together for recovery. The journal contains signed raw transactions and is written with file mode `0600`.

If a later action fails after a contract was deployed, correct the spec and create a new plan using the same state and journal. Planning reads verified creation evidence from the journal, rechecks it against the chain and current contract inputs, and can reuse that deployment without sending it again. Apply checks the journal proof again under its writer lock before accepting the saved plan. Pass `--journal path/to/journal.jsonl` to `plan` when apply used a custom journal path. The production backend uses its shared journal for this recovery. A missing or mismatched creation proof leaves the resource unverified.

A planned CREATE2 deployment stops if its predicted address acquires code without that plan settling a successful deployment transaction. A reverted deployment is not accepted as already satisfied, even if matching code appears. If an address was deployed outside Etherplan, adopt it deliberately with `import` before planning; declare getter checks for constructor-initialized storage that must hold.

Automated CREATE2 apply requires the bundled factory bytecode (at its default address or another address with the same runtime). Etherplan rejects deployment through an arbitrary factory before signing because a factory that returns success when CREATE2 fails cannot prove which transaction created the code. Contracts deployed through another factory can be adopted with `import` after reviewing their live state.

A saved plan pins the state it observed. Apply rejects it with `stale-state` if another plan or import changed that state; create a new plan from the current state to proceed. An interrupted apply can resume its own saved plan.

If a signed transaction remains unmined because its fee cap is too low, rerun the saved plan with `--replace-max-fee-per-gas`, `--replace-priority-fee-per-gas`, and `--replace-max-cost-wei` (all in wei). The two fee caps must each rise by at least 10%; the cost ceiling is the maximum gas cost plus value allowed for each replacement. For example: `etherplan apply --plan plan.json --replace-max-fee-per-gas 20000000000 --replace-priority-fee-per-gas 4000000000 --replace-max-cost-wei 2000000000000000`. Apply checks the old transaction's receipt and nonce before signing at the same nonce, saves the replacement link before broadcast, and accepts a receipt from either signed variant. Rerunning with the same fees resends the saved replacement. Review the fee caps and ceiling against the plan's gas and payload before applying.

For shared recovery across runners, use the [production backend guide](docs/production-backends.md). Provision the AWS table, plan bucket, and symmetric KMS key, then run `etherplan init --backend backend.json` from the project before the first remote plan. Init checks the resources and chain, creates empty remote state once, and records the backend identity locally. It stops if local recovery files exist; state migration is not automatic. The guide also covers encrypted journal records, fenced signer locks, external signers, structured events, and the read-only `status` command.

Schedule and apply both use the primary deployer serially by default. Add `--parallel` to either command to assign eligible independent deployments across multiple funded deployers. A resource must declare `senderIndependent: true` before it can use a secondary deployer, and the factory must be recognized as permissionless. Owner calls use the owner signer. Use `schedule --deployers address,address` to inspect the proposed waves without sending transactions.

## Single-signer pipelining

Create a pipeline plan with the signer address, then apply that saved plan with `--pipeline`:

```sh
etherplan plan --pipeline --deployers 0xYourDeployer --max-spend-wei 100000000000000000 --out plan.json
etherplan schedule --plan plan.json --pipeline
etherplan apply --plan plan.json --pipeline
```

Set `DEPLOYER_PRIVATE_KEY` or `DEPLOYER_PRIVATE_KEYS` for apply as usual. Add `--owner 0xYourOwner` at plan time if the plan contains owner calls; the apply signer must match it. A pipeline plan pins signer assignments, dependency waves, and each action's nonce offset in plan order. Absolute nonces are read under the writer lock at apply time. Each ready wave is a receipt barrier: Etherplan reserves consecutive nonces per signer, checks the whole signer group's maximum cost, syncs all signed transactions to the journal, then broadcasts in nonce order and waits for receipts concurrently. For a `schema: 2` spec, the waves follow the execution graph, so contracts that only store a predicted address share a wave. Apply rechecks completed execution dependencies on chain before it reserves nonces for a wave, and before it signs or resends an unmined transaction on resume. The final report includes `timings.submitMs`, `timings.receiptMs`, and `timings.verificationMs`.

Use `--parallel` when creating a pipeline plan to distribute eligible deployments across multiple deployers. Apply reads that choice from the saved plan. Keep the journal with the state file: after interruption, apply validates and resends the signed bytes, or uses the reviewed replacement fees above. If an unknown transaction consumes a reserved nonce, apply stops with `nonce-conflict` and requires operator reconciliation; it does not assign another nonce to that action.

## Existing contracts and proof

`verify` rereads live code, immutables, declared getter values, external code hashes, and binding state. Matching bytecode outside compiler-marked immutable regions is not enough when an immutable has no value proof. Incomplete proof is `unverified`; a mismatch is `conflict`.

Checks must name `view` or `pure` ABI functions. A check proves the declared return value at the block used for verification.

For a deployment with creation transaction evidence, Etherplan records a `creationProof` in the verified journal entry and state. It binds the transaction sender, canonical receipt block, initcode, address, and exact runtime hash; CREATE2 also binds the factory and salt. Later plan, verify, and apply recheck that identity, the current code and artifact runtime, and all declared getters. An unavailable or orphaned saved creation transaction makes verification incomplete even if runtime bytes match. This keeps immutables derived from the deployment block verified after time or block number changes. A replay proof can be reconstructed from its transaction and receipt-block data; a pinned-runtime proof also requires its pre-sign journal commitment. A legacy `proofHash` alone does not prove either.

For a constructor that creates implementation contracts, opt into `creation_proof_mode = "pinned_runtime"` before planning a fresh deployment. Declare an exact parent `code_hash` and at least one `created_code` entry with a zero-argument address getter, positive CREATE nonce, and exact child runtime hash. The JSON equivalents are `creationProofMode: "pinned-runtime"` and `createdCode: [{ getter, createNonce, codeHash }]`. This mode works only with the bundled atomic CREATE2 factory. See [the stateful constructor guide](docs/stateful-constructor-limitation.md) for an example, hash preparation, and the proof boundary.

A stateful CREATE2 constructor without that opt-in can deploy successfully but fail receipt-block creation replay. Etherplan then stops without recording verified state. The [recovery guide](docs/stateful-constructor-limitation.md) explains how to review and explicitly import a previously stopped local deployment. Pinned-runtime mode cannot retroactively prove a transaction whose signed plan lacked those commitments. Tracked in [issue #28](https://github.com/randyquaye/etherplan/issues/28).

Use `import --id contract:name` to adopt a verified existing contract into local state. For a direct CREATE deployment with a private immutable, pass `--creation-tx 0x…` when the creation transaction is needed as proof. Import sends no transaction.

## Rebuilt artifacts

Top-level ABI entry order does not affect artifact identity. The normalized ABI keeps its original order for transaction encoding; parameter order remains significant. Compared with v0.0.1-beta, this changes artifact hashes for nonempty ABIs even when their entry order is unchanged. Regenerate old saved plans and deliberately rebaseline any existing deployment state using the procedures below. Do not edit saved hashes by hand.

State separates a contract's deployment identity (address, initcode hash, and constructor inputs) from its artifact provenance (artifact and source hashes). A rebuild can change the artifact hash without changing the bytecode, for example when build metadata or settings change.

For a CREATE2 contract, the plan reuses the existing deployment and reports `observation.stateComparison.artifactDrift` with the old and new artifact hashes. This requires that the address, initcode, inputs, and salt match state, that the live code hash equals the saved code hash, and that the new artifact verifies the live contract. Otherwise the contract is a `conflict`, and `artifactDrift.reasons` says why. A deployment change is not drift: when the address and the initcode or inputs both change, it is a replacement; when only one changes, it is a `conflict`. For example, a salt change with the same initcode and inputs is a `conflict`, even after a rebuild, and `observation.stateComparison.saltChange` explains it, such as a rotated mixer or a new `derive` label. To deploy the same contract at a new address on purpose, remove its state record first. The plan still pins the new artifact hash. Apply signs no transaction for the drift. Under its lock, apply rechecks the saved record and the live code hash, and stops with `stale-state` or `drift` if either changed. It then records the new artifact and appends the previous artifact, source, proof, and code hashes to the record's `artifactRevisions`. Provenance, transactions, and prior-deployment fields are unchanged. A replacement starts a new revision list.

An imported contract is not rebaselined automatically. After rebuilding its artifact, run `import --id contract:name --rebaseline`. The existing import record must have the same address, inputs, and code hash, and the new artifact must verify the live contract. The recorded creation transaction is reused as proof unless `--creation-tx` is given. The import provenance is kept and an artifact revision is appended. Without `--rebaseline`, import still rejects a changed artifact.

An artifact revision records provenance only. It does not show that mutable storage matches the constructor inputs; declare getter checks for values that must hold.

`adapters --out generated` optionally writes TypeScript wrappers. Planning and deployment do not need generated wrappers.
