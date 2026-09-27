import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inWorkspace, stateFileFor } from '../src/cli/environment.ts';
import { COMMANDS, parseOptions, usage, validateOptions } from '../src/cli/options.ts';
import { hashJson } from '../src/identity.ts';
import { compileProject } from '../src/input/compile.ts';
import { parseHcl } from '../src/input/hcl.ts';
import { compileProjectFile, loadProject, selectWorkspace } from '../src/input/project.ts';
import { parseSpec } from '../src/spec/index.ts';

const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const OTHER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const USDC = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const SALT = `0x${'11'.repeat(32)}`;
const PROD_SALT = `0x${'22'.repeat(32)}`;

function world(source, { files = {}, env = {}, vars = [] } = {}) {
  return compileProject(parseHcl('main.ethp', source), {
    varsFile: 'main.ethpvars',
    files: Object.entries(files).map(([file, text]) => ({ file, document: parseHcl(file, text) })),
    env,
    vars,
  });
}

const spec = (source, inputs) => world(source, inputs).spec;
const sources = result => Object.fromEntries(result.variables.map(variable => [variable.name, [variable.value, variable.source]]));

// One spec, two worlds: dev deploys a mock token, prod uses an existing token and checks the vault owner.
const MULTI = `variable "chain_id" {
  type    = number
  default = 31337
}
variable "env" {
  type        = string
  default     = "dev"
  description = "dev, staging, or prod"
}
variable "owner" {
  type = address
}
variable "salt" {
  type    = bytes32
  default = "${SALT}"
}
variable "usdc" {
  type    = address
  default = null
}
variable "admins" {
  type    = list(address)
  default = []
}

locals {
  prod     = var.env == "prod"
  use_mock = !local.prod && var.usdc == null
  token    = local.use_mock ? contracts.mockToken.address : externals.usdc.address
}

chain_id = var.chain_id

resource "external" "usdc" {
  enabled = !local.use_mock
  address = var.usdc
}

resource "contract" "mockToken" {
  enabled  = local.use_mock
  artifact = "Mock.json"
  salt     = var.salt
  args     = []
}

resource "contract" "vault" {
  artifact = "Vault.json"
  salt     = var.salt
  args     = [local.token, var.owner, var.admins, local.prod ? 1 : 0]
  after    = local.use_mock ? [contracts.mockToken] : [externals.usdc]
}

resource "check" "mockOwner" {
  target = contracts.mockToken
  owner  = var.owner
}

resource "check" "vaultOwner" {
  target  = contracts.vault
  enabled = local.prod
  owner   = var.owner
}
`;

test('one spec lowers to a different concrete world for each set of inputs', () => {
  const dev = spec(MULTI, { vars: [`owner=${OWNER}`] });
  assert.deepEqual(dev, {
    schema: 2,
    chainId: 31337,
    values: { admins: [], owner: OWNER },
    externals: {},
    contracts: [
      { id: 'mockToken', artifact: 'Mock.json', salt: SALT, args: [], checks: { owner: { ref: 'values.owner' } } },
      { id: 'vault', artifact: 'Vault.json', salt: SALT, args: [{ ref: 'contracts.mockToken.address' }, { ref: 'values.owner' }, { ref: 'values.admins' }, 0], after: ['contract:mockToken'] },
    ],
    calls: [],
  });

  const prod = spec(MULTI, { files: { 'main.ethpvars': `env = "prod"\nowner = "${OWNER}"\nusdc = "${USDC}"\nchain_id = 1\nsalt = "${PROD_SALT}"` } });
  assert.deepEqual(prod, {
    schema: 2,
    chainId: 1,
    values: { admins: [], owner: OWNER },
    externals: { usdc: { address: USDC } },
    contracts: [
      { id: 'vault', artifact: 'Vault.json', salt: PROD_SALT, args: [{ ref: 'externals.usdc.address' }, { ref: 'values.owner' }, { ref: 'values.admins' }, 1], checks: { owner: { ref: 'values.owner' } }, after: ['external:usdc'] },
    ],
    calls: [],
  });
  assert.doesNotThrow(() => parseSpec(dev));
  assert.doesNotThrow(() => parseSpec(prod));
});

