// Parses the subset of HCL native syntax that Etherplan reads: attributes, blocks, comments, quoted
// strings, whole numbers, booleans, null, lists, objects, and references such as var.owner. A file it
// accepts means the same thing to HCL. It rejects templates, heredocs, operators, function calls, and
// other expressions instead of evaluating them. Every node records its file, line, and column.

const NUMBER = /[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const IDENTIFIER = /[\p{ID_Start}_][\p{ID_Continue}-]*/uy;
const IDENTIFIER_START = /^[\p{ID_Start}_]/u;
const IDENTIFIER_PART = /^[\p{ID_Continue}]/u;
const OPERATORS = ['==', '!=', '<=', '>=', '&&', '||', '=>', '...', '+', '*', '/', '%', '<', '>', '!', '?'];
const PUNCTUATION = new Set(['=', ':', ',', '.', '{', '}', '[', ']', '(', ')', '-']);
const ESCAPES = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Throws an error that starts with the file, line, and column of a parsed node or token. */
export function fail(node, message) {
  throw new Error(`${node.at.file}:${node.at.line}:${node.at.column}: ${message}`);
}

function tokenize(file, text) {
  const tokens = [];
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let lineStart = 0;
  const here = (offset = index) => ({ file, line, column: offset - lineStart + 1 });
  const error = (message, at) => fail({ at }, message);

  function string(at) {
    let value = '';
    let cursor = index + 1;
    for (;;) {
      const char = text[cursor];
      if (char === undefined || char === '\n' || char === '\r') error('This string has no closing quote. Quoted strings end on the same line.', at);
      if (char === '"') {
        index = cursor + 1;
        return value;
      }
      if (char === '\\') {
        const escape = text[cursor + 1];
        if (Object.hasOwn(ESCAPES, escape)) {
          value += ESCAPES[escape];
          cursor += 2;
          continue;
        }
        if (escape === 'u' || escape === 'U') {
          const hex = text.slice(cursor + 2, cursor + (escape === 'u' ? 6 : 10));
          const code = /^[0-9a-fA-F]+$/.test(hex) && hex.length === (escape === 'u' ? 4 : 8) ? parseInt(hex, 16) : NaN;
          if (!(code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) error(`Invalid Unicode escape \\${escape}${hex}.`, here(cursor));
          value += String.fromCodePoint(code);
          cursor += 2 + hex.length;
          continue;
        }
        error(`Invalid escape sequence \\${escape ?? ''}. Use \\n, \\r, \\t, \\", \\\\, \\uNNNN, or \\UNNNNNNNN.`, here(cursor));
      }
      if ((char === '$' || char === '%') && text[cursor + 1] === '{') {
        error(char === '$' ? 'String templates are not supported. Write a reference without quotes, for example var.owner.' : 'Template directives are not supported.', here(cursor));
      }
      if ((char === '$' || char === '%') && text[cursor + 1] === char && text[cursor + 2] === '{') {
        value += `${char}{`;
        cursor += 3;
        continue;
      }
      value += char;
      cursor++;
    }
  }

  while (index < text.length) {
    const char = text[index];
    const at = here();
    if (char === ' ' || char === '\t' || (char === '\r' && text[index + 1] === '\n')) {
      index++;
    } else if (char === '\n') {
      tokens.push({ type: 'newline', value: '\n', at });
      index++;
      line++;
      lineStart = index;
    } else if (char === '#' || text.startsWith('//', index)) {
      while (index < text.length && text[index] !== '\n') index++;
    } else if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      if (end === -1) error('This comment has no closing */.', at);
      for (; index < end + 2; index++) {
        if (text[index] === '\n') {
          line++;
          lineStart = index + 1;
        }
      }
    } else if (char === '"') {
      tokens.push({ type: 'string', value: string(at), at });
    } else if (char >= '0' && char <= '9') {
      NUMBER.lastIndex = index;
      const raw = NUMBER.exec(text)[0];
      index += raw.length;
      if (IDENTIFIER_PART.test(text.slice(index, index + 2))) {
        IDENTIFIER.lastIndex = index;
        error(`${raw}${IDENTIFIER.exec(text)?.[0] ?? text[index]} is not a number. Quote addresses and hex values as strings.`, at);
      }
      if (!/^[0-9]+$/.test(raw)) error(`Number ${raw} must be a whole number without a decimal point or exponent. Quote exact values as decimal strings.`, at);
      tokens.push({ type: 'number', value: raw, at });
    } else if (IDENTIFIER_START.test(text.slice(index, index + 2))) {
      IDENTIFIER.lastIndex = index;
      const name = IDENTIFIER.exec(text)[0];
      index += name.length;
      tokens.push({ type: 'ident', value: name, at });
    } else if (text.startsWith('<<', index)) {
      error('Heredoc strings are not supported. Use a quoted string.', at);
    } else {
      const operator = OPERATORS.find(candidate => text.startsWith(candidate, index));
      if (operator) {
        tokens.push({ type: 'operator', value: operator, at });
        index += operator.length;
      } else if (PUNCTUATION.has(char)) {
        tokens.push({ type: char, value: char, at });
        index++;
      } else {
        error(`Unexpected character ${JSON.stringify(String.fromCodePoint(text.codePointAt(index)))}.`, at);
      }
    }
  }
  tokens.push({ type: 'eof', value: '', at: here() });
  return tokens;
}

function describe(token) {
  if (token.type === 'eof') return 'the end of the file';
  if (token.type === 'newline') return 'a new line';
  if (token.type === 'string') return 'a string';
  return `"${token.value}"`;
}

function rejectOperator(token) {
  if (token.type !== 'operator' && token.type !== '-') return;
  fail(token, token.value === '?' ? 'Conditional expressions are not supported.'
    : token.value === '...' || token.value === '=>' ? 'For expressions are not supported.'
      : 'Arithmetic and operators are not supported.');
}

function integer(token, sign) {
  const value = BigInt(token.value) * sign;
  const text = `${sign < 0n ? '-' : ''}${token.value}`;
  if (value > MAX_SAFE || value < -MAX_SAFE) fail(token, `Number ${text} is outside JavaScript's safe integer range. Quote it as a decimal string: "${text}".`);
  return Number(value);
}

class Parser {
  constructor(file, tokens) {
    this.file = file;
    this.tokens = tokens;
    this.index = 0;
  }

  peek(offset = 0) {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)];
  }

  next() {
    const token = this.tokens[this.index];
    if (token.type !== 'eof') this.index++;
    return token;
  }

  skipNewlines() {
    while (this.peek().type === 'newline') this.index++;
  }

  endOfLine(what) {
    const token = this.peek();
    if (token.type === 'newline' || token.type === 'eof') return;
    rejectOperator(token);
    fail(token, token.type === ',' ? `Put each ${what} on its own line; commas do not separate them.` : `Expected a new line after the ${what}, found ${describe(token)}.`);
  }

  body(end, opener) {
    const attributes = new Map();
    const blocks = [];
    const blockTypes = new Set();
    for (;;) {
      this.skipNewlines();
      const token = this.peek();
      if (token.type === end) return { kind: 'body', attributes, blocks, at: opener?.at ?? { file: this.file, line: 1, column: 1 } };
      if (token.type === 'eof') fail(opener, `This ${opener.value} block has no closing }.`);
      if (token.type !== 'ident') fail(token, token.type === 'string' ? 'Attribute and block names must not be quoted.' : `Expected an attribute or block, found ${describe(token)}.`);
      this.next();
      if (this.peek().type === '=') {
        this.next();
        const value = this.expression();
        this.endOfLine('attribute');
        const first = attributes.get(token.value);
        if (first) fail(token, `${token.value} is already set on line ${first.at.line}.`);
        if (blockTypes.has(token.value)) fail(token, `${token.value} is used both as an attribute and as a block.`);
        attributes.set(token.value, { kind: 'attribute', name: token.value, value, at: token.at });
      } else {
        blocks.push(this.block(token));
        if (attributes.has(token.value)) fail(token, `${token.value} is used both as an attribute and as a block.`);
        blockTypes.add(token.value);
      }
    }
  }

  block(type) {
    const labels = [];
    while (this.peek().type === 'string' || this.peek().type === 'ident') labels.push(this.next().value);
    const open = this.next();
    if (open.type !== '{') fail(open, labels.length ? `Expected { after the block labels, found ${describe(open)}.` : `Expected = or { after ${type.value}, found ${describe(open)}.`);
    let body;
    if (this.peek().type === 'newline') {
      body = this.body('}', type);
      this.next();
    } else {
      body = { kind: 'body', attributes: new Map(), blocks: [], at: open.at };
      if (this.peek().type !== '}') {
        const name = this.next();
        if (name.type !== 'ident') fail(name, `Expected an attribute or }, found ${describe(name)}.`);
        if (this.peek().type !== '=') fail(this.peek(), 'A block on one line can hold only one attribute and no nested block. Put them on their own lines.');
        this.next();
        body.attributes.set(name.value, { kind: 'attribute', name: name.value, value: this.expression(), at: name.at });
      }
      const close = this.next();
      if (close.type !== '}') fail(close, 'A block on one line can hold only one attribute. Put each attribute on its own line.');
    }
    this.endOfLine('block');
    return { kind: 'block', type: type.value, labels, body, at: type.at };
  }

  expression() {
    const token = this.next();
    let node;
    if (token.type === 'string') node = { kind: 'literal', value: token.value, at: token.at };
    else if (token.type === 'number') node = { kind: 'literal', value: integer(token, 1n), at: token.at };
    else if (token.type === '-') {
      const number = this.next();
      if (number.type !== 'number') fail(token, 'Arithmetic and operators are not supported.');
      node = { kind: 'literal', value: integer(number, -1n), at: token.at };
    } else if (token.type === '[') node = this.list(token);
    else if (token.type === '{') node = this.object(token);
    else if (token.type === 'ident') node = this.reference(token);
    else if (token.type === '(') fail(token, 'Parenthesized expressions are not supported.');
    else {
      rejectOperator(token);
      fail(token, `Expected a value, found ${describe(token)}.`);
    }
    rejectOperator(this.peek());
    return node;
  }

  reference(first) {
    if (first.value === 'true' || first.value === 'false') return { kind: 'literal', value: first.value === 'true', at: first.at };
    if (first.value === 'null') return { kind: 'literal', value: null, at: first.at };
    if (this.peek().type === '(') fail(first, `Function calls are not supported (${first.value}).`);
    const parts = [first.value];
    while (this.peek().type === '.') {
      this.next();
      const part = this.next();
      if (part.type === 'number' || part.value === '*') fail(part, 'Index and splat expressions are not supported.');
      if (part.type !== 'ident') fail(part, `Expected a name after ".", found ${describe(part)}.`);
      parts.push(part.value);
    }
    if (this.peek().type === '[') fail(this.peek(), 'Index and splat expressions are not supported.');
    return { kind: 'reference', parts, at: first.at };
  }

  rejectFor() {
    if (this.peek().type === 'ident' && this.peek().value === 'for' && this.peek(1).type === 'ident') fail(this.peek(), 'For expressions are not supported.');
  }

  list(open) {
    const items = [];
    this.skipNewlines();
    this.rejectFor();
    while (this.peek().type !== ']') {
      items.push(this.expression());
      this.skipNewlines();
      const separator = this.peek();
      if (separator.type === ',') {
        this.next();
        this.skipNewlines();
      } else if (separator.type !== ']') {
        rejectOperator(separator);
        fail(separator, `Expected a comma or ] in the list, found ${describe(separator)}.`);
      }
    }
    this.next();
    return { kind: 'list', items, at: open.at };
  }

  object(open) {
    const entries = [];
    const keys = new Map();
    this.skipNewlines();
    this.rejectFor();
    while (this.peek().type !== '}') {
      const key = this.next();
      if (key.type === '(') fail(key, 'Computed object keys are not supported.');
      if (key.type !== 'ident' && key.type !== 'string') fail(key, `Expected an object key, found ${describe(key)}.`);
      if (this.peek().type === '.') fail(key, 'Object keys must be names or quoted strings.');
      const equals = this.next();
      if (equals.type !== '=' && equals.type !== ':') fail(equals, `Expected = after the object key ${key.value}, found ${describe(equals)}.`);
      if (keys.has(key.value)) fail(key, `Duplicate object key ${key.value}; it is first set on line ${keys.get(key.value).at.line}.`);
      const entry = { key: key.value, value: this.expression(), at: key.at };
      keys.set(key.value, entry);
      entries.push(entry);
      const separator = this.peek();
      if (separator.type === ',') {
        this.next();
        this.skipNewlines();
      } else if (separator.type === 'newline') {
        this.skipNewlines();
      } else if (separator.type !== '}') {
        rejectOperator(separator);
        fail(separator, `Expected a comma, new line, or } after the object value, found ${describe(separator)}.`);
      }
    }
    this.next();
    return { kind: 'object', entries, at: open.at };
  }
}

/**
 * Parses HCL text into a body: `attributes` maps each name to { name, value, at }, and `blocks` lists
 * { type, labels, body, at } in source order. Values are literal, list, object, or reference nodes.
 */
export function parseHcl(file, text) {
  return new Parser(file, tokenize(file, text)).body('eof');
}
