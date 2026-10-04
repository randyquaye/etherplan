import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadArtifacts } from '../src/artifacts.ts';
import { hashJson } from '../src/identity.ts';
import { compileConfig, compileSpec, configOptions } from '../src/input/compile.ts';
import { parseHcl } from '../src/input/hcl.ts';
import {
  compileSpecFile,
  findSpecFile,
  loadConfig,
  loadSpec,
  withConfig,
} from '../src/input/project.ts';
import { prepareResources, transactionFor } from '../src/planning/index.ts';
import { dependencyGraphs, graph, parseSpec } from '../src/spec/index.ts';
import { labFixture, labProject } from './ethp-fixtures.ts';

const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const OTHER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const HASH = `0x${'ab'.repeat(32)}`;
const SALT = `0x${'11'.repeat(32)}`;
const COMMANDS = {
  validate: ['spec'],
  plan: [
    'spec',
    'out',
    'state',
    'backend',
    'signer-module',
    'pipeline',
    'deployers',
    'owner',
    'parallel',
    'max-spend-wei',
  ],
  apply: [
    'spec',
    'plan',
    'state',
    'journal',
    'backend',
    'signer-module',
    'parallel',
    'pipeline',
    'max-spend-wei',
    'max-fee-per-gas',
    'priority-fee-per-gas',
    'gas-multiplier',
    'replace-max-fee-per-gas',
    'receipt-timeout-ms',
    'verification-timeout-ms',
  ],
  verify: ['spec', 'state', 'backend'],
};

function compile(source, vars = null, inputs = {}) {
  const files =
    vars === null ? [] : [{ file: 'test.ethpvars', document: parseHcl('test.ethpvars', vars) }];
  return compileSpec(parseHcl('test.ethp', source), {
    varsFile: 'test.ethpvars',
    files,
    ...inputs,
  });
}

function config(source) {
  return compileConfig(parseHcl('test.ethpconfig', source), COMMANDS, (value) =>
    path.join('/project', value),
  );
}

// A contract, a call, and its check. Each error case below replaces one line.
function base({ contract = '', call = '', check = '', extra = '' } = {}) {
  return `chain_id = 1
resource "contract" "registry" {
  artifact = "Registry.json"
  salt     = "${SALT}"
  args     = [var.owner]
  ${contract}
}
resource "call" "configure" {
  target = contracts.registry
  method = "configure"
  args   = []
  ${call}
}
resource "check" "configured" {
  target = calls.configure
  getter = "configured"
  before = false
  equals = true
  ${check}
}
${extra}
variable "owner" {
  type = address
}`;
}

test('the lab .ethp fixture lowers to its schema 2 JSON fixture regardless of block order', async () => {
  const expected = JSON.parse(await readFile(path.join(labFixture, 'lab.json'), 'utf8'));
  assert.deepEqual(await compileSpecFile(path.join(labFixture, 'lab.ethp')), expected);
  assert.deepEqual(await loadSpec(path.join(labFixture, 'lab.ethp')), parseSpec(expected));

  const source = await readFile(path.join(labFixture, 'lab.ethp'), 'utf8');
  const vars = await readFile(path.join(labFixture, 'lab.ethpvars'), 'utf8');
  const reversed = source.split('\n\n').reverse().join('\n\n');
  assert.notEqual(reversed, source);
  assert.deepEqual(compile(reversed, vars.split('\n').reverse().join('\n')), expected);
});

