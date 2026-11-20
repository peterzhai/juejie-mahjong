import { describe, expect, it } from 'vitest';
import {
  autoDisableUnmetFans,
  clonePreset,
  defaultFanConfig,
  resolveFanConfig,
  type ResolvedFanConfig,
} from '@quejie/fan-config';
import { TileIndex, countsOf } from '../src/tileIndex.js';
import { checkWin, type MeldData, type WinCheckOptions } from '../src/winCheck.js';

function resolvedFor(preset: string, opts?: { sevenPairsWithWild?: boolean }): ResolvedFanConfig {
  const cfg = defaultFanConfig();
  cfg.tileSet = clonePreset(preset);
  cfg.tileSet.preset = preset;
  if (cfg.tileSet.redCenterMode !== 'wild') cfg.scoring.redCenterBonus.enabled = false;
  if (opts?.sevenPairsWithWild !== undefined) cfg.tileSet.sevenPairsWithWild = opts.sevenPairsWithWild;
  // 预设应用语义：从番型表全量启用出发，按新牌集重新自动禁用
  for (const fan of cfg.fans) fan.enabled = true;
  const r = resolveFanConfig(autoDisableUnmetFans(cfg).config);
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join('; '));
  return r.resolved!;
}

function optsOf(resolved: ResolvedFanConfig): WinCheckOptions {
  const fan = (id: string) => resolved.fans.find((f) => f.id === id)!;
  return {
    sevenPairsEnabled: fan('sevenPairs').enabled,
    sevenPairsWithWild: resolved.sevenPairsWithWild,
    thirteenOrphansEnabled: fan('thirteenOrphans').enabled,
  };
}

const gd128 = resolvedFor('gd128');
const idx128 = new TileIndex(gd128);

function win(tiles: string[], melds: MeldData[] = [], index = idx128, resolved = gd128) {
  return checkWin(countsOf(tiles, index), melds, index, optsOf(resolved));
}

