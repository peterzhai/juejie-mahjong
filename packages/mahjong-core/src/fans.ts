/** 番型识别（PRD 5.5）：结构组 + 真实牌统计，万能牌按最优指派枚举 */

import type { ResolvedFanConfig, TileId } from '@quejie/fan-config';
import { isHonorTile, isOrphanTile, isTerminalTile, tileDef } from '@quejie/fan-config';
import type { TileIndex } from './tileIndex.js';
import type { MeldData, WinCheckResult } from './winCheck.js';

export interface ScoreContext {
  selfDraw: boolean;
  kongBlossom: boolean;
  robbingKong: boolean;
  seatWind: string; // 'east' | 'south' | 'west' | 'north'
  roundWind: string;
}

export interface ConcreteGroup {
  kind: 'triplet' | 'sequence' | 'pair';
  /** null = 纯万能组（或红中暗杠），需指派具体牌型 */
  tile: TileId | null;
  wildCount: number;
  exposed?: boolean;
}

export interface HandStructure {
  groups: ConcreteGroup[];
  /** 非万能真实牌（万能牌视为可指派任意牌型，花色判定用真实牌做下界） */
  realTiles: TileId[];
  wildCount: number;
  structural: { sevenPairs?: boolean; thirteenOrphans?: boolean; nineGates?: boolean };
}

export interface FanMatch {
  fanId: string;
  name: string;
  value: number;
  exclusiveGroup?: string;
}

export interface BonusMatch {
  fanId: string;
  name: string;
  value: number;
  count?: number;
}

export interface FanEvaluation {
  matched: FanMatch[];
  suppressed: FanMatch[];
  chickenApplied: boolean;
  bonus: BonusMatch[];
  bestFanId: string;
  baseFan: number;
  afterBonusFan: number;
}

const DRAGON_TILES = ['HR', 'HG', 'HW'] as const;
const WIND_TILES = ['WE', 'WS', 'WW', 'WN'] as const;
const SUIT_VALUES = new Set(['character', 'bamboo', 'dot']);

/** 从 WinCheckResult、 concealed 牌与副露构建全部结构（标准分解 / 七对 / 十三幺） */
export function buildStructures(
  winCheck: WinCheckResult,
  concealedTiles: TileId[],
  exposedMelds: MeldData[],
  index: TileIndex,
): HandStructure[] {
  const out: HandStructure[] = [];
  const wildTile = index.wildcardTile;

  // 副露 → 组（红中暗杠 → 纯万能组）
  const exposedGroups: ConcreteGroup[] = exposedMelds.map((m) => {
    if (wildTile !== null && m.tile === wildTile) {
      return { kind: 'triplet', tile: null, wildCount: 3, exposed: true };
    }
    return { kind: 'triplet', tile: m.tile, wildCount: 0, exposed: true };
  });

  for (const d of winCheck.decompositions) {
    const groups: ConcreteGroup[] = [
      ...exposedGroups,
      ...d.melds.map((m) => ({ kind: m.kind, tile: m.tile, wildCount: m.wildCount })),
      { kind: 'pair', tile: d.pair.tile, wildCount: d.pair.wildCount },
    ];
    out.push({
      groups,
      realTiles: realTilesOf(groups),
      wildCount: groups.reduce((a, g) => a + g.wildCount, 0),
      structural: { nineGates: winCheck.nineGates },
    });
  }

  if (winCheck.sevenPairs) {
    out.push(sevenPairsStructure(concealedTiles, index));
  }
  if (winCheck.thirteenOrphans) {
    const realTiles = concealedTiles.filter((t) => wildTile === null || t !== wildTile);
    out.push({
      groups: [],
      realTiles,
      wildCount: concealedTiles.length - realTiles.length,
      structural: { thirteenOrphans: true },
    });
  }

  void wildTile;
  return out;
}

function realTilesOf(groups: ConcreteGroup[]): TileId[] {
  const real: TileId[] = [];
  for (const g of groups) {
    if (g.tile === null) continue;
    const phys = (g.kind === 'pair' ? 2 : 3) - g.wildCount;
    for (let i = 0; i < phys; i++) real.push(g.tile);
  }
  return real;
}

