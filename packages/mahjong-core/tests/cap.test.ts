/** P4b：多维最大番数（value.type 四种来源、作用域、bypass、minFan、maxScore） */

import { describe, expect, it } from 'vitest';
import type { ResolvedFanConfig } from '@quejie/fan-config';
import { computeScore, type PipelineContext } from '../src/scoring.js';
import type { FanEvaluation } from '../src/fans.js';
import { makeConfig } from './helpers.js';

const baseCtx: PipelineContext = {
  selfDraw: false,
  kongBlossom: false,
  robbingKong: false,
  seatWind: 'east',
  roundWind: 'east',
  kongCount: 0,
  wallTiles: 40,
  playerCount: 4,
  roomLevel: 1,
  dealer: false,
};

function fanEvalOf(base: number, fanId = 'fullFlush', value = base): FanEvaluation {
  return {
    matched: [{ fanId, name: fanId, value }],
    suppressed: [],
    chickenApplied: fanId === 'chicken',
    bonus: [],
    bestFanId: fanId,
    baseFan: base,
    afterBonusFan: base,
  };
}

function scoreWith(
  resolved: ResolvedFanConfig,
  evalOverride: Partial<FanEvaluation>,
  ctxOverrides: Partial<PipelineContext> = {},
  hasRed = false,
) {
  const fe = { ...fanEvalOf(5), ...evalOverride };
  return computeScore(resolved, fe, { ...baseCtx, ...ctxOverrides }, hasRed);
}

/** 在解析后的配置上直接叠加 cap 配置（单测免启动校验） */
function withCap(resolved: ResolvedFanConfig, cap: Record<string, unknown>): ResolvedFanConfig {
  const r = structuredClone(resolved);
  r.scoring.cap = {
    enabled: true,
    value: { type: 'fixed', fixed: 3 },
    minFan: 0,
    scope: 'global',
    ...cap,
  } as never;
  return r;
}

describe('验收 11：cap.value.type 四种模式', () => {
  it('fixed=3：超封顶被截断', () => {
    const r = withCap(makeConfig('gd136'), { value: { type: 'fixed', fixed: 3 }, hardCap: 10 });
    const s = scoreWith(r, { baseFan: 5, afterBonusFan: 5 });
    expect(s.finalFan).toBe(3);
    expect(s.meta.resolvedCapFan).toBe(3);
    expect(s.score).toBe(8); // 1 × 2^3
  });

  it('fixed=3：未触及封顶不截断', () => {
    const r = withCap(makeConfig('gd136'), { value: { type: 'fixed', fixed: 3 }, hardCap: 10 });
    const s = scoreWith(r, { baseFan: 2, afterBonusFan: 2 });
    expect(s.finalFan).toBe(2);
    expect(s.lines.find((l) => l.key === 'capped')!.detail).toContain('未触及封顶');
  });

  it('tiered：按 roomLevel 取档并越界 clamp', () => {
    const r = withCap(makeConfig('gd136'), {
      value: { type: 'tiered', tiers: [3, 4, 5], tierSelector: 'roomLevel' },
      hardCap: 10,
    });
    expect(scoreWith(r, {}, { roomLevel: 1 }).finalFan).toBe(3);
    expect(scoreWith(r, { baseFan: 5, afterBonusFan: 5 }, { roomLevel: 2 }).finalFan).toBe(4);
    expect(scoreWith(r, { baseFan: 5, afterBonusFan: 5 }, { roomLevel: 3 }).finalFan).toBe(5);
    expect(scoreWith(r, { baseFan: 5, afterBonusFan: 5 }, { roomLevel: 99 }).finalFan).toBe(5);
    expect(scoreWith(r, {}, { roomLevel: 0 }).finalFan).toBe(3);
  });

  it('formula：随 kongCount 变化并 clamp 到 hardCap，记录 formulaSnapshot', () => {
    const r = withCap(makeConfig('gd136'), {
      value: { type: 'formula', formula: 'clamp(3 + floor(kongCount / 2), minFan, hardCap)', hardCap: 10 },
      minFan: 1,
      hardCap: 10,
    });
    const s0 = scoreWith(r, { baseFan: 8, afterBonusFan: 8 }, { kongCount: 0 });
    expect(s0.finalFan).toBe(3);
    const s4 = scoreWith(r, { baseFan: 8, afterBonusFan: 8 }, { kongCount: 4 });
    expect(s4.finalFan).toBe(5);
    expect(s4.meta.formulaSnapshot).toEqual({
      base: 8, kongCount: 4, wallTiles: 40, playerCount: 4, minFan: 1, hardCap: 10,
    });
    const sMany = scoreWith(r, { baseFan: 12, afterBonusFan: 12 }, { kongCount: 100 });
    expect(sMany.finalFan).toBe(10); // capFan 被 clamp 到 hardCap=10，再封顶手牌 12 番
  });

  it('formula：可依赖 base（当前番）；capFan 只降不升', () => {
    const r = withCap(makeConfig('gd136'), {
      value: { type: 'formula', formula: 'clamp(base, 2, 8)', hardCap: 10 },
      hardCap: 10,
    });
    expect(scoreWith(r, { baseFan: 5, afterBonusFan: 5 }).finalFan).toBe(5);
    expect(scoreWith(r, { baseFan: 12, afterBonusFan: 12 }).finalFan).toBe(8);
    // capFan 是上限：手牌 0 番不会被 capFan 抬升
    expect(scoreWith(r, { baseFan: 0, afterBonusFan: 0 }).finalFan).toBe(0);
  });

  it('unlimited：不封顶但受 hardCap 保护', () => {
    const r = withCap(makeConfig('gd136'), {
      value: { type: 'unlimited' },
      hardCap: 10,
      maxScore: 1000000,
    });
    const s = scoreWith(r, { baseFan: 5, afterBonusFan: 5 });
    expect(s.finalFan).toBe(5);
    expect(s.meta.resolvedCapFan).toBeNull();
    const sBig = scoreWith(r, { baseFan: 20, afterBonusFan: 20, matched: [{ fanId: 'thirteenOrphans', name: '十三幺', value: 20 }] });
    expect(sBig.finalFan).toBe(10);
  });

  it('验收 17：同一手牌 fixed=3 与 formula 分数不同且元数据正确', () => {
    const fixedCfg = withCap(makeConfig('gd136'), { value: { type: 'fixed', fixed: 3 }, hardCap: 10 });
    const formulaCfg = withCap(makeConfig('gd136'), {
      value: { type: 'formula', formula: 'clamp(base, 2, 8)', hardCap: 10 },
      hardCap: 10,
    });
    const a = scoreWith(fixedCfg, { baseFan: 5, afterBonusFan: 5 });
    const b = scoreWith(formulaCfg, { baseFan: 5, afterBonusFan: 5 });
    expect(a.finalFan).toBe(3);
    expect(b.finalFan).toBe(5);
    expect(a.score).not.toBe(b.score);
    expect(b.meta.capValueType).toBe('formula');
    expect(b.meta.formulaSnapshot!.base).toBe(5);
    expect(a.meta.resolvedCapFan).toBe(3);
  });
});

