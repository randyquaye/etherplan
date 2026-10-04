import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, stringToBytes } from 'viem';
import { compileSpec } from '../src/input/compile.ts';
import { parseHcl } from '../src/input/hcl.ts';
import { createPlan, prepareResources } from '../src/planning/index.ts';
import { parseSpec } from '../src/spec/index.ts';
import { deriveSalt } from '../src/spec/salt.ts';
import { importResource, recordResource, validateState } from '../src/state/index.ts';
import {
  normalizedArtifact,
  plan as interfacePlan,
  preparedResource,
  verificationResult,
} from './interface-fixtures.ts';

const MIXER = 'aztec/rollup';
const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const SALT = `0x${'11'.repeat(32)}`;
const GENESIS = `0x${'aa'.repeat(32)}`;
const OBSERVED_HASH = `0x${'bb'.repeat(32)}`;
const FACTORY = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
const FACTORY_CODE = '0x6001';

function compile(source, vars = null) {
  const files =
    vars === null ? [] : [{ file: 'test.ethpvars', document: parseHcl('test.ethpvars', vars) }];
  return compileSpec(parseHcl('test.ethp', source), { varsFile: 'test.ethpvars', files });
}

// Two contracts that derive their salts. Each error case below replaces one line.
function project({
  mixer = `mixer = "${MIXER}"`,
  registry = 'salt     = derive',
  portal = 'salt     = derive("second-instance")',
  extra = '',
} = {}) {
  return `chain_id = 1
${mixer}
resource "contract" "registry" {
  artifact = "Registry.json"
  ${registry}
  args     = []
}
resource "contract" "portal" {
  artifact = "Portal.json"
  ${portal}
  args     = []
}
${extra}`;
}

function planningClient() {
  return {
    async getChainId() {
      return 31337;
    },
    async getBlock(request) {
      return request.blockNumber === 0n
        ? { number: 0n, hash: GENESIS }
        : { number: 7n, hash: OBSERVED_HASH };
    },
    async getCode({ address }) {
      return address.toLowerCase() === FACTORY.toLowerCase() ? FACTORY_CODE : '0x';
    },
    async readContract() {
      throw new Error('No read was expected.');
    },
  };
}

test('derive lowers to keccak256 of the mixer, or of mixer:label, and records the derivation beside the salt', () => {
  const spec = compile(project());
  const registry = spec.contracts.find((item) => item.id === 'registry');
  const portal = spec.contracts.find((item) => item.id === 'portal');
  assert.deepEqual(registry, {
    id: 'registry',
    artifact: 'Registry.json',
    salt: keccak256(stringToBytes(MIXER)),
    saltDerivation: { mixer: MIXER },
    args: [],
  });
  assert.deepEqual(portal, {
    id: 'portal',
    artifact: 'Portal.json',
    salt: keccak256(stringToBytes(`${MIXER}:second-instance`)),
    saltDerivation: { mixer: MIXER, label: 'second-instance' },
    args: [],
  });
  assert.equal(registry.salt, deriveSalt(MIXER));
  assert.equal(portal.salt, deriveSalt(MIXER, 'second-instance'));
  assert.deepEqual(Object.keys(registry), ['id', 'artifact', 'salt', 'saltDerivation', 'args']);
  assert.deepEqual(parseSpec(spec).contracts, spec.contracts);

  // The mixer and a label are constant fields, so variables can supply them, and derive can sit in a branch.
  const adopt = (existing) =>
    compile(
      project({
        mixer: 'mixer = var.mixer',
        registry: 'salt     = var.existing == null ? derive : null\n  address  = var.existing',
        portal: 'salt     = derive(var.instance)',
        extra:
          'variable "mixer" {\n  type = string\n}\nvariable "instance" {\n  type    = string\n  default = "second-instance"\n}\nvariable "existing" {\n  type    = address\n  default = null\n}',
      }),
      `mixer = "${MIXER}"${existing ? `\nexisting = "${existing}"` : ''}`,
    );
  assert.deepEqual(adopt(null), spec);
  const adopted = adopt(OWNER);
  assert.deepEqual(
    adopted.contracts.find((item) => item.id === 'registry'),
    { id: 'registry', artifact: 'Registry.json', address: { ref: 'values.existing' }, args: [] },
  );
  assert.deepEqual(adopted.values, { existing: OWNER });
});

