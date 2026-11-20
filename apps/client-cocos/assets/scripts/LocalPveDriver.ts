/**
 * 本地 PVE 驱动：1 人类（座位 0）+ 3 AI（aiDecide hard）离线对局。
 * 直接驱动 mahjong-core 的 MahjongGame，把引擎状态转换为协议同构快照/事件/结算，
 * 经由 GameManager 转发给 TableScene —— 与联机模式共用同一渲染管线。
 */

import { _decorator, Component } from 'cc';
import {
  MahjongGame,
  aiDecide,
  type ActionOption,
  type Difficulty,
  type GameEvent,
  type PlayerAction,
  type Seat,
  type WinnerSettlement,
} from '@quejie/mahjong-core';
import {
  autoDisableUnmetFans,
  clonePreset,
  defaultFanConfig,
  resolveFanConfig,
  validateFanConfig,
  type ResolvedFanConfig,
} from '@quejie/fan-config';
import type { GameEventMsg, GameOverMsg, GameStateMsg, SettlementView } from '@quejie/protocol';
import { Tips } from './ui/Tips';

const { ccclass } = _decorator;

/** 人类固定坐 0 号位 */
const HUMAN_SEAT: Seat = 0;
/** 默认预设：gd128 红中变 */
const DEFAULT_PRESET = 'gd128';

/**
 * 微信小游戏等环境可能缺少 performance 全局，aiDecide 内部依赖 performance.now()。
 * 在模块加载时兜底注入（Date.now 与 performance.now 同为毫秒单调时钟，决策用途足够）。
 */
if (typeof performance === 'undefined') {
  (globalThis as unknown as { performance: { now(): number } }).performance = {
    now: () => Date.now(),
  };
}

/** PVE 对局启动参数 */
export interface LocalPveOptions {
  presetId?: string;
  seed?: number;
  dealer?: Seat;
  difficulty?: Difficulty;
  playerNames?: string[];
}

@ccclass('LocalPveDriver')
export class LocalPveDriver extends Component {
  /** —— 输出回调（由 GameManager 注入，事件经 GameManager 集中转发） —— */
  public onSnapshot: ((s: GameStateMsg) => void) | null = null;
  public onEvent: ((e: GameEventMsg['event']) => void) | null = null;
  public onOver: ((o: GameOverMsg) => void) | null = null;

  /** AI 难度（默认 hard） */
  public difficulty: Difficulty = 'hard';

  /** AI 出牌延时（ms，体感节奏） */
  public aiTurnDelayMs = 600;
  /** AI 宣告（碰/杠）响应延时（ms） */
  public aiClaimDelayMs = 400;
  /** 人类宣告窗口自动过时间（ms，超时未响应自动 pass） */
  public humanClaimAutoPassMs = 10000;

  /** 已解析规则配置（RulePanel 展示用） */
  public resolved: ResolvedFanConfig | null = null;

  /** 引擎实例与运行状态 */
  private game: MahjongGame | null = null;
  private running = false;
  /** 累计分数（跨局连庄保留；引擎每局内部分数从 0 计） */
  private cumulative = [0, 0, 0, 0] as number[];
  /** 引擎事件游标（增量排水） */
  private eventCursor = 0;
  /** 下一局庄家（结算时更新） */
  private lastDealerNext: Seat = 0;
  /** 最近使用的预设（连庄复用配置） */
  private lastPreset = DEFAULT_PRESET;

  /** AI 行动定时器防重入标记 */
  private aiTimerArmed = false;
  /** 人类宣告自动过定时器句柄（命名方法，可 unschedule） */
  private humanAutoPassTimerArmed = false;

  // —— 对局生命周期 ——

