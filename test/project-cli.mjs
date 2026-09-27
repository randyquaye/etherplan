// Keep older JSON engine fixtures useful for CLI integration tests. The CLI receives only a
// generated main.ethp project; --fixture is a test-only selector, never passed to the CLI.
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const generated = new Map();
const fields = {
  codeHash: 'code_hash', creationProofMode: 'creation_proof_mode', createdCode: 'created_code',
  signerRole: 'signer_role', senderIndependent: 'sender_independent', ownerOnly: 'owner_only',
  transfersOwnership: 'transfers_ownership',
};
const roots = { contract: 'contracts', external: 'externals', call: 'calls' };

function reference(value) {
  const [root, ...rest] = value.split('.');
  return root === 'values' ? `var.${rest.join('.')}` : value;
}

function expression(value) {
  if (Array.isArray(value)) return `[${value.map(expression).join(', ')}]`;
  if (value && typeof value === 'object') {
    if (typeof value.ref === 'string') return reference(value.ref);
    return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${expression(item)}`).join(', ')} }`;
  }
  return JSON.stringify(value);
}

function assignment(key, value) {
  if (key === 'after') return `  after = [${value.map(id => {
    const [type, name] = id.split(':');
    return `${roots[type]}.${name}`;
  }).join(', ')}]`;
  if (key === 'target') return `  target = contracts.${value}`;
  if (key === 'creationProofMode' && value === 'pinned-runtime') return '  creation_proof_mode = "pinned_runtime"';
  if (key === 'createdCode') return `  created_code = ${expression(value.map(item => ({ getter: item.getter, create_nonce: item.createNonce, code_hash: item.codeHash })) )}`;
  return `  ${fields[key] ?? key} = ${expression(value)}`;
}

function block(type, name, body) {
  return [`resource "${type}" "${name}" {`, ...Object.entries(body).filter(([key]) => key !== 'id' && key !== 'checks' && key !== 'check' && key !== 'before').map(([key, value]) => assignment(key, value)), '}'].join('\n');
}

function check(type, name, checks) {
  return Object.entries(checks).map(([getter, equals], index) => [
    `resource "check" "${type}_${name}_${index}" {`,
    `  target = ${roots[type]}.${name}`,
    `  getter = ${JSON.stringify(getter)}`,
    `  equals = ${expression(equals)}`,
    '}',
  ].join('\n'));
}

function usedVariables(value, names = new Set()) {
  if (Array.isArray(value)) value.forEach(item => usedVariables(item, names));
  else if (value && typeof value === 'object') {
    if (typeof value.ref === 'string' && value.ref.startsWith('values.')) names.add(value.ref.slice('values.'.length));
    else Object.values(value).forEach(item => usedVariables(item, names));
  }
  return names;
}

function toProject(spec) {
  const lines = [`chain_id = ${expression(spec.chainId)}`];
  const used = usedVariables({ contracts: spec.contracts, calls: spec.calls, externals: spec.externals, executionAssumptions: spec.executionAssumptions });
  for (const [name, value] of Object.entries(spec.values ?? {}).filter(([name]) => used.has(name))) {
    const type = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'bool' : 'string';
    lines.push(`variable "${name}" {\n  type = ${type}\n}`);
  }
  if (spec.dependencyMode || spec.schema === 1) lines.push(`dependency_mode = ${JSON.stringify(spec.dependencyMode ?? 'compatibility')}`);
  if (spec.executionAssumptions) lines.push(`execution_assumptions = [${spec.executionAssumptions.map(item =>
    `{ consumer = ${item.consumer.replace(/^contract:/, 'contracts.')}, location = ${expression(item.location)}, reference = ${item.reference}, reason = ${expression(item.reason)} }`).join(', ')}]`);
  if (spec.factory) lines.push(['factory {', ...Object.entries(spec.factory).map(([key, value]) => assignment(key, value)), '}'].join('\n'));
  for (const [name, external] of Object.entries(spec.externals ?? {})) {
    lines.push(block('external', name, external), ...check('external', name, external.checks ?? {}));
  }
  for (const contract of spec.contracts ?? []) {
    lines.push(block('contract', contract.id, contract), ...check('contract', contract.id, contract.checks ?? {}));
  }
  for (const call of spec.calls ?? []) {
    lines.push(block('call', call.id, call));
    if (call.check) lines.push([
      `resource "check" "call_${call.id}" {`,
      `  target = calls.${call.id}`,
      `  getter = ${expression(call.check.function)}`,
      `  args = ${expression(call.check.args ?? [])}`,
      `  before = ${expression(call.before?.equals)}`,
      `  equals = ${expression(call.check.equals)}`,
      '}',
    ].join('\n'));
  }
  for (const [name, value] of Object.entries(spec).filter(([key]) => !['schema', 'chainId', 'dependencyMode', 'executionAssumptions', 'factory', 'externals', 'contracts', 'calls', 'values'].includes(key))) {
    lines.push(`${name} = ${expression(value)}`);
  }
  const vars = Object.entries(spec.values ?? {})
    .filter(([name]) => used.has(name))
    .map(([name, value]) => `${name} = ${expression(value)}`).join('\n');
  return { main: `${lines.join('\n\n')}\n`, vars: `${vars}\n` };
}

function writeGenerated(file, content) {
  if (!generated.has(file)) generated.set(file, existsSync(file) ? readFileSync(file, 'utf8') : null);
  writeFileSync(file, content);
}

export function prepareJsonProject(specFile) {
  const directory = path.dirname(specFile);
  const { main, vars } = toProject(JSON.parse(readFileSync(specFile, 'utf8')));
  writeGenerated(path.join(directory, 'main.ethp'), main);
  writeGenerated(path.join(directory, 'main.ethpvars'), vars);
  return directory;
}

process.on('exit', () => {
  for (const [file, previous] of generated) {
    if (!existsSync(path.dirname(file))) continue;
    if (previous === null) { if (existsSync(file)) unlinkSync(file); }
    else writeFileSync(file, previous);
  }
});

function prepare(argv, options) {
  if (!argv[0]?.endsWith('dist/cli.js')) return { argv, options };
  const originalDirectory = path.resolve(options.cwd ?? process.cwd());
  const specIndex = argv.indexOf('--fixture');
  const specFile = specIndex >= 0 ? path.resolve(originalDirectory, argv[specIndex + 1]) : path.join(originalDirectory, 'spec.json');
  if (!existsSync(specFile) || !specFile.endsWith('.json')) return { argv, options };
  const directory = prepareJsonProject(specFile);
  const args = [...argv];
  if (specIndex >= 0) args.splice(specIndex, 2);
  if (!path.isAbsolute(args[0])) args[0] = path.resolve(originalDirectory, args[0]);
  for (let index = 1; index < args.length - 1; index++) {
    if (['--out', '--state', '--journal', '--plan', '--backend', '--signer-module'].includes(args[index]) && args[index + 1] !== '-' && !path.isAbsolute(args[index + 1])) {
      args[index + 1] = path.resolve(originalDirectory, args[index + 1]);
      index++;
    }
  }
  return { argv: args, options: { ...options, cwd: directory } };
}

export function spawnSync(command, argv, options = {}) {
  const prepared = prepare(argv, options);
  return nodeSpawnSync(command, prepared.argv, prepared.options);
}

export function spawn(command, argv, options = {}) {
  const prepared = prepare(argv, options);
  return nodeSpawn(command, prepared.argv, prepared.options);
}