describe('验收 13：group / player 作用域', () => {
  const groups = [
    { id: 'flushGroup', capFan: 6, fanIds: ['fullFlush', 'fullFlushTriplets'] },
    { id: 'honorGroup', capFan: 8, fanIds: ['allHonors', 'bigDragons', 'bigWinds'] },
  ];

  it('group：清一色类按分组封顶，未分组回落全局', () => {
    const r = withCap(makeConfig('gd136'), {
      value: { type: 'fixed', fixed: 3 },
      scope: 'group',
      groups,
      hardCap: 10,
    });
    // 清一色 9 番（构造）→ 分组封顶 6
    const flush = scoreWith(r, {
      matched: [{ fanId: 'fullFlush', name: '清一色', value: 9 }],
      bestFanId: 'fullFlush',
      baseFan: 9,
      afterBonusFan: 9,
    });
    expect(flush.finalFan).toBe(6);
    expect(flush.lines.find((l) => l.key === 'capScope')!.detail).toContain('flushGroup');
    // 未分组番型（碰碰胡）→ 全局 3
    const triplet = scoreWith(r, {
      matched: [{ fanId: 'allTriplets', name: '碰碰胡', value: 5 }],
      bestFanId: 'allTriplets',
      baseFan: 5,
      afterBonusFan: 5,
    });
    expect(triplet.finalFan).toBe(3);
    expect(triplet.lines.find((l) => l.key === 'capScope')!.detail).toContain('回落全局');
  });

  it('player：庄家封顶偏移生效', () => {
    const r = withCap(makeConfig('gd136'), {
      value: { type: 'fixed', fixed: 3 },
      scope: 'player',
      playerOffsets: { dealer: 2 },
      hardCap: 10,
    });
    // 庄家：capFan 5 → 4 番不触及
    const dealer = scoreWith(r, { baseFan: 4, afterBonusFan: 4 }, { dealer: true });
    expect(dealer.finalFan).toBe(4);
    // 闲家：capFan 3 → 截断
    const nonDealer = scoreWith(r, { baseFan: 4, afterBonusFan: 4 }, { dealer: false });
    expect(nonDealer.finalFan).toBe(3);
  });
});

