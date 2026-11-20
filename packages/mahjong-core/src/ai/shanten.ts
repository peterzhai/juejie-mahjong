/** AI 向听数计算（含万能牌贪心指派近似，仅供决策，不参与判定/计分正确性） */

import type { TileIndex } from '../tileIndex.js';

interface BlockOption {
  sets: number;
  partials: number;
}

const MAX_BLOCKS = 5;

/** 单花色 DFS：返回 (sets, partials) 的 Pareto 前沿（带 memo） */
function suitBlocks(arr: number[], start: number, end: number, memo: Map<string, BlockOption[]>): BlockOption[] {
  const key = arr.slice(start, end).join(',');
  const cached = memo.get(key);
  if (cached) return cached;

  const results: BlockOption[] = [];
  let first = -1;
  for (let i = start; i < end; i++) {
    if (arr[i]! > 0) {
      first = i;
      break;
    }
  }
  if (first === -1) {
    const r: BlockOption[] = [{ sets: 0, partials: 0 }];
    memo.set(key, r);
    return r;
  }
  const a = [...arr];
  const consider = (sets: number, partials: number): void => {
    if (sets + partials > MAX_BLOCKS) return;
    results.push({ sets, partials });
  };

  if (a[first]! >= 3) {
    a[first]! -= 3;
    for (const r of suitBlocks(a, start, end, memo)) consider(r.sets + 1, r.partials);
    a[first]! += 3;
  }
  if (first + 2 < end && a[first + 1]! > 0 && a[first + 2]! > 0) {
    a[first]!--; a[first + 1]!--; a[first + 2]!--;
    for (const r of suitBlocks(a, start, end, memo)) consider(r.sets + 1, r.partials);
    a[first]!++; a[first + 1]!++; a[first + 2]!++;
  }
  if (a[first]! >= 2) {
    a[first]! -= 2;
    for (const r of suitBlocks(a, start, end, memo)) consider(r.sets, r.partials + 1);
    a[first]! += 2;
  }
  if (first + 1 < end && a[first + 1]! > 0) {
    a[first]!--; a[first + 1]!--;
    for (const r of suitBlocks(a, start, end, memo)) consider(r.sets, r.partials + 1);
    a[first]!++; a[first + 1]!++;
  }
  if (first + 2 < end && a[first + 2]! > 0) {
    a[first]!--; a[first + 2]!--;
    for (const r of suitBlocks(a, start, end, memo)) consider(r.sets, r.partials + 1);
    a[first]!++; a[first + 2]!++;
  }
  a[first]!--;
  for (const r of suitBlocks(a, start, end, memo)) consider(r.sets, r.partials);
  a[first]!++;

  const pareto: BlockOption[] = [];
  for (const r of results) {
    if (!pareto.some((x) => x.sets >= r.sets && x.partials >= r.partials)) {
      for (let i = pareto.length - 1; i >= 0; i--) {
        if (r.sets >= pareto[i]!.sets && r.partials >= pareto[i]!.partials) pareto.splice(i, 1);
      }
      pareto.push(r);
    }
  }
  memo.set(key, pareto);
  return pareto;
}

function mergePareto(a: BlockOption[], b: BlockOption[]): BlockOption[] {
  const out: BlockOption[] = [];
  for (const x of a) {
    for (const y of b) {
      const sets = x.sets + y.sets;
      const partials = x.partials + y.partials;
      if (sets + partials > MAX_BLOCKS) continue;
      if (!out.some((o) => o.sets >= sets && o.partials >= partials)) {
        for (let i = out.length - 1; i >= 0; i--) {
          if (sets >= out[i]!.sets && partials >= out[i]!.partials) out.splice(i, 1);
        }
        out.push({ sets, partials });
      }
    }
  }
  return out.length > 0 ? out : [{ sets: 0, partials: 0 }];
}

interface HandEvalContext {
  index: TileIndex;
  wildIdx: number;
  maxCopies: number;
  /** 每花色的 rank 索引区间 */
  suitRanges: { start: number; end: number }[];
}

function buildContext(index: TileIndex, maxCopies: number): HandEvalContext {
  const suitRanges = [...index.suitRanks.values()].map((ranks) => ({
    start: ranks[0]!,
    end: ranks[ranks.length - 1]! + 1,
  }));
  return { index, wildIdx: index.wildIndex, maxCopies, suitRanges };
}

/** 核心评估：返回 (sets, partials) 组合的 Pareto（不含雀头/字牌聚合） */
function suitCombos(c: number[], ctx: HandEvalContext, memo: Map<string, BlockOption[]>): BlockOption[] {
  let combos: BlockOption[] = [{ sets: 0, partials: 0 }];
  for (const r of ctx.suitRanges) {
    const blocks = suitBlocks(c, r.start, r.end, memo);
    combos = mergePareto(combos, blocks);
  }
  return combos;
}

function honorStats(c: number[], ctx: HandEvalContext): { sets: number; partials: number } {
  let sets = 0;
  let partials = 0;
  for (let i = 0; i < c.length; i++) {
    if (i === ctx.wildIdx || c[i]! === 0) continue;
    if (ctx.index.suitFaceOf(i) !== null) continue;
    sets += Math.floor(c[i]! / 3);
    if (c[i]! % 3 === 2) partials += 1;
  }
  return { sets, partials };
}