test('an .ethp spec prepares the same resources, graphs, and transactions as its JSON lowering', async () => {
  const directory = await labProject();
  try {
    const load = async (name) => {
      const file = path.join(directory, name);
      const spec = await loadSpec(file);
      const ordered = graph(spec);
      const { resources } = prepareResources(spec, ordered, await loadArtifacts(spec, file));
      return {
        specHash: hashJson(spec),
        graphs: dependencyGraphs(ordered),
        resources,
        transactions: resources
          .filter((resource) => resource.kind !== 'external')
          .map(transactionFor),
      };
    };
    const [ethp, json] = await Promise.all([load('lab.ethp'), load('lab.json')]);
    assert.deepEqual(ethp, json);
    assert.equal(ethp.transactions.length, 6);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('snake_case attributes, check forms, and references map to their JSON fields', async () => {
  const spec = compile(
    `chain_id = 10
dependency_mode = "compatibility"
resource "external" "token" {
  address   = "${OTHER}"
  code_hash = "${HASH}"
  abi       = [{ type = "function", name = "target", inputs = [], outputs = [{ type = "address" }], stateMutability = "view" }]
}
resource "check" "tokenTarget" {
  target = externals.token
  getter = "target"
  equals = contracts.registry.address
}
resource "contract" "registry" {
  artifact    = "Registry.json"
  address     = var.registry
  args        = [externals.token.address, "9007199254740993", -5, [true, null], { label = "x" }]
  code_hash   = "${HASH}"
  signer_role = "deployer"
}
resource "call" "handOff" {
  target              = contracts.registry
  method              = "transferOwnership"
  args                = [var.owner]
  after               = [externals.token, calls.setup]
  transfers_ownership = true
  signer_role         = "owner"
}
resource "call" "setup" {
  target     = contracts.registry
  method     = "setup"
  args       = []
  owner_only = true
}
resource "check" "handOffOwner" {
  target = calls.handOff
  getter = "ownerOf"
  args   = ["1"]
  before = var.previous_owner
  equals = var.owner
}
resource "check" "setupDone" {
  target = calls.setup
  getter = "ready"
  before = false
  equals = true
}
variable "owner" {}
variable "previous_owner" {}
variable "registry" {
  type = address
}`,
    `owner = "${OWNER}"
previous_owner = "${OTHER}"
registry = "${OTHER}"`,
  );
  assert.deepEqual(spec, {
    schema: 2,
    chainId: 10,
    dependencyMode: 'compatibility',
    values: { owner: OWNER, previous_owner: OTHER, registry: OTHER },
    externals: {
      token: {
        address: OTHER,
        codeHash: HASH,
        abi: [
          {
            inputs: [],
            name: 'target',
            outputs: [{ type: 'address' }],
            stateMutability: 'view',
            type: 'function',
          },
        ],
        checks: { target: { ref: 'contracts.registry.address' } },
      },
    },
    contracts: [
      {
        id: 'registry',
        artifact: 'Registry.json',
        address: { ref: 'values.registry' },
        args: [
          { ref: 'externals.token.address' },
          '9007199254740993',
          -5,
          [true, null],
          { label: 'x' },
        ],
        codeHash: HASH,
        signerRole: 'deployer',
      },
    ],
    calls: [
      {
        id: 'handOff',
        target: 'registry',
        method: 'transferOwnership',
        args: [{ ref: 'values.owner' }],
        check: { function: 'ownerOf', args: ['1'], equals: { ref: 'values.owner' } },
        before: { equals: { ref: 'values.previous_owner' } },
        after: ['external:token', 'call:setup'],
        signerRole: 'owner',
        transfersOwnership: true,
      },
      {
        id: 'setup',
        target: 'registry',
        method: 'setup',
        args: [],
        check: { function: 'ready', args: [], equals: true },
        before: { equals: false },
        ownerOnly: true,
      },
    ],
  });
  assert.doesNotThrow(() => parseSpec(spec));
});

test('invalid .ethp and .ethpvars inputs fail with specific errors', async () => {
  const owner = `owner = "${OWNER}"`;
  const cases = [
    [
      'HCL syntax',
      `chain_id = 1\nchain_id = 2`,
      '',
      /test\.ethp:2:1: chain_id is already set on line 1\.$/,
    ],
    ['missing chain_id', 'resource "contract" "a" {}', '', /needs chain_id/],
    [
      'chain_id variable',
      base().replace('chain_id = 1', 'chain_id = var.owner'),
      owner,
      /test\.ethp:1:12: chain_id must be a positive integer/,
    ],
    [
      'unknown top-level',
      base({ extra: 'values = {}' }),
      owner,
      /test\.ethp:21:1: Unknown top-level attribute values\.$/,
    ],
    ['camelCase top-level', base().replace('chain_id', 'chainId'), owner, /Use chain_id/],
    [
      'duplicate resource',
      base({ extra: 'resource "contract" "registry" {}' }),
      owner,
      /Duplicate resource "contract" "registry"/,
    ],
    [
      'unknown resource type',
      base({ extra: 'resource "module" "a" {}' }),
      owner,
      /Unknown resource type module/,
    ],
    [
      'missing name label',
      base({ extra: 'resource "external" {}' }),
      owner,
      /A resource block needs a type label and a name label/,
    ],
    [
      'too many labels',
      base({ extra: 'resource "external" "a" "b" {}' }),
      owner,
      /A resource block needs a type label and a name label/,
    ],
    [
      'unknown attribute hint',
      base({ contract: `codeHash = "${HASH}"` }),
      owner,
      /unknown attribute codeHash\. Use code_hash/,
    ],
    [
      'inline checks',
      base({ contract: 'checks = {}' }),
      owner,
      /Declare checks in resource "check" blocks/,
    ],
    [
      'factory attribute',
      base({ extra: `factory = { address = "${OTHER}" }` }),
      owner,
      /Unknown top-level attribute factory\. Declare factory as a block/,
    ],
    [
      'bare resource value',
      base({ call: 'args = [contracts.registry]' }).replace('args   = []', ''),
      owner,
      /Use contracts\.registry\.address for its address, or list it in after/,
    ],
    [
      'deep variable',
      base().replace('[var.owner]', '[var.owner.address]'),
      owner,
      /unsupported reference var\.owner\.address/,
    ],
    [
      'call reference value',
      base().replace('[var.owner]', '[calls.configure]'),
      owner,
      /unsupported reference calls\.configure/,
    ],
    [
      'unknown contract',
      base().replace('[var.owner]', '[contracts.missing.address]'),
      owner,
      /test\.ethp:5:15: args references unknown contracts\.missing/,
    ],
    [
      'arithmetic',
      base().replace('[var.owner]', '[1 + 2]'),
      '',
      /test\.ethp:5:17: Arithmetic is not supported\.$/,
    ],
    [
      'function',
      base().replace('[var.owner]', '[max(1, 2), var.owner]'),
      owner,
      /test\.ethp:5:15: Function calls are not supported \(max\)/,
    ],
    [
      'string condition',
      base().replace('[var.owner]', '[var.owner ? 1 : 2]'),
      owner,
      /test\.ethp:5:15: The condition in args must be true or false; found string "0xf39F/,
    ],
    [
      'for expression',
      base().replace('[var.owner]', '[for x in [1] : x]'),
      '',
      /test\.ethp:5:15: For expressions are not supported/,
    ],
    [
      'template',
      base().replace('[var.owner]', '["id-${var.owner}"]'),
      owner,
      /test\.ethp:5:19: String templates are not supported/,
    ],
    [
      'index',
      base().replace('[var.owner]', '[var.owner[0]]'),
      owner,
      /test\.ethp:5:24: Index and splat expressions are not supported/,
    ],
    [
      'unsafe number',
      base().replace('[var.owner]', '[9007199254740993]'),
      '',
      /test\.ethp:5:15: Number 9007199254740993 is outside JavaScript's safe integer range\. Quote it as a decimal string: "9007199254740993"/,
    ],
    [
      'exponent number',
      base().replace('[var.owner]', '[1e18]'),
      '',
      /Number 1e18 must be a whole number without a decimal point or exponent/,
    ],
    ['fraction', base().replace('[var.owner]', '[1.5]'), '', /Number 1\.5 must be a whole number/],
    [
      'computed key',
      base({ contract: 'libraries = { (var.owner) = var.owner }' }),
      owner,
      /test\.ethp:6:17: Computed object keys are not supported/,
    ],
    [
      'constant field',
      base().replace(`salt     = "${SALT}"`, 'salt = contracts.registry.address'),
      owner,
      /test\.ethp:4:10: salt must be a constant, so it cannot reference contracts\.registry\.address/,
    ],
    [
      'missing variable',
      base(),
      '',
      /test\.ethp:22:1: Variable owner has no value\. Set it in test\.ethpvars/,
    ],
    [
      'undeclared variable',
      base(),
      `${owner}\nextra = 1`,
      /test\.ethpvars:2:1: extra is not declared\./,
    ],
    [
      'variable reference',
      base(),
      'owner = contracts.registry.address',
      /test\.ethpvars:1:9: Variable owner must be a literal; it cannot reference contracts\.registry\.address/,
    ],
    [
      'undeclared chain_id variable',
      base(),
      `${owner}\nchain_id = 1`,
      /test\.ethpvars:2:1: chain_id is not declared\./,
    ],
    [
      'variable secret',
      base(),
      `${owner}\nprivate_key = "0x01"`,
      /test\.ethpvars:2:1: private_key is a forbidden signer secret/,
    ],
    ['variable name', base(), `${owner}\nOwner = "x"`, /Owner is not declared/],
    [
      'after attribute',
      base({ call: 'after = [contracts.registry.address]' }),
      owner,
      /test\.ethp:12:12: after must be contracts\.<name> or externals\.<name> or calls\.<name>/,
    ],
    [
      'after unknown',
      base({ call: 'after = [calls.missing]' }),
      owner,
      /after references unknown calls\.missing/,
    ],
    [
      'call target external',
      base({ extra: `resource "external" "e" {\n address = "${OTHER}"\n}` }).replace(
        'target = contracts.registry',
        'target = externals.e',
      ),
      owner,
      /test\.ethp:9:12: target must be contracts\.<name>\./,
    ],
    [
      'call without check',
      base()
        .replace('target = calls.configure', 'target = contracts.registry\n  owner = var.owner')
        .replace(/getter.*\n.*before.*\n.*equals.*\n/, ''),
      owner,
      /call:configure needs one check block with target = calls\.configure/,
    ],
    [
      'two call checks',
      base({
        extra:
          'resource "check" "again" {\n target = calls.configure\n getter = "x"\n before = 1\n equals = 2\n}',
      }),
      owner,
      /call:configure has more than one check block: again and configured/,
    ],
    [
      'call check fields',
      base().replace('before = false', ''),
      owner,
      /targets a call and needs getter, before, and equals/,
    ],
    [
      'call check getter map',
      base({ check: 'owner = var.owner' }),
      owner,
      /targets a call and has unknown attribute owner/,
    ],
    [
      'contract check before',
      base({
        extra:
          'resource "check" "c" {\n target = contracts.registry\n owner = var.owner\n before = 1\n}',
      }),
      owner,
      /targets contract:registry; before is only for a check that targets a call/,
    ],
    [
      'contract check args',
      base({
        extra:
          'resource "check" "c" {\n target = contracts.registry\n getter = "owner"\n args = []\n equals = 1\n}',
      }),
      owner,
      /uses getter, so it can set only target, getter, equals, and enabled/,
    ],
    [
      'empty contract check',
      base({ extra: 'resource "check" "c" {\n target = contracts.registry\n}' }),
      owner,
      /"c" needs at least one getter/,
    ],
    [
      'duplicate getter',
      base({
        extra:
          'resource "check" "a" {\n target = contracts.registry\n owner = var.owner\n}\nresource "check" "b" {\n target = contracts.registry\n getter = "owner"\n equals = var.owner\n}',
      }),
      owner,
      /contract:registry getter owner is checked by both a and b/,
    ],
    [
      'check without target',
      base({ extra: 'resource "check" "c" {\n owner = 1\n}' }),
      owner,
      /resource "check" "c" needs target/,
    ],
    [
      'check unknown target',
      base({ extra: 'resource "check" "c" {\n target = contracts.nope\n owner = 1\n}' }),
      owner,
      /test\.ethp:22:11: target references unknown contracts\.nope/,
    ],
    [
      'assumption reference',
      base({
        extra:
          'execution_assumptions = [{ consumer = contracts.registry, location = "args[0]", reference = var.owner, reason = "x" }]',
      }),
      owner,
      /reference must be contracts\.<name>\.address/,
    ],
  ];
  for (const [name, source, vars, expected] of cases) {
    assert.throws(() => parseSpec(compile(source, vars)), expected, name);
  }
});

test('the getter form checks a getter whose name is reserved in check blocks', async () => {
  const spec = compile(
    base({
      extra:
        'resource "check" "c" {\n  target = contracts.registry\n  getter = "target"\n  equals = var.owner\n}',
    }),
    `owner = "${OWNER}"`,
  );
  assert.deepEqual(spec.contracts[0].checks, { target: { ref: 'values.owner' } });
  const special = compile(
    base({ extra: 'resource "check" "c" {\n  target    = contracts.registry\n  __proto__ = 1\n}' }),
    `owner = "${OWNER}"`,
  );
  assert.deepEqual(Object.entries(parseSpec(special).contracts[0].checks), [['__proto__', 1]]);
});

test('config applies command blocks over defaults, and explicit flags over both', async () => {
  const parsed = config(`
defaults {
  state    = "state/defaults.json"
  backend  = "backend.json"
  parallel = true
}
command "plan" {
  out       = "plans/plan.json"
  deployers = ["${OWNER}", "${OTHER}"]
  owner     = "${OWNER}"
  parallel  = false
  state     = "state/plan.json"
}
command "apply" {
  journal = "journal.jsonl"
}`);
  assert.deepEqual(configOptions(parsed, 'plan', COMMANDS.plan), {
    backend: '/project/backend.json',
    deployers: `${OWNER},${OTHER}`,
    out: '/project/plans/plan.json',
    owner: OWNER,
    state: '/project/state/plan.json',
  });
  assert.deepEqual(configOptions(parsed, 'apply', COMMANDS.apply), {
    backend: '/project/backend.json',
    journal: '/project/journal.jsonl',
    parallel: true,
    state: '/project/state/defaults.json',
  });
  assert.deepEqual(configOptions(parsed, 'validate', COMMANDS.validate), {});

  assert.deepEqual(withConfig({ state: 'cli.json' }, parsed, 'plan', COMMANDS.plan), {
    options: {
      backend: '/project/backend.json',
      deployers: `${OWNER},${OTHER}`,
      out: '/project/plans/plan.json',
      owner: OWNER,
      state: 'cli.json',
    },
    configured: ['backend', 'deployers', 'out', 'owner'],
  });
  assert.deepEqual(
    withConfig({ 'signer-module': 'signer.mjs' }, parsed, 'plan', COMMANDS.plan).configured,
    ['backend', 'out', 'state'],
  );
  assert.deepEqual(withConfig({ state: 'cli.json' }, null, 'plan', COMMANDS.plan), {
    options: { state: 'cli.json' },
    configured: [],
  });
  assert.equal(
    configOptions(config('command "plan" {\n out = "-"\n}'), 'plan', COMMANDS.plan).out,
    '-',
  );
});

test('config supplies apply fee, gas, and timeout defaults in their CLI string form', async () => {
  const parsed = config(`
defaults {
  receipt-timeout-ms = 300000
}
command "apply" {
  max-fee-per-gas         = 30000000000
  priority-fee-per-gas    = "1000000000"
  gas-multiplier          = "1.5"
  verification-timeout-ms = "600000"
}`);
  assert.deepEqual(configOptions(parsed, 'apply', COMMANDS.apply), {
    'gas-multiplier': '1.5',
    'max-fee-per-gas': '30000000000',
    'priority-fee-per-gas': '1000000000',
    'receipt-timeout-ms': '300000',
    'verification-timeout-ms': '600000',
  });
  assert.deepEqual(configOptions(parsed, 'plan', COMMANDS.plan), {});
  assert.equal(
    configOptions(config('command "apply" {\n gas-multiplier = 2\n}'), 'apply', COMMANDS.apply)[
      'gas-multiplier'
    ],
    '2',
  );
});

test('config rejects options that must stay explicit, options a command lacks, and secrets', async () => {
  const cases = [
    [
      'command "apply" {\n plan = "plan.json"\n}',
      /command "apply" cannot set plan\. Config can set only/,
    ],
    ['command "plan" {\n signer-module = "signer.mjs"\n}', /cannot set signer-module/],
    ['command "plan" {\n max-spend-wei = "1"\n}', /cannot set max-spend-wei/],
    ['command "apply" {\n replace-max-fee-per-gas = "1"\n}', /cannot set replace-max-fee-per-gas/],
    [
      'command "plan" {\n max-fee-per-gas = "1"\n}',
      /command "plan" cannot set max-fee-per-gas; the command has no --max-fee-per-gas option/,
    ],
    ['command "apply" {\n gas-multiplier = 1.5\n}', /Number 1\.5 must be a whole number/],
    [
      'command "apply" {\n gas-multiplier = "fast"\n}',
      /gas-multiplier must be a whole number or a quoted decimal, such as "1\.5"/,
    ],
    [
      'command "apply" {\n max-fee-per-gas = "30 gwei"\n}',
      /test\.ethpconfig:2:20: max-fee-per-gas must be a whole number of wei/,
    ],
    [
      'defaults {\n receipt-timeout-ms = true\n}',
      /receipt-timeout-ms must be a whole number of milliseconds/,
    ],
    [
      'command "verify" {\n journal = "journal.jsonl"\n}',
      /command "verify" cannot set journal; the command has no --journal option/,
    ],
    ['defaults {\n out = "plan.json"\n}', /defaults cannot set out; set it in a command block/],
    ['command "status" {\n backend = "backend.json"\n}', /command "status" does not read a spec/],
    ['command {\n state = "x"\n}', /A command block needs one label/],
    [
      'defaults {\n private_key = "0x01"\n}',
      /test\.ethpconfig:2:2: private_key is a forbidden signer secret/,
    ],
    ['mnemonic = "words"', /mnemonic is a forbidden signer secret/],
    ['state = "x"', /Unknown top-level attribute state/],
    [
      `command "plan" {\n deployers = "${OWNER}"\n}`,
      /deployers must be a nonempty list of addresses/,
    ],
    ['defaults {\n pipeline = "yes"\n}', /test\.ethpconfig:2:13: pipeline must be true or false/],
    ['command "plan" {\n owner = var.owner\n}', /owner must be a literal/],
  ];
  for (const [source, expected] of cases) assert.throws(() => config(source), expected, source);
});

test('a project requires main.ethp and bundles all root-level .ethp files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-discovery-'));
  try {
    await assert.rejects(findSpecFile(directory), /No main\.ethp/);
    await writeFile(path.join(directory, 'main.ethpvars'), '');
    await writeFile(path.join(directory, 'main.ethpconfig'), '');
    await writeFile(path.join(directory, 'spec.json'), '{}');
    await assert.rejects(findSpecFile(directory), /No main\.ethp/);
    await writeFile(path.join(directory, 'main.ethp'), 'chain_id = 31337\n');
    assert.equal(await findSpecFile(directory), path.join(directory, 'main.ethp'));
    await writeFile(
      path.join(directory, 'other.ethp'),
      'resource "external" "registry" {\n address = "0x0000000000000000000000000000000000000001"\n}\n',
    );
    assert.equal(await findSpecFile(directory), path.join(directory, 'main.ethp'));
    assert.deepEqual((await compileSpecFile(path.join(directory, 'main.ethp'))).externals, {
      registry: { address: '0x0000000000000000000000000000000000000001' },
    });

    await writeFile(
      path.join(directory, 'main.ethpconfig'),
      'defaults {\n  state = "deploy/state.json"\n}\n',
    );
    assert.equal(
      (await loadConfig(path.join(directory, 'main.ethp'), COMMANDS)).defaults.state,
      path.join(directory, 'deploy/state.json'),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('split files share variables, locals, and resource references; duplicates name both files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-split-'));
  const main = path.join(directory, 'main.ethp');
  const other = path.join(directory, 'resources.ethp');
  try {
    await writeFile(
      main,
      'chain_id = 31337\nresource "contract" "alpha" {\n artifact = "Alpha.json"\n salt = "0x1111111111111111111111111111111111111111111111111111111111111111"\n args = [externals.registry.address, var.owner, local.role]\n}\n',
    );
    await writeFile(
      path.join(directory, 'main.ethpvars'),
      'owner = "0x0000000000000000000000000000000000000002"\n',
    );
    await writeFile(
      other,
      'variable "owner" {\n type = address\n}\nlocals {\n role = "deployer"\n}\nresource "external" "registry" {\n address = "0x0000000000000000000000000000000000000001"\n}\n',
    );
    const compiled = await compileSpecFile(main);
    assert.deepEqual(compiled.contracts[0]?.args, [
      { ref: 'externals.registry.address' },
      { ref: 'values.owner' },
      'deployer',
    ]);
    await writeFile(other, 'chain_id = 1\n');
    await assert.rejects(
      compileSpecFile(main),
      /resources\.ethp:1:1: chain_id is already set at .*main\.ethp:1:1/,
    );
    await rm(path.join(directory, 'main.ethpvars'));
    await writeFile(other, 'resource "contract" "alpha" {\n args = []\n}\n');
    await assert.rejects(
      compileSpecFile(main),
      /resources\.ethp:1:1: Duplicate resource "contract" "alpha"; it is first declared at .*main\.ethp:2:1/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