test('derive and mixer are checked for a mixer, labels, placement, and use', () => {
  const cases = [
    [
      'no mixer',
      project({ mixer: '' }),
      /test\.ethp:5:14: salt uses derive, so the spec needs a top-level mixer attribute\.$/,
    ],
    [
      'null mixer',
      project({
        mixer: 'mixer = var.mixer',
        extra: 'variable "mixer" {\n  type    = string\n  default = null\n}',
      }),
      /salt uses derive, so the spec needs a top-level mixer attribute\.$/,
    ],
    [
      'untaken branch',
      project({
        mixer: '',
        registry: `salt     = true ? "${SALT}" : derive`,
        portal: `salt     = "${SALT}"`,
      }),
      /salt uses derive, so the spec needs a top-level mixer attribute\.$/,
    ],
    [
      'unused mixer',
      project({ registry: `salt     = "${SALT}"`, portal: `salt     = "0x${'22'.repeat(32)}"` }),
      /test\.ethp:2:1: mixer is unused; no salt uses derive\.$/,
    ],
    [
      'mixer with a space',
      project({ mixer: 'mixer = "has space"' }),
      /test\.ethp:2:9: mixer must be a nonempty string of printable ASCII characters without spaces; found string "has space"\.$/,
    ],
    [
      'mixer number',
      project({ mixer: 'mixer = 1' }),
      /mixer must be a nonempty string of printable ASCII characters without spaces; found number 1\.$/,
    ],
    [
      'mixer block',
      project({ mixer: 'mixer {}' }),
      /Unknown block type mixer\. Set mixer with =\.$/,
    ],
    [
      'empty label',
      project({ portal: 'salt     = derive("")' }),
      /test\.ethp:10:21: derive takes one label, a nonempty string of printable ASCII characters without spaces; found string ""\.$/,
    ],
    [
      'label number',
      project({ portal: 'salt     = derive(1)' }),
      /derive takes one label, a nonempty string of printable ASCII characters without spaces; found number 1\.$/,
    ],
    [
      'two labels',
      project({ portal: 'salt     = derive("a", "b")' }),
      /test\.ethp:10:14: derive takes one label, such as derive\("second-instance"\)\. Write derive alone for the default salt\.$/,
    ],
    [
      'no label',
      project({ portal: 'salt     = derive()' }),
      /derive takes one label, such as derive\("second-instance"\)/,
    ],
    [
      'derive in libraries',
      project({ portal: 'salt     = derive\n  libraries = { "src/L.sol:L" = derive("x") }' }),
      /test\.ethp:11:33: libraries uses derive, which is valid only as a salt value\.$/,
    ],
    [
      'derive as address',
      project({ registry: 'address  = derive' }),
      /test\.ethp:5:14: address uses derive, which is valid only as a salt value\.$/,
    ],
    [
      'derive in a local',
      project({ registry: 'salt     = local.s', extra: 'locals {\n  s = derive\n}' }),
      /test\.ethp:14:7: local\.s uses derive, which is valid only as a salt value\.$/,
    ],
    [
      'derive in a list',
      project({ registry: 'salt     = [derive]' }),
      /salt uses derive, which is valid only as a salt value\.$/,
    ],
    [
      'unknown function',
      project({ registry: 'salt     = derived("x")' }),
      /Function calls are not supported \(derived\)/,
    ],
    [
      'derive with address',
      project({ registry: `salt     = derive\n  address  = "${OWNER}"` }),
      /contract:registry needs exactly one of address or salt\./,
    ],
  ];
  for (const [name, source, expected] of cases) {
    assert.throws(() => parseSpec(compile(source)), expected, name);
  }
});

