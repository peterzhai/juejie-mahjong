/** P4b：无红中加成四模式 + 双运算顺序 + 判定范围（PRD 6.4） */

import { describe, expect, it } from 'vitest';
import { validateFanConfig } from '@quejie/fan-config';
import { computeScore, type PipelineContext } from '../src/scoring.js';
import type { FanEvaluation } from '../src/fans.js';
import { TileIndex } from '../src/tileIndex.js';
import { settleWin } from '../src/settle.js';
import { makeConfig } from './helpers.js';
import type { MeldData } from '../src/winCheck.js';

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

function evalOf(base: number): FanEvaluation {
  return {
    matched: [{ fanId: 'fullFlush', name: '清一色', value: base }],
    suppressed: [],
    chickenApplied: false,
    bonus: [],
    bestFanId: 'fullFlush',
    baseFan: base,
    afterBonusFan: base,
  };
}

function scoreWith(cfg, ctxOv: Partial<PipelineContext> = {}, hasRed = false, base = 3) {
  return computeScore(cfg, evalOf(base), { ...baseCtx, ...ctxOv }, hasRed);
}

function bonusCfg(mode: 'none' | 'addFan' | 'fanDouble' | 'scoreDouble', bypassCap = false, capFixed: number | null = null) {
  const cfg = makeConfig('gd128', { bonusEnabled: true, bonusMode: mode, bypassCap });
  cfg.scoring.redCenterBonus.addFan = 1;
  if (capFixed !== null) {
    cfg.scoring.cap.enabled = true;
    cfg.scoring.cap.value = { type: 'fixed', fixed: capFixed };
    cfg.scoring.cap.hardCap = 10;
    cfg.scoring.cap.minFan = 0;
    // 清除默认 bypass，避免干扰封顶语义测试
    cfg.scoring.cap.bypass = { fanIds: [], conditions: [] };
  }
  return cfg;
}

describe('验收 8：四种加成模式 × 有/无红中', () => {
  it('addFan：无红中 +1 番；有红中不加', () => {
    const cfg = bonusCfg('addFan');
    expect(scoreWith(cfg, {}, false, 3).finalFan).toBe(4);
    expect(scoreWith(cfg, {}, true, 3).finalFan).toBe(3);
  });

  it('fanDouble：无红中番数×2；有红中不翻', () => {
    const cfg = bonusCfg('fanDouble');
    expect(scoreWith(cfg, {}, false, 3).finalFan).toBe(6);
    expect(scoreWith(cfg, {}, true, 3).finalFan).toBe(3);
  });

  it('scoreDouble：无红中分数×2（推荐默认）；有红中不翻', () => {
    const cfg = bonusCfg('scoreDouble');
    expect(scoreWith(cfg, {}, false, 3).score).toBe(16); // 2^3 × 2
    expect(scoreWith(cfg, {}, true, 3).score).toBe(8);
    expect(scoreWith(cfg, {}, false, 3).meta.redCenterBonusApplied).toBe(true);
    expect(scoreWith(cfg, {}, true, 3).meta.redCenterBonusApplied).toBe(false);
  });

  it('none：无效果', () => {
    const cfg = bonusCfg('none');
    expect(scoreWith(cfg, {}, false, 3).finalFan).toBe(3);
    expect(scoreWith(cfg, {}, false, 3).score).toBe(8);
  });

  it('加成关闭时不生效', () => {
    const cfg = makeConfig('gd128', { bonusEnabled: false });
    expect(scoreWith(cfg, {}, false, 3).score).toBe(8);
  });
});

describe('验收 9：fanDouble 与封顶冲突', () => {
  it('fanDouble + capFan 3 + bypassCap=false：无实际加成', () => {
    const cfg = bonusCfg('fanDouble', false, 3);
    const s = scoreWith(cfg, {}, false, 3);
    // 3×2=6 → 封顶 3；与不加成（3→3）完全一致
    expect(s.finalFan).toBe(3);
    expect(s.score).toBe(8);
    expect(s.lines.find((l) => l.key === 'redCenterBonus')).toBeDefined();
    // 与 bonus 关闭时的分数一致
    const off = makeConfig('gd128', { bonusEnabled: false, capEnabled: false });
    off.scoring.cap = structuredClone(cfg.scoring.cap);
    expect(scoreWith(off, {}, false, 3).score).toBe(s.score);
  });

  it('启动校验对 fanDouble × 封顶组合告警', () => {
    const cfg = makeConfig('gd128', { bonusEnabled: true, bonusMode: 'fanDouble' });
    cfg.scoring.cap.enabled = true;
    const result = validateFanConfig(structuredCloneForValidate(cfg));
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.code === 'W_FAN_DOUBLE_CAP')).toBe(true);
  });
});

