# Creation proof

Part of [Verify contracts](index.md).

For a deployment with creation transaction evidence, Etherplan records a `creationProof` in the verified journal entry and state. It binds the transaction sender, canonical receipt block, initcode, address, and exact runtime hash; CREATE2 also binds the factory and salt. Later plan, verify, and apply recheck that identity, the current code and artifact runtime, and all declared getters. An unavailable or orphaned saved creation transaction makes verification incomplete even if runtime bytes match. This keeps immutables derived from the deployment block verified after time or block number changes. A replay proof can be reconstructed from its transaction and receipt-block data; a pinned-runtime proof also requires its pre-sign journal commitment. A legacy `proofHash` alone does not prove either.

For a constructor that creates implementation contracts, opt into `creation_proof_mode = "pinned_runtime"` before planning a fresh deployment. Declare an exact parent `code_hash` and at least one `created_code` entry with a zero-argument address getter, positive CREATE nonce, and exact child runtime hash. The JSON equivalents are `creationProofMode: "pinned-runtime"` and `createdCode: [{ getter, createNonce, codeHash }]`. This mode works only with the bundled atomic CREATE2 factory. See [the stateful constructor guide](../recovery/stateful-constructors.md) for an example, hash preparation, and the proof boundary.

A stateful CREATE2 constructor without that opt-in can deploy successfully but fail receipt-block creation replay. Etherplan then stops without recording verified state. The [review and import guide](../recovery/review-and-import.md) explains how to review and explicitly import a previously stopped local deployment. Pinned-runtime mode cannot retroactively prove a transaction whose signed plan lacked those commitments. Tracked in [issue #28](https://github.com/randyquaye/etherplan/issues/28).

[Previous: Import an existing contract](import.md) · [Next: Rebuilt artifacts](artifact-changes.md) · [Stateful constructors](../recovery/stateful-constructors.md)
