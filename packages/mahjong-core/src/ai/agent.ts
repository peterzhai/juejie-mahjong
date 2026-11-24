/**
 * 规则型 AI（PRD 7.1）：评分 = 向听数 + 下次摸到有效牌的概率 + 危险度。
 * 三档难度：easy 偏进攻（多碰杠），hard 加防守与舍牌记忆。
 * 只走合法动作接口（legalOptions），单步限时。
 */

import type { TileId } from '@quejie/fan-config';
import type { MahjongGame, ActionOption, PlayerAction, Seat } from '../game.js';
import { chanceToHit, drawPool } from '../drawOdds.js';
import { shantenOf } from './shanten.js';

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface AiConfig {
  difficulty: Difficulty;
  /** 单步决策时限（ms） */
  timeBudgetMs?: number;
  rng?: () => number;
}

const DEFAULT_BUDGET: Record<Difficulty, number> = {
  easy: 20,
  normal: 50,
  hard: 80,
};

/** AI 决策：永远从 legalOptions 中选择 */
export function aiDecide(game: MahjongGame, seat: Seat, config: AiConfig): PlayerAction {
  const deadline = performance.now() + (config.timeBudgetMs ?? DEFAULT_BUDGET[config.difficulty]);
  const rng = config.rng ?? Math.random;
  const options = game.legalOptions(seat);
  if (options.length === 0) return { type: 'pass' };

  // 1) 胡必胡（含自摸与抢杠）
  const hu = options.find((o) => o.type === 'hu');
  if (hu) return hu;

  // 2) 宣告窗口：碰/杠评估
  if (game.phase === 'claim') {
    return decideClaim(game, seat, options, config, deadline);
  }

  // 3) 回合：暗杠/补杠/出牌
  return decideTurn(game, seat, options, config, deadline, rng);
}

function handCounts(game: MahjongGame, seat: Seat): number[] {
  return [...game.players[seat]!.hand];
}

function decideClaim(
  game: MahjongGame,
  seat: Seat,
  options: ActionOption[],
  config: AiConfig,
  deadline: number,
): PlayerAction {
  const pass: PlayerAction = { type: 'pass' };
  const peng = options.find((o) => o.type === 'peng');
  const mingang = options.find((o) => o.type === 'mingang');

  const currentShanten = shantenOf(handCounts(game, seat), game.players[seat]!.melds.length, game.index);

  // 大明杠：多得一张补牌，几乎总有利；hard 也接受
  if (mingang) return mingang;

  if (peng && peng.tile) {
    // 碰是否改善向听：碰后手牌 -2、副露 +1，再从手牌中打出一张（取最优）
    const tile = peng.tile;
    const counts = handCounts(game, seat);
    const idx = game.index.idx(tile);
    if (counts[idx]! >= 2) {
      const afterPeng = [...counts];
      afterPeng[idx]! -= 2;
      // 碰后必须出牌：取打出后最优向听
      let bestAfter = 8;
      for (let i = 0; i < afterPeng.length; i++) {
        if (afterPeng[i]! <= 0) continue;
        const trial = [...afterPeng];
        trial[i]!--;
        const s = shantenOf(trial, game.players[seat]!.melds.length + 1, game.index);
        if (s < bestAfter) bestAfter = s;
        if (performance.now() > deadline) break;
      }
      // 不碰时的最优向听（打出一张）
      let bestNow = 8;
      for (let i = 0; i < counts.length; i++) {
        if (counts[i]! <= 0) continue;
        const trial = [...counts];
        trial[i]!--;
        const s = shantenOf(trial, game.players[seat]!.melds.length, game.index);
        if (s < bestNow) bestNow = s;
        if (performance.now() > deadline) break;
      }
      const improves = bestAfter < bestNow;
      void currentShanten;
      const w = DIFFICULTY_WEIGHTS[config.difficulty];
      if (w.pengAlways) return peng; // 新手偏进攻：能碰就碰
      if (w.pengStrict) {
        // 老手：必须严格改善向听才碰
        if (improves) return peng;
        return pass;
      }
      if (improves || (bestAfter <= bestNow && bestAfter <= 2)) return peng;
    }
  }
  return pass;
}

