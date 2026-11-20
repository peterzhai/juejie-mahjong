/** P7：AI 三档（合法性 harness / 决策差异 / soak / 性能预算） */

import { describe, expect, it } from 'vitest';
import { defaultFanConfig, resolveFanConfig, type ResolvedFanConfig } from '@quejie/fan-config';
import {
  MahjongGame,
  aiDecide,
  mulberry32,
  shantenOf,
  recordReplay,
  verifyReplay,
  type Difficulty,
  type PlayerAction,
  type ReplayInput,
} from '../src/index.js';

function cfgFor(preset: string, overrides?: (c: ResolvedFanConfig) => void): ResolvedFanConfig {
  const cfg = defaultFanConfig();
  cfg.tileSet = structuredClone(cfg.tileSet);
  cfg.tileSet.preset = preset;
  if (cfg.tileSet.redCenterMode !== 'wild') cfg.scoring.redCenterBonus.enabled = false;
  const r = resolveFanConfig(cfg);
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join('; '));
  const resolved = r.resolved!;
  overrides?.(resolved);
  return resolved;
}

const gd128 = cfgFor('gd128');
const gd136 = cfgFor('gd136');
const gd100 = cfgFor('gd100');
const gd108 = cfgFor('gd108');

interface AiGameResult {
  game: MahjongGame;
  inputs: ReplayInput[];
  decisions: number;
  maxDecisionMs: number;
}

/** 全 AI 对局驱动：每个动作先过合法性 harness 再喂给引擎 */
function aiPlay(
  resolved: ResolvedFanConfig,
  seed: number,
  difficulties: [Difficulty, Difficulty, Difficulty, Difficulty],
  validate = true,
  maxSteps = 6000,
): AiGameResult {
  const game = new MahjongGame({ resolved, seed, dealer: 0, roundWind: 'east' });
  game.start();
  const inputs: ReplayInput[] = [];
  let decisions = 0;
  let maxDecisionMs = 0;
  let step = 0;
  while (!game.result && step++ < maxSteps) {
    if (game.phase === 'claim') {
      const pending = game.claim!.pendingSeats.filter((s) => !game.claim!.responses.has(s));
      if (pending.length === 0) {
        game.autoPassPending();
        continue;
      }
      for (const seat of pending) {
        if (game.claim!.responses.has(seat)) continue;
        const t0 = performance.now();
        const action = aiDecide(game, seat, {
          difficulty: difficulties[seat]!,
          rng: mulberry32(seed * 7919 + seat * 131 + step),
        });
        maxDecisionMs = Math.max(maxDecisionMs, performance.now() - t0);
        decisions++;
        if (validate) {
          const legal = game.legalOptions(seat);
          const ok = legal.some(
            (o) => o.type === action.type && (o.tile === undefined || action.tile === undefined || o.tile === action.tile),
          );
          if (!ok) {
            throw new Error(`AI 非法动作 seat=${seat} action=${JSON.stringify(action)} legal=${JSON.stringify(legal)}`);
          }
        }
        game.action(seat, action);
        inputs.push({ seat, action });
      }
    } else {
      const seat = game.currentSeat;
      const t0 = performance.now();
      const action = aiDecide(game, seat, {
        difficulty: difficulties[seat]!,
        rng: mulberry32(seed * 7919 + seat * 131 + step),
      });
      maxDecisionMs = Math.max(maxDecisionMs, performance.now() - t0);
      decisions++;
      if (validate) {
        const legal = game.legalOptions(seat);
        const ok = legal.some(
          (o) => o.type === action.type && (o.tile === undefined || action.tile === undefined || o.tile === action.tile),
        );
        if (!ok) {
          throw new Error(`AI 非法动作 seat=${seat} action=${JSON.stringify(action)} legal=${JSON.stringify(legal)}`);
        }
      }
      game.action(seat, action);
      inputs.push({ seat, action });
    }
  }
  if (!game.result) throw new Error(`对局未结束 step=${step}`);
  return { game, inputs, decisions, maxDecisionMs };
}

const MIXED: [Difficulty, Difficulty, Difficulty, Difficulty][] = [
  ['easy', 'normal', 'hard', 'normal'],
  ['normal', 'hard', 'easy', 'easy'],
  ['hard', 'easy', 'normal', 'hard'],
];

