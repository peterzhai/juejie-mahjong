/**
 * 胡牌判定（PRD 5.3）：4 组顺子/刻子 + 1 对将；红中为万能牌时枚举替换组合。
 * 另支持：七对（可配含红中）、十三幺、九莲宝灯。
 *
 * 副露槽位约定：杠占 1 个副露（3 张位），第 4 张随杠入副露不参与分解；
 * 胡牌分解牌数 = 3 × (4 − 副露数) + 2。
 */

import type { TileId } from '@quejie/fan-config';
import { isOrphanTile } from '@quejie/fan-config';
import type { TileIndex } from './tileIndex.js';

export interface MeldData {
  type: 'peng' | 'mingang' | 'ankang' | 'bugang';
  tile: TileId;
  fromSeat?: number;
}

/** 分解出的一组：tile 为刻子/顺子基准牌；wildCount 为其中万能牌数量；tile=null 表示纯万能牌（可指派任意牌型） */
export interface MeldSpec {
  kind: 'triplet' | 'sequence';
  tile: TileId | null;
  wildCount: number;
}

export interface PairSpec {
  tile: TileId | null;
  wildCount: number;
}

export interface Decomposition {
  melds: MeldSpec[];
  pair: PairSpec;
}

export interface WinCheckOptions {
  sevenPairsEnabled: boolean;
  sevenPairsWithWild: boolean;
  thirteenOrphansEnabled: boolean;
}

export interface WinCheckResult {
  win: boolean;
  decompositions: Decomposition[];
  sevenPairs: boolean;
  thirteenOrphans: boolean;
  nineGates: boolean;
}

/** 检查（手牌 + 补完成牌）是否能胡，返回全部标准分解与特殊牌型标记 */
export function checkWin(
  counts: number[],
  melds: MeldData[],
  index: TileIndex,
  opts: WinCheckOptions,
): WinCheckResult {
  const needed = 3 * (4 - melds.length) + 2;
  const total = counts.reduce((a, b) => a + b, 0);
  const result: WinCheckResult = {
    win: false,
    decompositions: [],
    sevenPairs: false,
    thirteenOrphans: false,
    nineGates: false,
  };
  if (total !== needed) return result;

  const wildIdx = index.wildIndex;
  const wilds = wildIdx >= 0 ? counts[wildIdx]! : 0;
  const work = counts.slice();

  if (melds.length === 0 && needed === 14) {
    if (opts.sevenPairsEnabled && checkSevenPairs(work, wildIdx, wilds, opts.sevenPairsWithWild)) {
      result.sevenPairs = true;
    }
    if (opts.thirteenOrphansEnabled && checkThirteenOrphans(work, index, wildIdx)) {
      result.thirteenOrphans = true;
    }
    if (checkNineGates(work, index, wildIdx)) result.nineGates = true;
  }

  decomposeAll(work, index, wildIdx, wilds, 4 - melds.length, result);
  result.win = result.decompositions.length > 0 || result.sevenPairs || result.thirteenOrphans;
  return result;
}

function checkSevenPairs(counts: number[], wildIdx: number, wilds: number, withWild: boolean): boolean {
  if (!withWild && wilds > 0) return false;
  let odd = 0;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i]!;
    if (c === 0 || i === wildIdx) continue;
    if (c > 4) return false; // 七对不允许 5 张以上同牌
    if (c % 2 === 1) odd++;
  }
  return odd <= wilds && (wilds - odd) % 2 === 0;
}

function checkThirteenOrphans(counts: number[], index: TileIndex, wildIdx: number): boolean {
  const w = wildIdx >= 0 ? counts[wildIdx]! : 0;
  let pairTypes = 0;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i]!;
    if (c === 0 || i === wildIdx) continue;
    if (!isOrphanTile(index.tile(i))) return false;
    if (c >= 3) return false;
    if (c === 2) pairTypes++;
  }
  if (pairTypes > 1) return false;
  if (pairTypes === 0 && w < 1) return false;
  return true;
}

const NINE_GATES_BASE = [3, 1, 1, 1, 1, 1, 1, 1, 3] as const;

function checkNineGates(counts: number[], index: TileIndex, wildIdx: number): boolean {
  let suitFace: string | null = null;
  const rankCounts = new Array<number>(9).fill(0);
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i]!;
    if (c === 0 || i === wildIdx) continue;
    const face = index.suitFaceOf(i);
    if (!face) return false; // 含字牌
    if (suitFace && suitFace !== face) return false;
    suitFace = face;
    rankCounts[index.rankOf(i)! - 1]! = c;
  }
  if (!suitFace) return false;
  for (let e = 0; e < 9; e++) {
    let ok = true;
    for (let r = 0; r < 9; r++) {
      if (rankCounts[r]! > NINE_GATES_BASE[r]! + (r === e ? 1 : 0)) {
        ok = false;
        break;
      }
    }
    if (ok) return true; // 万能牌恰好补足缺口（无溢出时缺口总数 = 万能牌数）
  }
  return false;
}

