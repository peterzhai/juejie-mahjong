/**
 * 房间与对局编排（服务端权威）：
 * - 客户端只提交意图，非法动作拒绝并记录日志（验收 22）
 * - 超时由 AI 托管；断线重连返回完整对局状态
 * - 多局连庄与累计分数；回放元数据落盘
 */

import type { ResolvedFanConfig } from '@quejie/fan-config';
import {
  MahjongGame,
  aiDecide,
  recordReplay,
  type GameEvent,
  type HandResult,
  type PlayerAction,
  type ReplayData,
  type Seat,
} from '@quejie/mahjong-core';
import type { PlayerInfo, RoomStateMsg, GameStateMsg, GameEventMsg, SettlementView } from '@quejie/protocol';

export interface RoomSession {
  seat: Seat;
  name: string;
  token: string;
  ai: boolean;
  ready: boolean;
  connected: boolean;
  send: (msg: unknown) => void;
}

export interface RoomOptions {
  playerCount?: number;
  roomLevel?: number;
  resolved: ResolvedFanConfig;
  turnTimeoutMs: number;
  claimTimeoutMs: number;
  aiDelayMs: number;
  onEvent?: (roomCode: string, message: string) => void;
}

const HANDS_PER_ROOM_LIMIT = 16;

export class Room {
  readonly playerCount: number;
  readonly roomLevel: number;
  readonly code: string;
  readonly resolved: ResolvedFanConfig;
  readonly sessions: (RoomSession | null)[] = [null, null, null, null];
  phase: 'lobby' | 'playing' | 'finished' = 'lobby';
  game: MahjongGame | null = null;
  dealer: Seat = 0;
  scores = [0, 0, 0, 0];
  handCount = 0;
  readonly replays: ReplayData[] = [];
  readonly turnTimeoutMs: number;
  readonly claimTimeoutMs: number;
  readonly aiDelayMs: number;
  private readonly onEvent: (roomCode: string, message: string) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(code: string, resolved: ResolvedFanConfig, opts: RoomOptions) {
    this.playerCount = opts.playerCount ?? 4;
    if (![2, 3, 4].includes(this.playerCount)) throw new Error('人数必须为2至4');
    this.roomLevel = opts.roomLevel ?? 1;
    this.sessions = Array(this.playerCount).fill(null);
    this.scores = Array(this.playerCount).fill(0);
    this.code = code;
    this.resolved = resolved;
    this.turnTimeoutMs = opts.turnTimeoutMs;
    this.claimTimeoutMs = opts.claimTimeoutMs;
    this.aiDelayMs = opts.aiDelayMs;
    this.onEvent = opts.onEvent ?? (() => {});
  }

  log(message: string): void {
    this.onEvent(this.code, message);
  }

  join(name: string): { seat: Seat; token: string } | null {
    for (let s = 0; s < this.playerCount; s++) {
      const slot = this.sessions[s];
      if (slot === null) {
        const token = randomToken();
        this.sessions[s] = { seat: s, name, token, ai: false, ready: false, connected: true, send: () => {} };
        this.log(`玩家 ${name} 加入房间 ${this.code}（座位 ${s}）`);
        return { seat: s, token };
      }
    }
    return null;
  }

  seatByToken(token: string): RoomSession | null {
    for (const s of this.sessions) {
      if (s && s.token === token) return s;
    }
    return null;
  }

  attach(seat: Seat, send: (msg: unknown) => void): RoomSession | null {
    const s = this.sessions[seat];
    if (!s) return null;
    s.connected = true;
    s.send = send;
    return s;
  }

  detach(seat: Seat): void {
    const s = this.sessions[seat];
    if (s) {
      s.connected = false;
      this.log(`座位 ${seat} 断线，等待重连或托管`);
    }
  }

  setReady(seat: Seat, ready: boolean): void {
    const s = this.sessions[seat];
    if (s) s.ready = ready;
  }

  allReady(): boolean {
    return this.sessions.every((s) => s !== null && (s.ai || s.ready));
  }

