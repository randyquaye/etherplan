// Parses the subset of HCL native syntax that Etherplan reads: attributes, blocks, comments, quoted
// strings, whole numbers, booleans, null, lists, objects, references such as var.owner, conditionals,
// comparison and logical operators, parentheses, and function-call syntax. A file it accepts means the same
// thing to HCL. It rejects templates, heredocs, arithmetic, for expressions, and index expressions. It only
// builds the tree; compile.ts evaluates it. Every node records its file, line, and column.

import type { BinaryOperator, HclAttribute, HclBlock, HclBody, HclCall, HclDocument, HclExpression, HclList, HclObject, HclObjectEntry, HclToken, Located, Punctuation, SourcePosition, TokenType } from './types.ts';

const NUMBER = /[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const IDENTIFIER = /[\p{ID_Start}_][\p{ID_Continue}-]*/uy;
const IDENTIFIER_START = /^[\p{ID_Start}_]/u;
const IDENTIFIER_PART = /^[\p{ID_Continue}]/u;
const OPERATORS = ['==', '!=', '<=', '>=', '&&', '||', '=>', '...', '+', '*', '/', '%', '<', '>', '!', '?'];
const PUNCTUATION: ReadonlySet<string> = new Set<Punctuation>(['=', ':', ',', '.', '{', '}', '[', ']', '(', ')', '-']);
const ESCAPES = new Map([['n', '\n'], ['r', '\r'], ['t', '\t'], ['"', '"'], ['\\', '\\']]);
// HCL binary operator precedence, loosest first. Arithmetic is rejected.
const PRECEDENCE: ReadonlyMap<string, number> = new Map([['||', 1], ['&&', 2], ['==', 3], ['!=', 3], ['<', 4], ['<=', 4], ['>', 4], ['>=', 4]]);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function isPunctuation(char: string): char is Punctuation {
  return PUNCTUATION.has(char);
}

/** Throws an error that starts with the file, line, and column of a parsed node or token. */
export function fail(node: Located, message: string): never {
  throw new Error(`${node.at.file}:${node.at.line}:${node.at.column}: ${message}`);
}

function tokenize(file: string, text: string): HclToken[] {
  const tokens: HclToken[] = [];
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let lineStart = 0;
  const here = (offset = index): SourcePosition => ({ file, line, column: offset - lineStart + 1 });
  const error: (message: string, at: SourcePosition) => never = (message, at) => fail({ at }, message);

  function string(at: SourcePosition): string {
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
        const replacement = escape === undefined ? undefined : ESCAPES.get(escape);
        if (replacement !== undefined) {
          value += replacement;
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
    const char = text.charAt(index);
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
      const raw = NUMBER.exec(text)?.[0] ?? char;
      index += raw.length;
      if (IDENTIFIER_PART.test(text.slice(index, index + 2))) {
        IDENTIFIER.lastIndex = index;
        error(`${raw}${IDENTIFIER.exec(text)?.[0] ?? text[index]} is not a number. Quote addresses and hex values as strings.`, at);
      }
      if (!/^[0-9]+$/.test(raw)) error(`Number ${raw} must be a whole number without a decimal point or exponent. Quote exact values as decimal strings.`, at);
      tokens.push({ type: 'number', value: raw, at });
    } else if (IDENTIFIER_START.test(text.slice(index, index + 2))) {
      IDENTIFIER.lastIndex = index;
      const name = IDENTIFIER.exec(text)?.[0] ?? char;
      index += name.length;
      tokens.push({ type: 'ident', value: name, at });
    } else if (text.startsWith('<<', index)) {
      error('Heredoc strings are not supported. Use a quoted string.', at);
    } else {
      const operator = OPERATORS.find(candidate => text.startsWith(candidate, index));
      if (operator) {
        tokens.push({ type: 'operator', value: operator, at });
        index += operator.length;
      } else if (isPunctuation(char)) {
        tokens.push({ type: char, value: char, at });
        index++;
      } else {
        error(`Unexpected character ${JSON.stringify(String.fromCodePoint(text.codePointAt(index) ?? 0))}.`, at);
      }
    }
  }
  tokens.push({ type: 'eof', value: '', at: here() });
  return tokens;
}

function describe(token: HclToken): string {
  if (token.type === 'eof') return 'the end of the file';
  if (token.type === 'newline') return 'a new line';
  if (token.type === 'string') return 'a string';
  return `"${token.value}"`;
}

function isOperator(token: HclToken, value: string): boolean {
  return token.type === 'operator' && token.value === value;
}

function rejectOperator(token: HclToken): void {
  if (token.type === '-' || (token.type === 'operator' && ['+', '*', '/', '%'].includes(token.value))) fail(token, 'Arithmetic is not supported.');
  if (isOperator(token, '=>')) fail(token, 'For expressions are not supported.');
  if (isOperator(token, '...')) fail(token, 'The ... operator is not supported.');
}

function integer(token: HclToken, sign: 1n | -1n): number {
  const value = BigInt(token.value) * sign;
  const text = `${sign < 0n ? '-' : ''}${token.value}`;
  if (value > MAX_SAFE || value < -MAX_SAFE) fail(token, `Number ${text} is outside JavaScript's safe integer range. Quote it as a decimal string: "${text}".`);
  return Number(value);
}

class Parser {
  declare file: string;
  /** Always ends with an `eof` token, which `next` never moves past. */
  declare tokens: HclToken[];
  declare index: number;

  constructor(file: string, tokens: HclToken[]) {
    this.file = file;
    this.tokens = tokens;
    this.index = 0;
  }

  peek(offset = 0): HclToken {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)]!;
  }

  next(): HclToken {
    const token = this.peek();
    if (token.type !== 'eof') this.index++;
    return token;
  }

  skipNewlines(): void {
    while (this.peek().type === 'newline') this.index++;
  }

  endOfLine(what: string): void {
    const token = this.peek();
    if (token.type === 'newline' || token.type === 'eof') return;
    rejectOperator(token);
    fail(token, token.type === ',' ? `Put each ${what} on its own line; commas do not separate them.` : `Expected a new line after the ${what}, found ${describe(token)}.`);
  }

  /** Parses attributes and blocks up to `end`: the closing brace of `opener`, or the end of the file. */
  body(end: TokenType, opener?: HclToken): HclBody {
    const attributes = new Map<string, HclAttribute>();
    const blocks: HclBlock[] = [];
    const blockTypes = new Set<string>();
    for (;;) {
      this.skipNewlines();
      const token = this.peek();
      if (token.type === end) return { kind: 'body', attributes, blocks, at: opener?.at ?? { file: this.file, line: 1, column: 1 } };
      if (token.type === 'eof' && opener) fail(opener, `This ${opener.value} block has no closing }.`);
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

  block(type: HclToken): HclBlock {
    const labels: string[] = [];
    while (this.peek().type === 'string' || this.peek().type === 'ident') labels.push(this.next().value);
    const open = this.next();
    if (open.type !== '{') fail(open, labels.length ? `Expected { after the block labels, found ${describe(open)}.` : `Expected = or { after ${type.value}, found ${describe(open)}.`);
    let body: HclBody;
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

  /**
   * The next token. As in HCL, `multiline` looks past new lines, which are insignificant inside parentheses,
   * brackets, and call arguments; elsewhere a new line ends the expression.
   */
  lookahead(multiline: boolean): { token: HclToken; offset: number } {
    let offset = 0;
    if (multiline) while (this.peek(offset).type === 'newline') offset++;
    return { token: this.peek(offset), offset };
  }

  /** Consumes the token `lookahead` returned, and the new lines before it. */
  take(offset: number): HclToken {
    this.index += offset;
    return this.next();
  }

  expression(multiline = false): HclExpression {
    const node = this.conditional(multiline);
    rejectOperator(this.lookahead(multiline).token);
    return node;
  }

  conditional(multiline: boolean): HclExpression {
    const condition = this.binary(multiline, 1);
    const question = this.lookahead(multiline);
    if (!isOperator(question.token, '?')) return condition;
    this.take(question.offset);
    const then = this.conditional(multiline);
    const colon = this.lookahead(multiline);
    if (colon.token.type !== ':') {
      rejectOperator(colon.token);
      fail(colon.token, `Expected : and a false result in the conditional, found ${describe(colon.token)}.`);
    }
    this.take(colon.offset);
    return { kind: 'conditional', condition, then, otherwise: this.conditional(multiline), at: condition.at };
  }

  // Precedence climbing: operands bind to operators of `minimum` precedence or tighter, left to right.
  binary(multiline: boolean, minimum: number): HclExpression {
    let left = this.unary(multiline);
    for (;;) {
      const { token, offset } = this.lookahead(multiline);
      const precedence = token.type === 'operator' ? PRECEDENCE.get(token.value) : undefined;
      if (precedence === undefined || precedence < minimum) return left;
      this.take(offset);
      const right = this.binary(multiline, precedence + 1);
      left = { kind: 'binary', operator: token.value as BinaryOperator, operatorAt: token.at, left, right, at: left.at };
    }
  }

  unary(multiline: boolean): HclExpression {
    if (multiline) this.skipNewlines();
    const token = this.peek();
    if (!isOperator(token, '!')) return this.term();
    this.next();
    return { kind: 'not', operand: this.unary(multiline), at: token.at };
  }

  term(): HclExpression {
    const token = this.next();
    if (token.type === 'string') return { kind: 'literal', value: token.value, at: token.at };
    if (token.type === 'number') return { kind: 'literal', value: integer(token, 1n), at: token.at };
    if (token.type === '-') {
      const number = this.next();
      if (number.type !== 'number') fail(token, 'Arithmetic is not supported.');
      return { kind: 'literal', value: integer(number, -1n), at: token.at };
    }
    if (token.type === '[') return this.list(token);
    if (token.type === '{') return this.object(token);
    if (token.type === 'ident') return this.reference(token);
    if (token.type === '(') {
      this.skipNewlines();
      const inner = this.expression(true);
      this.skipNewlines();
      const close = this.next();
      if (close.type !== ')') fail(close, `Expected ) after the expression, found ${describe(close)}.`);
      return inner;
    }
    rejectOperator(token);
    fail(token, `Expected a value, found ${describe(token)}.`);
  }

  call(name: HclToken): HclCall {
    this.next();
    const args: HclExpression[] = [];
    this.skipNewlines();
    while (this.peek().type !== ')') {
      args.push(this.expression(true));
      this.skipNewlines();
      const separator = this.peek();
      if (separator.type === ',') {
        this.next();
        this.skipNewlines();
      } else if (separator.type !== ')') {
        rejectOperator(separator);
        fail(separator, `Expected a comma or ) in the arguments of ${name.value}, found ${describe(separator)}.`);
      }
    }
    this.next();
    return { kind: 'call', name: name.value, args, at: name.at };
  }

  reference(first: HclToken): HclExpression {
    if (first.value === 'true' || first.value === 'false') return { kind: 'literal', value: first.value === 'true', at: first.at };
    if (first.value === 'null') return { kind: 'literal', value: null, at: first.at };
    if (this.peek().type === '(') return this.call(first);
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

  rejectFor(): void {
    if (this.peek().type === 'ident' && this.peek().value === 'for' && this.peek(1).type === 'ident') fail(this.peek(), 'For expressions are not supported.');
  }

  list(open: HclToken): HclList {
    const items: HclExpression[] = [];
    this.skipNewlines();
    this.rejectFor();
    while (this.peek().type !== ']') {
      items.push(this.expression(true));
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

  object(open: HclToken): HclObject {
    const entries: HclObjectEntry[] = [];
    const keys = new Map<string, HclObjectEntry>();
    this.skipNewlines();
    this.rejectFor();
    while (this.peek().type !== '}') {
      const key = this.next();
      if (key.type === '(') fail(key, 'Computed object keys are not supported.');
      if (key.type !== 'ident' && key.type !== 'string') fail(key, `Expected an object key, found ${describe(key)}.`);
      if (this.peek().type === '.') fail(key, 'Object keys must be names or quoted strings.');
      const equals = this.next();
      if (equals.type !== '=' && equals.type !== ':') fail(equals, `Expected = after the object key ${key.value}, found ${describe(equals)}.`);
      const first = keys.get(key.value);
      if (first) fail(key, `Duplicate object key ${key.value}; it is first set on line ${first.at.line}.`);
      const entry: HclObjectEntry = { key: key.value, value: this.expression(), at: key.at };
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
 * { type, labels, body, at } in source order. Values are expression trees; see HclExpression.
 */
export function parseHcl(file: string, text: string): HclDocument {
  return new Parser(file, tokenize(file, text)).body('eof');
}

/** Parses one expression, such as a --var value for a list variable. */
export function parseHclExpression(file: string, text: string): HclExpression {
  const parser = new Parser(file, tokenize(file, text));
  parser.skipNewlines();
  const node = parser.expression(true);
  parser.skipNewlines();
  const end = parser.peek();
  if (end.type !== 'eof') fail(end, `Expected the end of the value, found ${describe(end)}.`);
  return node;
}