test('variable inputs apply default, environment, var files in order, then --var flags in order', () => {
  const source = `chain_id = 1
variable "a" {
  default = "default"
}
variable "b" {
  default = "default"
}
variable "c" {
  default = "default"
}
variable "d" {
  default = "default"
}
variable "e" {
  default = "default"
}
resource "contract" "x" {
  artifact = "X.json"
  args     = [var.a, var.b, var.c, var.d, var.e]
}`;
  const result = world(source, {
    env: { ETHP_VAR_b: 'env', ETHP_VAR_c: 'env', ETHP_VAR_d: 'env', ETHP_VAR_e: 'env', ETHP_VAR_undeclared: 'ignored', OTHER: 'ignored' },
    files: { 'main.ethpvars': 'c = "main"\nd = "main"\ne = "main"', 'main.prod.ethpvars': 'd = "prod"\ne = "prod"' },
    vars: ['e=first', 'e=second'],
  });
  assert.deepEqual(sources(result), {
    a: ['default', 'default'], b: ['env', 'ETHP_VAR_b'], c: ['main', 'main.ethpvars'], d: ['prod', 'main.prod.ethpvars'], e: ['second', '--var'],
  });
  // An untyped variable takes environment and --var strings as written, including = in the value.
  assert.deepEqual(sources(world(source, { vars: ['a=x=1', 'b='] })).a, ['x=1', '--var']);
  assert.deepEqual(sources(world(source, { vars: ['a=x=1', 'b='] })).b, ['', '--var']);
});

test('typed variables parse environment and --var strings and check every source against their type', () => {
  const source = `chain_id = 1
variable "n" {
  type = number
}
variable "flag" {
  type = bool
}
variable "owner" {
  type = address
}
variable "hash" {
  type = bytes32
}
variable "owners" {
  type = list(address)
}
variable "nested" {
  type = list(list(number))
}
variable "anything" {
  type = any
}
resource "contract" "x" {
  artifact = "X.json"
  args     = [var.n, var.flag, var.owner, var.hash, var.owners, var.nested, var.anything]
}`;
  const env = { ETHP_VAR_n: '-42', ETHP_VAR_flag: 'true', ETHP_VAR_owner: OWNER, ETHP_VAR_hash: SALT, ETHP_VAR_owners: `["${OWNER}",\n "${OTHER}"]`, ETHP_VAR_nested: '[[1], []]', ETHP_VAR_anything: '[1]' };
  assert.deepEqual(spec(source, { env }).values, {
    anything: '[1]', flag: true, hash: SALT, n: -42, nested: [[1], []], owner: OWNER, owners: [OWNER, OTHER],
  });
  assert.deepEqual(spec(source, { files: { 'main.ethpvars': `n = 1\nflag = false\nowner = null\nhash = "${SALT}"\nowners = []\nnested = [[null]]\nanything = { a = [1] }` } }).values, {
    anything: { a: [1] }, flag: false, hash: SALT, n: 1, nested: [[null]], owners: [],
  });
  // A null variable is inlined rather than kept as a value.
  assert.equal(spec(source, { files: { 'main.ethpvars': `n = 1\nflag = false\nowner = null\nhash = "${SALT}"\nowners = []\nnested = []\nanything = 1` } }).contracts[0].args[2], null);

  const cases = [
    [{ ETHP_VAR_n: '1.5' }, /^Error: ETHP_VAR_n must be a whole number within the safe integer range for variable n; found "1\.5"\.$/],
    [{ ETHP_VAR_n: '9007199254740993' }, /ETHP_VAR_n must be a whole number/],
    [{ ETHP_VAR_flag: 'yes' }, /ETHP_VAR_flag must be true or false for variable flag; found "yes"/],
    [{ ETHP_VAR_owner: '0x12' }, /ETHP_VAR_owner must be an address for variable owner/],
    [{ ETHP_VAR_owner: OWNER.replace('f39F', 'F39f') }, /ETHP_VAR_owner must be an address/],
    [{ ETHP_VAR_hash: '0x11' }, /ETHP_VAR_hash must be a 0x-prefixed 32-byte hex string/],
    [{ ETHP_VAR_owners: OWNER }, /ETHP_VAR_owners:1:1: 0xf39F.* is not a number/],
    [{ ETHP_VAR_owners: '["0x12"]' }, /ETHP_VAR_owners must be a list\(address\) for variable owners/],
    [{ ETHP_VAR_owners: '[var.owner]' }, /ETHP_VAR_owners:1:2: ETHP_VAR_owners for variable owners must be a literal; it cannot reference var\.owner/],
    [{ ETHP_VAR_nested: '[1]' }, /ETHP_VAR_nested must be a list\(list\(number\)\)/],
  ];
  for (const [override, expected] of cases) {
    assert.throws(() => spec(source, { env: { ...env, ...override } }), expected, JSON.stringify(override));
  }
  assert.throws(() => spec(source, { env, files: { 'main.ethpvars': 'n = "1"' } }), /main\.ethpvars:1:5: Variable n must be a whole number within the safe integer range; found string "1"\./);
  assert.throws(() => spec(source, { env, files: { 'main.ethpvars': 'flag = "true"' } }), /Variable flag must be true or false; found string "true"/);
  assert.throws(() => spec(source, { env, vars: ['n=x'] }), /^Error: --var n must be a whole number within the safe integer range for variable n; found "x"\.$/);
});