  /** 用 AI 填满空位 */
  fillWithAi(): void {
    for (let s = 0; s < this.playerCount; s++) {
      if (this.sessions[s] === null) {
        this.sessions[s] = {
          seat: s,
          name: `AI·${s + 1}号`,
          token: randomToken(),
          ai: true,
          ready: true,
          connected: false,
          send: () => {},
        };
      }
    }
  }

  canStart(): boolean {
    return this.phase === 'lobby' && this.sessions.every((s) => s !== null) && this.allReady();
  }

  startHand(): void {
    if (this.phase === 'playing') return;
    if (this.handCount >= HANDS_PER_ROOM_LIMIT) {
      this.phase = 'finished';
      return;
    }
    const seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    this.game = new MahjongGame({
      resolved: this.resolved,
      seed,
      dealer: this.dealer,
      roundWind: 'east',
      roomLevel: this.roomLevel,
      playerCount: this.playerCount,
      playerNames: this.sessions.map((s) => s!.name),
    });
    this.game.start();
    this.phase = 'playing';
    this.handCount++;
    this.log(`第 ${this.handCount} 局开始（庄家：座位 ${this.dealer}，seed=${seed}）`);
    this.broadcastRoomState();
    this.pushStateAll();
    this.broadcastEvent({ kind: 'draw', seat: this.dealer });
    this.scheduleTimeout();
    this.kickAi();
  }

  /** 客户端意图入口：校验归属与合法性 */
  handleAction(seat: Seat, action: PlayerAction): void {
    if (this.phase !== 'playing' || !this.game) {
      this.log(`[拒绝] 座位 ${seat} 在非对局阶段发送动作 ${JSON.stringify(action)}`);
      return;
    }
    const legal = this.game.legalOptions(seat);
    const ok = legal.some(
      (o) => o.type === action.type && (o.tile === undefined || action.tile === undefined || o.tile === action.tile),
    );
    if (!ok) {
      this.log(`[拒绝] 座位 ${seat} 非法动作 ${JSON.stringify(action)}（合法: ${JSON.stringify(legal)}）`);
      const s = this.sessions[seat];
      s?.send({ type: 'error', code: 'E_ILLEGAL_ACTION', message: `非法动作 ${JSON.stringify(action)}` });
      return;
    }
    this.clearTimer();
    const eventsBefore = this.game.events.length;
    this.game.action(seat, action);
    this.drainEvents(eventsBefore);
    this.afterAction();
  }

  /** AI 托管：为当前待决策座位执行 AI 决策 */
  runAiFor(seat: Seat): void {
    if (this.phase !== 'playing' || !this.game) return;
    const legal = this.game.legalOptions(seat);
    if (legal.length === 0) return;
    const difficulty = this.sessions[seat]?.ai === true ? 'hard' : 'normal';
    const action = aiDecide(this.game, seat, {
      difficulty,
      rng: Math.random,
      timeBudgetMs: 100,
    });
    const legalOk = legal.some(
      (o) => o.type === action.type && (o.tile === undefined || action.tile === undefined || o.tile === action.tile),
    );
    if (!legalOk) {
      this.log(`[AI] 座位 ${seat} 决策异常 ${JSON.stringify(action)}，自动过`);
      return;
    }
    const eventsBefore = this.game.events.length;
    this.game.action(seat, action);
    this.drainEvents(eventsBefore);
    this.afterAction();
  }

  private afterAction(): void {
    const game = this.game!;
    if (game.result) {
      this.finishHand();
      return;
    }
    this.pushStateAll();
    this.broadcastVisibleEvents();
    this.scheduleTimeout();
    this.kickAi();
  }

  /** 推送自上次以来的新事件（对局事件广播） */
  private drainedUpTo = 0;

  private drainEvents(from: number): void {
    const game = this.game!;
    for (let i = from; i < game.events.length; i++) {
      const e = game.events[i]!;
      const event = this.eventToMsg(e);
      if (event) this.broadcast({ type: 'gameEvent', event } as never);
    }
    this.drainedUpTo = game.events.length;
  }

  private broadcastVisibleEvents(): void {
    const game = this.game!;
    this.drainEvents(this.drainedUpTo);
    void game;
  }

