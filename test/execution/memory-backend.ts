import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { scopeKey } from '../../src/execution/backends.ts';

export function memoryBackend(scope) {
  const journals = new Map();
  const recordsFor = (deployment = scope) => {
    const key = scopeKey(deployment);
    if (!journals.has(key)) journals.set(key, []);
    return journals.get(key);
  };
  const records = recordsFor();
  const signed = [];
  const locks = new Map();
  const states = new Map();
  let version = 0;
  const key = randomBytes(32);
  const lockKey = value => JSON.stringify(value);
  const held = fence => fence.every(entry => {
    const current = locks.get(lockKey(entry.scope));
    return current?.token === entry.token && current.holder.id === entry.holderId && current.expiresAt > Date.now();
  });
  return {
    records, recordsFor,
    stateStore: {
      async read(deployment = scope) { return structuredClone(states.get(scopeKey(deployment)) ?? null); },
      async compareAndSwap(deployment, expected, value, { fence }) {
        if (fence.length < 2 || !held(fence) || expected !== (states.get(scopeKey(deployment))?.version ?? null)) throw new Error('State fence or version mismatch.');
        const state = { version: String(++version), value: structuredClone(value) };
        states.set(scopeKey(deployment), state);
        return structuredClone(state);
      },
    },
    journalStore: {
      async *signedForSigner(deployment, address) {
        for (const entry of signed) if (entry.signer === address.toLowerCase() && entry.chainId === deployment.chainId && entry.genesisHash === deployment.genesisHash) yield structuredClone(entry);
      },
      async head(deployment = scope) { const last = recordsFor(deployment).at(-1); return last ? { sequence: last.sequence, recordHash: last.recordHash } : null; },
      async *read(deployment = scope) { for (const record of recordsFor(deployment)) yield structuredClone(record); },
      async append(deployment, record, { expectedSequence, expectedPreviousHash, fence }) {
        const journal = recordsFor(deployment);
        if (fence.length < 2 || !held(fence) || expectedSequence !== journal.length + 1 || expectedPreviousHash !== (journal.at(-1)?.recordHash ?? null)) throw new Error('Journal fence or predecessor mismatch.');
        journal.push(structuredClone(record));
        if (record.phase === 'signed') signed.push({ project: deployment.project, environment: deployment.environment, chainId: deployment.chainId, genesisHash: deployment.genesisHash,
          label: deployment.label, planHash: record.planHash, actionId: record.actionId, signer: record.signer.toLowerCase(), nonce: record.nonce, transactionHash: record.transactionHash.toLowerCase() });
        return record;
      },
    },
    lockProvider: {
      async acquire(lockScope, holder, ttlMs) {
        const id = lockKey(lockScope);
        const previous = locks.get(id);
        if (previous?.expiresAt > Date.now()) throw new Error('Writer lock is held.');
        const token = (previous?.token ?? 0) + 1;
        locks.set(id, { token, holder, expiresAt: Date.now() + ttlMs });
        const assertHeld = () => { if (!held([{ scope: lockScope, token, holderId: holder.id }])) throw new Error('Writer lease is lost.'); };
        return {
          fencingToken: token,
          async renew() { assertHeld(); locks.get(id).expiresAt = Date.now() + ttlMs; },
          async assertHeld() { assertHeld(); },
          async release() { if (held([{ scope: lockScope, token, holderId: holder.id }])) locks.get(id).expiresAt = 0; },
        };
      },
    },
    journalCipher: {
      async encrypt(bytes, context) {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(Buffer.from(JSON.stringify(context)));
        const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
        return { iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
      },
      async decrypt(value, context) {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
        decipher.setAAD(Buffer.from(JSON.stringify(context)));
        decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]);
      },
    },
  };
}
