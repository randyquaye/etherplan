# One project for several chains

Part of [Project files](index.md).

Variables, conditions, and `enabled` let one `.ethp` file describe several deployments, such as a local chain with a mock token and a mainnet deployment that uses an existing token. Etherplan evaluates all of them when it compiles the file, so the JSON spec, its hash, the plan, and apply see only the result. Run `etherplan compile` with the same inputs to see it.

```hcl
variable "chain_id" {
  type    = number
  default = 31337
}

variable "owner" {
  type        = address
  description = "Owner of the vault"
}

variable "token" {
  type    = address
  default = null
}

variable "salt" {
  type    = bytes32
  default = "0x1111111111111111111111111111111111111111111111111111111111111111"
}

locals {
  use_mock = var.token == null
}

chain_id = var.chain_id

resource "contract" "mockToken" {
  enabled  = local.use_mock
  artifact = "MockToken.json"
  salt     = var.salt
  args     = []
}

resource "external" "token" {
  enabled = !local.use_mock
  address = var.token
}

resource "contract" "vault" {
  artifact = "Vault.json"
  salt     = var.salt
  args     = [local.use_mock ? contracts.mockToken.address : externals.token.address, var.owner]
  after    = local.use_mock ? [contracts.mockToken] : [externals.token]
}
```

[Previous: Resource types](resources.md) · [Next: Conditions and optional resources](conditions.md)