test('a JSON spec must keep salt and saltDerivation consistent', () => {
  const contract = {
    id: 'registry',
    artifact: 'Registry.json',
    salt: deriveSalt(MIXER),
    saltDerivation: { mixer: MIXER },
    args: [],
  };
  const spec = (fields) => ({ schema: 2, chainId: 1, contracts: [{ ...contract, ...fields }] });
  assert.deepEqual(parseSpec(spec({})).contracts[0].saltDerivation, { mixer: MIXER });
  const labelled = { salt: deriveSalt(MIXER, 'x'), saltDerivation: { mixer: MIXER, label: 'x' } };
  assert.deepEqual(parseSpec(spec(labelled)).contracts[0].saltDerivation, {
    mixer: MIXER,
    label: 'x',
  });
  const cases = [
    [
      { saltDerivation: { mixer: MIXER, extra: 1 } },
      /contract:registry saltDerivation must be an object with mixer and an optional label\./,
    ],
    [
      { saltDerivation: 'x' },
      /contract:registry saltDerivation must be an object with mixer and an optional label\./,
    ],
    [
      { saltDerivation: { mixer: 'has space' } },
      /contract:registry saltDerivation mixer must be a nonempty string of printable ASCII characters without spaces\./,
    ],
    [
      { saltDerivation: { mixer: MIXER, label: '' } },
      /contract:registry saltDerivation label must be a nonempty string of printable ASCII characters without spaces\./,
    ],
    [{ salt: SALT }, /contract:registry salt is not the salt derived from its saltDerivation\./],
    [
      { saltDerivation: { mixer: MIXER, label: 'x' } },
      /contract:registry salt is not the salt derived from its saltDerivation\./,
    ],
  ];
  for (const [fields, expected] of cases) assert.throws(() => parseSpec(spec(fields)), expected);
  assert.throws(
    () =>
      parseSpec({
        schema: 2,
        chainId: 1,
        contracts: [
          {
            id: 'registry',
            artifact: 'Registry.json',
            address: OWNER,
            saltDerivation: { mixer: MIXER },
          },
        ],
      }),
    /contract:registry saltDerivation requires a CREATE2 salt\./,
  );
});

test('two contracts that derive the same salt from identical initcode are reported with a label hint', () => {
  const artifacts = new Map([
    ['a', normalizedArtifact],
    ['b', normalizedArtifact],
  ]);
  const spec = (first, second) => ({
    schema: 2,
    chainId: 1,
    contracts: [
      { id: 'a', artifact: 'Example.json', ...first, args: [] },
      { id: 'b', artifact: 'Example.json', ...second, args: [] },
    ],
  });
  const derived = { salt: deriveSalt(MIXER), saltDerivation: { mixer: MIXER } };
  const labelled = {
    salt: deriveSalt(MIXER, 'second-instance'),
    saltDerivation: { mixer: MIXER, label: 'second-instance' },
  };
  assert.throws(
    () => prepareResources(spec(derived, derived), undefined, artifacts),
    /^Error: contract:b resolves to the same address as contract:a\. Both derive their salt from mixer "aztec\/rollup" and have the same initcode; give one of them a label, such as salt = derive\("second-instance"\)\.$/,
  );
  assert.throws(
    () => prepareResources(spec({ salt: SALT }, { salt: SALT }), undefined, artifacts),
    /^Error: contract:b resolves to the same address as contract:a\.$/,
  );
  const { resources, addresses } = prepareResources(spec(derived, labelled), undefined, artifacts);
  assert.notEqual(addresses.a, addresses.b);
  assert.deepEqual(
    resources.map((resource) => resource.saltDerivation),
    [{ mixer: MIXER }, { mixer: MIXER, label: 'second-instance' }],
  );
});

