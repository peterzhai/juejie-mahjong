/**
 * 受限表达式引擎（PRD 6.5.2 / 风险表 formula 执行风险）：
 * - 白名单变量：base, kongCount, wallTiles, playerCount, minFan, hardCap
 * - 白名单函数：min, max, clamp, floor, ceil, abs
 * - 运算：+ - * / % 与括号、一元负号
 * - 禁止：赋值、比较、成员访问、未知标识、任意函数调用
 * - 防护：表达式长度/深度/节点数上限 + 求值超时（默认 10ms）
 */

export type ExprVarName =
  | 'base'
  | 'kongCount'
  | 'wallTiles'
  | 'playerCount'
  | 'minFan'
  | 'hardCap';

export type ExprContext = Record<ExprVarName, number>;

export class ExprError extends Error {
  constructor(
    public code: 'EMPTY' | 'TOO_LONG' | 'TOO_DEEP' | 'ILLEGAL_CHAR' | 'UNKNOWN_TOKEN' | 'BAD_SYNTAX'
      | 'UNKNOWN_VAR' | 'UNKNOWN_FUNC' | 'BAD_ARG_COUNT' | 'TOO_MANY_NODES' | 'TIMEOUT' | 'NOT_FINITE' | 'DIV0',
    message: string,
  ) {
    super(message);
    this.name = 'ExprError';
  }
}

export const EXPR_VARS: readonly ExprVarName[] = [
  'base', 'kongCount', 'wallTiles', 'playerCount', 'minFan', 'hardCap',
];

const FUNCS: Record<string, { min: number; max: number; fn: (...args: number[]) => number }> = {
  min: { min: 2, max: 8, fn: (...a) => Math.min(...a) },
  max: { min: 2, max: 8, fn: (...a) => Math.max(...a) },
  clamp: { min: 3, max: 3, fn: (v, lo, hi) => Math.min(Math.max(v, lo), hi) },
  floor: { min: 1, max: 1, fn: (a) => Math.floor(a) },
  ceil: { min: 1, max: 1, fn: (a) => Math.ceil(a) },
  abs: { min: 1, max: 1, fn: (a) => Math.abs(a) },
};

export const EXPR_FUNC_NAMES = Object.keys(FUNCS);

export const EXPR_MAX_LENGTH = 200;
export const EXPR_MAX_DEPTH = 20;
export const EXPR_MAX_NODES = 120;
export const EXPR_TIMEOUT_MS = 10;

export type ExprNode =
  | { kind: 'num'; value: number }
  | { kind: 'var'; name: ExprVarName }
  | { kind: 'call'; name: string; args: ExprNode[] }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/' | '%'; left: ExprNode; right: ExprNode }
  | { kind: 'neg'; expr: ExprNode };