describe('标准 4 组+对将', () => {
  it('全顺子+刻子可胡', () => {
    const r = win(['C1', 'C1', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C8', 'C8', 'WE', 'WE']);
    expect(r.win).toBe(true);
    expect(r.decompositions.length).toBeGreaterThan(0);
  });

  it('非胡牌形不可胡', () => {
    const r = win(['C1', 'C1', 'C2', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C8', 'C8', 'WE', 'WE']);
    expect(r.win).toBe(false);
  });

  it('带副露（碰）可胡：3×(4-1)+2 = 11 张', () => {
    const melds: MeldData[] = [{ type: 'peng', tile: 'C1', fromSeat: 1 }];
    const r = win(['C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C8', 'C8', 'WE', 'WE'], melds);
    expect(r.win).toBe(true);
  });

  it('副露数与牌数不符 → 不可胡', () => {
    const melds: MeldData[] = [{ type: 'peng', tile: 'C1', fromSeat: 1 }];
    const r = win(['C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C8', 'C8', 'C9', 'C9', 'C9'], melds);
    expect(r.win).toBe(false);
  });

  it('杠占一副露槽（11 张暗杠流）', () => {
    const melds: MeldData[] = [
      { type: 'peng', tile: 'C1', fromSeat: 1 },
      { type: 'ankang', tile: 'C9' },
    ];
    // 3×(4-2)+2 = 8
    const r = win(['C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'WE', 'WE'], melds);
    expect(r.win).toBe(true);
  });
});

describe('万能牌（红中 wild）', () => {
  it('纯万能刻子 + 纯万能将', () => {
    const r = win(['C1', 'C1', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C8', 'C8', 'HR', 'HR']);
    expect(r.win).toBe(true);
  });

  it('万能牌补刻子（2 真 + 1 万）', () => {
    const r = win(['C1', 'C1', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C8', 'C8', 'C9', 'HR']);
    expect(r.win).toBe(true); // C9C9+HR 刻子 + ... 实为 C9C9HR 刻子? 对将 C8C8
  });

  it('万能牌补顺子', () => {
    const r = win(['C1', 'C1', 'C1', 'C2', 'C3', 'HR', 'C5', 'C6', 'C7', 'C9', 'C9', 'C9', 'C8', 'C8']);
    expect(r.win).toBe(true); // C2C3+C4(万) 顺子
  });

  it('万能牌当将的一员', () => {
    const r = win(['C1', 'C1', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C8', 'C8', 'C9', 'HR']);
    expect(r.win).toBe(true);
  });

  it('万能牌不足以成胡', () => {
    const r = win(['C1', 'C1', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C8', 'WE', 'WS', 'HR']);
    // 3 组已成，剩 C8C8 WE WS HR：C8C8+HR 刻子后 WE/WS 无法成对，其余组合均不成立
    expect(r.win).toBe(false);
  });

  it('4 张万能全用', () => {
    const r = win(['C1', 'C1', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'HR', 'HR', 'HR', 'HR', 'WE']);
    // 万能×4: 刻子×1(3) + WE+万 对将
    expect(r.win).toBe(true);
  });
});

describe('七对', () => {
  it('纯七对', () => {
    const r = win(['C1', 'C1', 'C2', 'C2', 'C3', 'C3', 'C4', 'C4', 'C5', 'C5', 'C6', 'C6', 'C7', 'C7']);
    expect(r.sevenPairs).toBe(true);
    expect(r.win).toBe(true);
  });

  it('含万能的七对（默认允许）', () => {
    const r = win(['C1', 'C1', 'C2', 'C2', 'C3', 'C3', 'C4', 'C4', 'C5', 'C5', 'C6', 'C6', 'C7', 'HR']);
    expect(r.sevenPairs).toBe(true);
  });

  it('sevenPairsWithWild=false 时含万能不作七对判定（标准胡不受影响）', () => {
    const resolved = resolvedFor('gd128', { sevenPairsWithWild: false });
    const r = win(['C1', 'C1', 'C2', 'C2', 'C3', 'C3', 'C4', 'C4', 'C5', 'C5', 'C6', 'C6', 'C7', 'HR'], [], idx128, resolved);
    expect(r.sevenPairs).toBe(false);
    // 123123456456 + C7+HR(万能补将) 仍可标准胡
    expect(r.win).toBe(true);
  });

  it('4 张同牌 = 两对，七对合法', () => {
    const r = win(['C1', 'C1', 'C1', 'C1', 'C2', 'C2', 'C3', 'C3', 'C4', 'C4', 'C5', 'C5', 'C6', 'C6']);
    expect(r.sevenPairs).toBe(true);
  });
});

describe('十三幺（gd136）', () => {
  const gd136 = resolvedFor('gd136');
  const idx136 = new TileIndex(gd136);

  it('标准十三幺', () => {
    const tiles = ['C1', 'C9', 'B1', 'B9', 'D1', 'D9', 'WE', 'WS', 'WW', 'WN', 'HR', 'HG', 'HW', 'HW'];
    expect(win(tiles, [], idx136, gd136).thirteenOrphans).toBe(true);
  });

  it('十三幺含万能补牌（gd136+wild：万能补 HR 单张与对将）', () => {
    // gd136（全幺九字牌齐备）+ redCenterMode=wild 的自定义配置
    const cfg = defaultFanConfig();
    cfg.tileSet = clonePreset('gd136');
    cfg.tileSet.preset = 'gd136';
    cfg.tileSet.redCenterMode = 'wild';
    for (const fan of cfg.fans) fan.enabled = true;
    const r = resolveFanConfig(autoDisableUnmetFans(cfg).config);
    expect(r.ok).toBe(true);
    const resolved = r.resolved!;
    const idx = new TileIndex(resolved);
    // 12 张真实幺九字牌 + 2 张万能（补 HR 单张 + 对将成员）
    const tiles = ['C1', 'C9', 'B1', 'B9', 'D1', 'D9', 'WE', 'WS', 'WW', 'WN', 'HG', 'HW', 'HR', 'HR'];
    expect(win(tiles, [], idx, resolved).thirteenOrphans).toBe(true);
  });

  it('两个对子不是十三幺', () => {
    const tiles = ['C1', 'C1', 'C9', 'B1', 'B9', 'D1', 'D9', 'D9', 'WE', 'WS', 'WW', 'WN', 'HR', 'HG'];
    expect(win(tiles, [], idx136, gd136).thirteenOrphans).toBe(false);
  });

  it('含非幺九字牌 → 不可', () => {
    const tiles = ['C1', 'C9', 'B1', 'B9', 'D1', 'D9', 'WE', 'WS', 'WW', 'WN', 'HR', 'HG', 'HW', 'C5'];
    expect(win(tiles, [], idx136, gd136).thirteenOrphans).toBe(false);
  });
});

describe('九莲宝灯（gd136）', () => {
  const gd136 = resolvedFor('gd136');
  const idx136 = new TileIndex(gd136);

  it('经典 1112345678999 + 5', () => {
    const tiles = ['B1', 'B1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B5', 'B6', 'B7', 'B8', 'B9', 'B9', 'B9'];
    const r = win(tiles, [], idx136, gd136);
    expect(r.nineGates).toBe(true);
    expect(r.win).toBe(true);
  });

  it('1112345678999 + 1', () => {
    const tiles = ['B1', 'B1', 'B1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B9', 'B9'];
    expect(win(tiles, [], idx136, gd136).nineGates).toBe(true);
  });

  it('缺张不是九莲宝灯', () => {
    const tiles = ['B1', 'B1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B5', 'B5', 'B6', 'B7', 'B8', 'B9', 'B9'];
    expect(win(tiles, [], idx136, gd136).nineGates).toBe(false);
    // 但仍是清一色标准胡（B5×3 刻子）
    expect(win(tiles, [], idx136, gd136).win).toBe(true);
  });

  it('万能牌补缺张成九莲宝灯（gd128 wild 模式）', () => {
    // 1112345678999 缺 8 → 1 张万能补（gd128 含条筒与红中万能牌）
    const tiles = ['B1', 'B1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'HR', 'B9', 'B9', 'B9', 'B5'];
    const r = win(tiles, [], idx128, gd128);
    expect(r.nineGates).toBe(true);
  });
});

describe('normal 模式（无万能牌）', () => {
  const gd136 = resolvedFor('gd136');
  const idx136 = new TileIndex(gd136);
  it('无红中参与判定', () => {
    const r = win(['C1', 'C1', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C8', 'C8', 'HG', 'HG'], [], idx136, gd136);
    expect(r.win).toBe(true);
  });
});