test('var files and --var flags may set only declared variables once any variable is declared', () => {
  const source = `chain_id = 1
variable "owner" {
  type = address
}
resource "contract" "x" {
  artifact = "X.json"
  args     = [var.owner]
}`;
  const owner = `owner = "${OWNER}"`;
  const cases = [
    [{ files: { 'main.ethpvars': `${owner}\nextra = 1` } }, /main\.ethpvars:2:1: extra is not declared\. Add variable "extra" \{\} to the \.ethp file, or remove it from main\.ethpvars\./],
    [{ files: { 'main.ethpvars': owner }, vars: ['extra=1'] }, /--var sets extra, which is not declared/],
    [{ vars: ['owner'] }, /--var owner must be name=value/],
    [{}, /main\.ethp:2:1: Variable owner has no value\. Set it in main\.ethpvars, with ETHP_VAR_owner or --var owner=<value>, or give it a default\./],
    [{ files: { 'main.ethpvars': 'private_key = "0x01"' } }, /main\.ethpvars:1:1: private_key is a forbidden signer secret/],
    [{ files: { 'main.ethpvars': 'owner = var.other' } }, /main\.ethpvars:1:9: Variable owner must be a literal; it cannot reference var\.other/],
    [{ files: { 'main.ethpvars': 'owner = true ? "a" : "b"' } }, /main\.ethpvars:1:9: Variable owner must be a literal, not an expression/],
  ];
  for (const [inputs, expected] of cases) assert.throws(() => spec(source, inputs), expected, JSON.stringify(inputs));
});

test('variable blocks are checked for names, types, defaults, and use', () => {
  const resource = 'resource "contract" "x" {\n  artifact = "X.json"\n  args     = [var.a]\n}';
  const cases = [
    ['variable {}', /A variable block needs one label/],
    ['variable "Owner" {}', /Variable name Owner must match/],
    ['variable "mnemonic" {}', /mnemonic is a forbidden signer secret/],
    ['variable "a" {\n  default = 1\n}\nvariable "a" {}', /main\.ethp:5:1: Duplicate variable "a"; it is first declared on line 2/],
    ['variable "a" {\n  type = "string"\n}', /main\.ethp:3:10: type must be string, number, bool, address, bytes32, any, or list\(<type>\)\. Write it without quotes\./],
    ['variable "a" {\n  type = map(string)\n}', /main\.ethp:3:10: type must be string/],
    ['variable "a" {\n  type = list(string, number)\n}', /type must be string/],
    ['variable "a" {\n  type    = number\n  default = "1"\n}', /main\.ethp:4:13: The default for variable a must be a whole number within the safe integer range; found string "1"\./],
    ['variable "a" {\n  default = var.b\n}', /main\.ethp:3:13: default must be a literal; it cannot reference var\.b/],
    ['variable "a" {\n  sensitive = true\n}', /variable "a" has unknown attribute sensitive\. Use type, default, and description/],
    ['variable "a" {\n  description = 1\n}', /description must be a string/],
    ['variable "a" {\n  validation {}\n}', /variable "a" cannot contain a validation block/],
    ['variable "a" {\n  default = 1\n}\nvariable "unused" {\n  default = 1\n}', /main\.ethp:5:1: Unused variables: unused\. Remove their variable blocks or reference them as var\.<name>\./],
  ];
  for (const [declarations, expected] of cases) {
    assert.throws(() => spec(`chain_id = 1\n${declarations}\n${resource}`, { env: { ETHP_VAR_a: '1' } }), expected, declarations);
  }
  assert.throws(() => spec(`chain_id = 1\nvariable "b" {\n  default = 1\n}\n${resource.replace('var.a', 'var.b, var.a')}`),
    /main\.ethp:7:22: args uses undeclared variable a\. Declare it with variable "a" \{\}\./);
});

