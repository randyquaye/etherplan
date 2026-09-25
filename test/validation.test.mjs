import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadArtifacts } from '../src/artifacts.mjs';
import { applyPlan } from '../src/execution/index.mjs';
import { hashJson } from '../src/identity.mjs';
import { prepareResources } from '../src/planning/index.mjs';
import { parseSpec } from '../src/spec/index.mjs';
import { validateResources } from '../src/validation/index.mjs';
import { exampleSpec, normalizedArtifact, plan as savedPlan } from './interface-fixtures.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const specFile = path.join(directory, 'fixtures/state-fixture.json');
const base = JSON.parse(await readFile(specFile, 'utf8'));
const artifacts = await loadArtifacts(base, specFile);
const ADDRESS = '0x0000000000000000000000000000000000000001';

function prepared(spec, artifactMap = artifacts) {
  return prepareResources(spec, undefined, artifactMap);
}

test('checks require view or pure ABI functions in contracts, externals, and calls', () => {
  for (const stateMutability of ['nonpayable', 'payable']) {
    const artifact = structuredClone(artifacts.get('stateFixture'));
    artifact.abi.find(item => item.name === 'BENEFICIARY').stateMutability = stateMutability;
    assert.throws(() => prepared(base, new Map([['stateFixture', artifact]])), /contract:stateFixture check BENEFICIARY.*view or pure/);

    const external = structuredClone(base);
    external.externals = { feed: { address: ADDRESS, abi: [{ type: 'function', name: 'answer', inputs: [], outputs: [{ type: 'uint256' }], stateMutability }], checks: { answer: '1' } } };
    assert.throws(() => prepared(external), /external:feed check answer.*view or pure/);

    const callArtifact = structuredClone(artifacts.get('stateFixture'));
    callArtifact.abi.find(item => item.name === 'binding').stateMutability = stateMutability;
    assert.throws(() => prepared(base, new Map([['stateFixture', callArtifact]])), /call:bind check binding after.*view or pure/);

    const resources = prepared(base).resources;
    const call = resources.find(item => item.kind === 'call');
    call.abi = structuredClone(call.abi);
    call.abi.push({ type: 'function', name: 'mutatingCheck', inputs: [], outputs: [{ type: 'address' }], stateMutability });
    call.before.functionName = 'mutatingCheck';
    assert.throws(() => validateResources(resources), /call:bind check binding before.*view or pure/);
  }

  const artifact = structuredClone(artifacts.get('stateFixture'));
  artifact.abi.find(item => item.name === 'BENEFICIARY').stateMutability = 'pure';
  assert.doesNotThrow(() => prepared(base, new Map([['stateFixture', artifact]])));
});

