# Quick start

Part of [Getting started](index.md).

From your Solidity project, create `main.ethp` beside the build output. This example assumes a compiled contract with no constructor arguments:

```hcl
chain_id = 31337
mixer    = "my-project"

resource "contract" "counter" {
  artifact = "out/Counter.sol/Counter.json"
  salt     = derive
  args     = []
}
```

Change the chain ID and artifact path to match your project. Before planning, [confirm the canonical CREATE2 factory](install.md) is present on your chain.

1. Inspect the compiled JSON spec and validate it without an RPC connection:

   ```sh
   npx etherplan compile
   npx etherplan validate
   ```

2. Set `ETH_RPC_URL`, then make a read-only plan. Replace the signer address and spend ceiling with reviewed values:

   ```sh
   npx etherplan plan --deployers 0xYourDeployer --max-spend-wei 100000000000000000 --out plan.json
   ```

3. Review `plan.json`. Check the action for each resource, chain identity, transaction destination and data, signer, and `maxSpendWei`. Set `DEPLOYER_PRIVATE_KEY` in the process environment, then apply the saved plan:

   ```sh
   npx etherplan apply --plan plan.json
   ```

   A saved-plan apply does not prompt again.

4. Check live state and read the addresses saved in local state:

   ```sh
   npx etherplan verify
   npx etherplan output
   ```

Keep `.etherplan/` state and journal files together for recovery. Continue with [HCL projects](../project/hcl.md), [plan review](../deploy/validate-and-plan.md), and [local recovery](../recovery/journals-and-resume.md).

[Previous: Install and prepare](install.md)