test('constant fields such as salt and chain_id take variable values, and every variable must be declared', () => {
  const source = `chain_id = var.chain_id
variable "chain_id" {
  type = number
}
variable "salt" {
  type = bytes32
}
variable "owner" {
  type = address
}
resource "contract" "x" {
  artifact = "X.json"
  salt     = var.salt
  args     = [var.owner]
}`;
  const result = world(source, {
    env: { ETHP_VAR_owner: OTHER },
    files: { 'main.ethpvars': `chain_id = 5\nsalt = "${SALT}"\nowner = "${OTHER}"`, 'extra.ethpvars': `owner = "${OWNER}"` },
  });
  assert.deepEqual(result.spec, { schema: 2, chainId: 5, values: { owner: OWNER }, externals: {}, contracts: [{ id: 'x', artifact: 'X.json', salt: SALT, args: [{ ref: 'values.owner' }] }], calls: [] });
  assert.deepEqual(sources(result).owner, [OWNER, 'extra.ethpvars']);
  const undeclared = 'chain_id = 1\nresource "contract" "x" {\n  artifact = "X.json"\n  args     = [var.owner]\n}';
  assert.throws(() => spec(undeclared, { files: { 'main.ethpvars': `owner = "${OWNER}"` } }), /main\.ethpvars:1:1: owner is not declared/);
  assert.throws(() => spec(undeclared), /main\.ethp:4:15: args uses undeclared variable owner\. Declare it with variable "owner" \{\}\./);
  assert.throws(() => spec(undeclared, { vars: [`owner=${OWNER}`] }), /--var sets owner, which is not declared/);
});

test('a null attribute is left unset, and only the winning input is parsed', () => {
  const source = `chain_id = 1
variable "existing" {
  type    = address
  default = null
}
variable "salt" {
  type    = bytes32
  default = "${SALT}"
}
resource "contract" "x" {
  artifact  = "X.json"
  address   = var.existing
  salt      = var.existing == null ? var.salt : null
  code_hash = null
  args      = []
}`;
  assert.deepEqual(spec(source).contracts, [{ id: 'x', artifact: 'X.json', salt: SALT, args: [] }]);
  assert.deepEqual(spec(source, { vars: [`existing=${OWNER}`] }).contracts, [{ id: 'x', artifact: 'X.json', address: { ref: 'values.existing' }, args: [] }]);
  // A stale environment value that a var file or flag overrides is never parsed.
  assert.deepEqual(sources(world(source, { env: { ETHP_VAR_salt: 'stale' }, vars: [`salt=${PROD_SALT}`] })).salt, [PROD_SALT, '--var']);
  assert.deepEqual(sources(world(source, { env: { ETHP_VAR_salt: 'stale' }, files: { 'main.ethpvars': `salt = "${PROD_SALT}"` } })).salt, [PROD_SALT, 'main.ethpvars']);
  assert.throws(() => world(source, { env: { ETHP_VAR_salt: 'stale' } }), /ETHP_VAR_salt must be a 0x-prefixed 32-byte hex string/);
});