test('offline validation checks getters on absent contracts and externals', () => {
  const wrongName = structuredClone(base);
  wrongName.contracts[0].checks.BENEFICIARY_TYPO = wrongName.contracts[0].checks.BENEFICIARY;
  delete wrongName.contracts[0].checks.BENEFICIARY;
  assert.throws(() => prepared(wrongName), /contract:stateFixture check BENEFICIARY_TYPO.*no ABI function/);

  const wrongOutput = structuredClone(base);
  wrongOutput.contracts[0].checks.BENEFICIARY = 'not an address';
  assert.throws(() => prepared(wrongOutput), /contract:stateFixture check BENEFICIARY.*valid address/);

  const extraTupleField = structuredClone(base);
  extraTupleField.contracts[0].checks.details = { owner: ADDRESS, unexpected: ADDRESS };
  const withTuple = structuredClone(artifacts.get('stateFixture'));
  withTuple.abi.push({ type: 'function', name: 'details', inputs: [], outputs: [{ type: 'tuple', components: [{ name: 'owner', type: 'address' }] }], stateMutability: 'view' });
  assert.throws(() => prepared(extraTupleField, new Map([['stateFixture', withTuple]])), /contract:stateFixture check details.*valid tuple/);

  const external = structuredClone(base);
  external.externals = { feed: { address: ADDRESS, checks: { answer: '1' } } };
  assert.throws(() => prepared(external), /external:feed check answer.*needs an ABI/);
  external.externals.feed.abi = [
    { type: 'function', name: 'answer', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
    { type: 'function', name: 'answer', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  ];
  assert.throws(() => prepared(external), /external:feed check answer.*more than one ABI function/);
  external.externals.feed.abi.pop();
  external.externals.feed.checks.answer = 'not a number';
  assert.throws(() => prepared(external), /external:feed check answer.*valid uint256/);
});

test('offline validation checks dormant call methods, arguments, and predicates', () => {
  const wrongMethod = structuredClone(base);
  wrongMethod.calls[0].method = 'setBnding';
  assert.throws(() => prepared(wrongMethod), /call:bind method setBnding.*no ABI function/);

  const wrongArguments = structuredClone(base);
  wrongArguments.calls[0].args = ['not an address'];
  assert.throws(() => prepared(wrongArguments), /call:bind method setBinding.*valid address/);

  const shortArray = structuredClone(base);
  shortArray.calls[0].args = [[ADDRESS]];
  const withArrayMethod = structuredClone(artifacts.get('stateFixture'));
  withArrayMethod.abi.find(item => item.name === 'setBinding').inputs[0].type = 'address[2]';
  assert.throws(() => prepared(shortArray, new Map([['stateFixture', withArrayMethod]])), /call:bind method setBinding.*valid address\[2\]/);

  const wrongGetter = structuredClone(base);
  wrongGetter.calls[0].check.function = 'bindng';
  assert.throws(() => prepared(wrongGetter), /call:bind check bindng after.*no ABI function/);

  const wrongBefore = structuredClone(base);
  wrongBefore.calls[0].before.equals = 'not an address';
  assert.throws(() => prepared(wrongBefore), /call:bind check binding before.*valid address/);

  const badCheckArgs = structuredClone(base);
  badCheckArgs.calls[0].check.function = 'byOwner';
  badCheckArgs.calls[0].check.args = ['not an address'];
  const withGetter = structuredClone(artifacts.get('stateFixture'));
  withGetter.abi.push({ type: 'function', name: 'byOwner', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'address' }], stateMutability: 'view' });
  assert.throws(() => prepared(badCheckArgs, new Map([['stateFixture', withGetter]])), /call:bind check byOwner after.*valid address/);

  const overloaded = structuredClone(artifacts.get('stateFixture'));
  overloaded.abi.push(structuredClone(overloaded.abi.find(item => item.name === 'setBinding')));
  assert.throws(() => prepared(base, new Map([['stateFixture', overloaded]])), /call:bind method setBinding.*more than one ABI function/);
});

test('offline validation checks constructor inputs and all declared libraries', () => {
  const badConstructor = structuredClone(base);
  badConstructor.contracts[0].args[0] = 'not an address';
  assert.throws(() => prepared(badConstructor), /contract:stateFixture constructor.*valid address/);

  const unknownLibrary = structuredClone(base);
  unknownLibrary.contracts[0].libraries = { 'Other.sol:Missing': ADDRESS };
  assert.throws(() => prepared(unknownLibrary), /contract:stateFixture libraries.*Unknown linked library Other.sol:Missing/);

  const imported = structuredClone(base);
  imported.contracts[0].address = ADDRESS;
  delete imported.contracts[0].salt;
  imported.contracts[0].args[0] = 'not an address';
  assert.throws(() => prepared(imported), /contract:stateFixture constructor.*valid address/);
});

test('apply preflight rejects an old invalid plan without invoking a signer or broadcast', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-invalid-preflight-'));
  let signatures = 0;
  let broadcasts = 0;
  try {
    const spec = structuredClone(exampleSpec);
    spec.contracts[0].checks = { misspelled: '1' };
    const plan = structuredClone(savedPlan);
    plan.specHash = hashJson(parseSpec(spec));
    const { planHash, ...fields } = plan;
    plan.planHash = hashJson(fields);
    const signer = {
      address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      async signTransaction() { signatures++; throw new Error('Signer should not be called.'); },
    };
    const client = { async request() { broadcasts++; throw new Error('Broadcast should not be called.'); } };
    await assert.rejects(applyPlan({
      plan, spec, artifacts: new Map([['example', normalizedArtifact]]), client,
      signers: { deployer: [signer] },
      stateFile: path.join(directory, 'state.json'), journalFile: path.join(directory, 'journal.jsonl'),
    }), /contract:example check misspelled.*no ABI function/);
    assert.equal(signatures, 0);
    assert.equal(broadcasts, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
