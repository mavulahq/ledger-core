type TokenType =
  | 'number'
  | 'string'
  | 'identifier'
  | 'operator'
  | 'leftParen'
  | 'rightParen'
  | 'comma'
  | 'eof';

interface Token {
  type: TokenType;
  value: string;
}

const MATH_FUNCTIONS: Record<string, (...args: number[]) => number> = {
  abs: (value) => Math.abs(value),
  ceil: (value) => Math.ceil(value),
  clamp: (value, min, max) => Math.min(Math.max(value, min), max),
  floor: (value) => Math.floor(value),
  max: (...values) => Math.max(...values),
  min: (...values) => Math.min(...values),
  percent: (value, rate) => (value * rate) / 100,
  pow: (base, exponent) => Math.pow(base, exponent),
  round: (value, precision = 0) => {
    const factor = Math.pow(10, precision);
    return Math.round(value * factor) / factor;
  },
  sqrt: (value) => Math.sqrt(value),
};

const MATH_CONSTANTS: Record<string, number> = {
  E: Math.E,
  PI: Math.PI,
};

export function evaluateNumericExpression(expression: string, context: Record<string, any>): number {
  const parser = new SafeExpressionParser(expression, context, true);
  const value = parser.parse();
  const numericValue = toNumber(value, true);

  if (!Number.isFinite(numericValue)) {
    throw new Error(`Invalid formula: ${expression}`);
  }

  return Number(numericValue.toFixed(2));
}

export function evaluateBooleanExpression(expression: string, context: Record<string, any>): boolean {
  const trimmed = expression.trim();
  if (!trimmed) {
    return true;
  }

  const parser = new SafeExpressionParser(trimmed, context, false);
  return toBoolean(parser.parse());
}

class SafeExpressionParser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(
    private readonly expression: string,
    private readonly context: Record<string, any>,
    private readonly missingNumberAsZero: boolean,
  ) {
    this.tokens = tokenizeExpression(expression);
  }

  parse(): any {
    const value = this.parseOr();
    this.expect('eof');
    return value;
  }

  private parseOr(): any {
    let value = this.parseAnd();
    while (this.matchOperator('||')) {
      const right = this.parseAnd();
      value = toBoolean(value) || toBoolean(right);
    }
    return value;
  }

  private parseAnd(): any {
    let value = this.parseEquality();
    while (this.matchOperator('&&')) {
      const right = this.parseEquality();
      value = toBoolean(value) && toBoolean(right);
    }
    return value;
  }

  private parseEquality(): any {
    let value = this.parseComparison();
    while (true) {
      if (this.matchOperator('===') || this.matchOperator('==')) {
        value = value === this.parseComparison();
      } else if (this.matchOperator('!==') || this.matchOperator('!=')) {
        value = value !== this.parseComparison();
      } else {
        return value;
      }
    }
  }

  private parseComparison(): any {
    let value = this.parseAdditive();
    while (true) {
      if (this.matchOperator('>=')) {
        value = this.toNumber(value) >= this.toNumber(this.parseAdditive());
      } else if (this.matchOperator('<=')) {
        value = this.toNumber(value) <= this.toNumber(this.parseAdditive());
      } else if (this.matchOperator('>')) {
        value = this.toNumber(value) > this.toNumber(this.parseAdditive());
      } else if (this.matchOperator('<')) {
        value = this.toNumber(value) < this.toNumber(this.parseAdditive());
      } else {
        return value;
      }
    }
  }

  private parseAdditive(): any {
    let value = this.parseMultiplicative();
    while (true) {
      if (this.matchOperator('+')) {
        const right = this.parseMultiplicative();
        value = typeof value === 'string' || typeof right === 'string'
          ? `${value}${right}`
          : this.toNumber(value) + this.toNumber(right);
      } else if (this.matchOperator('-')) {
        value = this.toNumber(value) - this.toNumber(this.parseMultiplicative());
      } else {
        return value;
      }
    }
  }

  private parseMultiplicative(): any {
    let value = this.parsePower();
    while (true) {
      if (this.matchOperator('*')) {
        value = this.toNumber(value) * this.toNumber(this.parsePower());
      } else if (this.matchOperator('/')) {
        const divisor = this.toNumber(this.parsePower());
        value = divisor === 0 ? 0 : this.toNumber(value) / divisor;
      } else if (this.matchOperator('%')) {
        const divisor = this.toNumber(this.parsePower());
        value = divisor === 0 ? 0 : this.toNumber(value) % divisor;
      } else {
        return value;
      }
    }
  }

  private parsePower(): any {
    let value = this.parseUnary();
    if (this.matchOperator('^')) {
      value = Math.pow(this.toNumber(value), this.toNumber(this.parsePower()));
    }
    return value;
  }

  private parseUnary(): any {
    if (this.matchOperator('!')) {
      return !toBoolean(this.parseUnary());
    }
    if (this.matchOperator('-')) {
      return -this.toNumber(this.parseUnary());
    }
    if (this.matchOperator('+')) {
      return this.toNumber(this.parseUnary());
    }
    return this.parsePrimary();
  }

  private parsePrimary(): any {
    const token = this.peek();

    if (this.match('number')) {
      return Number(token.value);
    }

    if (this.match('string')) {
      return token.value;
    }

    if (this.match('identifier')) {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      if (token.value === 'undefined') return undefined;
      if (token.value in MATH_CONSTANTS) return MATH_CONSTANTS[token.value];

      if (this.match('leftParen')) {
        return this.evaluateFunction(token.value, this.parseArguments());
      }

      return resolvePath(this.context, token.value);
    }

    if (this.match('leftParen')) {
      const value = this.parseOr();
      this.expect('rightParen');
      return value;
    }

    throw new Error(`Invalid expression: ${this.expression}`);
  }

  private parseArguments(): any[] {
    const args: any[] = [];
    if (this.match('rightParen')) {
      return args;
    }

    do {
      args.push(this.parseOr());
    } while (this.match('comma'));

    this.expect('rightParen');
    return args;
  }

  private evaluateFunction(name: string, args: any[]): number {
    const fn = MATH_FUNCTIONS[name];
    if (!fn) {
      throw new Error(`Invalid formula: ${this.expression}`);
    }

    return fn(...args.map((arg) => this.toNumber(arg)));
  }

  private toNumber(value: any): number {
    return toNumber(value, this.missingNumberAsZero);
  }

  private match(type: TokenType): boolean {
    if (this.peek().type !== type) {
      return false;
    }
    this.index += 1;
    return true;
  }

  private matchOperator(operator: string): boolean {
    const token = this.peek();
    if (token.type !== 'operator' || token.value !== operator) {
      return false;
    }
    this.index += 1;
    return true;
  }

  private expect(type: TokenType): void {
    if (!this.match(type)) {
      throw new Error(`Invalid expression: ${this.expression}`);
    }
  }

  private peek(): Token {
    return this.tokens[this.index];
  }
}