  /** 启动一局（首次或连庄下一局；resolved 配置按预设重建） */
  public startMatch(options: LocalPveOptions = {}): void {
    this.stopMatch();
    const presetId = options.presetId ?? this.lastPreset;
    this.lastPreset = presetId;
    this.resolved = this.buildResolved(presetId);
    const dealer = options.dealer ?? 0;
    const names = options.playerNames ?? ['你', 'AI·下家', 'AI·对家', 'AI·上家'];
    const seed = options.seed ?? Math.floor(Math.random() * 1_000_000_000);
    this.game = new MahjongGame({
      resolved: this.resolved,
      seed,
      dealer,
      playerNames: names,
    });
    if (options.difficulty) this.difficulty = options.difficulty;
    try {
      this.game.start();
    } catch (e) {
      Tips.show(`PVE 开局失败: ${(e as Error).message}`);
      this.game = null;
      return;
    }
    this.eventCursor = 0;
    this.running = true;
    this.aiTimerArmed = false;
    this.humanAutoPassTimerArmed = false;
    this.drainEvents(); // deal 事件（无协议映射，仅推进游标）
    this.step();
  }

  /** 连庄开下一局（沿用累计分数与最近预设） */
  public startNextHand(): void {
    this.startMatch({ dealer: this.lastDealerNext, presetId: this.lastPreset });
  }

  /** 停止并清场（返回大厅/重开时调用） */
  public stopMatch(): void {
    this.running = false;
    this.game = null;
    this.aiTimerArmed = false;
    this.humanAutoPassTimerArmed = false;
    this.unscheduleAllCallbacks();
  }

  /** 人类提交动作（TableScene → GameManager → 此处）；合法性先经引擎校验 */
  public submitHuman(action: PlayerAction): void {
    const g = this.game;
    if (!g || !this.running) return;
    const legal = g.legalOptions(HUMAN_SEAT);
    const ok = legal.some(
      (o: ActionOption) => o.type === action.type && (o.tile === undefined || action.tile === undefined || o.tile === action.tile),
    );
    if (!ok) {
      Tips.show('不合法动作');
      return;
    }
    this.applyEngineAction(HUMAN_SEAT, action);
    this.drainEvents();
    this.step();
  }

  // —— 回合驱动核心 ——

  /** 状态推进：结束→结算；宣告→AI 响应调度；回合→AI 行动调度或等待人类 */
  private step(): void {
    const g = this.game;
    if (!g || !this.running) return;
    if (g.phase === 'over') {
      this.finish();
      return;
    }
    this.emitSnapshot();

    if (g.phase === 'claim') {
      this.driveClaim();
    } else if (g.phase === 'turn') {
      if (g.currentSeat === HUMAN_SEAT) {
        // 等待人类出牌/自摸胡/杠（快照 legalOptions 已下发，ActionPanel/手牌触摸驱动）
        return;
      }
      this.armAiTimer(this.aiTurnDelayMs);
    }
  }

  /** 宣告窗口驱动：AI 座位逐个延时响应；人类在窗则挂自动过定时器 */
  private driveClaim(): void {
    const g = this.game!;
    let aiPending = false;
    let humanPending = false;
    for (let s = 0 as Seat; s < 4; s++) {
      const opts = g.legalOptions(s);
      if (opts.length === 0) continue;
      if (s === HUMAN_SEAT) humanPending = true;
      else aiPending = true;
    }
    if (aiPending && !this.aiTimerArmed) {
      this.armAiTimer(this.aiClaimDelayMs);
    }
    if (humanPending) {
      this.armHumanAutoPass();
    }
  }

  /** AI 定时器：到点执行一次 AI 行动（宣告响应或回合行动） */
  private armAiTimer(delayMs: number): void {
    if (this.aiTimerArmed) return;
    this.aiTimerArmed = true;
    this.scheduleOnce(() => {
      this.aiTimerArmed = false;
      this.aiStep();
    }, Math.max(0.05, delayMs / 1000));
  }

  /** 单次 AI 行动：按当前阶段选择响应或出牌 */
  private aiStep(): void {
    const g = this.game;
    if (!g || !this.running) return;
    if (g.phase === 'over') {
      this.finish();
      return;
    }
    if (g.phase === 'claim') {
      // 找第一个待响应 AI 座位，决策并提交
      for (let s = 0 as Seat; s < 4; s++) {
        if (s === HUMAN_SEAT) continue;
        const opts = g.legalOptions(s);
        if (opts.length === 0) continue;
        const decision = aiDecide(g, s, { difficulty: this.difficulty });
        this.applyEngineAction(s, decision);
        break;
      }
    } else if (g.phase === 'turn' && g.currentSeat !== HUMAN_SEAT) {
      const decision = aiDecide(g, g.currentSeat, { difficulty: this.difficulty });
      this.applyEngineAction(g.currentSeat, decision);
    }
    this.drainEvents();
    this.step();
  }