describe('验收 14：bypass 豁免封顶但 hardCap 仍生效', () => {
  it('bypass.fanIds 命中跳过 capFan，hardCap 仍截断', () => {
    const r = withCap(makeConfig('gd136'), {
      value: { type: 'fixed', fixed: 3 },
      hardCap: 4,
      bypass: { fanIds: ['fullFlush', 'fullFlushTriplets', 'bigDragons', 'bigWinds', 'nineGates'] },
    });
    const s = scoreWith(r, { baseFan: 5, afterBonusFan: 5 });
    expect(s.finalFan).toBe(4); // 5 越过 capFan 3，但 hardCap 4 截断
    expect(s.meta.bypassTriggered!.fanIds).toContain('fullFlush');
    // 未命中 bypass 的番型仍封顶 3
    const s2 = scoreWith(r, {
      matched: [{ fanId: 'allTriplets', name: '碰碰胡', value: 5 }],
      bestFanId: 'allTriplets',
      baseFan: 5,
      afterBonusFan: 5,
    });
    expect(s2.finalFan).toBe(3);
    expect(s2.meta.bypassTriggered).toBeNull();
  });

  it('bypass.conditions 四种条件分别生效', () => {
    const mk = (cond: Record<string, unknown>) =>
      withCap(makeConfig('gd136'), {
        value: { type: 'fixed', fixed: 3 },
        hardCap: 10,
        bypass: { conditions: [cond] },
      });
    const eval5 = { baseFan: 5, afterBonusFan: 5 };

    expect(scoreWith(mk({ type: 'selfDraw', enabled: true }), eval5, { selfDraw: true }).finalFan).toBe(5);
    expect(scoreWith(mk({ type: 'selfDraw', enabled: true }), eval5, { selfDraw: false }).finalFan).toBe(3);
    expect(scoreWith(mk({ type: 'kongBlossom', enabled: true }), eval5, { kongBlossom: true }).finalFan).toBe(5);
    expect(scoreWith(mk({ type: 'robbingKong', enabled: true }), eval5, { robbingKong: true }).finalFan).toBe(5);
    expect(scoreWith(mk({ type: 'noRedCenter', enabled: true }), eval5, {}, false).finalFan).toBe(5);
    expect(scoreWith(mk({ type: 'noRedCenter', enabled: true }), eval5, {}, true).finalFan).toBe(3);
    // enabled=false 的条件不豁免
    expect(scoreWith(mk({ type: 'selfDraw', enabled: false }), eval5, { selfDraw: true }).finalFan).toBe(3);
  });

  it('多条件同时满足只豁免一次（不叠加）', () => {
    const r = withCap(makeConfig('gd136'), {
      value: { type: 'fixed', fixed: 3 },
      hardCap: 6,
      bypass: {
        conditions: [
          { type: 'selfDraw', enabled: true },
          { type: 'noRedCenter', enabled: true },
        ],
      },
    });
    const s = scoreWith(r, { baseFan: 5, afterBonusFan: 5 }, { selfDraw: true }, false);
    expect(s.finalFan).toBe(5); // 豁免一次 = 5，而非 5×2 之类
    expect(s.meta.bypassTriggered!.conditions.sort()).toEqual(['noRedCenter', 'selfDraw']);
  });
});

describe('验收 15/16：minFan 保底与 maxScore 截断', () => {
  it('minFan：鸡胡在任意封顶下 ≥ baseScore × 2^minFan', () => {
    const r = withCap(makeConfig('gd136'), {
      value: { type: 'fixed', fixed: 3 },
      minFan: 1,
      hardCap: 10,
    });
    const s = scoreWith(r, {
      matched: [{ fanId: 'chicken', name: '鸡胡', value: 0 }],
      bestFanId: 'chicken',
      chickenApplied: true,
      baseFan: 0,
      afterBonusFan: 0,
    });
    expect(s.finalFan).toBe(1);
    expect(s.score).toBe(2);
    expect(s.meta.minFanFloorApplied).toBe(true);
  });

  it('maxScore 在 unlimited 下截断且无 NaN/Infinity', () => {
    const r = withCap(makeConfig('gd136'), {
      value: { type: 'unlimited' },
      hardCap: 25,
      maxScore: 100000,
    });
    const s = scoreWith(r, { baseFan: 25, afterBonusFan: 25, matched: [{ fanId: 'thirteenOrphans', name: '十三幺', value: 25 }] });
    expect(Number.isFinite(s.score)).toBe(true);
    expect(s.score).toBe(100000);
    expect(s.meta.maxScoreApplied).toBe(true);
  });

  it('maxScore 在 bypass 场景下仍截断', () => {
    const r = withCap(makeConfig('gd136'), {
      value: { type: 'fixed', fixed: 3 },
      hardCap: 25,
      maxScore: 1000,
      bypass: { fanIds: ['fullFlush'] },
    });
    const s = scoreWith(r, { baseFan: 25, afterBonusFan: 25 });
    expect(s.finalFan).toBe(25); // bypass 豁免 capFan，hardCap 25 不触及
    expect(s.score).toBe(1000); // 2^25 × 1 > 1000 → 截断
  });
});

describe('验收 7 相关：cap 关闭时不生效', () => {
  it('cap.enabled=false：无封顶、无 minFan、无 hardCap', () => {
    const cfg = makeConfig('gd136');
    expect(cfg.scoring.cap.enabled).toBe(false);
    const s = scoreWith(cfg, { baseFan: 0, afterBonusFan: 0, matched: [{ fanId: 'chicken', name: '鸡胡', value: 0 }], bestFanId: 'chicken', chickenApplied: true });
    expect(s.finalFan).toBe(0);
    expect(s.score).toBe(1);
  });
});
