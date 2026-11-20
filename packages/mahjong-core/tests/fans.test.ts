/** P4：番型正反例全覆盖（cap 关闭以便观察裸番数） */

import { describe, expect, it } from 'vitest';
import type { ResolvedFanConfig } from '@quejie/fan-config';
import { settleWin, type WinEvaluation } from '../src/settle.js';
import { TileIndex } from '../src/tileIndex.js';
import type { MeldData } from '../src/winCheck.js';
import { makeConfig } from './helpers.js';

const gd136: ResolvedFanConfig = makeConfig('gd136');
const gd128: ResolvedFanConfig = makeConfig('gd128');

function evalHand(
  resolved: ResolvedFanConfig,
  tiles: string[],
  melds: MeldData[] = [],
  via: 'self' | 'discard' | 'robKong' = 'discard',
  extra: Record<string, unknown> = {},
): WinEvaluation {
  const index = new TileIndex(resolved);
  return settleWin(resolved, index, {
    winnerSeat: 0,
    completingTile: tiles[tiles.length - 1]!,
    via,
    concealedTiles: tiles,
    exposedMelds: melds,
    kongBlossom: false,
    seatWind: 'east',
    roundWind: 'east',
    dealer: false,
    kongCount: 0,
    wallTiles: 40,
    playerCount: 4,
    roomLevel: 1,
    ...extra,
  } as never);
}

const hasFan = (ev: WinEvaluation, id: string) => ev.fanEval.matched.some((m) => m.fanId === id);
const fanValue = (ev: WinEvaluation, id: string) => ev.fanEval.matched.find((m) => m.fanId === id)?.value;

describe('结构类番型正反例', () => {
  it('平胡：全顺子（正例）', () => {
    const ev = evalHand(gd136, ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'D1', 'D2', 'D3', 'D9', 'D9']);
    expect(hasFan(ev, 'allSequences')).toBe(true);
    expect(ev.finalFan).toBe(1);
  });

  it('平胡反例：含刻子则不命中', () => {
    const ev = evalHand(gd136, ['C1', 'C1', 'C1', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'D1', 'D2', 'D3', 'D9', 'D9']);
    expect(hasFan(ev, 'allSequences')).toBe(false);
    expect(ev.fanEval.chickenApplied).toBe(true);
    expect(ev.finalFan).toBe(0);
  });

  it('碰碰胡（正例 2 番）', () => {
    const ev = evalHand(gd136, ['C1', 'C1', 'C1', 'C4', 'C4', 'C4', 'C7', 'C7', 'C7', 'D2', 'D2', 'D2', 'WE', 'WE']);
    expect(hasFan(ev, 'allTriplets')).toBe(true);
    expect(ev.finalFan).toBe(2);
  });

  it('碰碰胡反例：混顺子不命中（鸡胡 0 番）', () => {
    const ev = evalHand(gd136, ['C1', 'C1', 'C1', 'C2', 'C3', 'C4', 'C7', 'C7', 'C7', 'D2', 'D2', 'D2', 'WE', 'WE']);
    expect(hasFan(ev, 'allTriplets')).toBe(false);
    expect(ev.finalFan).toBe(0);
    expect(ev.score).toBe(1); // baseScore 1 × 2^0
  });

  it('鸡胡为兜底：任何胡牌至少命中', () => {
    const ev = evalHand(gd136, ['C1', 'C1', 'C1', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'D1', 'D2', 'D3', 'WE', 'WE']);
    expect(ev.fanEval.chickenApplied).toBe(true);
    expect(hasFan(ev, 'chicken')).toBe(true);
    expect(ev.finalFan).toBe(0);
  });
});

