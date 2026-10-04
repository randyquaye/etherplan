# Module map and package boundary

Part of [Working on Etherplan](index.md).

Etherplan turns a desired EVM deployment into a saved plan, checks that plan against the live chain, and applies its writes under a lock. The CLI in `src/cli.ts` is a thin entry point; `src/index.ts` is the library entry point. Source is TypeScript, and `npm run build` emits the JavaScript and declarations in `dist/`.

## Module map

| Area | Main modules | Responsibility |
| --- | --- | --- |
| Input | `input/hcl.ts`, `input/variables.ts`, `input/evaluate.ts`, `input/compile.ts`, `input/project.ts` | Parse `.ethp`, resolve typed variables from files, the environment, and flags, fold conditions, locals, and `enabled` at compile time, compile the result to a JSON spec, and load project configuration, workspace overlays, and spec files. |
| Spec and artifacts | `spec/index.ts`, `artifacts.ts`, `artifacts/normalize.ts` | Validate desired resources and dependency references; load and normalize compiler artifacts. |
| Planning | `planning/resources.ts`, `planning/index.ts`, `validation/index.ts` | Resolve resource inputs, validate artifacts, read one chain block and existing state, verify live resources, decide actions, and hash the canonical plan. |
| Verification | `verification/index.ts`, `bytecode.ts`, `creation-proof.ts`, `simulate.ts` | Compare runtime code, getters, call bindings, and deployment evidence with the plan. A reason makes a result `conflict`; otherwise missing proof makes it `unverified`; only complete evidence is `verified`. |
| Scheduling | `scheduling/index.ts` | Arrange dependency waves, signer lanes, serial or parallel batches, and pipeline nonce offsets. |
| State | `state/index.ts` | Validate, import, and atomically write the recorded deployment state. |
| Execution | `execution/context.ts`, `lifecycle.ts`, `batch.ts`, `pipeline.ts`, `settlement.ts`, `funding.ts`, `outcome.ts` | Acquire the writer, recheck the plan, reserve and sign transactions, recover pending work, settle receipts, verify outcomes, and persist state. `execution/index.ts` reexports the entry points. |
| Durable backends | `execution/lock.ts`, `journal.ts`, `backends.ts`, `aws.ts` | Local lock and JSONL journal, or fenced leases, encrypted journal, and state storage through production backends. |
| CLI | `cli/options.ts`, `environment.ts`, `main.ts`, `commands/*` | Validate command options, construct RPC and signer dependencies, dispatch commands, and set exit codes. |

The read path is `input → spec/artifacts → planning → verification → plan`. Apply adds `execution/context → preflight → scheduling → journaled transaction settlement → state`. `status` reads backend metadata without decrypting signed transactions.

## Package boundary

`package.json` exports only `.`: consumers import functions and public types from `etherplan`. `src/index.ts` defines that surface; internal modules and the CLI are implementation details. Deep package imports are intentionally unavailable. The CLI executable is `dist/cli.js`, built from `src/cli.ts`.

[Previous: Artifact adapters](adapters.md) · [Next: Durable records and types](records-and-types.md)
