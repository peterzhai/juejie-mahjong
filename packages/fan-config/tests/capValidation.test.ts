/** P4b：cap 校验规则 8–12（PRD 6.5.6）+ 验收 12 */

import { describe, expect, it } from 'vitest';
import { defaultFanConfig, validateFanConfig, type CapConfig } from '@quejie/fan-config';

function cap(cfg: Partial<CapConfig>): CapConfig {
  return {
    enabled: true,
    value: { type: 'fixed', fixed: 3 },
    minFan: 0,
    scope: 'global',
    hardCap: 10,
    ...cfg,
  } as CapConfig;
}

function validateWith(cap: CapConfig) {
  const config = defaultFanConfig();
  config.scoring.cap = cap;
  return validateFanConfig(config);
}

describe('规则 8：value.type 枚举与必填字段', () => {
  it('type 非法 → 报错', () => {
    const r = validateWith(cap({ value: { type: 'bogus' } as never }));
    expect(r.errors.some((e) => e.code === 'E_CAP_VALUE_TYPE')).toBe(true);
  });

  it('fixed 非负整数', () => {
    expect(validateWith(cap({ value: { type: 'fixed', fixed: -1 } })).errors.some((e) => e.code === 'E_CAP_FIXED')).toBe(true);
    expect(validateWith(cap({ value: { type: 'fixed', fixed: 1.5 } })).errors.some((e) => e.code === 'E_CAP_FIXED')).toBe(true);
    expect(validateWith(cap({ value: { type: 'fixed', fixed: 3 } })).ok).toBe(true);
  });

  it('tiered：非空升序 + tierSelector 合法', () => {
    expect(validateWith(cap({ value: { type: 'tiered', tiers: [], tierSelector: 'roomLevel' } })).errors.some((e) => e.code === 'E_CAP_TIERS')).toBe(true);
    expect(validateWith(cap({ value: { type: 'tiered', tiers: [5, 3], tierSelector: 'roomLevel' } })).errors.some((e) => e.code === 'E_CAP_TIERS')).toBe(true);
    expect(validateWith(cap({ value: { type: 'tiered', tiers: [3, 4], tierSelector: 'season' } })).errors.some((e) => e.code === 'E_CAP_TIER_SELECTOR')).toBe(true);
    expect(validateWith(cap({ value: { type: 'tiered', tiers: [3, 4, 5], tierSelector: 'roomLevel' } })).ok).toBe(true);
  });

  it('formula：白名单校验与 hardCap 必填（验收 12）', () => {
    expect(validateWith(cap({ value: { type: 'formula', formula: 'clamp(3 + floor(kongCount / 2), minFan, hardCap)', hardCap: 10 } })).ok).toBe(true);
    // 含赋值 → 非法
    expect(validateWith(cap({ value: { type: 'formula', formula: 'a = 1', hardCap: 10 } })).errors.some((e) => e.code === 'E_CAP_FORMULA_INVALID')).toBe(true);
    // 未白名单函数
    expect(validateWith(cap({ value: { type: 'formula', formula: 'eval("1+1")', hardCap: 10 } })).errors.some((e) => e.code === 'E_CAP_FORMULA_INVALID')).toBe(true);
    // 未白名单变量
    expect(validateWith(cap({ value: { type: 'formula', formula: 'process.exit(1)', hardCap: 10 } })).errors.some((e) => e.code === 'E_CAP_FORMULA_INVALID')).toBe(true);
    // hardCap 缺失
    expect(validateWith(cap({ value: { type: 'formula', formula: 'min(base, 8)' } })).errors.some((e) => e.code === 'E_CAP_FORMULA_HARDCAP')).toBe(true);
    // 循环写法无法通过 tokenizer → ILLEGAL_CHAR → E_CAP_FORMULA_INVALID
    expect(validateWith(cap({ value: { type: 'formula', formula: 'while(1){base}', hardCap: 10 } })).errors.some((e) => e.code === 'E_CAP_FORMULA_INVALID')).toBe(true);
  });

  it('unlimited：hardCap 与 maxScore 必填', () => {
    expect(validateWith(cap({ value: { type: 'unlimited' }, hardCap: undefined })).errors.some((e) => e.code === 'E_CAP_UNLIMITED_HARDCAP')).toBe(true);
    expect(validateWith(cap({ value: { type: 'unlimited' }, maxScore: undefined })).errors.some((e) => e.code === 'E_CAP_UNLIMITED_MAXSCORE')).toBe(true);
    expect(validateWith(cap({ value: { type: 'unlimited' }, hardCap: 10, maxScore: 100000 })).ok).toBe(true);
  });
});

