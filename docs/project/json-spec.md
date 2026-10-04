# JSON spec shape

Part of [Project files](index.md).

`etherplan compile` turns an HCL project into a canonical Schema 2 JSON spec. A JSON spec has a positive numeric `chainId`, a `schema` of `1` or `2`, and at least one contract. It may also contain `values`, `externals`, `calls`, a CREATE2 `factory`, a dependency mode, and execution assumptions.

A contract names a compiled JSON artifact and has either an existing `address` or a CREATE2 `salt`. A deployable contract has constructor `args`. A call declares its target, method, arguments, allowed `before` getter value, and desired getter value in `check`. Derived salts record their `mixer` and optional `label` alongside the hash.

The [neutral state fixture](../../test/fixtures/state-fixture.json) and [parallel fixture](../../test/fixtures/parallel-lab.json) show complete JSON inputs. They are test fixtures, not deployment recommendations. Keep signer secrets outside the spec.

For the meaning of `dependencyMode`, `requiresLive`, `after`, and `executionAssumptions`, follow [Dependencies and execution order](../dependencies/index.md).

[HCL projects](hcl.md) · [Resource types](resources.md) · [Validate and plan](../deploy/validate-and-plan.md)