test('conditionals and operators fold at compile time with HCL precedence', () => {
  const source = condition => `chain_id = 1
variable "n" {
  type    = number
  default = 3
}
variable "s" {
  default = "prod"
}
variable "owner" {
  type    = address
  default = "${OWNER.toLowerCase()}"
}
variable "maybe" {
  default = null
}
variable "list" {
  default = [1, { a = "0xAB" }]
}
resource "contract" "x" {
  artifact = "X.json"
  args     = [${condition}, var.n, var.s, var.owner, var.maybe, var.list]
}`;
  const value = condition => spec(source(condition)).contracts[0].args[0];
  const cases = [
    ['var.n > 2 && var.s == "prod"', true],
    ['var.n >= 4 || var.s != "prod"', false],
    ['!(var.n < 3) && var.n <= 3', true],
    ['false && true || true', true],
    ['false == false == true', true],
    ['var.n == 3 ? "three" : var.n == 4 ? "four" : "other"', 'three'],
    ['var.n == 4 ? "four" : var.n == 3 ? "three" : "other"', 'three'],
    ['true ? false ? 1 : 2 : 3', 2],
    [`var.owner == "${OWNER}"`, true],
    ['var.list == [1, { a = "0xab" }]', true],
    ['var.list == [1]', false],
    ['{ a = 1, b = 2 } == { b = 2, a = 1 }', true],
    ['var.maybe == null', true],
    ['var.s == null', false],
    ['var.maybe != null && var.maybe > 1', false],
    ['var.maybe == null || var.maybe > 1', true],
    ['var.n > 2 ? [var.s, { k = var.n }] : []', [{ ref: 'values.s' }, { k: { ref: 'values.n' } }]],
    [`(\n  var.n > 2\n  ? "multi"\n  : "line"\n)`, 'multi'],
  ];
  for (const [condition, expected] of cases) assert.deepEqual(value(condition), expected, condition);
  // Only the taken branch is evaluated, so the other may reference a disabled or unrelated resource; every
  // branch must still name declared variables and resources.
  assert.deepEqual(value('var.n == 3 ? 1 : contracts.x.address'), 1);
  const errors = [
    ['var.s ? 1 : 2', /main\.ethp:21:15: The condition in args must be true or false; found string "prod"\./],
    ['!var.n', /main\.ethp:21:16: The operand of ! in args must be true or false; found number 3\./],
    ['var.n && true', /The operand of && in args must be true or false; found number 3/],
    ['var.n == "3"', /main\.ethp:21:21: == in args compares number 3 with string "3"\. Both sides must have the same type, or one must be null\./],
    ['var.s < 1', /main\.ethp:21:21: < in args compares numbers; found string "prod" and number 1\./],
    ['contracts.x.address == var.owner', /main\.ethp:21:15: args uses contracts\.x\.address in a condition or comparison\. Those can use only literals, var\.<name>, and local\.<name>\./],
    ['true ? 1 : var.missing', /main\.ethp:21:26: args uses undeclared variable missing/],
    ['true ? 1 : contracts.missing.address', /main\.ethp:21:26: args references unknown contracts\.missing\./],
    ['true ? 1 : local.missing', /args uses undefined local\.missing\. Define it in a locals block/],
    ['true ? 1 : lower(var.s)', /main\.ethp:21:26: Function calls are not supported \(lower\)/],
    ['true ? 1 : var.s.x', /args has unsupported reference var\.s\.x/],
  ];
  for (const [condition, expected] of errors) assert.throws(() => value(condition), expected, condition);
});

test('locals name conditions and values, keep references in value fields, and reject cycles', () => {
  const source = locals => `chain_id = 1
variable "owner" {
  type    = address
  default = "${OWNER}"
}
locals {
${locals}
}
resource "contract" "a" {
  artifact = "A.json"
  args     = [local.owner]
}
resource "check" "aOwner" {
  target = contracts.a
  owner  = var.owner
}`;
  assert.deepEqual(spec(source('owner = true ? var.owner : null')).contracts[0].args, [{ ref: 'values.owner' }]);
  assert.deepEqual(spec(source('owner = local.inner\n  inner = [var.owner, "x"]')).contracts[0].args, [[{ ref: 'values.owner' }, 'x']]);
  assert.deepEqual(spec(`${source('owner = contracts.b.address')}\nlocals {\n  unused_elsewhere = local.owner\n}\nresource "contract" "b" {\n  artifact = "B.json"\n  args = [local.unused_elsewhere]\n}`)
    .contracts[0].args, [{ ref: 'contracts.b.address' }]);
  const cases = [
    ['owner = local.owner', /main\.ethp:7:1: Locals refer to themselves: local\.owner -> local\.owner\./],
    ['owner = var.owner == null ? local.b : 1\n  b = local.c\n  c = local.owner', /Locals refer to themselves: local\.b -> local\.c -> local\.owner -> local\.b\./],
    ['owner = var.owner\n  spare = 1', /main\.ethp:8:3: Unused locals: spare\. Remove them or reference them as local\.<name>\./],
    ['owner = var.owner\n  owner = 2', /owner is already set on line 7/],
    ['owner = var.missing', /main\.ethp:7:9: local\.owner uses undeclared variable missing/],
    ['secret_key = 1\n  owner = 1', /secret_key is a forbidden signer secret/],
  ];
  for (const [locals, expected] of cases) assert.throws(() => spec(source(locals)), expected, locals);
  assert.throws(() => spec(`${source('owner = var.owner')}\nlocals {\n  owner = 2\n}`), /main\.ethp:18:3: local\.owner is already defined on line 7/);
  assert.throws(() => spec(`${source('owner = var.owner')}\nlocals "x" {}`), /A locals block has no labels/);
  assert.throws(() => spec(source('salt = contracts.a.address\n  owner = 1').replace('args     = [local.owner]', 'args = [local.owner]\n  salt = local.salt')),
    /main\.ethp:7:8: salt through local\.salt must be a constant, so it cannot reference contracts\.a\.address/);
});