interface Token {
  type: 'num' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma';
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t') { i++; continue; }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      if (src[j] === '.') {
        j++;
        while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      }
      tokens.push({ type: 'num', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      tokens.push({ type: 'ident', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/%'.includes(c)) { tokens.push({ type: 'op', value: c }); i++; continue; }
    if (c === '(') { tokens.push({ type: 'lparen', value: c }); i++; continue; }
    if (c === ')') { tokens.push({ type: 'rparen', value: c }); i++; continue; }
    if (c === ',') { tokens.push({ type: 'comma', value: c }); i++; continue; }
    throw new ExprError('ILLEGAL_CHAR', `表达式含非法字符 "${c}"（禁止赋值/比较/成员访问等）`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private depth = 0;
  nodeCount = 0;

  constructor(private tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  /** 是否还有未消费的 token */
  atEnd(): boolean {
    return this.pos >= this.tokens.length;
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new ExprError('BAD_SYNTAX', '表达式意外结束');
    this.pos++;
    return t;
  }

  private addNode(): void {
    this.nodeCount++;
    if (this.nodeCount > EXPR_MAX_NODES) {
      throw new ExprError('TOO_MANY_NODES', `表达式节点数超过上限 ${EXPR_MAX_NODES}`);
    }
  }

  parseExpr(): ExprNode {
    let node = this.parseTerm();
    while (true) {
      const t = this.peek();
      if (t && t.type === 'op' && (t.value === '+' || t.value === '-')) {
        this.next();
        const right = this.parseTerm();
        this.addNode();
        node = { kind: 'bin', op: t.value as '+' | '-', left: node, right };
      } else {
        return node;
      }
    }
  }

  private parseTerm(): ExprNode {
    let node = this.parseFactor();
    while (true) {
      const t = this.peek();
      if (t && t.type === 'op' && (t.value === '*' || t.value === '/' || t.value === '%')) {
        this.next();
        const right = this.parseFactor();
        this.addNode();
        node = { kind: 'bin', op: t.value as '*' | '/' | '%', left: node, right };
      } else {
        return node;
      }
    }
  }

  private parseFactor(): ExprNode {
    const t = this.peek();
    if (t && t.type === 'op' && t.value === '-') {
      this.next();
      this.addNode();
      return { kind: 'neg', expr: this.parseFactor() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ExprNode {
    const t = this.next();
    if (t.type === 'num') {
      this.addNode();
      return { kind: 'num', value: Number(t.value) };
    }
    if (t.type === 'lparen') {
      this.depth++;
      if (this.depth > EXPR_MAX_DEPTH) {
        throw new ExprError('TOO_DEEP', `表达式嵌套深度超过上限 ${EXPR_MAX_DEPTH}`);
      }
      const inner = this.parseExpr();
      const close = this.next();
      this.depth--;
      if (close.type !== 'rparen') throw new ExprError('BAD_SYNTAX', '缺少右括号');
      return inner;
    }
    if (t.type === 'ident') {
      if (this.peek()?.type === 'lparen') {
        if (!(t.value in FUNCS)) {
          throw new ExprError('UNKNOWN_FUNC', `表达式函数 "${t.value}" 不在白名单（允许: ${EXPR_FUNC_NAMES.join(', ')}）`);
        }
        this.next(); // consume (
        const args: ExprNode[] = [];
        if (this.peek()?.type !== 'rparen') {
          args.push(this.parseExpr());
          while (this.peek()?.type === 'comma') {
            this.next();
            args.push(this.parseExpr());
          }
        }
        const close = this.next();
        if (close.type !== 'rparen') throw new ExprError('BAD_SYNTAX', `函数 ${t.value} 参数列表缺少右括号`);
        const spec = FUNCS[t.value]!;
        if (args.length < spec.min || args.length > spec.max) {
          throw new ExprError('BAD_ARG_COUNT', `函数 ${t.value} 参数数量应为 ${spec.min}..${spec.max}`);
        }
        this.addNode();
        return { kind: 'call', name: t.value, args };
      }
      if (!EXPR_VARS.includes(t.value as ExprVarName)) {
        throw new ExprError('UNKNOWN_VAR', `表达式变量 "${t.value}" 不在白名单（允许: ${EXPR_VARS.join(', ')}）`);
      }
      this.addNode();
      return { kind: 'var', name: t.value as ExprVarName };
    }
    throw new ExprError('BAD_SYNTAX', `表达式语法错误（位于 "${t.value}"）`);
  }
}

/** 解析表达式，启动期 fail-fast */
export function parseExpr(src: string): ExprNode {
  if (!src || src.trim().length === 0) throw new ExprError('EMPTY', '表达式为空');
  if (src.length > EXPR_MAX_LENGTH) {
    throw new ExprError('TOO_LONG', `表达式长度 ${src.length} 超过上限 ${EXPR_MAX_LENGTH}`);
  }
  const parser = new Parser(tokenize(src));
  const node = parser.parseExpr();
  if (!parser.atEnd()) throw new ExprError('BAD_SYNTAX', '表达式存在多余内容');
  return node;
}

/** 求值（带超时与有限数校验） */
export function evalExpr(node: ExprNode, ctx: ExprContext, timeoutMs = EXPR_TIMEOUT_MS): number {
  const start = now();
  const visit = (n: ExprNode): number => {
    if (now() - start > timeoutMs) {
      throw new ExprError('TIMEOUT', `表达式求值超过 ${timeoutMs}ms 限制`);
    }
    switch (n.kind) {
      case 'num':
        return n.value;
      case 'var':
        return ctx[n.name];
      case 'neg':
        return -visit(n.expr);
      case 'call': {
        const args = n.args.map(visit);
        return FUNCS[n.name]!.fn(...args);
      }
      case 'bin': {
        const l = visit(n.left);
        const r = visit(n.right);
        if (n.op === '+') return l + r;
        if (n.op === '-') return l - r;
        if (n.op === '*') return l * r;
        if (n.op === '/') {
          if (r === 0) throw new ExprError('DIV0', '表达式除零');
          return l / r;
        }
        if (r === 0) throw new ExprError('DIV0', '表达式取模零');
        return l % r;
      }
    }
  };
  const result = visit(node);
  if (!Number.isFinite(result)) {
    throw new ExprError('NOT_FINITE', '表达式求值结果不是有限数');
  }
  return result;
}

export interface CompiledExpr {
  /** 求值（每次调用重置超时计时） */
  eval(ctx: ExprContext, timeoutMs?: number): number;
  readonly source: string;
}

/** 编译一次、多次求值（启动校验 + 运行时共用） */
export function compileExpr(source: string): CompiledExpr {
  const ast = parseExpr(source);
  return {
    source,
    eval(ctx: ExprContext, timeoutMs: number = EXPR_TIMEOUT_MS) {
      return evalExpr(ast, ctx, timeoutMs);
    },
  };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
