# Write an HCL project

Part of [Project files](index.md).

Write a Terraform-style project with `main.ethp` in its root directory. Every other `.ethp` file directly in that directory joins the same project; files in subdirectories do not. Etherplan combines all declarations before resolving variables and references, so resources, variables, and locals can refer across files. It then compiles the project and optional `main.ethpvars` into a `schema: 2` JSON spec for validation, planning, hashing, and applying. Duplicate top-level attributes and resource declarations are errors. [The lab fixture](../../test/fixtures/ethp/lab.ethp) and [its JSON form](../../test/fixtures/ethp/lab.json) show a full example.

```hcl
chain_id = 31337
mixer    = "myorg/myproject"

variable "owner" {
  type = address
}

variable "previous_owner" {
  type    = address
  default = "0x0000000000000000000000000000000000000000"
}

resource "contract" "registry" {
  artifact = "Registry.json"
  salt     = derive
  args     = [var.owner]
}

resource "contract" "portal" {
  artifact = "Portal.json"
  salt     = derive("portal")
  args     = [contracts.registry.address, "86400"]
  after    = [contracts.registry]
}

resource "check" "portalRefs" {
  target   = contracts.portal
  REGISTRY = contracts.registry.address
}

resource "call" "setOwner" {
  target = contracts.portal
  method = "setOwner"
  args   = [var.owner]
}

resource "check" "setOwnerResult" {
  target = calls.setOwner
  getter = "owner"
  before = var.previous_owner
  equals = var.owner
}
```

[Next: Variables](variables.md)