/** 枚举全部标准分解（将 + 组合），万能牌按组合枚举替换 */
function decomposeAll(
  work: number[],
  index: TileIndex,
  wildIdx: number,
  initialWilds: number,
  meldsNeeded: number,
  result: WinCheckResult,
): void {
  const melds: MeldSpec[] = [];

  const decompose = (remaining: number, wilds: number, pair: PairSpec | null): void => {
    let i = -1;
    for (let k = 0; k < work.length; k++) {
      if (k !== wildIdx && work[k]! > 0) {
        i = k;
        break;
      }
    }
    if (i === -1) {
      // 只剩万能牌：全部组成刻子
      if (remaining * 3 === wilds) {
        const all: MeldSpec[] = [...melds];
        for (let m = 0; m < remaining; m++) all.push({ kind: 'triplet', tile: null, wildCount: 3 });
        if (pair) result.decompositions.push({ melds: all, pair });
      }
      return;
    }
    if (remaining <= 0) return;
    const c = work[i]!;

    for (let t = Math.min(c, 3); t >= 1; t--) {
      const j = 3 - t;
      if (j > wilds) continue;
      work[i] = c - t;
      melds.push({ kind: 'triplet', tile: index.tile(i), wildCount: j });
      decompose(remaining - 1, wilds - j, pair);
      melds.pop();
      work[i] = c;
    }

    const rank = index.rankOf(i);
    if (rank !== null) {
      // (i, i+1, i+2)
      if (rank <= 7) {
        const i1 = index.nextInSuit(i);
        const i2 = i1 >= 0 ? index.nextInSuit(i1) : -1;
        if (i1 >= 0 && i2 >= 0) {
          for (const f1 of seqFill(work, i1, wilds)) {
            for (const f2 of seqFill(work, i2, wilds - f1)) {
              const members: [number, number][] = [
                [i, 1],
                [i1, f1 === 0 ? 1 : 0],
                [i2, f2 === 0 ? 1 : 0],
              ];
              takeSeq(index, work, melds, i, members, f1 + f2);
              decompose(remaining - 1, wilds - (f1 + f2), pair);
              untakeSeq(work, members);
              melds.pop();
            }
          }
        }
      }
      // (i-1, i, i+1)：i-1 必为万能（i 是最小非零牌）
      if (rank >= 2 && rank <= 8) {
        const ip = index.prevInSuit(i);
        const i1 = index.nextInSuit(i);
        if (ip >= 0 && i1 >= 0) {
          for (const f of seqFill(work, i1, wilds - 1)) {
            const members: [number, number][] = [
              [ip, 0],
              [i, 1],
              [i1, f === 0 ? 1 : 0],
            ];
            takeSeq(index, work, melds, i, members, 1 + f);
            decompose(remaining - 1, wilds - (1 + f), pair);
            untakeSeq(work, members);
            melds.pop();
          }
        }
      }
      // (i-2, i-1, i)：i-2、i-1 必为万能
      if (rank >= 3) {
        const ip = index.prevInSuit(i);
        const ipp = ip >= 0 ? index.prevInSuit(ip) : -1;
        if (ipp >= 0) {
          const members: [number, number][] = [
            [ipp, 0],
            [ip, 0],
            [i, 1],
          ];
          takeSeq(index, work, melds, i, members, 2);
          decompose(remaining - 1, wilds - 2, pair);
          untakeSeq(work, members);
          melds.pop();
        }
      }
    }
  };

  // 选将：真实对 / 真实+万能 / 纯万能
  for (let p = 0; p < work.length; p++) {
    const c = work[p]!;
    if (p === wildIdx) {
      if (c >= 2) {
        work[p] = c - 2;
        decompose(meldsNeeded, initialWilds - 2, { tile: null, wildCount: 2 });
        work[p] = c;
      }
      continue;
    }
    if (c >= 2) {
      work[p] = c - 2;
      decompose(meldsNeeded, initialWilds, { tile: index.tile(p), wildCount: 0 });
      work[p] = c;
    }
    if (c >= 1 && initialWilds >= 1) {
      work[p] = c - 1;
      decompose(meldsNeeded, initialWilds - 1, { tile: index.tile(p), wildCount: 1 });
      work[p] = c;
    }
  }
}

function seqFill(work: number[], idx: number, wilds: number): number[] {
  const opts: number[] = [];
  if (work[idx]! > 0) opts.push(0);
  if (wilds > 0) opts.push(1);
  return opts;
}

function takeSeq(
  index: TileIndex,
  work: number[],
  melds: MeldSpec[],
  base: number,
  members: [number, number][],
  wildsUsed: number,
): void {
  for (const [idx, take] of members) {
    if (take > 0) work[idx] = work[idx]! - take;
  }
  melds.push({ kind: 'sequence', tile: index.tile(base), wildCount: wildsUsed });
}

function untakeSeq(work: number[], members: [number, number][]): void {
  for (const [idx, take] of members) {
    if (take > 0) work[idx] = work[idx]! + take;
  }
}
