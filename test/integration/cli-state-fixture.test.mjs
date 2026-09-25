import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { startAnvil, stopAnvil } from './anvil.mjs';

const projectDirectory = fileURLToPath(new URL('../..', import.meta.url));
const artifactFile = path.join(projectDirectory, 'test/fixtures/StateFixture.json');
const ownerKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const owner = privateKeyToAccount(ownerKey);
const beneficiary = '0x0000000000000000000000000000000000000001';
const wrongBeneficiary = '0x0000000000000000000000000000000000000002';
const desiredBinding = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const wrongBinding = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
let anvil;
let publicClient;
let walletClient;
let directory;
let artifact;
let address;
let creationHash;

function runVerify(specFile) {
  return spawnSync(process.execPath, ['src/cli.mjs', 'verify', '--spec', specFile], {
    cwd: projectDirectory,
    encoding: 'utf8',
    env: { ...process.env, ETH_RPC_URL: anvil.rpcUrl },
  });
}

function runCli(arguments_) {
  return spawnSync(process.execPath, ['src/cli.mjs', ...arguments_], {
    cwd: projectDirectory,
    encoding: 'utf8',
    env: { ...process.env, ETH_RPC_URL: anvil.rpcUrl },
  });
}

function runImport(specFile, stateFile, transactionHash) {
  return spawnSync(process.execPath, [
    'src/cli.mjs',
    'import',
    '--spec',
    specFile,
    '--id',
    'contract:stateFixture',
    '--state',
    stateFile,
    '--creation-tx',
    transactionHash,
  ], {
    cwd: projectDirectory,
    encoding: 'utf8',
    env: { ...process.env, ETH_RPC_URL: anvil.rpcUrl },
  });
}

function importedSpec(expectedBeneficiary, withBinding = false) {
  return {
    schema: 1,
    chainId: 31337,
    values: {
      beneficiary: expectedBeneficiary,
      owner: owner.address,
      zeroAddress: '0x0000000000000000000000000000000000000000',
      desiredBinding,
    },
    contracts: [{
      id: 'stateFixture',
      source: 'test/fixtures/StateFixture.sol',
      name: 'StateFixture',
      artifact: artifactFile,
      address,
      args: [{ ref: 'values.beneficiary' }, { ref: 'values.owner' }],
      checks: {
        BENEFICIARY: { ref: 'values.beneficiary' },
        owner: { ref: 'values.owner' },
      },
    }],
    calls: withBinding ? [{
      id: 'bind',
      target: 'stateFixture',
      method: 'setBinding',
      args: [{ ref: 'values.desiredBinding' }],
      check: { function: 'binding', equals: { ref: 'values.desiredBinding' } },
      before: { equals: { ref: 'values.zeroAddress' } },
      signerRole: 'owner',
    }] : [],
  };
}

async function saveSpec(name, spec) {
  const file = path.join(directory, name);
  await writeFile(file, `${JSON.stringify(spec, null, 2)}\n`);
  return file;
}

before(async () => {
  anvil = await startAnvil();
  publicClient = createPublicClient({ transport: http(anvil.rpcUrl) });
  walletClient = createWalletClient({ account: owner, transport: http(anvil.rpcUrl) });
  artifact = JSON.parse(await readFile(artifactFile, 'utf8'));
  directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-acceptance-'));
  creationHash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [beneficiary, owner.address],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: creationHash });
  assert.equal(receipt.status, 'success');
  address = receipt.contractAddress;
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
  await stopAnvil(anvil);
});