test('enabled removes a resource before references resolve, and checks and assumptions follow their target', () => {
  const source = ({ flag = 'var.deploy_extra', extra = '' } = {}) => `chain_id = 1
variable "deploy_extra" {
  type    = bool
  default = false
}
resource "contract" "base" {
  artifact = "Base.json"
  args     = []
}
resource "contract" "extra" {
  enabled  = ${flag}
  artifact = "Extra.json"
  args     = [contracts.base.address]
}
resource "call" "configure" {
  enabled = var.deploy_extra
  target  = contracts.extra
  method  = "configure"
  args    = []
}
resource "check" "configured" {
  target = calls.configure
  getter = "configured"
  before = false
  equals = true
}
resource "check" "extraBase" {
  target = contracts.extra
  BASE   = contracts.base.address
}
resource "check" "baseOwner" {
  target  = contracts.base
  enabled = !var.deploy_extra
  getter  = "enabled"
  equals  = false
}
execution_assumptions = [{ consumer = contracts.extra, location = "args[0]", reference = contracts.base.address, reason = "stored" }]
${extra}`;
  const off = spec(source());
  assert.deepEqual(off.contracts.map(contract => contract.id), ['base']);
  assert.deepEqual(off.contracts[0].checks, { enabled: false });
  assert.deepEqual(off.calls, []);
  assert.deepEqual(off.executionAssumptions, []);

  const on = spec(source(), { env: { ETHP_VAR_deploy_extra: 'true' } });
  assert.deepEqual(on.contracts.map(contract => [contract.id, contract.checks]), [['base', undefined], ['extra', { BASE: { ref: 'contracts.base.address' } }]]);
  assert.deepEqual(on.calls.map(call => call.id), ['configure']);
  assert.deepEqual(on.executionAssumptions, [{ consumer: 'contract:extra', location: 'args[0]', reference: 'contracts.base.address', reason: 'stored' }]);

  const live = extra => assert.throws(() => spec(source({ extra })), error => {
    assert.match(error.message, /references contracts\.extra, but contract:extra is disabled \(its enabled on line 11 is false\)\. Put the reference behind the same condition\./);
    return true;
  }, extra);
  live('resource "contract" "user" {\n  artifact = "U.json"\n  args     = [contracts.extra.address]\n}');
  live('resource "contract" "user" {\n  artifact  = "U.json"\n  args      = []\n  libraries = { "L.sol:L" = contracts.extra.address }\n}');
  live('resource "contract" "user" {\n  artifact = "U.json"\n  args     = []\n  after    = [contracts.extra]\n}');
  live('resource "check" "baseRef" {\n  target = contracts.base\n  EXTRA  = contracts.extra.address\n}');
  live('resource "call" "poke" {\n  target = contracts.extra\n  method = "poke"\n  args   = []\n}\nresource "check" "poked" {\n  target = calls.poke\n  getter = "poked"\n  before = false\n  equals = true\n}');
  // A guarded reference to a disabled resource is fine; an unknown attribute in a disabled resource is not.
  assert.equal(spec(source({ extra: 'resource "contract" "user" {\n  artifact = "U.json"\n  args     = [var.deploy_extra ? contracts.extra.address : contracts.base.address]\n}' }))
    .contracts.find(contract => contract.id === 'user').args[0].ref, 'contracts.base.address');
  assert.throws(() => spec(source().replace('artifact = "Extra.json"', 'artifact = "Extra.json"\n  codeHash = "0x"')), /resource "contract" "extra" has unknown attribute codeHash\. Use code_hash/);
  assert.throws(() => spec(source({ flag: '"yes"' })), /main\.ethp:11:14: enabled must be true or false; found string "yes"\./);
  assert.throws(() => spec(source({ flag: 'contracts.base.address == null' })), /main\.ethp:11:14: enabled uses contracts\.base\.address in a condition or comparison/);
  assert.throws(() => spec(source().replace('target = calls.configure', 'enabled = false\n  target = calls.configure'), { env: { ETHP_VAR_deploy_extra: 'true' } }),
    /call:configure needs one check block with target = calls\.configure\. Its check block configured is disabled; an enabled call needs an enabled check\./);
  // A check or assumption that is dropped in this world is still checked, so a typo fails in every world.
  const dropped = [
    ['resource "check" "bad" {\n  target  = contracts.base\n  enabled = false\n  getter  = "x"\n  bogus   = 1\n}', /resource "check" "bad" uses getter, so it can set only target, getter, equals, and enabled/],
    ['resource "check" "bad" {\n  target = contracts.extra\n  before = 1\n}', /resource "check" "bad" targets contract:extra; before is only for a check that targets a call/],
    ['resource "check" "bad" {\n  target = calls.configure\n  getter = "x"\n}', /resource "check" "bad" targets a call and needs getter, before, and equals/],
    ['resource "check" "bad" {\n  target = contracts.extra\n}', /resource "check" "bad" needs at least one getter/],
  ];
  for (const [extra, expected] of dropped) assert.throws(() => spec(source({ extra })), expected, extra);
  assert.throws(() => spec(source().replace('reference = contracts.base.address', 'reference = contracts.base')), /reference must be contracts\.<name>\.address/);
  assert.throws(() => spec(`chain_id = 1\nfactory {\n  enabled = true\n}\nresource "contract" "a" {\n  artifact = "A.json"\n  args = []\n}`), /factory has unknown attribute enabled/);
});