  /** 人类宣告窗口自动过定时器（超时未响应自动 pass，避免卡局） */
  private armHumanAutoPass(): void {
    if (this.humanAutoPassTimerArmed) return;
    this.humanAutoPassTimerArmed = true;
    this.scheduleOnce(() => {
      this.humanAutoPassTimerArmed = false;
      const g = this.game;
      if (!g || !this.running || g.phase !== 'claim') return;
      const opts = g.legalOptions(HUMAN_SEAT);
      if (opts.length === 0) return;
      Tips.show('超时自动过');
      this.applyEngineAction(HUMAN_SEAT, { type: 'pass' });
      this.drainEvents();
      this.step();
    }, Math.max(1, this.humanClaimAutoPassMs / 1000));
  }

  /** 引擎动作包装：失败自动降级为 pass（AI 决策永远来自合法列表，此处为兜底） */
  private applyEngineAction(seat: Seat, action: PlayerAction): void {
    const g = this.game;
    if (!g) return;
    try {
      g.action(seat, action);
    } catch (e) {
      void e;
      try {
        g.action(seat, { type: 'pass' });
      } catch (e2) {
        void e2; // 回合阶段 pass 非法：仅放弃本次动作
      }
    }
  }

  // —— 状态转换与推送 ——

  /** 排水引擎新增事件 → 协议事件转发 + 分数累加 */
  private drainEvents(): void {
    const g = this.game;
    if (!g) return;
    while (this.eventCursor < g.events.length) {
      const ev = g.events[this.eventCursor++]!;
      // 分数：杠分与支付事件实时累加（结算事件直接同步引擎账本）
      if (ev.type === 'kongScore') {
        this.cumulative[ev.from] = (this.cumulative[ev.from] ?? 0) - ev.amount;
        this.cumulative[ev.to] = (this.cumulative[ev.to] ?? 0) + ev.amount;
      } else if (ev.type === 'payment') {
        this.cumulative[ev.from] = (this.cumulative[ev.from] ?? 0) - ev.amount;
        this.cumulative[ev.to] = (this.cumulative[ev.to] ?? 0) + ev.amount;
      }
      const mapped = toProtocolEvent(ev);
      if (mapped && this.onEvent) this.onEvent(mapped);
    }
  }

  /** 构建人类视角快照（结构与联机 GameStateMsg 同构，TableScene 无感知差异） */
  private buildSnapshot(): GameStateMsg {
    const g = this.game!;
    const seats = [0, 1, 2, 3].map((seat) => {
      const p = g.players[seat]!;
      return {
        seat,
        name: p.name,
        handCount: p.hand.reduce((a, c) => a + c, 0),
        melds: p.melds.map((m) => ({
          type: m.type,
          tile: m.tile,
          fromSeat: m.fromSeat,
        })),
        discards: [...p.discards],
        connected: true,
        ai: seat !== HUMAN_SEAT,
      };
    });
    const hand = expandTiles(g.players[HUMAN_SEAT]!.hand, g);
    const drew =
      g.phase === 'turn' && g.currentSeat === HUMAN_SEAT ? g.drewTile : null;
    return {
      type: 'gameState',
      viewSeat: HUMAN_SEAT,
      dealer: g.dealer,
      currentSeat: g.currentSeat,
      phase: g.phase,
      seats,
      hand,
      drewTile: drew,
      wallRemaining: g.wall.liveRemaining,
      deadWall: g.wall.deadWallCount,
      legalOptions: g.legalOptions(HUMAN_SEAT).map((o) => ({ type: o.type, tile: o.tile })),
      claimTile: g.claim ? g.claim.tile : undefined,
      claimFrom: g.claim ? g.claim.fromSeat : undefined,
      scores: [...this.cumulative],
      actionDeadlineMs: this.humanAutoPassTimerArmed ? this.humanClaimAutoPassMs : undefined,
    };
  }

  private emitSnapshot(): void {
    if (this.onSnapshot) this.onSnapshot(this.buildSnapshot());
  }

