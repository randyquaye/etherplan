# Project files

Start with [HCL projects](hcl.md) to see the shape of `main.ethp`. Etherplan loads every `.ethp` file beside it as one project and compiles them into a JSON spec.

Read the topics as needed:

1. [HCL projects](hcl.md): files, blocks, and a complete example.
2. [Variables](variables.md) and [CREATE2 salts](salts.md): inputs, references, and addresses.
3. [HCL syntax](syntax-and-resources.md) and [resource types](resources.md): accepted forms and fields.
4. [One project for several chains](multi-chain.md): choose local contracts or external addresses.
5. [Conditions](conditions.md): locals and `enabled`.
6. [Workspaces](workspaces.md) and [configuration](configuration.md): separate state and set CLI defaults.

If you generate specs directly, use [JSON spec shape](json-spec.md). For address and execution ordering, use [Dependencies](../dependencies/index.md). Once the project validates, [create a plan](../deploy/validate-and-plan.md).
