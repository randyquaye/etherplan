# Resource types

Part of [Project files](index.md).

A project has at least one contract. Each `resource` block has a type and a name; names become IDs such as `contract:registry` or `call:setOwner`.

| Type | Required fields | Purpose |
| --- | --- | --- |
| `contract` | `artifact`; exactly one of `address` or `salt`; `args` when deploying | Adopt an address or deploy compiled code through CREATE2. |
| `external` | `address` | Verify an address managed outside Etherplan. |
| `call` | `target`, `method`, `args`, and one check block | Run a declared method only when its before value allows it, then verify its desired result. |
| `check` | `target` and getter expectations | Attach read-only checks to a contract, external, or call. It is folded into the target, not planned as its own resource. |

## Contracts and externals

`artifact` is a compiled JSON path relative to `main.ethp`. Optional `source` and `name` must match the artifact's identities. A deployable contract needs `args`, including `[]` for a zero-argument constructor. Optional `libraries` links compiled libraries; `after` orders it after verified resources. `code_hash` pins expected runtime code. `signer_role` selects a signer, and `sender_independent = true` allows an eligible deployment to use a secondary deployer. See [pinned runtime](../recovery/stateful-constructors.md) for `creation_proof_mode` and `created_code`.

An external may add `code_hash` and getter checks. If it has checks, supply an `abi`. Writes that reference an external wait for its verification. A top-level `factory` block can specify the CREATE2 factory address and code hash; automated apply still requires the bundled runtime.

## Calls and checks

A call targets a declared contract. Its check block must set `getter`, `before`, and `equals`, with optional getter `args`. The getter must be `view` or `pure` in the ABI. Calls may add `after`, `signer_role`, `owner_only`, or `transfers_ownership`; see [ordering](../dependencies/ordering-and-assumptions.md).

A check on a contract or external can list getter names and expected values, and several check blocks may target the same resource. Each getter can appear only once. For a getter whose name is reserved by the check syntax, use `getter = "target"` and `equals = …`. Any resource can use `enabled = <condition>` to leave it out of the compiled spec.

[Previous: Syntax](syntax-and-resources.md) · [Next: One project for several chains](multi-chain.md) · [Complete example](hcl.md)