test('verify proves an imported immutable and rejects the wrong immutable value', async () => {
  const correctFile = await saveSpec('correct.json', importedSpec(beneficiary));
  const wrongFile = await saveSpec('wrong.json', importedSpec(wrongBeneficiary));
  const blockBefore = await anvil.rpc('eth_blockNumber');
  const nonceBefore = await anvil.rpc('eth_getTransactionCount', [owner.address, 'latest']);

  const correct = runVerify(correctFile);
  assert.equal(correct.status, 0, `${correct.stderr}\n${correct.stdout}`);
  assert.match(correct.stdout, /verified|reuse|exact|masked/i);

  const wrong = runVerify(wrongFile);
  assert.equal(wrong.status, 1);
  assert.match(`${wrong.stdout}\n${wrong.stderr}`, /BENEFICIARY.*differ|conflict|mismatch/i);

  assert.equal(await anvil.rpc('eth_blockNumber'), blockBefore);
  assert.equal(await anvil.rpc('eth_getTransactionCount', [owner.address, 'latest']), nonceBefore);
});

test('import rejects wrong immutable evidence and records a verified existing deployment', async () => {
  const correctFile = await saveSpec('import-correct.json', importedSpec(beneficiary));
  const wrongFile = await saveSpec('import-wrong.json', importedSpec(wrongBeneficiary));
  const wrongStateFile = path.join(directory, 'wrong-state.json');
  const stateFile = path.join(directory, 'import-state.json');

  const wrong = runImport(wrongFile, wrongStateFile, creationHash);
  assert.equal(wrong.status, 1);
  assert.match(`${wrong.stdout}\n${wrong.stderr}`, /conflict|BENEFICIARY|immutable|different/i);
  await assert.rejects(access(wrongStateFile), /ENOENT/);

  const imported = runImport(correctFile, stateFile, creationHash);
  assert.equal(imported.status, 0, `${imported.stderr}\n${imported.stdout}`);
  const result = JSON.parse(imported.stdout);
  assert.equal(result.status, 'imported');
  assert.equal(result.id, 'contract:stateFixture');
  assert.equal(result.address.toLowerCase(), address.toLowerCase());
  assert.match(result.codeHash, /^0x[0-9a-f]{64}$/);
  assert.match(result.proofHash, /^0x[0-9a-f]{64}$/);

  const stateText = await readFile(stateFile, 'utf8');
  const state = JSON.parse(stateText);
  assert.equal(state.resources['contract:stateFixture'].address.toLowerCase(), address.toLowerCase());
  assert.equal(state.resources['contract:stateFixture'].transactions.length, 0);
  assert.deepEqual(state.resources['contract:stateFixture'].provenance, {
    kind: 'import',
    creationTransactionHash: creationHash,
  });
  assert.doesNotMatch(stateText, new RegExp(ownerKey.slice(2), 'i'));
});

test('verify distinguishes a binding before value, conflict, and desired value', async () => {
  const specFile = await saveSpec('binding.json', importedSpec(beneficiary, true));

  const beforeResult = runVerify(specFile);
  assert.equal(beforeResult.status, 1);
  assert.match(`${beforeResult.stdout}\n${beforeResult.stderr}`, /call:bind/);
  assert.match(`${beforeResult.stdout}\n${beforeResult.stderr}`, /call|before|unverified|pending/i);

  let hash = await walletClient.writeContract({
    address,
    abi: artifact.abi,
    functionName: 'setBinding',
    args: [wrongBinding],
  });
  assert.equal((await publicClient.waitForTransactionReceipt({ hash })).status, 'success');
  const conflict = runVerify(specFile);
  assert.equal(conflict.status, 1);
  assert.match(`${conflict.stdout}\n${conflict.stderr}`, /conflict|differ|other/i);

  hash = await walletClient.writeContract({
    address,
    abi: artifact.abi,
    functionName: 'setBinding',
    args: [desiredBinding],
  });
  assert.equal((await publicClient.waitForTransactionReceipt({ hash })).status, 'success');
  const desired = runVerify(specFile);
  assert.equal(desired.status, 0, `${desired.stderr}\n${desired.stdout}`);
  assert.match(desired.stdout, /verified|reuse|after/i);
});

