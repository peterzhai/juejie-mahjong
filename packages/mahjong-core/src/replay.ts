/**
 * 回放（PRD 6.5.7）：记录输入决策流 + resolvedFanConfig 全量快照。
 * 重放 = 用快照配置与种子重建引擎，按序喂入决策，比对事件流与结算，改配置不漂移。
 */

import type { ResolvedFanConfig } from '@quejie/fan-config';
import { stableStringify } from '@quejie/fan-config';
import { MahjongGame } from './game.js';
import type { GameEvent, HandResult, PlayerAction, ReplayMeta, Seat } from './game.js';

export interface ReplayInput {
  seat: Seat;
  action: PlayerAction;
}

export interface ReplayData {
  meta: ReplayMeta;
  resolvedConfigSnapshot: ResolvedFanConfig;
  inputs: ReplayInput[];
  events: GameEvent[];
  result: {
    outcome: HandResult['outcome'];
    winnerSeats: Seat[];
    deltas: number[];
    dealerNext: Seat;
    reason?: 'wallExhausted';
  };
}

export function recordReplay(
  game: MahjongGame,
  inputs: ReplayInput[],
  resolved: ResolvedFanConfig = game.resolved,
): ReplayData {
  if (!game.result) throw new Error('对局尚未结束，无法生成回放');
  return {
    meta: game.result.replayMeta,
    resolvedConfigSnapshot: structuredClone(resolved),
    inputs: structuredClone(inputs),
    events: structuredClone(game.events),
    result: {
      outcome: game.result.outcome,
      winnerSeats: [...game.result.winnerSeats],
      deltas: [...game.result.deltas],
      dealerNext: game.result.dealerNext,
      reason: game.result.reason,
    },
  };
}

export interface ReplayVerifyResult {
  ok: boolean;
  differences: string[];
}

/** 重放验证：用快照配置重建对局并喂入决策流，比对全部事件与结果 */
export function verifyReplay(data: ReplayData, playerNames?: string[]): ReplayVerifyResult {
  const differences: string[] = [];
  let game: MahjongGame;
  try {
    game = new MahjongGame({
      resolved: data.resolvedConfigSnapshot,
      playerCount: data.meta.playerCount ?? 4,
      seed: data.meta.seed,
      dealer: data.meta.dealer,
      roundWind: data.meta.roundWind,
      roomLevel: data.meta.roomLevel,
      playerNames,
    });
  } catch (e) {
    return { ok: false, differences: [`引擎构建失败: ${String(e)}`] };
  }

  try {
    game.start();
    for (const input of data.inputs) {
      game.action(input.seat, input.action);
    }
  } catch (e) {
    return { ok: false, differences: [`重放执行失败: ${String(e)}`] };
  }

  if (!game.result) {
    return { ok: false, differences: ['重放后对局未结束'] };
  }

  // 事件流比对
  const a = stableStringify(data.events);
  const b = stableStringify(game.events);
  if (a !== b) {
    differences.push('事件流不一致');
    // 定位首个差异便于诊断
    const ea = stableStringify(data.events).split('},{');
    const eb = stableStringify(game.events).split('},{');
    for (let i = 0; i < Math.max(ea.length, eb.length); i++) {
      if (ea[i] !== eb[i]) {
        differences.push(`首个差异事件 #${i}`);
        break;
      }
    }
  }

  const r = game.result;
  if (r.outcome !== data.result.outcome) differences.push(`结果不一致: outcome ${data.result.outcome} → ${r.outcome}`);
  if (stableStringify(r.winnerSeats) !== stableStringify(data.result.winnerSeats)) {
    differences.push('结果不一致: winnerSeats');
  }
  if (stableStringify(r.deltas) !== stableStringify(data.result.deltas)) {
    differences.push(`结果不一致: deltas ${stableStringify(data.result.deltas)} → ${stableStringify(r.deltas)}`);
  }
  if (r.dealerNext !== data.result.dealerNext) differences.push('结果不一致: dealerNext');

  return { ok: differences.length === 0, differences };
}
