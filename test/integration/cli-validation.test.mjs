import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { hashJson } from '../../src/identity.mjs';
import { parseSpec } from '../../src/spec/index.mjs';
import { startAnvil, stopAnvil } from './anvil.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fixtureFile = path.join(root, 'test/fixtures/state-fixture.json');
const artifactFile = path.join(root, 'test/fixtures/StateFixture.json');
const key = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const signer = privateKeyToAccount(key).address;

function cli(args, rpcUrl = '', signed = false) {
  return spawnSync(process.execPath, ['src/cli.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ETH_RPC_URL: rpcUrl, DEPLOYER_PRIVATE_KEYS: signed ? key : '', DEPLOYER_PRIVATE_KEY: '', OWNER_PRIVATE_KEY: signed ? key : '' },
  });
}

async function workspace() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-validation-'));
  const spec = JSON.parse(await readFile(fixtureFile, 'utf8'));
  spec.contracts[0].artifact = artifactFile;
  const specFile = path.join(directory, 'spec.json');
  await writeFile(specFile, JSON.stringify(spec));
  return { directory, spec, specFile, planFile: path.join(directory, 'plan.json'), journalFile: path.join(directory, 'journal.jsonl'), stateFile: path.join(directory, 'state.json') };
}

async function save(ws) {
  await writeFile(ws.specFile, JSON.stringify(ws.spec));
}

test('validate works offline and distinguishes graph structure from artifact validation', async () => {
  const ws = await workspace();
  try {
    const valid = cli(['validate', '--spec', ws.specFile]);
    assert.equal(valid.status, 0, valid.stderr);
    assert.deepEqual(JSON.parse(valid.stdout), { status: 'valid', resources: ['contract:stateFixture', 'call:bind'] });

    ws.spec.contracts[0].artifact = 'missing.json';
    await save(ws);
    assert.equal(cli(['graph', '--spec', ws.specFile]).status, 0);
    const missing = cli(['validate', '--spec', ws.specFile]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /contract:stateFixture artifact .*missing\.json/);

    await writeFile(path.join(ws.directory, 'broken.json'), '{oops');
    ws.spec.contracts[0].artifact = 'broken.json';
    await save(ws);
    const malformed = cli(['validate', '--spec', ws.specFile]);
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /contract:stateFixture artifact .*broken\.json/);

    ws.spec.contracts[0].artifact = artifactFile;
    ws.spec.contracts[0].source = 'Other.sol';
    await save(ws);
    const wrongSource = cli(['validate', '--spec', ws.specFile]);
    assert.equal(wrongSource.status, 1);
    assert.match(wrongSource.stderr, /contract:stateFixture artifact .*Declared source Other\.sol differs/);

    ws.spec.contracts[0].source = 'test/fixtures/StateFixture.sol';
    ws.spec.contracts[0].name = 'Other';
    await save(ws);
    const wrongName = cli(['validate', '--spec', ws.specFile]);
    assert.equal(wrongName.status, 1);
    assert.match(wrongName.stderr, /contract:stateFixture artifact .*expects Other.*holds StateFixture/);

    const artifact = JSON.parse(await readFile(artifactFile, 'utf8'));
    delete artifact.rawMetadata;
    delete artifact.metadata;
    await writeFile(path.join(ws.directory, 'unidentified.json'), JSON.stringify(artifact));
    ws.spec.contracts[0].artifact = 'unidentified.json';
    ws.spec.contracts[0].name = 'StateFixture';
    await save(ws);
    const unidentified = cli(['validate', '--spec', ws.specFile]);
    assert.equal(unidentified.status, 1);
    assert.match(unidentified.stderr, /contract:stateFixture artifact .*Declared name StateFixture cannot be checked/);

    delete ws.spec.contracts[0].name;
    await save(ws);
    const sourceUnknown = cli(['validate', '--spec', ws.specFile]);
    assert.equal(sourceUnknown.status, 1);
    assert.match(sourceUnknown.stderr, /contract:stateFixture artifact .*Declared source test\/fixtures\/StateFixture\.sol cannot be checked/);

    const inconsistent = JSON.parse(await readFile(artifactFile, 'utf8'));
    inconsistent.contractName = 'Other';
    await writeFile(path.join(ws.directory, 'inconsistent.json'), JSON.stringify(inconsistent));
    ws.spec.contracts[0].artifact = 'inconsistent.json';
    await save(ws);
    const conflict = cli(['validate', '--spec', ws.specFile]);
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /contract:stateFixture artifact .*conflicting contract name declarations/);

    const wrongAbi = JSON.parse(await readFile(artifactFile, 'utf8'));
    wrongAbi.abi.find(item => item.name === 'setBinding').name = 'setOther';
    await writeFile(path.join(ws.directory, 'wrong-abi.json'), JSON.stringify(wrongAbi));
    ws.spec.contracts[0].artifact = 'wrong-abi.json';
    await save(ws);
    const abiConflict = cli(['validate', '--spec', ws.specFile]);
    assert.equal(abiConflict.status, 1);
    assert.match(abiConflict.stderr, /contract:stateFixture artifact .*wrong-abi\.json.*ABI differs from its compiler metadata/);

    const invalidAbi = JSON.parse(await readFile(artifactFile, 'utf8'));
    invalidAbi.abi = [{}];
    await writeFile(path.join(ws.directory, 'invalid-abi.json'), JSON.stringify(invalidAbi));
    ws.spec.contracts[0].artifact = 'invalid-abi.json';
    await save(ws);
    const badAbi = cli(['validate', '--spec', ws.specFile]);
    assert.equal(badAbi.status, 1);
    assert.match(badAbi.stderr, /contract:stateFixture artifact .*invalid-abi\.json.*ABI item 0 has an invalid kind/);
  } finally {
    await rm(ws.directory, { recursive: true, force: true });
  }
});