test('import --rebaseline accepts a rebuilt artifact for an imported contract; plan and import stay blocked without it', async () => {
  const stateFile = path.join(directory, 'import-state.json');
  const before = JSON.parse(await readFile(stateFile, 'utf8'));
  const prior = before.resources['contract:stateFixture'];
  const raw = structuredClone(artifact);
  delete raw.rawMetadata;
  raw.metadata.settings.remappings = ['forge-std/=lib/forge-std/src/'];
  const rebuiltFile = path.join(directory, 'StateFixture.rebuilt.json');
  await writeFile(rebuiltFile, JSON.stringify(raw));
  const rebuiltSpec = expectedBeneficiary => {
    const spec = importedSpec(expectedBeneficiary);
    spec.contracts[0].artifact = rebuiltFile;
    return spec;
  };
  const specFile = await saveSpec('rebuilt.json', rebuiltSpec(beneficiary));
  const importArguments = ['import', '--spec', specFile, '--id', 'contract:stateFixture', '--state', stateFile];

  const planned = runCli(['plan', '--spec', specFile, '--state', stateFile, '--deployers', owner.address, '--owner', owner.address, '--max-spend-wei', '100000000000000000000']);
  assert.equal(planned.status, 1);
  const [blocked] = JSON.parse(planned.stdout).resources;
  assert.equal(blocked.action, 'conflict');
  assert.match(blocked.observation.stateComparison.artifactDrift.reasons.join(' '), /import --id contract:stateFixture --rebaseline/);

  const plain = runCli(importArguments);
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /different artifact identity\. Use import --rebaseline/);
  const wrongFile = await saveSpec('rebuilt-wrong.json', rebuiltSpec(wrongBeneficiary));
  const wrong = runCli(['import', '--spec', wrongFile, '--id', 'contract:stateFixture', '--state', stateFile, '--rebaseline']);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /conflict/);
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), before);
  const missing = runCli([...importArguments.slice(0, -1), path.join(directory, 'missing-state.json'), '--rebaseline']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no state record to rebaseline/);
  const misused = runCli(['verify', '--spec', specFile, '--rebaseline']);
  assert.equal(misused.status, 2);
  assert.match(misused.stderr, /--rebaseline is not an option for verify/);

  const rebaselined = runCli([...importArguments, '--rebaseline']);
  assert.equal(rebaselined.status, 0, `${rebaselined.stderr}\n${rebaselined.stdout}`);
  const result = JSON.parse(rebaselined.stdout);
  assert.equal(result.status, 'rebaselined');
  assert.equal(result.previousArtifactHash, prior.artifactHash);
  assert.notEqual(result.artifactHash, prior.artifactHash);
  const record = JSON.parse(await readFile(stateFile, 'utf8')).resources['contract:stateFixture'];
  assert.equal(record.artifactHash, result.artifactHash);
  assert.deepEqual(record.provenance, { kind: 'import', creationTransactionHash: creationHash });
  assert.deepEqual(record.artifactRevisions, [{ artifactHash: prior.artifactHash, sourceHash: prior.sourceHash, proofHash: prior.proofHash, codeHash: prior.codeHash }]);
  for (const key of ['address', 'priorAddress', 'initcodeHash', 'inputs', 'inputsHash', 'priorInputs', 'priorInputsHash', 'salt', 'codeHash', 'priorCodeHash', 'priorProofHash', 'transactions']) {
    assert.deepEqual(record[key], prior[key], key);
  }

  const replanned = runCli(['plan', '--spec', specFile, '--state', stateFile, '--deployers', owner.address, '--owner', owner.address, '--max-spend-wei', '100000000000000000000']);
  assert.equal(replanned.status, 0, `${replanned.stderr}\n${replanned.stdout}`);
  const [reused] = JSON.parse(replanned.stdout).resources;
  assert.equal(reused.action, 'reuse');
  assert.equal(reused.observation.stateComparison.artifactDrift, undefined);
});
