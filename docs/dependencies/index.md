# Dependencies and execution order

Etherplan has two questions to answer: **which addresses and values are needed to build an action**, and **which resources must already be verified on chain before that action runs**.

1. [Resolution and execution](resolution-and-execution.md): Schema 2 split dependencies and compatibility mode.
2. [Ordering and assumptions](ordering-and-assumptions.md): `after`, implicit barriers, ownership transfer, and safe predicted addresses.
3. [Inspect graphs and waves](graphs-and-waves.md): use `graph` and `schedule` to inspect the resulting order.

For resource syntax, start with [HCL projects](../project/hcl.md). For transaction batching, see [parallel deployers](../deploy/parallel.md) and [pipelining](../deploy/pipeline.md).
