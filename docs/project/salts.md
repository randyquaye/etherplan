# CREATE2 salts

Part of [Project files](index.md).

A top-level `mixer` attribute lets `salt = derive` replace a literal salt. The salt is keccak256 of the mixer, so every derived contract in the project shares one salt and gets its address from its initcode, and renaming a resource does not move it. Two contracts with identical initcode would share an address; `validate` and `plan` report the pair, and `salt = derive("second-instance")` hashes `<mixer>:<label>` for the second one. `derive` is valid only as a salt value, and `mixer` is a constant field, so `mixer = var.mixer` works. The compiled spec records the resulting `salt` beside a `saltDerivation` with the mixer and label, and the plan and state carry both. Rotating the mixer moves every derived contract, so `plan` reports each as a `conflict` with a `saltChange` reason, and a mixer edited after `plan` stops apply with `stale-spec`. A mixer or label is printable ASCII without spaces. Both are public, since the salt is in the factory transaction, and `cast keccak "<mixer>"` reproduces a derived salt.

## Generations

A contract with a derived salt can set `generation`, a whole number that defaults to 0. Above 0 it is appended to the derivation, so `salt = derive` hashes `<mixer> generation <n>` and `derive("label")` hashes `<mixer>:<label> generation <n>`; the space cannot occur in a mixer or label, so no label produces the same salt. Generation 0 adds nothing, so existing salts do not move. `generation` is a constant field, so `generation = var.generation` works, and the compiled spec records it inside `saltDerivation` rather than as a field of its own.

```hcl
resource "contract" "factory" {
  artifact   = "out/Factory.sol/Factory.json"
  salt       = derive
  generation = var.factory_generation
  args       = [var.owner]
}
```

The generation is part of the contract's deployment identity. Raising it moves the address and changes the identity together, so `plan` replaces the contract even when its code and constructor inputs are unchanged, and dependents that take its address redeploy or repoint as for any replacement. Use it to deploy a fresh instance of a contract whose state cannot be repaired, such as one with write-once settings. A rotated mixer or a new label at the same generation is still a `conflict`, and so is a lowered generation, because an earlier address may already hold code. `observation.stateComparison.saltChange` names the old and new generation, and a state record without a generation counts as generation 0.

[Previous: Variables](variables.md) · [Next: Syntax and resources](syntax-and-resources.md)