/** 七对结构：真实对子 + 万能配对（real+wild → tile=real；wild+wild → tile=null） */
export function sevenPairsStructure(concealedTiles: TileId[], index: TileIndex): HandStructure {
  const wildTile = index.wildcardTile;
  const groups: ConcreteGroup[] = [];
  const realTiles: TileId[] = [];
  const counts = new Map<TileId, number>();
  for (const t of concealedTiles) counts.set(t, (counts.get(t) ?? 0) + 1);

  let wildPool = 0;
  const oddSingles: TileId[] = [];
  for (const [id, c] of counts) {
    if (wildTile !== null && id === wildTile) {
      wildPool = c;
      continue;
    }
    for (let i = 0; i < Math.floor(c / 2); i++) {
      groups.push({ kind: 'pair', tile: id, wildCount: 0 });
      realTiles.push(id, id);
    }
    if (c % 2 === 1) oddSingles.push(id);
  }
  // 奇数单张与万能牌配对
  for (const id of oddSingles) {
    if (wildPool <= 0) break; // checkWin 已保证可行性
    wildPool--;
    groups.push({ kind: 'pair', tile: id, wildCount: 1 });
    realTiles.push(id);
  }
  // 剩余万能牌组成纯万能对
  while (wildPool >= 2) {
    wildPool -= 2;
    groups.push({ kind: 'pair', tile: null, wildCount: 2 });
  }
  return {
    groups,
    realTiles,
    wildCount: concealedTiles.length - realTiles.length,
    structural: { sevenPairs: true },
  };
}

/** 枚举 null 槽位的具体牌型指派 */
export function enumerateAssignments(structure: HandStructure, index: TileIndex): TileId[][] {
  const nullSlots = structure.groups.filter((g) => g.tile === null).length;
  const results: TileId[][] = [];
  const rec = (depth: number, acc: TileId[]): void => {
    if (depth === nullSlots) {
      results.push([...acc]);
      return;
    }
    for (const id of index.ids) {
      acc.push(id);
      rec(depth + 1, acc);
      acc.pop();
    }
  };
  rec(0, []);
  if (results.length === 0) results.push([]);
  return results;
}