describe('PRD 6.4 运算顺序锁定（顺序敏感用例）', () => {
  it('bypassCap=false：加成在封顶前（会被封顶吃掉）；=true：封顶后（突破封顶）', () => {
    // cap 2 番，基础 2 番，addFan 1
    const before = bonusCfg('addFan', false, 2);
    const after = bonusCfg('addFan', true, 2);
    const sBefore = scoreWith(before, {}, false, 2);
    const sAfter = scoreWith(after, {}, false, 2);
    // false：2+1=3 → 封顶 2
    expect(sBefore.finalFan).toBe(2);
    // true：min(2,2)=2 → +1 = 3（突破 capFan）
    expect(sAfter.finalFan).toBe(3);
  });

  it('bypassCap=true 时 hardCap 仍然生效', () => {
    const cfg = bonusCfg('addFan', true, 2);
    cfg.scoring.cap.hardCap = 2; // hardCap 2 < 3
    const s = scoreWith(cfg, {}, false, 2);
    expect(s.finalFan).toBe(2);
    expect(s.meta.hardCapApplied).toBe(true);
  });

  it('scoreDouble 模式下分数在 maxScore 之前×2', () => {
    const cfg = bonusCfg('scoreDouble');
    cfg.scoring.cap.enabled = true;
    cfg.scoring.cap.value = { type: 'fixed', fixed: 3 };
    cfg.scoring.cap.maxScore = 10;
    const s = scoreWith(cfg, {}, false, 3);
    // 2^3=8 → ×2 = 16 → maxScore 10 截断
    expect(s.score).toBe(10);
    expect(s.meta.maxScoreApplied).toBe(true);
  });
});

describe('验收 10：无红中判定范围', () => {
  it('红中暗杠计入"有红中"（不加成）', () => {
    const cfg = bonusCfg('scoreDouble');
    const index = new TileIndex(cfg);
    const melds: MeldData[] = [{ type: 'ankang', tile: 'HR' }];
    // 暗杠占一副露：3×(4-1)+2 = 11 张手牌，无其他红中
    const ev = settleWin(cfg, index, {
      winnerSeat: 0,
      completingTile: 'C9',
      via: 'discard',
      concealedTiles: ['C1', 'C1', 'C1', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'B2', 'B2'],
      exposedMelds: melds,
      kongBlossom: false,
      seatWind: 'east',
      roundWind: 'east',
      dealer: false,
      kongCount: 1,
      wallTiles: 40,
      playerCount: 4,
      roomLevel: 1,
    });
    expect(ev.scoreResult.meta.hasRedCenter).toBe(true);
    expect(ev.scoreResult.meta.redCenterBonusApplied).toBe(false);
  });

  it('手牌含红中（万能牌在手）不加成', () => {
    const cfg = bonusCfg('scoreDouble');
    const index = new TileIndex(cfg);
    const ev = settleWin(cfg, index, {
      winnerSeat: 0,
      completingTile: 'C9',
      via: 'self',
      concealedTiles: ['C1', 'C1', 'C1', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'B2', 'B3', 'B4', 'C9', 'HR'],
      exposedMelds: [],
      kongBlossom: false,
      seatWind: 'east',
      roundWind: 'east',
      dealer: false,
      kongCount: 0,
      wallTiles: 40,
      playerCount: 4,
      roomLevel: 1,
    });
    expect(ev.scoreResult.meta.hasRedCenter).toBe(true);
    expect(ev.scoreResult.meta.redCenterBonusApplied).toBe(false);
  });

  it('弃牌区与他家副露的红中不影响判定（引擎只见胜者手牌+副露）', () => {
    const cfg = bonusCfg('scoreDouble');
    const index = new TileIndex(cfg);
    // 胜者手牌与副露均无红中
    const ev = settleWin(cfg, index, {
      winnerSeat: 0,
      completingTile: 'C9',
      via: 'discard',
      concealedTiles: ['C1', 'C1', 'C1', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'B2', 'B3', 'B4', 'C9', 'C9'],
      exposedMelds: [],
      kongBlossom: false,
      seatWind: 'east',
      roundWind: 'east',
      dealer: false,
      kongCount: 0,
      wallTiles: 40,
      playerCount: 4,
      roomLevel: 1,
    });
    expect(ev.scoreResult.meta.hasRedCenter).toBe(false);
    expect(ev.scoreResult.meta.redCenterBonusApplied).toBe(true);
  });

  it('他家副露含红中不影响胜者判定（副露传的是胜者自己的）', () => {
    const cfg = bonusCfg('scoreDouble');
    const index = new TileIndex(cfg);
    const melds: MeldData[] = [{ type: 'peng', tile: 'B5', fromSeat: 2 }];
    const ev = settleWin(cfg, index, {
      winnerSeat: 0,
      completingTile: 'C9',
      via: 'discard',
      concealedTiles: ['C1', 'C1', 'C1', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C9', 'C9'],
      exposedMelds: melds,
      kongBlossom: false,
      seatWind: 'east',
      roundWind: 'east',
      dealer: false,
      kongCount: 0,
      wallTiles: 40,
      playerCount: 4,
      roomLevel: 1,
    });
    expect(ev.scoreResult.meta.hasRedCenter).toBe(false);
  });
});

function structuredCloneForValidate(resolved) {
  // 从 resolved 反推可校验配置：resolved 自身满足 FanConfig 形状
  return JSON.parse(JSON.stringify({
    version: resolved.version,
    tileSet: resolved.tileSet,
    scoring: resolved.scoring,
    fans: resolved.fans.map((f) => ({ ...f })),
    bonusFans: resolved.bonusFans,
    rules: resolved.rules,
  }));
}
