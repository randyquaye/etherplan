# How Etherplan works

Part of [Getting started](index.md).

Your `.ethp` project describes desired contracts, existing addresses, getter checks, and setup calls. `plan` reads the live chain and proposes actions such as `reuse`, `deploy`, or `call`. Review that saved plan before `apply` signs its transactions.

The blockchain is the source of **observed state**. Local state records deployment identity and provenance; it does not replace a live check. `verify` rereads code, immutables, and declared getters. A journal preserves signed transactions and creation evidence so an interrupted apply can resume without choosing a new transaction for the same action.

Etherplan deploys through a checked CREATE2 factory, verifies declared existing contracts and externals, links libraries, and runs declared post-deployment calls. It does not choose an upgrade policy or remove contracts from a chain.

[Next: Install and prepare](install.md) · [Creation proof](../verify/creation-proof.md) · [State and recovery](../recovery/index.md)
