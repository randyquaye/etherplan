# Resolution and execution dependencies

Part of [Dependencies and execution order](index.md).

An address reference may be known before the referenced contract exists. In Schema 2, `contracts.registry.address` resolves the registry's predicted CREATE2 address while building another contract's constructor arguments. It does not, by itself, wait for a registry deployment receipt.

Use an execution edge when the consumer needs a verified live contract:

```hcl
resource "contract" "portal" {
  artifact = "Portal.json"
  salt     = derive("portal")
  args     = [contracts.registry.address]
  after    = [contracts.registry]
}
```

Here `args` creates a **resolution dependency** and `after` creates an **execution dependency**. In JSON, a reference may instead set `"requiresLive": true`; `"after": ["contract:registry"]` is the explicit JSON form of the barrier. Use `after` for an HCL project.

HCL projects compile to Schema 2 and use split dependencies by default. Set `dependency_mode = "compatibility"` to make every reference an execution barrier. Schema 1 JSON specs keep that older behavior unless they select `"dependencyMode": "split"`. Cycles in either graph are errors.

[Next: Ordering and assumptions](ordering-and-assumptions.md) · [JSON spec shape](../project/json-spec.md)