  private eventToMsg(e: GameEvent): GameEventMsg['event'] | null {
    switch (e.type) {
      case 'draw':
        return { kind: 'draw', seat: e.seat };
      case 'discard':
        return { kind: 'discard', seat: e.seat, tile: e.tile };
      case 'peng':
        return { kind: 'peng', seat: e.seat, tile: e.tile, from: e.from };
      case 'mingang':
        return { kind: 'mingang', seat: e.seat, tile: e.tile, from: e.from };
      case 'ankang':
        return { kind: 'ankang', seat: e.seat, tile: e.tile };
      case 'bugang':
        return { kind: 'bugang', seat: e.seat, tile: e.tile };
      case 'kongScore':
        return { kind: 'kongScore', from: e.from, to: e.to, amount: e.amount };
      case 'missLock':
        return { kind: 'missLock', seat: e.seat, tile: e.tile };
      case 'hu':
        return { kind: 'hu', seat: e.seat, via: e.via, fromSeat: e.fromSeat };
      default:
        return null;
    }
  }

  private finishHand(): void {
    const game = this.game!;
    this.drainEvents(this.drainedUpTo);
    const result: HandResult = game.result!;
    for (let s = 0; s < this.playerCount; s++) this.scores[s]! += result.deltas[s]!;
    const replay = recordReplay(game, []);
    this.replays.push(replay);
    this.log(
      `第 ${this.handCount} 局结束：${result.outcome === 'win' ? `胡牌 ${JSON.stringify(result.winnerSeats)}` : '流局'}，deltas=${JSON.stringify(result.deltas)}`,
    );

    const settlements: SettlementView[] = result.settlements.map((s) => ({
      winnerSeat: s.winnerSeat,
      via: s.via,
      payerSeat: s.payerSeat,
      paymentKind: s.paymentKind,
      baoReasons: s.baoReasons,
      score: s.score,
      finalFan: s.finalFan,
      fans: s.fans,
      bonus: s.bonus,
      chicken: s.chicken,
      lines: s.lines,
    }));
    for (const s of this.sessions) {
      if (s?.connected) {
        s.send({
          type: 'gameOver',
          outcome: result.outcome,
          settlements,
          deltas: result.deltas,
          scores: this.scores,
          dealerNext: result.dealerNext,
          replayMeta: { ...result.replayMeta, hands: this.handCount },
        } as never);
      }
    }

    this.dealer = result.dealerNext;
    this.game = null;
    this.phase = 'lobby';
    this.clearTimer();
    for (const s of this.sessions) {
      if (s?.ai) s.ready = true;
      else if (s) s.ready = false;
    }
    this.broadcastRoomState();
  }

  /** 自动开下一局（全部就绪时） */
  maybeAutoStart(): void {
    if (this.canStart()) {
      this.log('全员就绪，自动开局');
      this.startHand();
    }
  }

  // —— 超时托管 ——
  private scheduleTimeout(): void {
    this.clearTimer();
    if (this.phase !== 'playing' || !this.game) return;
    const game = this.game;
    const isClaim = game.phase === 'claim';
    const ms = isClaim ? this.claimTimeoutMs : this.turnTimeoutMs;
    this.timer = setTimeout(() => {
      if (this.phase !== 'playing' || !this.game) return;
      const g = this.game;
      if (g.phase === 'claim') {
        // 未响应座位由 AI 托管
        const pending = g.claim!.pendingSeats.filter((s) => !g.claim!.responses.has(s));
        this.log(`[托管] 宣告超时，座位 ${JSON.stringify(pending)} 由 AI 接管`);
        this.runAiFor(pending[0]!);
      } else {
        this.log(`[托管] 出牌超时，座位 ${g.currentSeat} 由 AI 接管`);
        this.runAiFor(g.currentSeat);
      }
    }, ms);
  }