describe('规则 9：minFan / maxScore 边界', () => {
  it('minFan > fixed → 报错', () => {
    expect(validateWith(cap({ minFan: 4, value: { type: 'fixed', fixed: 3 } })).errors.some((e) => e.code === 'E_CAP_MIN_FAN_ABOVE_CAPFAN')).toBe(true);
  });

  it('minFan > hardCap → 报错', () => {
    expect(validateWith(cap({ minFan: 11, hardCap: 10 })).errors.some((e) => e.code === 'E_CAP_MIN_FAN_HARDCAP')).toBe(true);
  });

  it('maxScore ≤ 0 → 报错', () => {
    expect(validateWith(cap({ maxScore: 0 })).errors.some((e) => e.code === 'E_CAP_MAX_SCORE')).toBe(true);
  });

  it('tier 值 < minFan → 报错', () => {
    expect(validateWith(cap({ minFan: 4, value: { type: 'tiered', tiers: [3, 5], tierSelector: 'roomLevel' } })).errors.some((e) => e.code === 'E_CAP_MIN_FAN_ABOVE_CAPFAN')).toBe(true);
  });
});

describe('规则 10：分组', () => {
  it('引用不存在/未启用的番型 → 报错', () => {
    expect(validateWith(cap({ scope: 'group', groups: [{ id: 'g', capFan: 6, fanIds: ['notExist'] }] })).errors.some((e) => e.code === 'E_CAP_GROUP_FAN_MISSING')).toBe(true);
    const config = defaultFanConfig();
    config.scoring.cap = cap({ scope: 'group', groups: [{ id: 'g', capFan: 6, fanIds: ['bigDragons'] }] });
    // gd128 默认配置 bigDragons 已自动禁用
    expect(validateFanConfig(config).errors.some((e) => e.code === 'E_CAP_GROUP_FAN_DISABLED')).toBe(true);
  });

  it('同一番型出现在多个分组 → 报错', () => {
    const r = validateWith(cap({
      scope: 'group',
      groups: [
        { id: 'a', capFan: 6, fanIds: ['fullFlush'] },
        { id: 'b', capFan: 8, fanIds: ['fullFlush'] },
      ],
    }));
    expect(r.errors.some((e) => e.code === 'E_CAP_GROUP_FAN_MULTI')).toBe(true);
  });

  it('scope=group 但 groups 为空 → 报错', () => {
    expect(validateWith(cap({ scope: 'group', groups: [] })).errors.some((e) => e.code === 'E_CAP_SCOPE_GROUP_EMPTY')).toBe(true);
  });
});

describe('规则 11：bypass', () => {
  it('引用未启用的番型 → 报错', () => {
    const config = defaultFanConfig();
    config.scoring.cap = cap({ bypass: { fanIds: ['bigDragons'] } });
    expect(validateFanConfig(config).errors.some((e) => e.code === 'E_CAP_BYPASS_FAN_DISABLED')).toBe(true);
  });

  it('条件类型不在白名单 → 报错', () => {
    expect(validateWith(cap({ bypass: { conditions: [{ type: 'bogus', enabled: true }] } })).errors.some((e) => e.code === 'E_CAP_BYPASS_CONDITION')).toBe(true);
  });

  it('白名单四条件均合法', () => {
    const r = validateWith(cap({
      bypass: {
        conditions: [
          { type: 'selfDraw', enabled: true },
          { type: 'kongBlossom', enabled: false },
          { type: 'noRedCenter', enabled: true },
          { type: 'robbingKong', enabled: false },
        ],
      },
    }));
    expect(r.errors.some((e) => e.code === 'E_CAP_BYPASS_CONDITION')).toBe(false);
  });
});

describe('冲突告警（验收 9 告警部分）', () => {
  it('fanDouble + cap 启用 → W_FAN_DOUBLE_CAP', () => {
    const config = defaultFanConfig();
    config.scoring.redCenterBonus.mode = 'fanDouble';
    config.scoring.cap.enabled = true;
    const r = validateFanConfig(config);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.code === 'W_FAN_DOUBLE_CAP')).toBe(true);
  });
});
