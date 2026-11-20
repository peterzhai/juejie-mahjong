import { describe, expect, it } from 'vitest';
import {
  clonePreset,
  computeTileMath,
  defaultFanConfig,
  resolveFanConfig,
  TILE_SET_PRESETS,
  validateFanConfig,
} from '@quejie/fan-config';
import { buildWallTiles, Wall } from '@quejie/mahjong-core';
import { configForPreset } from './helpers.js';

describe('验收 1：9 套预设张数黄金值', () => {
  const EXPECTED: Record<string, { total: number; deal: number; wall: number; dead: number }> = {
    gd100: { total: 100, deal: 53, wall: 47, dead: 8 },
    gd108: { total: 108, deal: 53, wall: 55, dead: 9 },
    gd112: { total: 112, deal: 53, wall: 59, dead: 9 },
    gd116: { total: 116, deal: 53, wall: 63, dead: 10 },
    gd120: { total: 120, deal: 53, wall: 67, dead: 11 },
    gd124: { total: 124, deal: 53, wall: 71, dead: 11 },
    gd128: { total: 128, deal: 53, wall: 75, dead: 12 },
    gd136: { total: 136, deal: 53, wall: 83, dead: 13 },
    gd144: { total: 144, deal: 53, wall: 91, dead: 14 },
  };

  it('预设表共 9 套', () => {
    expect(Object.keys(TILE_SET_PRESETS).sort()).toEqual(
      ['gd100', 'gd108', 'gd112', 'gd116', 'gd120', 'gd124', 'gd128', 'gd136', 'gd144'],
    );
  });

  for (const [id, exp] of Object.entries(EXPECTED)) {
    it(`${id}: total=${exp.total} deal=${exp.deal} wall=${exp.wall} deadWall=${exp.dead}`, () => {
      const preset = TILE_SET_PRESETS[id]!;
      const math = computeTileMath(preset);
      expect(math.totalTiles).toBe(exp.total);
      expect(math.dealTiles).toBe(exp.deal);
      expect(math.wallTiles).toBe(exp.wall);
      expect(math.deadWallCount).toBe(exp.dead);
      // wallTiles > deadWallCount + 1
      expect(math.wallTiles).toBeGreaterThan(math.deadWallCount + 1);
    });
  }
});

describe('验收 2：copies 改为 3/5 动态变化', () => {
  it('条 copies=5：总张数/牌墙同步变化且可建墙（条=9 种牌面 ×5）', () => {
    const cfg = configForPreset('gd128');
    cfg.tileSet.suits.bamboo.copies = 5;
    const math = computeTileMath(cfg.tileSet);
    expect(math.totalTiles).toBe(137); // 128 + 9
    expect(math.wallTiles).toBe(84);
    const r = resolveFanConfig(cfg);
    expect(r.ok).toBe(true);
    const wall = new Wall(r.resolved!, 42);
    // 先发 53 张（4×13+庄家 1），再验证牌墙余量
    for (let i = 0; i < 53; i++) expect(wall.drawFromHead()).not.toBeNull();
    expect(wall.liveRemaining).toBe(84);
    expect(wall.drawFromHead()).not.toBeNull();
  });

  it('条 copies=3：总张数/牌墙同步变化且引擎不崩溃', () => {
    const cfg = configForPreset('gd128');
    cfg.tileSet.suits.bamboo.copies = 3;
    const math = computeTileMath(cfg.tileSet);
    expect(math.totalTiles).toBe(119); // 128 - 9
    expect(math.wallTiles).toBe(66);
    const r = resolveFanConfig(cfg);
    expect(r.ok).toBe(true);
    const wall = new Wall(r.resolved!, 7);
    for (let i = 0; i < 53; i++) expect(wall.drawFromHead()).not.toBeNull();
    for (let i = 0; i < 20; i++) expect(wall.drawFromHead()).not.toBeNull();
    expect(wall.drawFromTail()).not.toBeNull();
    expect(wall.liveRemaining).toBe(66 - 21);
  });

  it('buildWallTiles 与 tileMath 一致（实体牌 = 总张数）', () => {
    for (const id of Object.keys(TILE_SET_PRESETS)) {
      const cfg = configForPreset(id);
      const r = resolveFanConfig(cfg, { strictDependency: false });
      if (!r.ok) continue; // gd144 花牌被拒，在数学测试中单独覆盖
      expect(buildWallTiles(r.resolved!).length).toBe(computeTileMath(r.resolved!.tileSet).totalTiles);
    }
  });
});

