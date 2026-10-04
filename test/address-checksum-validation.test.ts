import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { isAddress } from 'viem';
import { isUserAddress } from '../src/address.ts';
import { loadArtifacts } from '../src/artifacts.ts';
import { compileSpec } from '../src/input/compile.ts';
import { parseHcl } from '../src/input/hcl.ts';
import { createPlan, prepareResources } from '../src/planning/index.ts';
import { linkBytecode, linkPlaceholder } from '../src/verification/bytecode.ts';
import { normalizeAbiValue } from '../src/verification/values.ts';
import { validateLibraries, validateResources } from '../src/validation/index.ts';
import { labProject } from './ethp-fixtures.ts';

const fixtureFile = path.resolve('test/fixtures/state-fixture.json');
const valid = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const typo = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92267';
const base = JSON.parse(await readFile(fixtureFile, 'utf8'));
const artifacts = await loadArtifacts(base, fixtureFile);

test('mixed-case typos fail offline validation and planning before any RPC', async () => {
  assert.equal(isAddress(valid), true);
  assert.equal(isAddress(typo), false);
  for (const change of [
    (spec) => {
      spec.values.owner = typo;
    },
    (spec) => {
      spec.values.desiredBinding = typo;
    },
  ]) {
    const spec = structuredClone(base);
    change(spec);
    assert.throws(
      () => prepareResources(spec, null, artifacts),
      /(?:contract:stateFixture constructor|call:bind).*valid address/,
    );
    let rpcCalls = 0;
    const client = new Proxy(
      {},
      {
        get() {
          return async () => {
            rpcCalls++;
            throw new Error('RPC must not be called.');
          };
        },
      },
    );
    await assert.rejects(createPlan({ spec, artifacts, client }), /valid address/);
    assert.equal(rpcCalls, 0);
  }
});

test('a reused values reference cannot self-verify a mistyped constructor address in JSON or compiled HCL', async () => {
  const spec = structuredClone(base);
  spec.values.beneficiary = typo;
  assert.throws(
    () => prepareResources(spec, null, artifacts),
    /contract:stateFixture constructor.*argument beneficiary.*valid address/,
  );

  const directory = await labProject();
  const source = await readFile(path.join(directory, 'lab.ethp'), 'utf8');
  const vars = (await readFile(path.join(directory, 'lab.ethpvars'), 'utf8')).replace(
    '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    typo,
  );
  // The .ethp spec declares owner as an address, so the typo fails at compile time, before artifacts load.
  assert.throws(
    () =>
      compileSpec(parseHcl('lab.ethp', source), {
        files: [{ file: 'lab.ethpvars', document: parseHcl('lab.ethpvars', vars) }],
      }),
    /lab\.ethpvars:3:19: Variable owner must be an address; found string "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92267"/,
  );
});

test('nested arrays, tuples, getter arguments and expected values retain their location', () => {
  const nested = { type: 'tuple', components: [{ name: 'recipients', type: 'address[]' }] };
  assert.throws(
    () => normalizeAbiValue(nested, { recipients: [valid, typo] }, 'constructor owner'),
    /constructor owner\.recipients\[1\].*valid address/,
  );

  const resources = structuredClone(prepareResources(base, null, artifacts).resources);
  const call = resources.find((resource) => resource.kind === 'call');
  call.args[0] = typo;
  assert.throws(
    () => validateResources(resources),
    /call:bind method setBinding.*argument value.*valid address/,
  );
  call.args[0] = valid;
  call.after.args = [typo];
  call.abi.push({
    type: 'function',
    name: 'byOwner',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  });
  call.after.functionName = 'byOwner';
  assert.throws(
    () => validateResources(resources),
    /call:bind check byOwner after.*argument owner.*valid address/,
  );
  call.after.args = [valid];
  call.after.expected = typo;
  assert.throws(
    () => validateResources(resources),
    /call:bind check byOwner after.*expected.*valid address/,
  );
});

test('literal linked libraries reject an invalid mixed-case checksum', () => {
  const key = 'Lib.sol:MyLib';
  const references = { 'Lib.sol': { MyLib: [{ start: 1, length: 20 }] } };
  const object = `0x73${linkPlaceholder(key)}3014`;
  assert.throws(
    () => linkBytecode(object, references, { [key]: typo }),
    /Lib\.sol:MyLib.*checksum/,
  );
  const artifact = structuredClone(artifacts.get('stateFixture'));
  artifact.bytecode = { object, linkReferences: references };
  artifact.deployedBytecode = { object, linkReferences: references, immutableReferences: {} };
  assert.throws(
    () => validateLibraries(artifact, { [key]: typo }, 'contract:linked'),
    /contract:linked libraries.*Lib\.sol:MyLib.*checksum/,
  );
});

test('checksummed and single-case forms encode the same address bytes', () => {
  const parameter = { type: 'address' };
  const forms = [valid, valid.toLowerCase(), valid.toUpperCase().replace('0X', '0x')];
  assert.ok(forms.every(isUserAddress));
  assert.deepEqual(
    forms.map((value) => normalizeAbiValue(parameter, value)),
    Array(3).fill(valid.toLowerCase()),
  );
  assert.equal(isUserAddress(typo), false);
});
