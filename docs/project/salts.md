# CREATE2 salts

Part of [Project files](index.md).

A top-level `mixer` attribute lets `salt = derive` replace a literal salt. The salt is keccak256 of the mixer, so every derived contract in the project shares one salt and gets its address from its initcode, and renaming a resource does not move it. Two contracts with identical initcode would share an address; `validate` and `plan` report the pair, and `salt = derive("second-instance")` hashes `<mixer>:<label>` for the second one. `derive` is valid only as a salt value, and `mixer` is a constant field, so `mixer = var.mixer` works. The compiled spec records the resulting `salt` beside a `saltDerivation` with the mixer and label, and the plan and state carry both. Rotating the mixer moves every derived contract, so `plan` reports each as a `conflict` with a `saltChange` reason, and a mixer edited after `plan` stops apply with `stale-spec`. A mixer or label is printable ASCII without spaces. Both are public, since the salt is in the factory transaction, and `cast keccak "<mixer>"` reproduces a derived salt.

[Previous: Variables](variables.md) · [Next: Syntax and resources](syntax-and-resources.md)
