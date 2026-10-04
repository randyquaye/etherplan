# Conditions, locals, and optional resources

Part of [Project files](index.md).

## Expressions

A condition uses `condition ? a : b`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||`, `!`, and parentheses, with HCL's precedence. A condition must be `true` or `false`; strings and numbers are not truthy. `==` needs both sides to have the same type unless one is `null`, and compares hex strings such as addresses without regard to case. `<`, `<=`, `>`, and `>=` compare numbers. `&&` and `||` skip their right side once the left side decides, so `var.limit != null && var.limit > 0` is safe. Conditions can use only literals, variables, and locals; they cannot use a contract address, which is not known until planning. Only the chosen branch is evaluated, but every branch must name declared variables and resources. A conditional expression spans lines only inside parentheses or brackets.

## Locals and enabled resources

A `locals` block names expressions, such as `use_mock` in the [multi-chain example](multi-chain.md), for use as `local.<name>`. A local is evaluated where it is used, so a local can hold a condition, a value, a contract address, or a resource for `after`. A local cannot refer to itself, and an unused local is an error.

`enabled = <condition>` on a resource block leaves that resource out of the compiled spec. Any reference that evaluation reaches, in `args`, `address`, `libraries`, `after`, `target`, a check value, or an execution assumption's `reference`, must not name a disabled resource; put it behind the same condition. A check block is dropped with its target, and an execution assumption is dropped with its consumer. A check block can also set its own `enabled`; to check a getter named `enabled`, write `getter = "enabled"`. Disabling a resource stops Etherplan from managing it; it does not remove the contract from the chain, and planning ignores its state record.

## Null values and spec hashes

As in Terraform, an attribute that evaluates to `null` is left unset. One contract can adopt an existing deployment where one is given and deploy otherwise: `address = var.existing` with `salt = var.existing == null ? var.salt : null`.

The compiled spec keeps as `values` only the non-null variables that a reference field still uses. A variable used only in a condition, `enabled`, or a constant field is folded into the spec, so changing it changes the spec hash only when it changes the result. `impact --value` covers only the variables kept as values.

[Previous: One project for several chains](multi-chain.md) · [Next: Workspaces](workspaces.md)
