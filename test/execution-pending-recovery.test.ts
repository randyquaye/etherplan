import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createWalletClient, encodeFunctionData, http } from 'viem';
import { applyPlan } from '../src/execution/index.ts';
import { hashJson } from '../src/identity.ts';
import { createPlan } from '../src/planning/index.ts';
import { deployerA, fixture, outsider, owner, spare, startAnvil } from './execution/chain.ts';
import { registryArtifact } from './execution/contracts.ts';

const callId = 'call:bind';
const highFees = { maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n };

// Keep the registry's binding() getter, but let either signer set it and count
// every setter call in slot 1. The counter exposes a late transaction's effect.
function countedRegistry() {
  const gate = `73${'00'.repeat(20)}3314603157600080fd`;
  const bypass = `603156${'00'.repeat(27)}`;
  const runtime = registryArtifact.deployedBytecode.object.slice(2)
    .replace(gate, bypass)
    .replace('5b60043560005500', '5b60043560005560015460010160015500');
  assert.ok(runtime.includes(bypass) && runtime.endsWith('60015460010160015500'));
  const size = (runtime.length / 2).toString(16).padStart(2, '0');
  const { artifactHash: _hash, ...original } = registryArtifact;
  const fields = {
    ...original,
    abi: original.abi.map(entry => entry.type === 'constructor' ? { ...entry, inputs: [] } : entry),
    bytecode: { ...original.bytecode, object: `0x60${size}600c60003960${size}6000f3${runtime}` },
    deployedBytecode: { ...original.deployedBytecode, object: `0x${runtime}`, immutableReferences: {} },
  };
  return { ...fields, artifactHash: hashJson(fields) };
}

async function records(file: string) {
  return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function setup(chain: Awaited<ReturnType<typeof startAnvil>>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'etherplan-pending-recovery-'));
  const stateFile = path.join(dir, 'state.json');
  const journalFile = path.join(dir, 'journal.jsonl');
  const artifact = countedRegistry();
  const base = fixture({ withCall: false });
  base.spec.contracts = base.spec.contracts.filter(contract => contract.id === 'registry');
  base.spec.contracts[0].args = [];
  base.artifacts = new Map([['registry', artifact]]);
  const deployment = await createPlan({ ...base, client: chain.client,
    signers: { deployers: [deployerA.address] }, maxSpendWei: '100000000000000000000' });
  const common = { client: chain.client, signers: { deployer: [deployerA], owner },
    stateFile, journalFile, pollIntervalMs: 10, receiptTimeoutMs: 100 };
  assert.equal((await applyPlan({ ...base, plan: deployment, ...common })).status, 'applied');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  const address = deployment.resources[0].address;
  const spec = structuredClone(base.spec);
  spec.calls = [{ id: 'bind', target: 'registry', method: 'setBinding', args: [spare.address],
    check: { function: 'binding', equals: spare.address }, before: { equals: '0x0000000000000000000000000000000000000000' } }];
  const plan = await createPlan({ spec, artifacts: base.artifacts, client: chain.client, state,
    signers: { deployers: [deployerA.address], owner: owner.address }, maxSpendWei: '100000000000000000000' });
  assert.equal(plan.resources.find(resource => resource.id === callId)?.action, 'call');
  return { input: { spec, artifacts: base.artifacts, plan, ...common }, address, journalFile };
}

async function pendingCall(chain: Awaited<ReturnType<typeof startAnvil>>, input: Awaited<ReturnType<typeof setup>>) {
  await chain.rpc('anvil_setAutomine', [false]);
  await assert.rejects(applyPlan({ ...input.input, fees: highFees }), error => error.code === 'receipt-timeout');
  const signed = (await records(input.journalFile)).find(record => record.actionId === callId && record.phase === 'signed');
  assert.ok(signed);
  assert.equal(await chain.client.getTransactionReceipt({ hash: signed.transactionHash }).catch(() => null), null);
  return signed;
}

