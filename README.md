# Etherplan

Etherplan is a CLI for deploying and checking EVM contracts. You describe the contracts you want in a `main.ethp` file and point to compiled Solidity artifacts. Etherplan compares that project with the chain, saves a plan for review, applies the plan, and verifies the result.

It deploys through the canonical CREATE2 factory, can adopt existing contracts, and can run declared setup calls. It does not manage upgrades or delete contracts.

## Install

Use Node.js 22.18 or newer. Install the current beta in your Solidity project from its GitHub tag:

```sh
npm install --save-dev 'github:randyquaye/etherplan#v0.1.1-beta'
npx etherplan --version
```

The package is not on the npm registry yet.

## Create a project

Put `main.ethp` in the directory where you will run Etherplan. For example, with a compiled `Counter` artifact:

```hcl
chain_id = 31337
mixer    = "my-project"

resource "contract" "counter" {
  artifact = "out/Counter.sol/Counter.json"
  salt     = derive
  args     = []
}
```

Change `chain_id` and `artifact` to match your chain and build output. Artifact paths are relative to `main.ethp`. `mixer` gives derived CREATE2 salts a stable project name. If your constructor takes arguments, put them in `args`.

From that directory, check the project without a chain connection:

```sh
npx etherplan validate
```

Etherplan reads every `.ethp` file beside `main.ethp` as one project. See [Project files](docs/project/index.md) for variables, existing contracts, checks, calls, and dependencies.

## Plan, apply, verify

Set `ETH_RPC_URL` to your chain's RPC endpoint. The chain ID must match the project, and CREATE2 deployment requires the canonical factory at `0x4e59b44847b379578588920cA78FbF26c0B4956C`.

```sh
npx etherplan plan --deployers 0xYourDeployer --max-spend-wei 100000000000000000 --out plan.json
```

Replace the deployer address and spend ceiling with values you intend to use. `plan` reads the chain and writes no transactions. Review `plan.json`, including its actions, transaction data, and maximum spend, before applying it.

Set `DEPLOYER_PRIVATE_KEY` in the process environment, then run:

```sh
npx etherplan apply --plan plan.json
npx etherplan verify
npx etherplan output
```

`apply --plan` sends the saved plan without another approval prompt. `verify` checks the live chain; `output` prints addresses recorded in local state. Keep the `.etherplan/` state and journal files together so an interrupted apply can resume. Keep signer keys out of `.ethp` files.

See [Deploy contracts](docs/deploy/index.md) for signers, spend limits, recovery, and advanced execution options.

## More documentation

- [Documentation](docs/README.md): find a guide by task.
- [Project files](docs/project/index.md): HCL, variables, checks, workspaces, and config.
- [Deploy contracts](docs/deploy/index.md): plans, apply, recovery, fees, and pipelining.
- [Verify contracts](docs/verify/index.md): live checks, creation proof, and rebuilt artifacts.
- [Shared operations](docs/operations/index.md): AWS state, journals, and signers.
- [Working on Etherplan](docs/internals/index.md): development, architecture, and design notes.

Run `npx etherplan --help` for all commands or, for example, `npx etherplan plan --help` for options.
