# Etherplan documentation

The repository [README](../README.md) gives the shortest path from install to a verified deployment. Use these guides when you need a specific task or rule. Command examples use `etherplan`; prefix them with `npx` for a project-local install.

1. **[Getting started](start/index.md):** how Etherplan observes the chain, installation, and a complete quick start.
2. **[Project files and DSL](project/index.md):** `main.ethp`, resource fields, variables, conditions, salts, workspaces, and config.
3. **[Dependencies and graphs](dependencies/index.md):** Schema 2 resolution, execution barriers, assumptions, and waves.
4. **[Planning and execution](deploy/index.md):** validate, review, apply, fees, parallel deployers, and pipelining.
5. **[State and recovery](recovery/index.md):** journals, CREATE2 guards, stateful constructors, and resuming stopped work.
6. **[Verification and adoption](verify/index.md):** live checks, creation proof, import, and artifact drift.
7. **[Shared operations](operations/index.md):** DynamoDB state and journals, S3 plans, KMS, and signer services.
8. **[CLI reference](reference/index.md):** command matrix and environment variables.
9. **[Developer tools](internals/index.md):** CI checks, adapters, tests, architecture, and design notes.

For a first run, follow [Quick start](start/quickstart.md) → [Project files](project/hcl.md) → [Dependencies](dependencies/resolution-and-execution.md) → [Plan review](deploy/validate-and-plan.md) → [Verification](verify/existing-contracts.md).
