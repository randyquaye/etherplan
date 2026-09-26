import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parse as referenceParse } from '@cdktn/hcl2json';
import { parseHcl } from '../src/input/hcl.mjs';
import { labFixture } from './ethp-fixtures.mjs';

// Converts a parsed body to the JSON shape of the HCL reference parser. That parser writes strings as
// Terraform JSON templates, so a literal ${ appears as $${ and a reference as "${...}".
function referenceShape(body) {
  const value = node => node.kind === 'literal' ? (typeof node.value === 'string' ? node.value.replaceAll('${', () => '$${').replaceAll('%{', '%%{') : node.value)
    : node.kind === 'list' ? node.items.map(value)
      : node.kind === 'object' ? Object.fromEntries(node.entries.map(entry => [entry.key, value(entry.value)]))
        : `\${${node.parts.join('.')}}`;
  const result = {};
  for (const attribute of body.attributes.values()) result[attribute.name] = value(attribute.value);
  for (const block of body.blocks) {
    let parent = result;
    let key = block.type;
    for (const label of block.labels) {
      parent = parent[key] ??= {};
      key = label;
    }
    (parent[key] ??= []).push(referenceShape(block.body));
  }
  return result;
}

const SYNTAX = `# hash comment
// slash comment
/* block
   comment */
chain_id  = 1 # trailing comment
flag      = true
nothing   = null
negative  = -42
spaced    = - 7
zeros     = 007
largest   = 9007199254740991
smallest  = -9007199254740991
text      = "tab\\tquote\\" slash\\\\ unicode \\u00e9 \\U0001F600 dollars $5 $$ %% 100%"
escaped   = "$\${literal} %%{literal}"
empty     = ""
list      = [1, "two", [true], { a = 1 }, ]
multiline = [
  1,

  2, # comment inside a list
]
object = {
  plain        = 1
  "quoted key" = 2, colon: 3
  nested       = { deep = [null] }
  true         = "keyword key"
}
ref          = contracts.alpha.address
bare         = var.owner
résumé       = "unicode identifier"
dash-name    = contracts.my-thing.address
_under       = 2
resource "contract" "a" {
  args = []

  after = [contracts.b]
}
resource contract b {}
factory {}
one "line" { x = [1, 2] }
outer "x" {
  inner {
    deep = "nested block"
  }
}
`;

test('accepted files parse exactly as the HCL reference parser reads them', async () => {
  const corpus = [
    ['syntax.ethp', SYNTAX],
    ['crlf.ethp', SYNTAX.replaceAll('\n', '\r\n')],
    ['no-final-newline.ethp', 'a = 1\nb { c = 2 }'],
    ['empty.ethp', ''],
    ...await Promise.all(['lab.ethp', 'lab.ethpvars'].map(async name => [name, await readFile(path.join(labFixture, name), 'utf8')])),
    ['lab.ethpconfig', 'defaults {\n  state = "deploy/state.json"\n}\n\ncommand "plan" {\n  out       = "plan.json"\n  deployers = ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"]\n  pipeline  = true\n}\n'],
  ];
  for (const [file, text] of corpus) {
    assert.deepEqual(referenceShape(parseHcl(file, text)), await referenceParse(file, text), file);
  }
});

test('values keep their exact meaning', () => {
  const body = parseHcl('values.ethp', SYNTAX);
  const value = name => body.attributes.get(name).value;
  assert.deepEqual([value('negative').value, value('spaced').value, value('zeros').value, value('largest').value, value('smallest').value],
    [-42, -7, 7, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]);
  assert.equal(value('text').value, 'tab\tquote" slash\\ unicode é 😀 dollars $5 $$ %% 100%');
  assert.equal(value('escaped').value, '${literal} %{literal}');
  assert.deepEqual(value('ref'), { kind: 'reference', parts: ['contracts', 'alpha', 'address'], at: { file: 'values.ethp', line: 28, column: 16 } });
  assert.deepEqual(parseHcl('spaced.ethp', 'a = contracts . alpha . address').attributes.get('a').value.parts, ['contracts', 'alpha', 'address']);
  assert.equal(parseHcl('bom.ethp', '﻿a = 1').attributes.get('a').value.value, 1);
  assert.deepEqual(body.blocks.map(block => [block.type, block.labels, block.at.line]), [
    ['resource', ['contract', 'a'], 33], ['resource', ['contract', 'b'], 38], ['factory', [], 39], ['one', ['line'], 40], ['outer', ['x'], 41],
  ]);
});

