# Variables

Part of [Project files](index.md).

Each variable is declared in a `variable` block, and `main.ethpvars` sets values with literal assignments, such as `owner = "0x…"`. In a field that can hold references, such as `args`, `address`, `libraries`, or a check's expected value, each `var.owner` compiles to `{ "ref": "values.owner" }`, and `contracts.registry.address` and `externals.name.address` compile to the same references as JSON. Fields that must be constant, such as `chain_id`, `salt`, `code_hash`, `signer_role`, an external's `address`, or the factory, take the variable's value instead, so `salt = var.salt` and `chain_id = var.chain_id` work. An undeclared, unset, or unused variable is an error, and the vars file cannot reference contracts. Because the variables are part of the compiled spec, changing them after `plan` makes a saved-plan apply stop with `stale-spec`.

## Types and input order

A `variable` block declares a variable with an optional `type`, `default`, and `description`. Types are `string`, `number` (a safe whole number), `bool`, `address`, `bytes32`, `list(<type>)`, and `any`, the default. Every value is checked against its type, and `null` is valid for any type, so a variable with `default = null` is optional. A variable with no default must get a value. Every variable the spec uses, and every name set in a vars file or with `--var`, must be declared.

A declared variable takes the last value from this list:

1. its `default`
2. the `ETHP_VAR_<name>` environment variable, such as `ETHP_VAR_owner`
3. `main.ethpvars`
4. `main.<workspace>.ethpvars`, for a workspace other than `default`
5. each `--var-file path.ethpvars`, in order
6. each `--var name=value`, in order

The environment and `--var` give strings. A `string` or `any` variable takes the string as written, a `number` or `bool` parses it, and a `list` parses it as an HCL list, such as `--var 'admins=["0x…","0x…"]'`. Only the input that wins is parsed, so a stale `ETHP_VAR_` value that a vars file or flag overrides does no harm. `ETHP_VAR_` names for undeclared variables are ignored. Commands print each variable's value and source on stderr.

[Previous: HCL projects](hcl.md) · [Next: CREATE2 salts](salts.md)