async function assertPending(chain: Awaited<ReturnType<typeof startAnvil>>, signed: { signer: `0x${string}`; transactionHash: `0x${string}` }) {
  assert.equal(await chain.client.getTransactionReceipt({ hash: signed.transactionHash }).catch(() => null), null);
  assert.equal((await chain.client.getTransaction({ hash: signed.transactionHash })).hash.toLowerCase(), signed.transactionHash.toLowerCase());
  const latest = await chain.client.getTransactionCount({ address: signed.signer, blockTag: 'latest' });
  const pending = await chain.client.getTransactionCount({ address: signed.signer, blockTag: 'pending' });
  assert.ok(pending > latest);
}

test('a satisfied getter cannot close a pending signed call; its later side effect is recorded', async () => {
  const chain = await startAnvil();
  try {
    const input = await setup(chain);
    const signed = await pendingCall(chain, input);
    await assertPending(chain, signed);

    // Mine the other signer's setter alone, then restore the original signed
    // bytes to the pending pool before recovery.
    await chain.rpc('anvil_dropTransaction', [signed.transactionHash]);
    const wallet = createWalletClient({ account: outsider, transport: http(chain.url) });
    const data = encodeFunctionData({ abi: registryArtifact.abi, functionName: 'setBinding', args: [spare.address] });
    const other = await wallet.sendTransaction({ to: input.address, data, gas: 100_000n,
      maxFeePerGas: highFees.maxFeePerGas, maxPriorityFeePerGas: highFees.maxPriorityFeePerGas, chain: null });
    await chain.rpc('evm_mine');
    assert.equal((await chain.client.getTransactionReceipt({ hash: other })).status, 'success');
    assert.equal(await chain.client.getStorageAt({ address: input.address, slot: '0x1' }), '0x' + '0'.repeat(63) + '1');
    await chain.rpc('eth_sendRawTransaction', [signed.rawTransaction]);
    await assertPending(chain, signed);

    await assert.rejects(applyPlan(input.input), error => error.code === 'receipt-timeout');
    const unresolved = await records(input.journalFile);
    assert.equal(unresolved.filter(record => record.actionId === callId && record.phase === 'verified').length, 0);
    assert.equal(unresolved.filter(record => record.actionId === callId && record.phase === 'signed').length, 1);
    await assertPending(chain, signed);

    await chain.rpc('evm_mine');
    const result = await applyPlan(input.input);
    assert.equal(result.status, 'applied');
    assert.equal((await chain.client.getTransactionReceipt({ hash: signed.transactionHash })).status, 'success');
    assert.equal(await chain.client.getStorageAt({ address: input.address, slot: '0x1' }), '0x' + '0'.repeat(63) + '2');
    const settled = await records(input.journalFile);
    assert.equal(settled.filter(record => record.actionId === callId && record.phase === 'receipt').length, 1);
    assert.equal(settled.filter(record => record.actionId === callId && record.phase === 'verified').length, 1);
    assert.equal(settled.find(record => record.actionId === callId && record.phase === 'verified').transactionHash, signed.transactionHash);
    assert.equal((await applyPlan(input.input)).transactionsSigned, 0);
    assert.equal((await records(input.journalFile)).filter(record => record.actionId === callId && record.phase === 'verified').length, 1);
  } finally {
    await chain.rpc('anvil_setAutomine', [true]).catch(() => {});
    await chain.stop();
  }
});

test('a consumed signed nonce with no known receipt reports a conflict', async () => {
  const chain = await startAnvil();
  try {
    const input = await setup(chain);
    const signed = await pendingCall(chain, input);
    await chain.rpc('anvil_dropTransaction', [signed.transactionHash]);
    const competing = await owner.signTransaction({ type: 'eip1559', chainId: input.input.plan.chain.id,
      nonce: Number(signed.nonce), to: owner.address, value: 0n, gas: 21_000n, data: '0x',
      maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 4_000_000_000n });
    await chain.rpc('eth_sendRawTransaction', [competing]);
    await chain.rpc('evm_mine');
    await assert.rejects(applyPlan(input.input), error => error.code === 'nonce-race');
    const journal = await records(input.journalFile);
    assert.equal(journal.filter(record => record.actionId === callId && record.phase === 'verified').length, 0);
    assert.ok(journal.some(record => record.actionId === callId && record.phase === 'failed' && record.code === 'nonce-race'));
  } finally {
    await chain.rpc('anvil_setAutomine', [true]).catch(() => {});
    await chain.stop();
  }
});
