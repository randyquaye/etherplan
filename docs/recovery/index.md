# State and recovery

A saved plan, local state, and the journal serve different purposes: the plan pins the reviewed writes, state records verified identities, and the journal preserves signed transactions for safe resume.

1. [Local state, journal, and resume](journals-and-resume.md): locks, durable signatures, and a new plan after partial success.
2. [CREATE2 safety guards](create2-safety.md): predicted addresses and factory checks.
3. [Stateful constructors](stateful-constructors.md): choose pinned-runtime proof before deployment.
4. [RPC replay recovery](rpc-replay.md): retry verification of a signed transaction.
5. [Review and import](review-and-import.md): handle a successful transaction that could not be proved automatically.

For multiple runners sharing a signer, use [shared deployment operations](../operations/index.md). To inspect live state, start with [verification](../verify/index.md).