test('fresh CREATE2 getter error blocks plan and apply before signing or broadcast', async () => {
  const anvil = await startAnvil();
  const ws = await workspace();
  try {
    const good = cli(['plan', '--spec', ws.specFile, '--out', ws.planFile, '--state', ws.stateFile], anvil.rpcUrl);
    assert.equal(good.status, 0, good.stderr);
    const plan = JSON.parse(good.stdout);
    assert.equal(plan.resources[0].action, 'deploy');

    ws.spec.contracts[0].checks.BENEFICIARY_TYPO = ws.spec.contracts[0].checks.BENEFICIARY;
    delete ws.spec.contracts[0].checks.BENEFICIARY;
    await save(ws);
    const invalid = cli(['plan', '--spec', ws.specFile, '--state', ws.stateFile], anvil.rpcUrl);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /BENEFICIARY_TYPO.*no ABI function/);
    assert.equal(invalid.stdout, '');

    // Model a saved plan from an older planner, with internally consistent hashes.
    plan.specHash = hashJson(parseSpec(ws.spec));
    const { planHash, ...fields } = plan;
    plan.planHash = hashJson(fields);
    await writeFile(ws.planFile, JSON.stringify(plan));
    const rejected = cli(['apply', '--spec', ws.specFile, '--plan', ws.planFile, '--state', ws.stateFile, '--journal', ws.journalFile], anvil.rpcUrl, true);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /BENEFICIARY_TYPO.*no ABI function/);
    assert.equal(await anvil.rpc('eth_getTransactionCount', [signer, 'latest']), '0x0');
    const journal = await readFile(ws.journalFile, 'utf8');
    assert.doesNotMatch(journal, /"phase":"signed"|"phase":"broadcast"/);
  } finally {
    await rm(ws.directory, { recursive: true, force: true });
    await stopAnvil(anvil);
  }
});

test('an already satisfied call still rejects a misspelled write method', async () => {
  const anvil = await startAnvil();
  const ws = await workspace();
  try {
    const planned = cli(['plan', '--spec', ws.specFile, '--out', ws.planFile, '--state', ws.stateFile], anvil.rpcUrl);
    assert.equal(planned.status, 0, planned.stderr);
    const applied = cli(['apply', '--spec', ws.specFile, '--plan', ws.planFile, '--state', ws.stateFile, '--journal', ws.journalFile], anvil.rpcUrl, true);
    assert.equal(applied.status, 0, applied.stderr);
    const satisfied = cli(['plan', '--spec', ws.specFile, '--state', ws.stateFile], anvil.rpcUrl);
    assert.equal(satisfied.status, 0, satisfied.stderr);
    assert.equal(JSON.parse(satisfied.stdout).resources.at(-1).action, 'reuse');

    const nonce = await anvil.rpc('eth_getTransactionCount', [signer, 'latest']);
    ws.spec.calls[0].method = 'setBnding';
    await save(ws);
    const invalid = cli(['plan', '--spec', ws.specFile, '--state', ws.stateFile], anvil.rpcUrl);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /call:bind method setBnding.*no ABI function/);
    assert.equal(await anvil.rpc('eth_getTransactionCount', [signer, 'latest']), nonce);
  } finally {
    await rm(ws.directory, { recursive: true, force: true });
    await stopAnvil(anvil);
  }
});