  /** 结算：引擎 HandResult → GameOverMsg（deltas=本局分，scores=累计分） */
  private finish(): void {
    const g = this.game;
    if (!g) return;
    const result = g.result;
    if (!result) return;
    this.drainEvents();
    const deltas = [...result.deltas];
    this.cumulative = this.cumulative.map((c, i) => c + (deltas[i] ?? 0));
    this.lastDealerNext = result.dealerNext;
    const msg: GameOverMsg = {
      type: 'gameOver',
      outcome: result.outcome,
      settlements: result.settlements.map((s) => toSettlementView(s)),
      deltas,
      scores: [...this.cumulative],
      dealerNext: result.dealerNext,
      replayMeta: {
        mode: 'local-pve',
        seed: g.seed,
        presetId: this.resolved?.tileSetPresetId ?? '',
        resolvedFanConfigHash: this.resolved?.resolvedFanConfigHash ?? '',
      },
    };
    this.running = false;
    if (this.onOver) this.onOver(msg);
  }

  /** 按预设构建已解析配置（与服务端 resolvedConfig 同口径：autoDisable + 校验 + resolve） */
  private buildResolved(presetId: string): ResolvedFanConfig {
    const cfg = defaultFanConfig();
    cfg.tileSet = clonePreset(presetId);
    cfg.tileSet.preset = presetId;
    if (cfg.tileSet.redCenterMode !== 'wild') {
      cfg.scoring.redCenterBonus.enabled = false;
    }
    const { config } = autoDisableUnmetFans(cfg);
    const v = validateFanConfig(config);
    if (!v.ok) {
      throw new Error(`PVE 配置校验失败: ${v.errors.map((e) => e.message).join('; ')}`);
    }
    const r = resolveFanConfig(config, { strictDependency: false });
    if (!r.ok || !r.resolved) {
      throw new Error(`PVE 配置解析失败: ${r.errors.map((e) => e.message).join('; ')}`);
    }
    return r.resolved;
  }
}

// —— 纯函数：类型转换（引擎 → 协议） ——

/** 把手牌计数数组展开为 TileId 列表 */
function expandTiles(counts: number[], g: MahjongGame): string[] {
  const tiles: string[] = [];
  counts.forEach((c, i) => {
    for (let k = 0; k < c; k++) tiles.push(g.index.tile(i));
  });
  return tiles;
}

/** 引擎事件 → 协议事件（deal/payment/settle/drawGame 为内部事件，不映射） */
function toProtocolEvent(ev: GameEvent): GameEventMsg['event'] | null {
  switch (ev.type) {
    case 'draw':
      return { kind: 'draw', seat: ev.seat };
    case 'discard':
      return { kind: 'discard', seat: ev.seat, tile: ev.tile };
    case 'peng':
      return { kind: 'peng', seat: ev.seat, tile: ev.tile, from: ev.from };
    case 'mingang':
      return { kind: 'mingang', seat: ev.seat, tile: ev.tile, from: ev.from };
    case 'ankang':
      return { kind: 'ankang', seat: ev.seat, tile: ev.tile };
    case 'bugang':
      return { kind: 'bugang', seat: ev.seat, tile: ev.tile };
    case 'kongScore':
      return { kind: 'kongScore', from: ev.from, to: ev.to, amount: ev.amount };
    case 'missLock':
      return { kind: 'missLock', seat: ev.seat, tile: ev.tile };
    case 'hu':
      return { kind: 'hu', seat: ev.seat, via: ev.via, fromSeat: ev.fromSeat };
    default:
      return null;
  }
}

/** 引擎结算 → 协议结算视图（PRD 7.4 字段子集） */
function toSettlementView(s: WinnerSettlement): SettlementView {
  return {
    winnerSeat: s.winnerSeat,
    via: s.via,
    payerSeat: s.payerSeat,
    paymentKind: s.paymentKind,
    baoReasons: [...s.baoReasons],
    score: s.score,
    finalFan: s.finalFan,
    fans: s.fans.map((f) => ({ fanId: f.fanId, name: f.name, value: f.value })),
    bonus: s.bonus.map((b) => ({ fanId: b.fanId, name: b.name, value: b.value, count: b.count })),
    chicken: s.chicken,
    lines: s.lines.map((l) => ({ key: l.key, label: l.label, detail: l.detail })),
  };
}