function decideTurn(
  game: MahjongGame,
  seat: Seat,
  options: ActionOption[],
  config: AiConfig,
  deadline: number,
  rng: () => number,
): PlayerAction {
  // 暗杠/补杠：直接执行（额外补牌 + 杠分）
  const ankang = options.find((o) => o.type === 'ankang');
  if (ankang) return ankang;
  const bugang = options.find((o) => o.type === 'bugang');
  if (bugang) return bugang;

  const discards = options.filter((o): o is ActionOption & { type: 'discard'; tile: TileId } => o.type === 'discard');
  if (discards.length === 0) return { type: 'pass' };

  const counts = handCounts(game, seat);
  const melds = game.players[seat]!.melds.length;
  // 候选舍牌仍属于已知牌，所有候选共用出牌前的未见牌池。
  const { visible, remaining, unseenTiles } = drawPool(game, seat);

  // 各弃牌候选的 (向听, 进张, 危险度)
  const evaluated = discards.map((d) => {
    const idx = game.index.idx(d.tile);
    const trial = [...counts];
    trial[idx]!--;
    const s = shantenOf(trial, melds, game.index);
    return { option: d, idx, trial, shanten: s, chance: 0 };
  });

  const minShanten = Math.min(...evaluated.map((e) => e.shanten));
  const opponents = game.players.filter((player) => player.seat !== seat);
  const canDealIn = game.resolved.rules.allowDiscardHu !== false;
  const lateHand = game.wall.liveRemaining - game.wall.deadWallCount <= game.playerCount * 7;
  const hardFold =
    canDealIn &&
    config.difficulty === 'hard' &&
    minShanten >= 2 &&
    (lateHand || opponents.some((player) => player.melds.length >= 3));
  const danger = (idx: number) => {
    if (!canDealIn) return 0;
    const risk = dangerOf(game, idx, visible);
    if (config.difficulty !== 'hard') return risk;
    const tile = game.index.tile(idx);
    return Math.max(...opponents.map((player) =>
      risk * (player.discards.slice(-4).includes(tile) ? 0.45 : 1) * (1 + 0.2 * player.melds.length),
    ));
  };

  if (hardFold) {
    let safest = evaluated[0]!;
    for (const e of evaluated) {
      if (danger(e.idx) < danger(safest.idx)) safest = e;
    }
    return safest.option;
  }

  // 常规：向听优先 → 摸到有效牌的概率 → 危险度
  const topShanten = evaluated.filter((e) => e.shanten === minShanten);
  const checked: typeof topShanten = [];
  for (const e of topShanten) {
    if (game.wall.exhausted || performance.now() >= deadline) break;
    const hits = minShanten <= 0
      ? game.winningDraws(seat, e.trial).reduce((total, idx) => total + remaining[idx]!, 0)
      : effectiveCopies(game, e.trial, melds, e.shanten, remaining, deadline);
    if (hits === undefined) break;
    e.chance = chanceToHit(unseenTiles, hits, 1);
    checked.push(e);
    if (minShanten > 0 && checked.length >= 3) break;
  }
  const pool = checked.length ? checked : topShanten.slice(0, 3);
  const maxChance = Math.max(...pool.map((e) => e.chance));
  const chanceWeight = game.resolved.tileMath.totalTiles * 100;
  // easy：忽略危险度 + 大抖动（进攻不精细）；normal：弱危险度；hard：强危险度且无抖动
  const w = DIFFICULTY_WEIGHTS[config.difficulty];
  let best = pool[0]!;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const e of pool) {
    if (minShanten <= 0 && maxChance > 0 && e.chance === 0 && config.difficulty !== 'hard') continue;
    const score =
      (maxChance - e.chance) * chanceWeight +
      danger(e.idx) * w.danger +
      rng() * w.jitter;
    if (score < bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return best.option;
}

function effectiveCopies(
  game: MahjongGame, hand: number[], melds: number, shanten: number, remaining: number[], deadline: number,
): number | undefined {
  const trial = [...hand];
  let hits = 0;
  for (let i = 0; i < trial.length; i++) {
    if (remaining[i]! === 0) continue;
    if (performance.now() >= deadline) return undefined;
    trial[i]!++;
    if (shantenOf(trial, melds, game.index) < shanten) hits += remaining[i]!;
    trial[i]!--;
  }
  return hits;
}

interface DifficultyWeights {
  danger: number;
  jitter: number;
  /** 碰：true = 只要可用就碰（偏进攻） */
  pengAlways: boolean;
  /** 碰：true = 必须严格改善向听才碰 */
  pengStrict: boolean;
}

const DIFFICULTY_WEIGHTS: Record<Difficulty, DifficultyWeights> = {
  easy: { danger: 0, jitter: 6000, pengAlways: true, pengStrict: false },
  normal: { danger: 40, jitter: 30, pengAlways: false, pengStrict: false },
  hard: { danger: 220, jitter: 0, pengAlways: false, pengStrict: true },
}

/** 危险度：中张 > 幺九 > 字牌；可见张数越多越安全；他家副露越多越危险 */
function dangerOf(game: MahjongGame, idx: number, visibleCounts: number[]): number {
  const rank = game.index.rankOf(idx);
  const visible = visibleCounts[idx] ?? 0;
  let danger: number;
  if (rank === null) danger = 30; // 字牌
  else if (rank === 1 || rank === 9) danger = 45;
  else if (rank === 2 || rank === 8) danger = 70;
  else danger = 100; // 中张
  danger -= visible * 18; // 可见越多越安全（振听近似）
  if (rank === null && visible >= 3) danger = 0;
  return Math.max(danger, 0);
}
