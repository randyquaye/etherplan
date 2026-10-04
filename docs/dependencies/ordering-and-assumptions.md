# Ordering and execution assumptions

Part of [Dependencies and execution order](index.md).

Some barriers are automatic. A call waits for its target contract. A write that references an external address waits for that external to be verified. A call named `transferOwnership`, or marked `transfers_ownership = true`, waits for owner-only calls on the same target. For other ordering needs, add `after = [contracts.registry]` or another declared resource.

A constructor argument or linked library can name a predicted contract address without guaranteeing that the constructor only stores it. In split mode, Etherplan warns when such a reference has no execution edge. If the constructor calls the referenced contract, add `after`. If it only stores the address, record the exact reviewed use:

```hcl
execution_assumptions = [{
  consumer  = contracts.portal
  location  = "args[0]"
  reference = contracts.registry.address
  reason    = "Constructor only stores this address."
}]
```

The JSON form uses `executionAssumptions` with `consumer: "contract:portal"`, `location: "args[0]"`, and `reference: "contracts.registry.address"`. Library locations use `libraries.<artifact name>`. An assumption must match a real constructor or library reference and suppresses only its warning; it does not create an execution edge.

[Previous: Resolution and execution](resolution-and-execution.md) · [Next: Inspect graphs and waves](graphs-and-waves.md)