test('an assumption whose consumer is enabled must reference an enabled contract', () => {
  const source = `chain_id = 1
resource "contract" "base" {
  enabled  = false
  artifact = "Base.json"
  args     = []
}
resource "contract" "user" {
  artifact = "U.json"
  args     = []
}
execution_assumptions = [{ consumer = contracts.user, location = "args[0]", reference = contracts.base.address, reason = "stored" }]`;
  assert.throws(() => spec(source), /main\.ethp:11:89: reference references contracts\.base, but contract:base is disabled/);
});

test('spec values hold only the variables that value fields reference, so unrelated inputs keep the spec hash', () => {
  const source = `chain_id = 1
variable "env" {
  default = "dev"
}
variable "owner" {
  type    = address
  default = "${OWNER}"
}
variable "salt" {
  type    = bytes32
  default = "${SALT}"
}
resource "contract" "a" {
  artifact = "A.json"
  salt     = var.salt
  args     = [var.env == "prod" ? var.owner : "${OTHER}"]
}`;
  const dev = spec(source);
  assert.deepEqual(dev.values, {});
  assert.equal(hashJson(spec(source, { vars: ['env=staging'] })), hashJson(dev));
  assert.notEqual(hashJson(spec(source, { vars: [`salt=${PROD_SALT}`] })), hashJson(dev));
  const prod = spec(source, { vars: ['env=prod'] });
  assert.deepEqual(prod.values, { owner: OWNER });
  assert.deepEqual(prod.contracts[0].args, [{ ref: 'values.owner' }]);
});