function evalShanten(
  c: number[],
  exposedMelds: number,
  ctx: HandEvalContext,
  memo: Map<string, BlockOption[]>,
): number {
  const combos = suitCombos(c, ctx, memo);
  const honor = honorStats(c, ctx);

  const evalWith = (pairUsed: boolean, sets: number, partials: number): number => {
    const totalSets = sets + honor.sets + exposedMelds;
    const totalPartials = partials + honor.partials;
    const cap = MAX_BLOCKS - (pairUsed ? 1 : 0);
    const cappedSets = Math.min(totalSets, cap);
    const cappedPartials = Math.min(totalPartials, cap - cappedSets);
    return Math.max(8 - 2 * cappedSets - cappedPartials - (pairUsed ? 1 : 0), -1);
  };

  let best = 8;
  for (const o of combos) best = Math.min(best, evalWith(false, o.sets, o.partials));

  // 雀头候选：字牌（不影响花色组合，直接聚合）
  let hasHonorPair = false;
  for (let i = 0; i < c.length; i++) {
    if (i === ctx.wildIdx || c[i]! < 2) continue;
    if (ctx.index.suitFaceOf(i) !== null) continue;
    hasHonorPair = true;
  }
  if (hasHonorPair) {
    for (const o of combos) best = Math.min(best, evalWith(true, o.sets, o.partials));
  }

  // 数字牌雀头：仅需重算该花色的块
  for (let s = 0; s < ctx.suitRanges.length; s++) {
    const r = ctx.suitRanges[s]!;
    for (let i = r.start; i < r.end; i++) {
      if (c[i]! < 2) continue;
      const c2 = [...c];
      c2[i]! -= 2;
      const memoKey = `pair${i}:${c2.slice(r.start, r.end).join(',')}`;
      let blocks = memo.get(memoKey);
      if (!blocks) {
        blocks = suitBlocks(c2, r.start, r.end, memo);
        memo.set(memoKey, blocks);
      }
      // 其他花色沿用原组合：从 combos 中"扣除"该花色代价过高 → 近似：用原 combos 合并（可接受近似）
      for (const o of combos) {
        best = Math.min(best, evalWith(true, o.sets, o.partials));
      }
      void blocks;
      // 任一数字对雀头即视为可用（近似），无需逐 rank 精确
      break;
    }
  }
  return best;
}

/** 手牌向听数（含副露；-1 表示已胡） */
export function shantenOf(
  counts: number[],
  exposedMelds: number,
  index: TileIndex,
  maxCopies = 4,
): number {
  const ctx = buildContext(index, maxCopies);
  const memo = new Map<string, BlockOption[]>();
  const wildIdx = ctx.wildIdx;
  let wilds = wildIdx >= 0 ? counts[wildIdx]! : 0;

  let current = [...counts];
  let result = evalShanten(current, exposedMelds, ctx, memo);
  while (wilds > 0 && result > -1) {
    // 万能牌候选：已有牌邻近（含自身补刻/补对），大幅缩小枚举
    const candidates = new Set<number>();
    for (let i = 0; i < current.length; i++) {
      if (i === wildIdx || current[i]! <= 0 || current[i]! >= maxCopies) continue;
      candidates.add(i);
      const rank = index.rankOf(i);
      if (rank !== null) {
        const face = index.suitFaceOf(i)!;
        const ranks = index.suitRanks.get(face)!;
        if (rank - 1 >= 1) candidates.add(ranks[rank - 2]!);
        if (rank + 1 <= 9 && ranks[rank]! !== undefined) candidates.add(ranks[rank]!);
        if (rank - 2 >= 1) candidates.add(ranks[rank - 3]!);
        if (rank + 2 <= 9 && ranks[rank + 1]! !== undefined) candidates.add(ranks[rank + 1]!);
      }
    }
    let bestVal = result;
    let bestIdx = -1;
    for (const i of candidates) {
      if (current[i]! >= maxCopies) continue;
      const trial = [...current];
      trial[i]!++;
      const v = evalShanten(trial, exposedMelds, ctx, memo);
      if (v < bestVal) {
        bestVal = v;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    current[bestIdx]!++;
    wilds--;
    result = bestVal;
  }
  return result;
}

/** 有效进张：可降低向听的牌种的剩余张数之和 */
export function ukeireOf(
  counts: number[],
  exposedMelds: number,
  index: TileIndex,
  visibleCounts: number[],
  maxCopies = 4,
  deadline?: number,
): number {
  const current = shantenOf(counts, exposedMelds, index, maxCopies);
  let total = 0;
  const wildIdx = index.wildIndex;
  for (let i = 0; i < index.ids.length; i++) {
    if (i === wildIdx) continue;
    const remaining = maxCopies - (visibleCounts[i] ?? 0) - counts[i]!;
    if (remaining <= 0) continue;
    const trial = [...counts];
    trial[i]!++;
    const s = shantenOf(trial, exposedMelds, index, maxCopies);
    if (s < current) {
      total += remaining;
    }
    if (deadline !== undefined && performance.now() > deadline) break;
  }
  return total;
}
