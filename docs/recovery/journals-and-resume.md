# Local state, journal, and resume

Part of [Recovery](index.md).

Apply holds one writer lock while it checks the saved plan and live preconditions. Before broadcasting each transaction, it writes the signed bytes to an append-only journal. On restart, it compares the journal with the chain and resends the same signed bytes when needed.

By default, state, journal, and recovery plans live under `.etherplan/<workspace>/` beside `main.ethp`; the default workspace uses `.etherplan/default/`. Keep these files together. The journal contains raw signed transactions and is written with file mode `0600`.

If a later action fails after a deployment succeeded, correct the spec and create a new plan with the same state and journal. Planning rechecks verified creation evidence against the live chain and current inputs. Apply checks the journal proof again under its writer lock before accepting that plan. If apply used a custom journal, pass the same `--journal path/to/journal.jsonl` to plan. A missing or mismatched proof leaves the resource `unverified`.

A saved plan pins the state it observed. If another plan or import changed that state, apply stops with `stale-state`; make a new plan. An interrupted apply can resume its own saved plan.

[Next: CREATE2 safety](create2-safety.md) · [Apply a plan](../deploy/apply.md) · [Creation proof](../verify/creation-proof.md)