/** 对一个结构 + 指派组合做番型判定 */
export function detectFans(
  resolved: ResolvedFanConfig,
  s: HandStructure,
  assignments: TileId[],
  ctx: ScoreContext,
): FanEvaluation {
  let ai = 0;
  const groups: ConcreteGroup[] = s.groups.map((g) =>
    g.tile === null ? { ...g, tile: assignments[ai++]! } : g,
  );

  const matched: FanMatch[] = [];
  const suppressed: FanMatch[] = [];
  const bonus: BonusMatch[] = [];
  const enabledFan = (id: string) => {
    const f = resolved.fans.find((x) => x.id === id);
    return f && f.enabled && f.available ? f : null;
  };
  const add = (id: string): void => {
    const f = enabledFan(id);
    if (!f) return;
    if (f.onlyWhenWild && resolved.redCenterMode !== 'wild') return;
    matched.push({ fanId: f.id, name: f.name, value: f.value, exclusiveGroup: f.exclusiveGroup });
  };

  // 结构番型
  if (s.structural.thirteenOrphans) add('thirteenOrphans');
  if (s.structural.sevenPairs) add('sevenPairs');
  if (s.structural.nineGates) add('nineGates');

  // 真实牌统计
  const realSuits = new Set(
    s.realTiles.map((t) => tileDef(t).suit).filter((x) => SUIT_VALUES.has(x)),
  );
  const realHonorAny = s.realTiles.some((t) => isHonorTile(t));
  const realAllOrphan = s.realTiles.every((t) => isOrphanTile(t));
  const realAllTerminal = s.realTiles.every((t) => isTerminalTile(t));
  const realTerminalAny = s.realTiles.some((t) => isTerminalTile(t));

  const meldGroups = groups.filter((g) => g.kind !== 'pair');
  const pairTile = groups.find((g) => g.kind === 'pair')?.tile ?? null;
  const allSeq = meldGroups.length > 0 && meldGroups.every((g) => g.kind === 'sequence');
  const allTri = meldGroups.length > 0 && meldGroups.every((g) => g.kind === 'triplet');
  const tripletOf = (t: string): number =>
    meldGroups.filter((g) => g.kind === 'triplet' && g.tile === t).length;
  const wilds = s.wildCount;
  const isSpecial = s.structural.sevenPairs === true || s.structural.thirteenOrphans === true;

  if (!s.structural.thirteenOrphans) {
    // 花色类（七对也可配清一色/混一色）
    const suitsOk = realSuits.size === 1 || (realSuits.size === 0 && wilds > 0);
    if (suitsOk && !realHonorAny) add('fullFlush');
    if (suitsOk && realHonorAny) add('halfFlush');
    if (allTri && suitsOk && !realHonorAny) add('fullFlushTriplets');
    if (allTri && suitsOk && realHonorAny) add('halfFlushTriplets');

    if (!isSpecial) {
      if (allSeq) add('allSequences');
      if (allTri) add('allTriplets');
      if (allTri && realAllOrphan && (realHonorAny || wilds > 0) && (realTerminalAny || wilds > 0)) {
        add('mixedTerminals');
      }
      if (allTri && realAllTerminal && !realHonorAny) add('allTerminals');

      const dragonTriplets = DRAGON_TILES.reduce((n, t) => n + tripletOf(t), 0);
      const windTriplets = WIND_TILES.reduce((n, t) => n + tripletOf(t), 0);
      if (dragonTriplets >= 3) add('bigDragons');
      if (dragonTriplets === 2 && pairTile !== null && DRAGON_TILES.includes(pairTile as 'HR')) {
        add('smallDragons');
      }
      if (windTriplets >= 4) add('bigWinds');
      if (windTriplets === 3 && pairTile !== null && WIND_TILES.includes(pairTile as 'WE')) {
        add('smallWinds');
      }

      // 字一色：真实牌无花色，且全部组（含指派后的纯万能组与将）均为字牌
      if (
        realSuits.size === 0 &&
        groups.every((g) => g.tile !== null && isHonorTile(g.tile)) &&
        (realHonorAny || wilds > 0)
      ) {
        add('allHonors');
      }
    }
  }

  // exclusiveGroup：同组互斥取最高
  const groupMap = new Map<string, FanMatch[]>();
  for (const m of matched) {
    if (m.exclusiveGroup) {
      const arr = groupMap.get(m.exclusiveGroup) ?? [];
      arr.push(m);
      groupMap.set(m.exclusiveGroup, arr);
    }
  }
  const kept = matched.filter((m) => !m.exclusiveGroup);
  for (const arr of groupMap.values()) {
    const best = arr.reduce((a, b) => (b.value > a.value ? b : a));
    kept.push(best);
    for (const m of arr) if (m !== best) suppressed.push(m);
  }

  // 兜底鸡胡
  let chickenApplied = false;
  if (!kept.some((m) => m.fanId !== 'chicken')) {
    const f = enabledFan('chicken');
    if (f) {
      kept.push({ fanId: f.id, name: f.name, value: f.value });
      chickenApplied = true;
    }
  }

  // 附加番
  const bonusDef = (id: string) => {
    const b = resolved.bonusFans.find((x) => x.id === id);
    return b && b.enabled ? b : null;
  };
  const addBonus = (id: string, count = 1): void => {
    const b = bonusDef(id);
    if (b) bonus.push({ fanId: b.id, name: b.name, value: b.value, count });
  };
  if (ctx.selfDraw) addBonus('selfDraw');
  // 风位（face 名）→ 风牌 TileId
  const WIND_FACE_TILE: Record<string, string> = { east: 'WE', south: 'WS', west: 'WW', north: 'WN' };
  const seatTriplets = tripletOf(WIND_FACE_TILE[ctx.seatWind] ?? ctx.seatWind);
  if (seatTriplets > 0) addBonus('seatWindTriplet', seatTriplets);
  const roundTriplets = tripletOf(WIND_FACE_TILE[ctx.roundWind] ?? ctx.roundWind);
  if (roundTriplets > 0) addBonus('roundWindTriplet', roundTriplets);
  const dragonCount = DRAGON_TILES.reduce((n, t) => n + tripletOf(t), 0);
  if (dragonCount > 0) addBonus('dragonTriplet', dragonCount);
  if (ctx.kongBlossom) addBonus('kongBlossom');
  if (ctx.robbingKong) addBonus('robbingKong');

  const scoring = resolved.scoring;
  const baseFan =
    scoring.mode === 'additive'
      ? kept.reduce((a, m) => a + m.value, 0)
      : kept.reduce((a, m) => Math.max(a, m.value), 0);
  const afterBonusFan = baseFan + bonus.reduce((a, b) => a + b.value * (b.count ?? 1), 0);
  const bestFan = kept.reduce<FanMatch | null>((best, m) => (!best || m.value > best.value ? m : best), null);

  return {
    matched: kept,
    suppressed,
    chickenApplied,
    bonus,
    bestFanId: bestFan?.fanId ?? 'chicken',
    baseFan,
    afterBonusFan,
  };
}
