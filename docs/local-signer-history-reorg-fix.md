# Local signer history after a chain reorg

Status: fixed for `0.0.3-beta`. The local file backend retains signer journal history across completed applies, and the shared backend checks the current plan's signer index as well as older plans. Both stop a new signature when an earlier one lacks a canonical receipt at the configured confirmation depth.

## Failure

A local apply can finish after one confirmation. It then removes its journal path from the signer's local registry. If that block is later reorganized out, a second apply using the same signer can read the freed nonce and sign a different transaction. The first signed transaction remains valid and may be rebroadcast. Reusing the same journal does not close the gap, because the local signer-history check skips that journal and current-plan recovery examines only its own completed actions and live records.

The path is [`run` in lifecycle.ts](../src/execution/lifecycle.ts), [`retireLocalSignerHistory` and `assertSignerHistory` in settlement.ts](../src/execution/settlement.ts), and [`retireLocalSignerJournal` in local-signer.ts](../src/execution/local-signer.ts). An Anvil reproduction demonstrated both journal layouts:

1. Save an `evm_snapshot`, then apply contract `alpha` with a local state file and journal. Its transaction is signed at nonce `0` and the apply reports success.
2. Call `evm_revert` on the snapshot without clearing Etherplan's signer registry. The `alpha` receipt disappears, but its signed bytes remain in the journal.
3. Plan and apply a different contract `beta` with the same signer, using either a new journal or the first journal. The second apply reports success and signs a different transaction at nonce `0`.

This requires a reorg that removes the first transaction and another apply during the period when its old signature can still matter. A forked block alone does not establish that an Etherplan user was harmed. The shared AWS backend retains a signer-wide signed index; the pre-signature check now includes signatures from the current deployment and plan.

## Required behavior

Before a local signer signs a new transaction, every older signed transaction for that signer and chain must have a canonical receipt at the configured confirmation depth. An unresolved or orphaned signature stops the new signing attempt and identifies the journal and transaction to reconcile. A retry of an active plan may continue only through its existing validated recovery path, using its saved signature or an explicitly reviewed same-nonce replacement.

The check should include:

- Other journals registered for the signer, regardless of whether their applies returned success.
- Earlier plans in the current journal, including records whose latest phase is `verified` or `failed`.
- Earlier completed actions in the current plan. Active signatures in a validated serial recovery or pipeline reservation remain under those recovery rules; they must not be mistaken for unrelated history.
- All signed variants of a replacement chain, treating the nonce as resolved if one variant has a canonical receipt.

## Implementation

1. Registered local journal paths remain after apply; no success path retires them.
2. The signer-wide pre-signature gate inspects the already-open current journal and every registered prior journal, grouping replacement variants at one nonce and checking their canonical receipts.
3. The remote gate includes current-plan signer-index rows. Only signatures from a validated active pipeline reservation are exempt while its remaining reserved nonces are signed.
4. An original signature whose nonce was consumed by an unknown transaction remains live in recovery. A retry reconciles that signature instead of signing the action at a new nonce.

No migration or compatibility path is needed for prior local registry contents. A registry that names a missing or unreadable journal should continue to fail closed.

## Regression coverage

- Apply one deployment, reorganize away its receipt, then attempt a different plan with the same signer and a separate journal. Assert that no second signature is produced at the freed nonce.
- Repeat with both plans sharing one journal.
- Confirm that a prior canonical receipt permits the next plan, and that a missing or orphaned receipt blocks it.
- Confirm that an interrupted serial apply and a partially signed pipeline reservation still resume their own validated signatures and saved nonce assignments.
- Confirm that replacement variants are checked as one nonce group and that another signer or chain is unaffected.

These tests should use an Anvil reorg without clearing the local signer registry. The fix detects a reorg visible when history is checked; it cannot guarantee that an unfinalized block will never reorganize later.