test('state records a derived salt beside its derivation, drops it for an explicit salt, and checks that they agree', () => {
  const derived = {
    ...preparedResource,
    salt: deriveSalt(MIXER),
    saltDerivation: { mixer: MIXER },
  };
  const { chain } = interfacePlan;
  const imported = importResource({
    resource: derived,
    verification: verificationResult,
    state: null,
    chain,
  });
  const record = imported.resources['contract:example'];
  assert.equal(record.salt, deriveSalt(MIXER));
  assert.deepEqual(record.saltDerivation, { mixer: MIXER });
  assert.deepEqual(validateState(imported), imported);

  const recorded = recordResource({
    resource: derived,
    verification: verificationResult,
    state: imported,
    chain,
    transactions: [],
  });
  assert.deepEqual(recorded.resources['contract:example'].saltDerivation, { mixer: MIXER });
  const explicit = recordResource({
    resource: { ...preparedResource, salt: deriveSalt(MIXER) },
    verification: verificationResult,
    state: imported,
    chain,
    transactions: [],
  });
  assert.equal(Object.hasOwn(explicit.resources['contract:example'], 'saltDerivation'), false);

  const tampered = (change) => {
    const copy = structuredClone(imported);
    change(copy.resources['contract:example'], copy);
    return copy;
  };
  assert.throws(
    () =>
      validateState(
        tampered((item) => {
          item.saltDerivation.mixer = 'other';
        }),
      ),
    /contract:example salt is not the salt derived from its saltDerivation\./,
  );
  assert.throws(
    () =>
      validateState(
        tampered((item) => {
          item.saltDerivation = { mixer: MIXER, note: 1 };
        }),
      ),
    /contract:example saltDerivation must be an object with mixer and an optional label\./,
  );
  assert.throws(
    () =>
      validateState(
        tampered((item, state) => {
          state.resources['call:bind'] = {
            address: item.address,
            transactions: [],
            saltDerivation: { mixer: MIXER },
          };
        }),
      ),
    /call:bind saltDerivation belongs only to a contract\./,
  );
});

test('a changed mixer or label is a conflict whose saltChange names the old and new derivation', async () => {
  const artifacts = new Map([['vault', normalizedArtifact]]);
  const spec = (fields) => ({
    schema: 2,
    chainId: 31337,
    factory: { address: FACTORY, codeHash: keccak256(FACTORY_CODE) },
    contracts: [{ id: 'vault', artifact: 'Vault.json', ...fields, args: [] }],
  });
  const derived = (derivation) => ({
    salt: deriveSalt(derivation.mixer, derivation.label),
    saltDerivation: derivation,
  });
  const chain = { id: 31337, genesisHash: GENESIS };
  const [resource] = prepareResources(
    spec(derived({ mixer: MIXER })),
    undefined,
    artifacts,
  ).resources;
  const verification = {
    id: resource.id,
    address: resource.address,
    codeHash: `0x${'44'.repeat(32)}`,
    codeComparison: { mode: 'exact', matched: true },
    proofs: [],
    missingProofs: [],
    bindingChecks: [],
    status: 'verified',
  };
  const state = importResource({ resource, verification, state: null, chain });
  assert.deepEqual(state.resources['contract:vault'].saltDerivation, { mixer: MIXER });

  const plan = (fields) =>
    createPlan({ spec: spec(fields), artifacts, client: planningClient(), state });
  const same = await plan(derived({ mixer: MIXER }));
  assert.equal(same.resources[0].action, 'deploy');
  assert.deepEqual(same.resources[0].saltDerivation, { mixer: MIXER });
  assert.equal(same.resources[0].observation.stateComparison.saltChange, undefined);

  const rotated = await plan(derived({ mixer: 'aztec/rollup-v2' }));
  assert.equal(rotated.resources[0].action, 'conflict');
  assert.deepEqual(rotated.resources[0].saltDerivation, { mixer: 'aztec/rollup-v2' });
  assert.deepEqual(rotated.resources[0].observation.stateComparison.saltChange, {
    previousSalt: deriveSalt(MIXER),
    salt: deriveSalt('aztec/rollup-v2'),
    previousDerivation: { mixer: MIXER },
    derivation: { mixer: 'aztec/rollup-v2' },
    reason: 'The mixer changed from "aztec/rollup" to "aztec/rollup-v2".',
  });

  const relabelled = await plan(derived({ mixer: MIXER, label: 'second-instance' }));
  assert.equal(relabelled.resources[0].action, 'conflict');
  assert.equal(
    relabelled.resources[0].observation.stateComparison.saltChange.reason,
    'The derive label changed from no label to label "second-instance".',
  );

  const explicit = await plan({ salt: SALT });
  assert.equal(explicit.resources[0].action, 'conflict');
  assert.equal(explicit.resources[0].saltDerivation, undefined);
  assert.deepEqual(explicit.resources[0].observation.stateComparison.saltChange, {
    previousSalt: deriveSalt(MIXER),
    salt: SALT,
    previousDerivation: { mixer: MIXER },
    derivation: null,
    reason: 'The salt is now explicit; the saved salt was derived from mixer "aztec/rollup".',
  });
});