function tokenizeExpression(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < expression.length) {
    const char = expression[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    const numberMatch = expression.slice(index).match(/^\d+(\.\d+)?/);
    if (numberMatch) {
      tokens.push({ type: 'number', value: numberMatch[0] });
      index += numberMatch[0].length;
      continue;
    }

    if (char === '"' || char === "'") {
      const { value, nextIndex } = readString(expression, index, char);
      tokens.push({ type: 'string', value });
      index = nextIndex;
      continue;
    }

    const identifierMatch = expression.slice(index).match(/^[A-Za-z_][A-Za-z0-9_.]*/);
    if (identifierMatch) {
      tokens.push({ type: 'identifier', value: identifierMatch[0] });
      index += identifierMatch[0].length;
      continue;
    }

    const threeChar = expression.slice(index, index + 3);
    if (['===', '!=='].includes(threeChar)) {
      tokens.push({ type: 'operator', value: threeChar });
      index += 3;
      continue;
    }

    const twoChar = expression.slice(index, index + 2);
    if (['>=', '<=', '==', '!=', '&&', '||'].includes(twoChar)) {
      tokens.push({ type: 'operator', value: twoChar });
      index += 2;
      continue;
    }

    if ('+-*/%^!<>'.includes(char)) {
      tokens.push({ type: 'operator', value: char });
      index += 1;
      continue;
    }

    if (char === '(') {
      tokens.push({ type: 'leftParen', value: char });
      index += 1;
      continue;
    }

    if (char === ')') {
      tokens.push({ type: 'rightParen', value: char });
      index += 1;
      continue;
    }

    if (char === ',') {
      tokens.push({ type: 'comma', value: char });
      index += 1;
      continue;
    }

    throw new Error(`Unsupported expression token at position ${index}`);
  }

  tokens.push({ type: 'eof', value: '' });
  return tokens;
}

function readString(source: string, startIndex: number, quote: string): { value: string; nextIndex: number } {
  let value = '';
  let index = startIndex + 1;

  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      const next = source[index + 1];
      if (next === undefined) {
        throw new Error(`Invalid string literal: ${source}`);
      }
      value += next;
      index += 2;
      continue;
    }
    if (char === quote) {
      return { value, nextIndex: index + 1 };
    }
    value += char;
    index += 1;
  }

  throw new Error(`Invalid string literal: ${source}`);
}

function resolvePath(context: Record<string, any>, path: string): any {
  return path.split('.').reduce((current, key) => {
    if (current === undefined || current === null) {
      return undefined;
    }
    return current[key];
  }, context as any);
}

function toNumber(value: any, missingNumberAsZero: boolean): number {
  if (value === undefined || value === null || value === '') {
    if (!missingNumberAsZero) {
      throw new Error('Expected numeric value, received empty value');
    }
    return 0;
  }
  const numericValue = Number(value);
  if (Number.isNaN(numericValue)) {
    throw new Error(`Expected numeric value, received ${String(value)}`);
  }
  return numericValue;
}

function toBoolean(value: any): boolean {
  return Boolean(value);
}
