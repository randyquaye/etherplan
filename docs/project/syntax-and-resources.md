# HCL syntax

Part of [Project files](index.md).

Etherplan accepts attributes, blocks, comments, quoted strings, whole numbers, `true`, `false`, `null`, lists, objects, references, and [conditions](conditions.md). Use `var.owner` directly in a value field, not a string template such as `"${var.owner}"`.

Heredocs, string templates, arithmetic, `for` expressions, index expressions, and function calls other than `derive` are unsupported. Errors name the file, line, and column. Numbers must be whole and within JavaScript's safe integer range (±9007199254740991). Quote larger integers, such as wei amounts, as decimal strings.

Resource types are `contract`, `external`, `call`, and `check`. Attribute names use snake case: `chain_id`, `code_hash`, `owner_only`, and `sender_independent`, for example. See the [resource reference](resources.md) for required fields and checks. `target` and `after` take resources such as `contracts.registry`, `externals.token`, or `calls.setOwner`; their ordering rules are in [Dependencies](../dependencies/index.md).

Run `etherplan compile` from the directory containing `main.ethp` to inspect the canonical JSON spec. The CLI loads all root-level `.ethp` files together. There is no `--spec` option. Declaration order does not affect the spec hash: contracts and calls are sorted by ID.

[Previous: CREATE2 salts](salts.md) · [Next: Resource types](resources.md)