test('workspace overlays, --var-file, and the environment feed an .ethp file, and JSON specs reject --var', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etherplan-world-'));
  try {
    const file = name => path.join(directory, name);
    await writeFile(file('main.ethp'), `chain_id = var.chain_id
variable "chain_id" {
  type = number
}
variable "salt" {
  type    = bytes32
  default = "${SALT}"
}
variable "owner" {
  type = address
}
resource "contract" "a" {
  artifact = "A.json"
  salt     = var.salt
  args     = [var.owner]
}
`);
    await writeFile(file('main.ethpvars'), `chain_id = 5\nowner = "${OWNER}"\n`);
    await writeFile(file('main.prod.ethpvars'), `chain_id = 1\nsalt = "${PROD_SALT}"\n`);
    await writeFile(file('ci.ethpvars'), `owner = "${OTHER}"\n`);
    const base = await compileProjectFile(file('main.ethp'));
    assert.deepEqual([base.spec.chainId, base.spec.contracts[0].salt, base.spec.values.owner], [5, SALT, OWNER]);
    const prod = await compileProjectFile(file('main.ethp'), { workspace: 'prod', varFiles: [file('ci.ethpvars')], env: { ETHP_VAR_salt: SALT } });
    assert.deepEqual([prod.spec.chainId, prod.spec.contracts[0].salt, prod.spec.values.owner], [1, PROD_SALT, OTHER]);
    assert.match(prod.variables.find(variable => variable.name === 'salt').source, /main\.prod\.ethpvars$/);
    const staging = await compileProjectFile(file('main.ethp'), { workspace: 'staging', vars: ['chain_id=11155111'] });
    assert.deepEqual([staging.spec.chainId, staging.variables.find(variable => variable.name === 'chain_id').source], [11155111, '--var']);
    await assert.rejects(compileProjectFile(file('main.ethp'), { varFiles: [file('missing.ethpvars')] }), { code: 'ENOENT' });

    await writeFile(file('spec.json'), JSON.stringify({ schema: 2, chainId: 1, contracts: [{ id: 'a', artifact: 'A.json', address: OWNER }] }));
    assert.equal((await loadProject(file('spec.json'), { workspace: 'prod' })).spec.chainId, 1);
    await assert.rejects(loadProject(file('spec.json'), { vars: ['a=1'] }), /--var and --var-file apply only to \.ethp specs/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('workspaces select separate default and configured state files', () => {
  assert.equal(selectWorkspace(undefined, {}), 'default');
  assert.equal(selectWorkspace(undefined, { ETHP_WORKSPACE: 'staging' }), 'staging');
  assert.equal(selectWorkspace('prod', { ETHP_WORKSPACE: 'staging' }), 'prod');
  for (const name of ['../x', '', '-x', 'a/b', 'a b']) assert.throws(() => selectWorkspace(name, {}), /must start with a letter or digit/, name);
  assert.equal(selectWorkspace(undefined, { ETHP_WORKSPACE: '' }), 'default');
  assert.equal(stateFileFor('/p/main.ethp', {}), path.resolve('/p/.etherplan/default/state.json'));
  assert.equal(stateFileFor('/p/main.ethp', {}, 'prod'), path.resolve('/p/.etherplan/prod/state.json'));
  assert.equal(stateFileFor('/p/main.ethp', { state: '/q/state.json' }, 'prod'), path.resolve('/q/state.json'));
  assert.equal(inWorkspace('/p/deploy/state.json', 'prod'), '/p/deploy/prod/state.json');
  assert.equal(inWorkspace('/p/deploy/state.json', 'default'), '/p/deploy/default/state.json');
});

test('--var and --var-file repeat, and every command that compiles a spec accepts them with --workspace', () => {
  assert.deepEqual(parseOptions(['--var', 'a=1', '--workspace', 'prod', '--var-file', 'x.ethpvars', '--var', 'b=2', '--var-file', 'y.ethpvars']), {
    var: ['a=1', 'b=2'], workspace: 'prod', 'var-file': ['x.ethpvars', 'y.ethpvars'],
  });
  assert.throws(() => parseOptions(['--workspace', 'a', '--workspace', 'b']), /Duplicate option --workspace/);
  assert.throws(() => parseOptions(['--var']), /Option --var needs a value/);
  assert.throws(() => validateOptions('validate', { var: ['1=2'] }), /--var 1=2 must be name=value/);
  assert.throws(() => validateOptions('status', { workspace: 'prod' }), /--workspace is not an option for status/);
  for (const [command, details] of Object.entries(COMMANDS)) {
    if (!details.options.includes('spec') || command === 'output') continue; // output uses the spec path only to locate state.
    for (const option of ['var', 'var-file', 'workspace']) assert.ok(details.options.includes(option), `${command} --${option}`);
    assert.match(usage(command), /--var-file/);
  }
});