describe('花色类番型', () => {
  it('混一色（2 番）与清一色（3 番）', () => {
    const half = evalHand(gd136, ['B1', 'B1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B7', 'B8', 'B9', 'WE', 'WE']);
    expect(hasFan(half, 'halfFlush')).toBe(true);
    expect(half.finalFan).toBe(2);

    const full = evalHand(gd136, ['B1', 'B1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B8', 'B8', 'B9', 'B9']);
    expect(hasFan(full, 'fullFlush')).toBe(true);
    expect(full.finalFan).toBe(3);
  });

  it('混一色反例：两种花色不命中', () => {
    const ev = evalHand(gd136, ['B1', 'B1', 'B1', 'B2', 'B3', 'B4', 'D5', 'D6', 'D7', 'D1', 'D2', 'D3', 'WE', 'WE']);
    expect(hasFan(ev, 'halfFlush')).toBe(false);
    expect(hasFan(ev, 'fullFlush')).toBe(false);
  });

  it('混碰（3 番）与清碰（4 番）', () => {
    const half = evalHand(gd136, ['B1', 'B1', 'B1', 'B4', 'B4', 'B4', 'B7', 'B7', 'B7', 'WE', 'WE', 'WE', 'HG', 'HG']);
    expect(hasFan(half, 'halfFlushTriplets')).toBe(true);
    expect(half.finalFan).toBe(3);
    // exclusiveGroup=flush：halfFlush(2) 被压制
    expect(half.fanEval.suppressed.some((m) => m.fanId === 'halfFlush')).toBe(true);

    const full = evalHand(gd136, ['B1', 'B1', 'B1', 'B4', 'B4', 'B4', 'B7', 'B7', 'B7', 'B9', 'B9', 'B9', 'B2', 'B2']);
    expect(hasFan(full, 'fullFlushTriplets')).toBe(true);
    expect(full.finalFan).toBe(4);
  });
});

describe('幺九类番型', () => {
  it('混幺九（4 番）', () => {
    const ev = evalHand(gd136, ['C1', 'C1', 'C1', 'C9', 'C9', 'C9', 'WE', 'WE', 'WE', 'HR', 'HR', 'HR', 'B9', 'B9']);
    expect(hasFan(ev, 'mixedTerminals')).toBe(true);
    expect(ev.finalFan).toBe(4);
  });

  it('清幺九（5 番）', () => {
    const ev = evalHand(gd136, ['C1', 'C1', 'C1', 'C9', 'C9', 'C9', 'B1', 'B1', 'B1', 'B9', 'B9', 'B9', 'D9', 'D9']);
    expect(hasFan(ev, 'allTerminals')).toBe(true);
    expect(ev.finalFan).toBe(5);
  });

  it('混幺九反例：纯字牌（字一色而非混幺九）', () => {
    const ev = evalHand(gd136, ['WE', 'WE', 'WE', 'WS', 'WS', 'WS', 'WW', 'WW', 'WW', 'HR', 'HR', 'HR', 'HG', 'HG']);
    expect(hasFan(ev, 'mixedTerminals')).toBe(false);
    expect(hasFan(ev, 'allHonors')).toBe(true);
    expect(ev.finalFan).toBe(5);
  });
});

describe('字牌类番型', () => {
  it('小三元（5 番）', () => {
    const ev = evalHand(gd136, ['HG', 'HG', 'HG', 'HW', 'HW', 'HW', 'C1', 'C1', 'C1', 'C9', 'C9', 'C9', 'HR', 'HR']);
    expect(hasFan(ev, 'smallDragons')).toBe(true);
    expect(ev.finalFan).toBe(5);
  });

  it('大三元（6 番）', () => {
    const ev = evalHand(gd136, ['HG', 'HG', 'HG', 'HW', 'HW', 'HW', 'HR', 'HR', 'HR', 'C1', 'C1', 'C1', 'C9', 'C9']);
    expect(hasFan(ev, 'bigDragons')).toBe(true);
    expect(ev.finalFan).toBe(6);
  });

  it('小四喜（5 番）与大四喜（6 番）', () => {
    const small = evalHand(gd136, ['WE', 'WE', 'WE', 'WS', 'WS', 'WS', 'WW', 'WW', 'WW', 'C1', 'C1', 'C1', 'WN', 'WN']);
    expect(hasFan(small, 'smallWinds')).toBe(true);
    expect(small.finalFan).toBe(5);

    const big = evalHand(gd136, ['WE', 'WE', 'WE', 'WS', 'WS', 'WS', 'WW', 'WW', 'WW', 'WN', 'WN', 'WN', 'HR', 'HR']);
    expect(hasFan(big, 'bigWinds')).toBe(true);
    expect(big.finalFan).toBe(6);
  });

  it('字一色（5 番）', () => {
    const ev = evalHand(gd136, ['WE', 'WE', 'WE', 'WS', 'WS', 'WS', 'WW', 'WW', 'WW', 'HR', 'HR', 'HR', 'HG', 'HG']);
    expect(hasFan(ev, 'allHonors')).toBe(true);
    expect(ev.finalFan).toBe(5);
    expect(hasFan(ev, 'bigWinds')).toBe(false);
  });
});

