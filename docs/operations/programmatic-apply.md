# Programmatic apply and signer services

Part of [Shared deployment operations](index.md).

```js
import { applyPlan, createAwsBackend, createSignerServiceProvider } from 'etherplan';

const backend = createAwsBackend({
  tableName: 'etherplan-deployments',
  kmsKeyId: 'arn:aws:kms:REGION:ACCOUNT:key/KEY_ID',
  bucket: 'etherplan-plans',
});
const scope = {
  project: 'my-app', environment: 'testnet', label: 'blue',
  chainId: plan.chain.id, genesisHash: plan.chain.genesisHash,
};
const signerProvider = createSignerServiceProvider({ url: 'https://signer.example.test/' });
await backend.planStore.put(scope, plan);
const result = await applyPlan({
  plan, spec, artifacts, client, signerProvider,
  stateStore: backend.stateStore, journalStore: backend.journalStore,
  lockProvider: backend.lockProvider, journalCipher: backend.journalCipher,
  scope, principal: 'ci-role/my-app-deploy', confirmations: 12,
  reporter: event => deploymentLog.write(event),
});
```

`signerProvider.address(role)` and `signerProvider.signTransaction(role, request, authorization)` are the only required signer methods. The default roles are `deployer` and, when the plan needs it, `owner`. Pass `signerRoles: { deployer: ['role-a', 'role-b'], owner: 'owner-role' }` for multiple deployers. The optional third argument contains the scope and current fencing tokens. A production signer service should validate these tokens against the lock table before signing, so an expired runner cannot sign while its old request is still in flight. Etherplan decodes every returned EIP-1559 transaction and verifies chain ID, sender, nonce, destination, value, calldata, gas, and fees before persisting it. The signer service adapter calls `GET /address?role=...` and `POST /sign` with `{ role, transaction, authorization }`; the latter returns `{ rawTransaction }`. Use HTTPS except for local loopback testing. Pass service credentials through the adapter's `headers` option; user-info credentials in the URL are rejected.

The reporter receives JSON-safe events with plan and chain identity, scope, principal, action, sequence, and phase. Events include lock acquisition and renewal, intent, signed, broadcast attempt and result, receipt, verification, resource reuse and resume, recovery, rebroadcast, conflict, and terminal failure. Timing fields include lock wait, journal append, signer, broadcast, and receipt latency. The reporter must not log raw signed bytes.

[Previous: AWS permissions](permissions.md) · [Deployment scope](scope-and-recovery.md)
