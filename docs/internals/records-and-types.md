# Durable records and type boundaries

Part of [Working on Etherplan](index.md).

The plan is a reviewed snapshot. It pins chain ID and genesis hash, spec and artifact hashes, observed block, prior state hash, signer addresses, spend ceiling, and optionally the pipeline schedule. Apply checks those commitments before signing. `planHash` is the hash of the other plan fields in canonical JSON. Changing the spec, state, signer set, or pinned schedule requires a new plan.

One writer owns the deployment and its signer lanes. Local apply uses a file lock and JSONL journal. Production apply requires `stateStore`, `journalStore`, `lockProvider`, `journalCipher`, and `scope` together; leases carry fencing tokens, and the stored journal is a sequence of hash linked records. Signed transaction bytes are encrypted before storage. Every journal append completes before the action it authorizes proceeds.

The transaction sequence is **intent → signed → broadcast attempt → broadcast → receipt → verified → state write**. A durable `signed` record precedes the first raw transaction send, so a restart can resend the same bytes. A receipt alone does not authorize a state write: settlement checks finality and verifies the live result first. State writes happen only for verified resources, after checking the latest state against the plan, while the writer still holds the lock. `failed` records preserve a terminal or retryable outcome without claiming verification.

Serial batches read each signer's latest nonce and reject unknown pending transactions. Pipeline batches use nonce offsets saved in the plan: they durably record every reservation intent before signing, then send each signer group's transactions in nonce order. Recovery checks known signed variants and receipts before rebroadcast or replacement. A transaction at a reserved nonce that is absent from the journal stops recovery rather than being treated as Etherplan's transaction.

## Type boundaries

The `types.ts` files beside each module define its domain shapes; `src/types.ts` holds shared addresses, hashes, chain identity, JSON values, and the narrow RPC client interface. Runtime validators remain at the boundaries because TypeScript types do not validate disk, JSON, RPC, signer module, or backend data.

- `RawSpec` is `unknown`. `parseSpec` validates it into `ParsedSpec`; HCL first becomes `CompiledSpec`, then passes through the same validator. `PreparedResource` is discriminated by `kind`; `PlannedResource` adds the selected action and observation. A `Plan` is a disk shape with decimal strings, not in-memory `bigint` values.
- `VerificationResult` records proofs, missing proofs, conflicts, and optional creation evidence. A persisted `CreationProof` is rechecked against the chain before reuse. `StateFile` is the validated disk shape; state and journal inputs are checked on read and before writing.
- `JournalRecord` describes the in-memory phase union. The local journal stores format 1 JSONL. `StoredJournalRecord` is the format 2 production envelope with sequence, prior and current hashes, principal, and encrypted signed bytes. The production journal decrypts signed bytes into its in-memory records only after validating the stored chain.
- `Client`, `SignerProvider`, `StateStore`, `JournalStore`, `LockProvider`, `JournalCipher`, and `Reporter` are narrow interfaces for external implementations. Implementations must satisfy the runtime checks in execution and the storage contracts in [production backends](../operations/scope-and-recovery.md).

[Previous: Module map](modules.md)