describe('验收辅助：墙约束与不足开局', () => {
  it('牌墙过小启动报错（wallTiles ≤ deadWallCount+1）', () => {
    const cfg = configForPreset('gd128');
    // 条36 + 筒18 + 红中4 = 58，deal 53 → wall 5 ≤ deadWall(7)+1
    cfg.tileSet = {
      ...clonePreset('gd128'),
      suits: {
        character: { enabled: false, copies: 0 },
        bamboo: { enabled: true, copies: 4 },
        dot: { enabled: true, copies: 2 },
      },
      honors: {
        east: { enabled: false, copies: 0 },
        south: { enabled: false, copies: 0 },
        west: { enabled: false, copies: 0 },
        north: { enabled: false, copies: 0 },
        red: { enabled: true, copies: 4 },
        green: { enabled: false, copies: 0 },
        white: { enabled: false, copies: 0 },
      },
    };
    const result = validateFanConfig(cfg, { strictDependency: false });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'E_WALL_TOO_SMALL')).toBe(true);
  });

  it('总张数不足开局报错', () => {
    const cfg = configForPreset('gd128');
    // 万4 + 条9 + 筒9 + 风红20 = 42 < 53
    cfg.tileSet.suits.character.copies = 1;
    cfg.tileSet.suits.bamboo.copies = 1;
    cfg.tileSet.suits.dot.copies = 1;
    const result = validateFanConfig(cfg, { strictDependency: false });
    expect(result.errors.some((e) => e.code === 'E_TILES_INSUFFICIENT')).toBe(true);
  });

  it('gd144 花牌预设：张数核算正确，但正式校验拒绝（v0.2 预留）', () => {
    const preset = TILE_SET_PRESETS['gd144']!;
    const math = computeTileMath(preset);
    expect(math.totalTiles).toBe(144);
    expect(math.wallTiles).toBe(91);
    const result = validateFanConfig(configForPreset('gd144'), { strictDependency: false });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'E_FLOWERS_RESERVED')).toBe(true);
  });
});

describe('验收 5 前置：红中一致性校验', () => {
  it('redCenterMode="wild" 但红中关闭 → 报错', () => {
    const cfg = configForPreset('gd128');
    cfg.tileSet.honors.red = { enabled: false, copies: 0 };
    const result = validateFanConfig(cfg, { strictDependency: false });
    expect(result.errors.some((e) => e.code === 'E_WILD_NEEDS_RED')).toBe(true);
  });

  it('redCenterMode="off" 但红中启用 → 报错', () => {
    const cfg = configForPreset('gd108');
    cfg.tileSet.honors.red = { enabled: true, copies: 4 };
    const result = validateFanConfig(cfg, { strictDependency: false });
    expect(result.errors.some((e) => e.code === 'E_OFF_WITH_RED')).toBe(true);
  });

  it('redCenterMode="normal" 时启用 redCenterBonus → 被拒（验收 5）', () => {
    const cfg = configForPreset('gd136');
    cfg.scoring.redCenterBonus.enabled = true;
    const result = validateFanConfig(cfg, { strictDependency: false });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'E_BONUS_NEEDS_WILD')).toBe(true);
  });

  it('redCenterMode="off" 时启用 redCenterBonus → 被拒', () => {
    const cfg = configForPreset('gd108');
    cfg.scoring.redCenterBonus.enabled = true;
    const result = validateFanConfig(cfg, { strictDependency: false });
    expect(result.errors.some((e) => e.code === 'E_BONUS_NEEDS_WILD')).toBe(true);
  });

  it('wild + redCenterBonus 启用 → 通过', () => {
    const cfg = configForPreset('gd128');
    const result = validateFanConfig(cfg);
    expect(result.ok).toBe(true);
  });
});

describe('默认配置自洽', () => {
  it('defaultFanConfig 通过完整校验（含十三幺自动禁用）', () => {
    const cfg = defaultFanConfig();
    expect(cfg.tileSet.preset).toBe('gd128');
    const result = validateFanConfig(cfg);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    const thirteen = cfg.fans.find((f) => f.id === 'thirteenOrphans');
    expect(thirteen?.enabled).toBe(false);
    const bigDragons = cfg.fans.find((f) => f.id === 'bigDragons');
    expect(bigDragons?.enabled).toBe(false);
  });

  it('默认配置可解析出 resolvedFanConfig', () => {
    const r = resolveFanConfig(defaultFanConfig());
    expect(r.ok).toBe(true);
    expect(r.resolved!.wildcardTile).toBe('HR');
    expect(r.resolved!.tileSetPresetId).toBe('gd128');
    expect(r.resolved!.resolvedFanConfigHash).toMatch(/^[0-9a-f]{8}$/);
    expect(r.resolved!.configHash).toMatch(/^[0-9a-f]{8}$/);
  });
});
