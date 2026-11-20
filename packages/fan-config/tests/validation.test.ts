import { describe, expect, it } from 'vitest';
import {
  compileExpr,
  defaultFanConfig,
  ExprError,
  validateFanConfig,
  EXPR_TIMEOUT_MS,
  evalExpr,
  parseExpr,
} from '@quejie/fan-config';

describe('schema 校验（PRD 6.3 第 1 条）', () => {
  it('番型 id 重复 → 报错', () => {
    const cfg = defaultFanConfig();
    cfg.fans.push({ ...cfg.fans[0]!, id: cfg.fans[0]!.id });
    const result = validateFanConfig(cfg);
    expect(result.errors.some((e) => e.code === 'E_FAN_DUP_ID')).toBe(true);
  });

  it('番型 value 为负 → 报错', () => {
    const cfg = defaultFanConfig();
    cfg.fans.find((f) => f.id === 'fullFlush')!.value = -1;
    const result = validateFanConfig(cfg);
    expect(result.errors.some((e) => e.code === 'E_FAN_VALUE')).toBe(true);
  });

  it('无启用的兜底番 → 报错', () => {
    const cfg = defaultFanConfig();
    cfg.fans.find((f) => f.fallback)!.enabled = false;
    const result = validateFanConfig(cfg);
    expect(result.errors.some((e) => e.code === 'E_NO_FALLBACK')).toBe(true);
  });

  it('scoring.mode 非法 → 报错', () => {
    const cfg = defaultFanConfig();
    (cfg.scoring.mode as string) = 'bogus';
    const result = validateFanConfig(cfg);
    expect(result.errors.some((e) => e.code === 'E_SCORING_MODE')).toBe(true);
  });

  it('baseScore 非正 → 报错', () => {
    const cfg = defaultFanConfig();
    cfg.scoring.baseScore = 0;
    const result = validateFanConfig(cfg);
    expect(result.errors.some((e) => e.code === 'E_BASE_SCORE')).toBe(true);
  });
});

describe('受限表达式引擎：白名单与求值', () => {
  const ctx = { base: 3, kongCount: 2, wallTiles: 40, playerCount: 4, minFan: 1, hardCap: 10 };

  it('PRD 示例公式可解析并求值', () => {
    const compiled = compileExpr('clamp(3 + floor(kongCount / 2), minFan, hardCap)');
    expect(compiled.eval({ ...ctx, kongCount: 2 })).toBe(4); // 3 + floor(2/2)
    expect(compiled.eval({ ...ctx, kongCount: 0 })).toBe(3);
    expect(compiled.eval({ ...ctx, kongCount: 99 })).toBe(10); // clamp 到 hardCap
  });

  it('白名单函数可用', () => {
    expect(compileExpr('min(base, hardCap)').eval(ctx)).toBe(3);
    expect(compileExpr('max(minFan, base - 1)').eval(ctx)).toBe(2);
    expect(compileExpr('ceil(base / 2)').eval(ctx)).toBe(2);
    expect(compileExpr('abs(0 - base)').eval(ctx)).toBe(3);
  });

  it('赋值/比较/成员访问/未知标识全部拒绝', () => {
    const bad: [string, string][] = [
      ['a = 1', 'ILLEGAL_CHAR'],
      ['base++', 'BAD_SYNTAX'],
      ['base == 1', 'ILLEGAL_CHAR'],
      ['Math.floor(base)', 'ILLEGAL_CHAR'],
      ['this.hardCap', 'ILLEGAL_CHAR'],
      ['evil()', 'UNKNOWN_FUNC'],
      ['foo + 1', 'UNKNOWN_VAR'],
      ['constructor', 'UNKNOWN_VAR'],
      ['__proto__', 'UNKNOWN_VAR'],
      ['while(1){}', 'ILLEGAL_CHAR'],
      ['', 'EMPTY'],
      ['1 +', 'BAD_SYNTAX'],
      ['(1 + 2', 'BAD_SYNTAX'],
    ];
    for (const [src, code] of bad) {
      try {
        parseExpr(src);
        expect.unreachable(`应拒绝: ${src}`);
      } catch (e) {
        expect(e).toBeInstanceOf(ExprError);
        expect((e as ExprError).code, src).toBe(code);
      }
    }
  });

  it('除零与非有限数被拒', () => {
    expect(() => compileExpr('base / 0').eval(ctx)).toThrowError(/除零/);
    expect(() => compileExpr('0 / 0').eval(ctx)).toThrowError();
  });

  it('长度/深度/节点数上限', () => {
    expect(() => parseExpr('1 + '.repeat(60) + '1')).toThrowError(/长度/);
    expect(() => parseExpr('('.repeat(25) + '1' + ')'.repeat(25))).toThrowError(/深度/);
  });

  it('求值超时报错（PRD：超时 10ms 即报配置错误）', () => {
    const ast = parseExpr('minFan + 1');
    expect(() => evalExpr(ast, ctx, 0)).toThrowError(/超过/);
    expect(EXPR_TIMEOUT_MS).toBe(10);
  });

  it('表达式括号与优先级', () => {
    expect(compileExpr('2 + 3 * 4').eval(ctx)).toBe(14);
    expect(compileExpr('(2 + 3) * 4').eval(ctx)).toBe(20);
    expect(compileExpr('10 % 3').eval(ctx)).toBe(1);
    expect(compileExpr('0 - base').eval(ctx)).toBe(-3);
  });
});
