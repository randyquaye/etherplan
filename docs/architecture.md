# Architecture

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

## Durable records and recovery

The plan is a reviewed snapshot. It pins chain ID and genesis hash, spec and artifact hashes, observed block, prior state hash, signer addresses, spend ceiling, and optionally the pipeline schedule. Apply checks those commitments before signing. `planHash` is the hash of the other plan fields in canonical JSON. Changing the spec, state, signer set, or pinned schedule requires a new plan.

One writer owns the deployment and its signer lanes. Local apply uses a file lock and JSONL journal. Production apply requires `stateStore`, `journalStore`, `lockProvider`, `journalCipher`, and `scope` together; leases carry fencing tokens, and the stored journal is a sequence of hash linked records. Signed transaction bytes are encrypted before storage. Every journal append completes before the action it authorizes proceeds.

The transaction sequence is **intent → signed → broadcast attempt → broadcast → receipt → verified → state write**. A durable `signed` record precedes the first raw transaction send, so a restart can resend the same bytes. A receipt alone does not authorize a state write: settlement checks finality and verifies the live result first. State writes happen only for verified resources, after checking the latest state against the plan, while the writer still holds the lock. `failed` records preserve a terminal or retryable outcome without claiming verification.

Serial batches read each signer's latest nonce and reject unknown pending transactions. Pipeline batches use nonce offsets saved in the plan: they durably record every reservation intent before signing, then send each signer group's transactions in nonce order. Recovery checks known signed variants and receipts before rebroadcast or replacement. A transaction at a reserved nonce that is absent from the journal stops recovery rather than being treated as Etherplan's transaction.

## Type boundaries

The `types.ts` files beside each module define its domain shapes; `src/types.ts` holds shared addresses, hashes, chain identity, JSON values, and the narrow RPC client interface. Runtime validators remain at the boundaries because TypeScript types do not validate disk, JSON, RPC, signer module, or backend data.

- `RawSpec` is `unknown`. `parseSpec` validates it into `ParsedSpec`; HCL first becomes `CompiledSpec`, then passes through the same validator. `PreparedResource` is discriminated by `kind`; `PlannedResource` adds the selected action and observation. A `Plan` is a disk shape with decimal strings, not in-memory `bigint` values.
- `VerificationResult` records proofs, missing proofs, conflicts, and optional creation evidence. A persisted `CreationProof` is rechecked against the chain before reuse. `StateFile` is the validated disk shape; state and journal inputs are checked on read and before writing.
- `JournalRecord` describes the in-memory phase union. The local journal stores format 1 JSONL. `StoredJournalRecord` is the format 2 production envelope with sequence, prior and current hashes, principal, and encrypted signed bytes. The production journal decrypts signed bytes into its in-memory records only after validating the stored chain.
- `Client`, `SignerProvider`, `StateStore`, `JournalStore`, `LockProvider`, `JournalCipher`, and `Reporter` are narrow interfaces for external implementations. Implementations must satisfy the runtime checks in execution and the storage contracts in [production backends](production-backends.md).

## Package boundary

`package.json` exports only `.`: consumers import functions and public types from `etherplan`. `src/index.ts` defines that surface; internal modules and the CLI are implementation details. Deep package imports are intentionally unavailable. The CLI executable is `dist/cli.js`, built from `src/cli.ts`.
