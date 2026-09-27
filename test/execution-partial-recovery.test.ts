import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyPlan } from '../src/execution/index.ts';
import { readStoredJournal } from '../src/execution/backends.ts';
import { readLocalJournal } from '../src/execution/journal.ts';
import { createPlan } from '../src/planning/index.ts';
import { hashJson } from '../src/identity.ts';
import { deployerA, fixture, owner, startAnvil } from './execution/chain.ts';
import { memoryBackend } from './execution/memory-backend.ts';

const signers = { deployer: [deployerA], owner };
const policy = { signers: { deployers: [deployerA.address], owner: owner.address, parallel: false }, maxSpendWei: '100000000000000000000' };

for (const mode of ['local', 'production'] as const) {
  test(`${mode} planning recovers completed deployments after a later postcondition failure`, async () => {
    const chain = await startAnvil();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-partial-recovery-'));
    try {
      const stateFile = path.join(directory, 'state.json');
      const journalFile = path.join(directory, 'journal.jsonl');
      const genesisHash = (await chain.client.getBlock({ blockNumber: 0n })).hash;
      const scope = { project: 'test', environment: 'dev', label: 'partial', chainId: 31337, genesisHash };
      const backend = mode === 'production' ? memoryBackend(scope) : null;
      const storage = backend ? { ...backend, scope, confirmations: 1 } : { stateFile, journalFile };
      const broken = fixture();
      broken.spec.calls[0].check.equals = { ref: 'values.other' };
      const first = await createPlan({ ...broken, client: chain.client, ...policy });
      await assert.rejects(applyPlan({ ...broken, plan: first, client: chain.client, signers, ...storage, pollIntervalMs: 20 }),
        (error: { code?: string }) => error.code === 'postcondition');
      const history = backend ? await readStoredJournal(backend.journalStore, scope) : await readLocalJournal(journalFile);
      const deployed = history.filter(record => record.phase === 'verified' && record.actionId.startsWith('contract:'));
      assert.equal(deployed.length, 4);
      if (backend) assert.equal(await backend.stateStore.read(scope), null);
      else await assert.rejects(readFile(stateFile, 'utf8'), { code: 'ENOENT' });

      const corrected = fixture();
      const incomplete = await createPlan({ ...corrected, client: chain.client,
        journalRecords: history.filter(record => record.phase === 'verified'), ...policy });
      assert.ok(incomplete.resources.some(resource => resource.kind === 'contract' && resource.action === 'unverified'));
      const next = await createPlan({ ...corrected, client: chain.client, journalRecords: history, ...policy });
      assert.ok(next.resources.filter(resource => resource.kind === 'contract').every(resource => resource.action === 'reuse'));
      const signaturesBefore = history.filter(record => record.phase === 'signed').length;
      if (mode === 'production') {
        const changed = structuredClone(next);
        const contract = changed.resources.find(resource => resource.kind === 'contract');
        contract.observation.creationProof.blockHash = `0x${'ff'.repeat(32)}`;
        const { planHash: _oldHash, ...fields } = changed;
        changed.planHash = hashJson(fields);
        await assert.rejects(applyPlan({ ...corrected, plan: changed, client: chain.client, signers, ...storage, pollIntervalMs: 20 }),
          (error: { code?: string }) => error.code === 'journal');
      }
      const result = await applyPlan({ ...corrected, plan: next, client: chain.client, signers, ...storage, pollIntervalMs: 20 });
      assert.equal(result.status, 'applied');
      assert.equal(result.transactionsSigned, 0);
      const after = backend ? await readStoredJournal(backend.journalStore, scope) : await readLocalJournal(journalFile);
      assert.equal(after.filter(record => record.phase === 'signed').length, signaturesBefore);
      const state = backend ? (await backend.stateStore.read(scope))?.value : JSON.parse(await readFile(stateFile, 'utf8'));
      for (const resource of next.resources.filter(resource => resource.kind === 'contract')) {
        const record = state.resources[resource.id];
        assert.equal(record.provenance.kind, 'apply');
        assert.equal(record.creationProof.transactionHash, resource.observation.creationProof.transactionHash);
        assert.ok(record.transactions.includes(record.creationProof.transactionHash));
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
      await chain.stop();
    }
  });
}