  private kickAi(): void {
    if (this.phase !== 'playing' || !this.game) return;
    const game = this.game;
    const aiSeats: Seat[] = [];
    if (game.phase === 'claim') {
      for (const s of game.claim!.pendingSeats) {
        if (this.sessions[s]?.ai && !game.claim!.responses.has(s)) aiSeats.push(s);
      }
    } else if (this.sessions[game.currentSeat]?.ai) {
      aiSeats.push(game.currentSeat);
    }
    for (const seat of aiSeats) {
      setTimeout(() => {
        if (this.phase === 'playing' && this.game && this.sessions[seat]?.ai) {
          this.runAiFor(seat);
        }
      }, this.aiDelayMs);
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // —— 广播 ——
  broadcastRoomState(): void {
    const msg: RoomStateMsg = {
      type: 'roomState',
      roomCode: this.code,
      phase: this.phase,
      players: this.sessions.map((s): PlayerInfo => ({
        seat: s?.seat ?? 0,
        name: s?.name ?? '空位',
        ready: s?.ready ?? false,
        connected: s?.connected ?? false,
        ai: s?.ai ?? false,
      })),
      rulesSummary: {
        presetId: this.resolved.tileSetPresetId ?? 'custom',
        totalTiles: this.resolved.tileMath.totalTiles,
        wallTiles: this.resolved.tileMath.wallTiles,
        redCenterMode: this.resolved.redCenterMode,
        capDesc: capDescription(this.resolved),
        scoringMode: this.resolved.scoring.mode,
      },
    };
    this.broadcast(msg);
  }

  /** 个性化对局状态（仅本人手牌） */
  gameStateFor(seat: Seat): GameStateMsg {
    const game = this.game!;
    const p = game.players[seat]!;
    const hand: string[] = [];
    p.hand.forEach((c, i) => {
      for (let k = 0; k < c; k++) hand.push(game.index.tile(i));
    });
    return {
      type: 'gameState',
      viewSeat: seat,
      dealer: game.dealer,
      currentSeat: game.currentSeat,
      phase: game.phase,
      seats: game.players.map((pp) => ({
        seat: pp.seat,
        name: this.sessions[pp.seat]?.name ?? `座位${pp.seat}`,
        handCount: pp.hand.reduce((a, b) => a + b, 0),
        melds: pp.melds.map((m) => ({ type: m.type, tile: m.tile, fromSeat: m.fromSeat })),
        discards: [...pp.discards],
        connected: this.sessions[pp.seat]?.connected ?? false,
        ai: this.sessions[pp.seat]?.ai ?? false,
      })),
      hand,
      drewTile: game.drewTile,
      wallRemaining: game.wall.liveRemaining,
      deadWall: game.wall.deadWallCount,
      legalOptions: game.legalOptions(seat),
      claimTile: game.claim?.tile,
      claimFrom: game.claim?.fromSeat,
      scores: this.scores,
      actionDeadlineMs: game.phase === 'claim' ? this.claimTimeoutMs : this.turnTimeoutMs,
    };
  }

  pushStateAll(): void {
    if (!this.game) return;
    for (const s of this.sessions) {
      if (s?.connected) s.send(this.gameStateFor(s.seat));
    }
  }

  pushState(seat: Seat): void {
    const s = this.sessions[seat];
    if (s?.connected && this.game) s.send(this.gameStateFor(seat));
  }

  private broadcast(msg: unknown): void {
    for (const s of this.sessions) {
      if (s?.connected) s.send(msg);
    }
  }

  private broadcastEvent(event: GameEventMsg['event']): void {
    this.broadcast({ type: 'gameEvent', event } as never);
  }

  close(): void {
    this.closed = true;
    this.clearTimer();
    void this.closed;
  }
}

export function capDescription(resolved: ResolvedFanConfig): string {
  const cap = resolved.scoring.cap;
  if (!cap.enabled) return '不封顶';
  switch (cap.value.type) {
    case 'fixed':
      return `封顶 ${cap.value.fixed} 番`;
    case 'tiered':
      return `分档封顶 [${cap.value.tiers.join('/')}]`;
    case 'formula':
      return `动态封顶 ${cap.value.formula}`;
    case 'unlimited':
      return '不设番数封顶（受 hardCap 保护）';
  }
}

export function randomToken(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function randomRoomCode(): string {
  return String(1000 + Math.floor(Math.random() * 9000));
}