describe('P7 门禁：合法性 harness + 1000 局 soak', () => {
  it('向听数 sanity：胡牌形 -1 / 距离合理', () => {
    const g = new MahjongGame({ resolved: gd136, seed: 1, dealer: 0 });
    g.start();
    // 注入标准胡牌形
    const p = g.players[0]!;
    p.hand.fill(0);
    for (const t of ['C1', 'C1', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C8', 'C8', 'D9', 'D9']) {
      p.hand[g.index.idx(t)]!++;
    }
    expect(shantenOf([...p.hand], 0, g.index)).toBe(-1);
    // 听牌（单吊）
    p.hand.fill(0);
    for (const t of ['C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'B2', 'B3', 'B4', 'D1', 'D1', 'D4', 'D4']) {
      p.hand[g.index.idx(t)]!++;
    }
    expect(shantenOf([...p.hand], 0, g.index)).toBe(0);
  });

  it('soak 1000 局混合配置：无崩溃、动作全合法、对局全部正常结束', () => {
    const configs = [gd128, gd136, gd100, gd108];
    let games = 0;
    let wins = 0;
    let maxMs = 0;
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      const cfg = configs[i % configs.length]!;
      const diffs = MIXED[i % MIXED.length]!;
      const r = aiPlay(cfg, i + 1, diffs);
      games++;
      if (r.game.result!.outcome === 'win') wins++;
      maxMs = Math.max(maxMs, r.maxDecisionMs);
      // 回放一致性抽查（每 50 局）
      if (i % 50 === 0) {
        const v = verifyReplay(recordReplay(r.game, r.inputs));
        expect(v.ok).toBe(true);
      }
    }
    const elapsed = performance.now() - t0;
    console.log(`[soak] ${games} 局（胜 ${wins}）耗时 ${Math.round(elapsed)}ms，单步最大 ${maxMs.toFixed(1)}ms`);
    expect(games).toBe(1000);
    // 动态编码不硬编码 34 种：gd108（无字牌）也能正常跑
  }, 600000);

  it('AI 决策限时生效（hard 档单步 < 200ms）', () => {
    const r = aiPlay(gd128, 42, ['hard', 'hard', 'hard', 'hard']);
    expect(r.maxDecisionMs).toBeLessThan(200);
  });
});

describe('P7 门禁：三档决策差异', () => {
  it('easy/normal/hard 在相同局面下产生显著不同决策', () => {
    let diffEasyNormal = 0;
    let diffHardNormal = 0;
    const seeds = 40;
    for (let seed = 1; seed <= seeds; seed++) {
      const base = aiPlay(gd128, seed, ['normal', 'normal', 'normal', 'normal']);
      const easy = aiPlay(gd128, seed, ['easy', 'easy', 'easy', 'easy']);
      const hard = aiPlay(gd128, seed, ['hard', 'hard', 'hard', 'hard']);
      const n = Math.min(base.inputs.length, easy.inputs.length, hard.inputs.length);
      for (let i = 0; i < n; i++) {
        const a = JSON.stringify(base.inputs[i]!.action);
        if (a !== JSON.stringify(easy.inputs[i]!.action)) diffEasyNormal++;
        if (a !== JSON.stringify(hard.inputs[i]!.action)) diffHardNormal++;
      }
    }
    console.log(`[差异] easy vs normal: ${diffEasyNormal}, hard vs normal: ${diffHardNormal}（前 ${seeds} 局）`);
    expect(diffEasyNormal).toBeGreaterThan(seeds * 5);
    expect(diffHardNormal).toBeGreaterThan(seeds * 5);
  }, 300000);

  it('hard 档点炮更少（防守有效）', () => {
    const dealIns = (diff: Difficulty): number => {
      let count = 0;
      for (let seed = 1; seed <= 60; seed++) {
        const diffs: [Difficulty, Difficulty, Difficulty, Difficulty] = [diff, 'normal', 'normal', 'normal'];
        const r = aiPlay(gd136, seed, diffs);
        for (const s of r.game.result!.settlements) {
          // 观测座位 0 的点炮次数（payment kind discard 且 payer = 0）
          if (s.paymentKind === 'discard' && s.payerSeat === 0) count++;
          if (s.paymentKind === 'bao' && s.payerSeat === 0) count += 3;
        }
      }
      return count;
    };
    const easyDealIns = dealIns('easy');
    const hardDealIns = dealIns('hard');
    console.log(`[点炮] easy 座位0: ${easyDealIns}, hard 座位0: ${hardDealIns}`);
    expect(hardDealIns).toBeLessThanOrEqual(easyDealIns);
  }, 300000);
});

describe('P7 门禁：AI 胜率显著优于随机弃牌', () => {
  it('AI 桌（全 normal）胜局率高于 20%', () => {
    let wins = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const r = aiPlay(gd136, seed, ['normal', 'normal', 'normal', 'normal'], false);
      if (r.game.result!.outcome === 'win') wins++;
    }
    console.log(`[胜率] 全 normal AI：${wins}/100 局有胡`);
    expect(wins).toBeGreaterThan(20);
  }, 300000);
});