test('unsupported expressions and malformed input fail at their line and column', () => {
  const cases = [
    ['a = "x-${var.owner}"', '1:8: String templates are not supported'],
    ['a = "%{ if true }x%{ endif }"', '1:6: Template directives are not supported'],
    ['a = <<EOF\nx\nEOF', '1:5: Heredoc strings are not supported'],
    ['a = 1 + 2', '1:7: Arithmetic and operators are not supported'],
    ['a = 1 - 2', '1:7: Arithmetic and operators are not supported'],
    ['a = -var.x', '1:5: Arithmetic and operators are not supported'],
    ['a = !true', '1:5: Arithmetic and operators are not supported'],
    ['a = [\n  1\n  + 2\n]', '3:3: Arithmetic and operators are not supported'],
    ['a = true ? 1 : 2', '1:10: Conditional expressions are not supported'],
    ['a = max(1, 2)', '1:5: Function calls are not supported (max)'],
    ['a = [for x in var.list : x]', '1:6: For expressions are not supported'],
    ['a = { for k, v in var.map : k => v }', '1:7: For expressions are not supported'],
    ['a = var.list[0]', '1:13: Index and splat expressions are not supported'],
    ['a = var.list.0', '1:14: Index and splat expressions are not supported'],
    ['a = var.list[*].id', '1:13: Index and splat expressions are not supported'],
    ['a = (var.x)', '1:5: Parenthesized expressions are not supported'],
    ['a = { (var.k) = 1 }', '1:7: Computed object keys are not supported'],
    ['a = { var.k = 1 }', '1:7: Object keys must be names or quoted strings'],
    ['a = 9007199254740993', '1:5: Number 9007199254740993 is outside JavaScript\'s safe integer range. Quote it as a decimal string: "9007199254740993".'],
    ['a = -9007199254740992', '1:6: Number -9007199254740992 is outside'],
    ['a = 1.0000000000000001', '1:5: Number 1.0000000000000001 must be a whole number'],
    ['a = 1e3', '1:5: Number 1e3 must be a whole number'],
    ['a = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', '1:5: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 is not a number. Quote addresses and hex values as strings.'],
    ['a = 1\na = 2', '2:1: a is already set on line 1.'],
    ['a = { x = 1, x = 2 }', '1:14: Duplicate object key x; it is first set on line 1.'],
    ['a = 1\na {}', '2:1: a is used both as an attribute and as a block.'],
    ['a {}\na = 1', '2:1: a is used both as an attribute and as a block.'],
    ['a = "unterminated', '1:5: This string has no closing quote'],
    ['a = "bad \\q"', '1:10: Invalid escape sequence \\q'],
    ['a = "\\uD800"', '1:6: Invalid Unicode escape \\uD800'],
    ['a = 1 b = 2', '1:7: Expected a new line after the attribute, found "b".'],
    ['a = 1, b = 2', '1:6: Put each attribute on its own line'],
    ['a = [1 2]', '1:8: Expected a comma or ] in the list, found "2".'],
    ['a = { x = 1 y = 2 }', '1:13: Expected a comma, new line, or } after the object value, found "y".'],
    ['a =', '1:4: Expected a value, found the end of the file.'],
    ['a = [1,', '1:8: Expected a value, found the end of the file.'],
    ['"a" = 1', '1:1: Attribute and block names must not be quoted.'],
    ['a b', '1:4: Expected { after the block labels, found the end of the file.'],
    ['a\n{\n}', '1:2: Expected = or { after a, found a new line.'],
    ['block {\n  x = 1\n', '1:1: This block block has no closing }.'],
    ['block { x = 1\n y = 2 }', '1:14: A block on one line can hold only one attribute.'],
    ['block { inner {} }', '1:15: A block on one line can hold only one attribute and no nested block.'],
    ['block {\n  x = 1 }', '2:9: Expected a new line after the attribute, found "}".'],
    ['block {} a = 1', '1:10: Expected a new line after the block, found "a".'],
    ['a = 1 /* open', '1:7: This comment has no closing */.'],
    ['a = @', '1:5: Unexpected character "@".'],
  ];
  for (const [text, expected] of cases) {
    assert.throws(() => parseHcl('bad.ethp', text), error => {
      assert.ok(error.message.startsWith(`bad.ethp:${expected}`), `${JSON.stringify(text)}\n  expected: bad.ethp:${expected}\n  actual:   ${error.message}`);
      return true;
    });
  }
});

test('input the HCL reference parser rejects is also rejected', async () => {
  for (const text of ['a = [1 2]', 'a = {', 'a =', '"a" = 1', 'a = 1, b = 2', 'block { x = 1\n y = 2 }', 'block {} a = 1', 'a = "open', 'a = "\\q"', 'a b', 'a = 1\na = 2']) {
    assert.throws(() => parseHcl('bad.ethp', text), undefined, text);
    await assert.rejects(referenceParse('bad.ethp', text), undefined, text);
  }
});
