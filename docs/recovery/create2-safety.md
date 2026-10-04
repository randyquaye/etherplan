# CREATE2 safety guards

Part of [Recovery](index.md).

A planned CREATE2 deployment stops if its predicted address acquires code without that plan settling a successful deployment transaction. A reverted deployment is not accepted as satisfied, even if matching code appears later. If another tool deployed the contract, [review and import it](../verify/import.md) before planning. Add getter checks for constructor-initialized storage that must hold.

Automated CREATE2 apply also checks the deployment factory before signing. It requires the bundled factory bytecode at the default address or another address with the same runtime. An arbitrary factory could report success after CREATE2 failed, leaving no proof of which transaction created the code. Contracts deployed through another factory can be [imported](../verify/existing-contracts.md) after their live state is reviewed.

[Previous: Local state and journal](journals-and-resume.md) · [Next: Stateful constructors](stateful-constructors.md)