describe('特殊结构番型', () => {
  it('七对（2 番）', () => {
    const ev = evalHand(gd136, ['C1', 'C1', 'C2', 'C2', 'C4', 'C4', 'C5', 'C5', 'C7', 'C7', 'D1', 'D1', 'D9', 'D9']);
    expect(hasFan(ev, 'sevenPairs')).toBe(true);
    expect(ev.structureKind).toBe('sevenPairs');
    expect(ev.finalFan).toBe(2);
  });

  it('七对反例：非对子结构', () => {
    const ev = evalHand(gd136, ['C1', 'C1', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C8', 'C8', 'D1', 'D1']);
    expect(hasFan(ev, 'sevenPairs')).toBe(false);
  });

  it('七对与平胡重叠：按最优得分选择结构（七对 2 > 平胡 1）', () => {
    // 混花色 112233445566 + 99：可七对也可全顺子，无清一色干扰
    const ev = evalHand(gd136, ['C1', 'C1', 'C2', 'C2', 'C3', 'C3', 'C4', 'C4', 'C5', 'C5', 'C6', 'C6', 'D9', 'D9']);
    // 跨结构重叠由“最优分解得分”裁决；同一分解内的互斥由 exclusiveGroup 裁决
    expect(ev.fanEval.matched.some((m) => m.fanId === 'sevenPairs')).toBe(true);
    expect(ev.finalFan).toBe(2);
    expect(ev.score).toBe(4);
  });

  it('十三幺（8 番）', () => {
    const ev = evalHand(gd136, ['C1', 'C9', 'B1', 'B9', 'D1', 'D9', 'WE', 'WS', 'WW', 'WN', 'HR', 'HG', 'HW', 'HW']);
    expect(hasFan(ev, 'thirteenOrphans')).toBe(true);
    expect(ev.structureKind).toBe('thirteenOrphans');
    expect(ev.finalFan).toBe(8);
  });

  it('十三幺反例：两个对子不构成胡牌形', () => {
    expect(() =>
      evalHand(gd136, ['C1', 'C1', 'C9', 'B1', 'B9', 'D1', 'D9', 'D9', 'WE', 'WS', 'WW', 'WN', 'HR', 'HG']),
    ).toThrowError(/不构成胡牌形/);
  });

  it('九莲宝灯（6 番）', () => {
    const ev = evalHand(gd136, ['B1', 'B1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B5', 'B6', 'B7', 'B8', 'B9', 'B9', 'B9']);
    expect(hasFan(ev, 'nineGates')).toBe(true);
    expect(ev.finalFan).toBe(6);
    // 清一色同时命中，取最高
    expect(hasFan(ev, 'fullFlush')).toBe(true);
  });
});

describe('附加番', () => {
  it('自摸 +1', () => {
    const cfg = makeConfig('gd136', { bonusFansOn: true });
    const ev = evalHand(cfg, ['C1', 'C1', 'C1', 'C4', 'C4', 'C4', 'C7', 'C7', 'C7', 'D2', 'D2', 'D2', 'WE', 'WE'], [], 'self');
    expect(ev.fanEval.bonus.some((b) => b.fanId === 'selfDraw')).toBe(true);
    expect(ev.finalFan).toBe(3); // 碰碰胡 2 + 自摸 1
  });

  it('门风刻 + 圈风刻（东风位东风圈）', () => {
    const cfg = makeConfig('gd136', { bonusFansOn: true });
    const ev = evalHand(cfg, ['WE', 'WE', 'WE', 'WS', 'WS', 'WS', 'WW', 'WW', 'WW', 'WN', 'WN', 'WN', 'HR', 'HR'], [], 'discard', {
      seatWind: 'east',
      roundWind: 'east',
    });
    expect(ev.fanEval.bonus.find((b) => b.fanId === 'seatWindTriplet')).toBeDefined();
    expect(ev.fanEval.bonus.find((b) => b.fanId === 'roundWindTriplet')).toBeDefined();
    // 大四喜 6 + 门风 1 + 圈风 1 = 8
    expect(ev.finalFan).toBe(8);
  });

  it('箭牌刻按刻数叠加', () => {
    const cfg = makeConfig('gd136', { bonusFansOn: true });
    const ev = evalHand(cfg, ['HG', 'HG', 'HG', 'HW', 'HW', 'HW', 'HR', 'HR', 'HR', 'C1', 'C1', 'C1', 'C9', 'C9']);
    expect(ev.fanEval.bonus.find((b) => b.fanId === 'dragonTriplet')?.count).toBe(3);
    // 大三元 6 + 箭牌刻 3 = 9
    expect(ev.finalFan).toBe(9);
  });
});

describe('计分模式 max vs additive', () => {
  it('max：取最高番型', () => {
    const maxCfg = makeConfig('gd136', { scoringMode: 'max' });
    const ev = evalHand(maxCfg, ['B1', 'B1', 'B1', 'B4', 'B4', 'B4', 'B7', 'B7', 'B7', 'WE', 'WE', 'WE', 'HG', 'HG']);
    // 混碰 3 与 混一色 2 同组互斥 → 只计混碰；碰碰胡 2 独立 → max(3,2)=3
    expect(ev.fanEval.baseFan).toBe(3);
  });

  it('additive：叠加后取和', () => {
    const addCfg = makeConfig('gd136', { scoringMode: 'additive' });
    const ev = evalHand(addCfg, ['B1', 'B1', 'B1', 'B4', 'B4', 'B4', 'B7', 'B7', 'B7', 'WE', 'WE', 'WE', 'HG', 'HG']);
    // 混碰 3（同组互斥仍生效，混一色 2 被压制）+ 碰碰胡 2 = 5
    expect(ev.fanEval.baseFan).toBe(5);
    expect(ev.fanEval.suppressed.some((m) => m.fanId === 'halfFlush')).toBe(true);
  });
});

describe('万能牌下的番型（gd128 wild）', () => {
  it('万能牌补顺子仍可判平胡之外的基础胡', () => {
    const ev = evalHand(gd128, ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C9', 'C9', 'HR', 'HR', 'HR']);
    expect(ev.finalFan).toBeGreaterThanOrEqual(0);
    expect(ev.score).toBeGreaterThan(0);
  });

  it('万能牌指派为字牌刻（大三元）需要字牌在牌集——gd128 缺发白不可判', () => {
    // gd128 无发白：即便 3 张万能指派为发/白，大三元依赖校验禁用 → 不命中
    const cfg = makeConfig('gd128');
    const ev = evalHand(cfg, ['C1', 'C1', 'C1', 'C9', 'C9', 'C9', 'B1', 'B1', 'B1', 'B9', 'B9', 'B9', 'HR', 'HR']);
    expect(hasFan(ev, 'bigDragons')).toBe(false);
    // 碰碰胡仍命中
    expect(hasFan(ev, 'allTriplets')).toBe(true);
  });

  it('自定义 gd136+wild：万能刻子指派为大三元', () => {
    const cfg = makeConfig('gd136');
    cfg.redCenterMode = 'wild';
    cfg.wildcardTile = 'HR';
    const index = new TileIndex(cfg);
    const ev = settleWin(cfg, index, {
      winnerSeat: 0,
      completingTile: 'C9',
      via: 'discard',
      concealedTiles: ['HG', 'HG', 'HG', 'HW', 'HW', 'HW', 'C1', 'C1', 'C1', 'C9', 'C9', 'HR', 'HR', 'HR'],
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
    expect(hasFan(ev, 'bigDragons')).toBe(true);
    expect(ev.finalFan).toBe(6);
  });

  it('清一色七对：七对 + 清一色同时命中', () => {
    const ev = evalHand(gd136, ['B1', 'B1', 'B2', 'B2', 'B4', 'B4', 'B5', 'B5', 'B7', 'B7', 'B8', 'B8', 'B9', 'B9']);
    expect(hasFan(ev, 'sevenPairs')).toBe(true);
    expect(hasFan(ev, 'fullFlush')).toBe(true);
    expect(ev.finalFan).toBe(3);
  });
});

describe('红中万能牌约束（wild 模式）', () => {
  it('无红中加成判定不含弃牌区与他家副露（settle 只看胜者牌）', () => {
    // 构造：胜者手牌无 HR → hasRed=false
    const cfg = makeConfig('gd128', { bonusEnabled: true, bonusMode: 'scoreDouble' });
    const index = new TileIndex(cfg);
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
    expect(ev.score).toBe(2); // 鸡胡 0 番 → 1 分 ×2
  });
});
