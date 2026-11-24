/**
 * 对局状态机（服务端权威裁决与单机 PVE 共用）：
 * 发牌 → 回合（摸牌→出牌/杠/胡）→ 副露宣告（胡 > 碰/杠）→ 结算/流局。
 * 客户端只提交意图，合法性由本引擎裁决。
 */

import type { ResolvedFanConfig, TileId } from '@quejie/fan-config';
import { Wall } from './tileSet.js';
import { TileIndex } from './tileIndex.js';
import { checkWin, type MeldData, type WinCheckOptions } from './winCheck.js';
import { settleWin, type WinEvaluation } from './settle.js';
import { resolveHardCap } from './scoring.js';

export type Seat = number;
export const SEAT_WINDS = ['east', 'south', 'west', 'north'] as const;
export const SEAT_WIND_NAMES = ['东', '南', '西', '北'] as const;

export type ActionType = 'discard' | 'peng' | 'mingang' | 'bugang' | 'ankang' | 'hu' | 'pass';

export interface PlayerAction {
  type: ActionType;
  tile?: TileId;
}

export interface ActionOption {
  type: ActionType;
  tile?: TileId;
}

export interface GamePlayer {
  seat: Seat;
  name: string;
  hand: number[]; // counts by TileIndex
  melds: MeldData[];
  discards: TileId[];
  missLocks: Set<TileId>;
}

export type GameEvent =
  | { type: 'deal'; hands: TileId[][]; dealer: Seat; seed: number }
  | { type: 'draw'; seat: Seat; tile: TileId; fromKong: boolean }
  | { type: 'discard'; seat: Seat; tile: TileId }
  | { type: 'peng'; seat: Seat; tile: TileId; from: Seat }
  | { type: 'mingang'; seat: Seat; tile: TileId; from: Seat }
  | { type: 'ankang'; seat: Seat; tile: TileId }
  | { type: 'bugang'; seat: Seat; tile: TileId }
  | { type: 'kongScore'; from: Seat; to: Seat; amount: number; kind: 'mingang' | 'bugang' | 'ankang' }
  | { type: 'missLock'; seat: Seat; tile: TileId }
  | { type: 'hu'; seat: Seat; tile: TileId; via: 'self' | 'discard' | 'robKong'; fromSeat?: Seat; evaluation: WinEvaluation }
  | { type: 'payment'; from: Seat; to: Seat; amount: number; reason: string }
  | { type: 'settle'; settlements: WinnerSettlement[]; deltas: number[] }
  | { type: 'drawGame'; reason: 'wallExhausted'; refund: number; deltas: number[] };

export interface WinnerSettlement {
  winnerSeat: Seat;
  completingTile: TileId;
  via: 'self' | 'discard' | 'robKong';
  payerSeat: Seat | null;
  paymentKind: 'selfDraw' | 'discard' | 'bao';
  baoReasons: string[];
  score: number;
  finalFan: number;
  structureKind: string;
  fans: { fanId: string; name: string; value: number }[];
  suppressed: { fanId: string; name: string; value: number }[];
  bonus: { fanId: string; name: string; value: number; count?: number }[];
  chicken: boolean;
  lines: { key: string; label: string; detail: string }[];
  meta: WinEvaluation['scoreResult']['meta'];
}

export interface HandResult {
  outcome: 'win' | 'draw';
  winnerSeats: Seat[];
  settlements: WinnerSettlement[];
  deltas: number[];
  reason?: 'wallExhausted';
  dealerNext: Seat;
  replayMeta: ReplayMeta;
}

export interface ReplayMeta {
  playerCount?: number;
  fanConfigVersion: string;
  configHash: string;
  tileSetPresetId?: string;
  resolvedFanConfigHash: string;
  seed: number;
  dealer: Seat;
  roundWind: string;
  roomLevel: number;
  capValueType: string;
  capScope: string;
  hardCap: number;
  maxScore: number;
}

export class IllegalActionError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'IllegalActionError';
  }
}

interface ClaimWindow {
  tile: TileId;
  fromSeat: Seat;
  kind: 'discard' | 'robBugang' | 'robAnkang';
  pendingSeats: Seat[];
  options: Map<Seat, ActionOption[]>;
  responses: Map<Seat, PlayerAction>;
}

export interface GameOptions {
  playerCount?: number;
  resolved: ResolvedFanConfig;
  seed: number;
  dealer: Seat;
  roundWind?: string;
  roomLevel?: number;
  playerNames?: string[];
}

export class MahjongGame {
  readonly playerCount: number;
  readonly resolved: ResolvedFanConfig;
  readonly index: TileIndex;
  readonly wall: Wall;
  readonly players: GamePlayer[];
  readonly dealer: Seat;
  readonly roundWind: string;
  readonly roomLevel: number;
  readonly seed: number;

  phase: 'idle' | 'turn' | 'claim' | 'over' = 'idle';
  currentSeat: Seat = 0;
  drewTile: TileId | null = null;
  drewFromKong = false;
  lastDiscard: { seat: Seat; tile: TileId } | null = null;
  claim: ClaimWindow | null = null;
  readonly events: GameEvent[] = [];
  result: HandResult | null = null;

  /** 杠分账本（流局退回） */
  private kongLedger: { from: Seat; to: Seat; amount: number }[] = [];
  /** 每家第 4 组副露的供给者（十二张落地包牌） */
  readonly twelfthSupplier: (Seat | null)[] = [null, null, null, null];
  /** 大明杠供给者（放杠致杠上开花包牌） */
  mingangGiver: Seat | null = null;
  /** 抢杠窗口暂存的杠信息 */
  private pendingKong: { seat: Seat; kind: 'bugang' | 'ankang'; tile: TileId } | null = null;
  kongCount = 0;
  private scores = [0, 0, 0, 0];
  private lastSettlements: WinnerSettlement[] = [];

  constructor(options: GameOptions) {
    this.playerCount = options.playerCount ?? 4;
    if (![2, 3, 4].includes(this.playerCount) || options.dealer < 0 || options.dealer >= this.playerCount) throw new Error('人数必须为2至4人，庄家必须在座');
    this.scores = Array(this.playerCount).fill(0);
    this.resolved = options.resolved;
    this.index = new TileIndex(options.resolved);
    this.wall = new Wall(options.resolved, options.seed);
    this.seed = options.seed;
    this.dealer = options.dealer;
    this.roundWind = options.roundWind ?? SEAT_WINDS[options.dealer]!;
    this.roomLevel = options.roomLevel ?? 1;
    this.players = Array.from({ length: this.playerCount }, (_, i) => i).map((seat) => ({
      seat,
      name: options.playerNames?.[seat] ?? `玩家${seat + 1}`,
      hand: new Array<number>(this.index.ids.length).fill(0),
      melds: [],
      discards: [],
      missLocks: new Set<TileId>(),
    }));
    this.currentSeat = options.dealer;
  }

  private get rules() {
    return this.resolved.rules;
  }

  private wildMode(): boolean {
    return this.resolved.redCenterMode === 'wild';
  }

  private canClaimTile(tile: TileId): boolean {
    return !(this.wildMode() && tile === this.index.wildcardTile);
  }

  private winCheckOpts(): WinCheckOptions {
    const fan = (id: string) => this.resolved.fans.find((f) => f.id === id);
    return {
      sevenPairsEnabled: fan('sevenPairs')?.enabled === true,
      sevenPairsWithWild: this.resolved.sevenPairsWithWild,
      thirteenOrphansEnabled: fan('thirteenOrphans')?.enabled === true,
    };
  }

  // —— 开局 ——
  start(): void {
    if (this.phase !== 'idle') throw new IllegalActionError('E_STATE', '对局已开始');
    const hands: TileId[][] = [];
    for (const p of this.players) {
      const tiles: TileId[] = [];
      for (let i = 0; i < 13; i++) {
        const t = this.wall.drawFromHead();
        if (!t) throw new IllegalActionError('E_WALL', '牌墙不足以发牌');
        p.hand[this.index.idx(t)]!++;
        tiles.push(t);
      }
      hands.push(tiles);
    }
    this.events.push({ type: 'deal', hands, dealer: this.dealer, seed: this.seed });
    for (let i = 0; i < this.resolved.tileSet.dealerExtraTile; i++) {
      this.drawFor(this.currentSeat, false);
    }
    this.phase = 'turn';
  }

  private drawFor(seat: Seat, fromKong: boolean): TileId {
    const tile = fromKong ? this.wall.drawFromTail() : this.wall.drawFromHead();
    if (!tile) throw new IllegalActionError('E_WALL', '牌墙已空');
    const p = this.players[seat]!;
    p.hand[this.index.idx(tile)]!++;
    p.missLocks.clear(); // 摸牌解除漏胡锁
    this.drewTile = tile;
    this.drewFromKong = fromKong;
    this.events.push({ type: 'draw', seat, tile, fromKong });
    return tile;
  }

  handTiles(seat: Seat): TileId[] {
    const p = this.players[seat]!;
    const tiles: TileId[] = [];
    p.hand.forEach((c, i) => {
      for (let k = 0; k < c; k++) tiles.push(this.index.tile(i));
    });
    return tiles;
  }

  /** 会让指定的听牌手牌立即自摸的牌面，按当前规则判定。 */
  winningDraws(seat: Seat, hand = this.players[seat]!.hand): number[] {
    const { melds } = this.players[seat]!;
    if (hand.reduce((total, count) => total + count, 0) !== 3 * (4 - melds.length) + 1) return [];
    const owned = [...hand];
    for (const meld of melds) owned[this.index.idx(meld.tile)]! += meld.type === 'peng' ? 3 : 4;
    const trial = [...hand];
    const options = this.winCheckOpts();
    const winning: number[] = [];
    for (let i = 0; i < trial.length; i++) {
      if (owned[i]! >= this.index.copies[i]!) continue;
      trial[i]!++;
      if (checkWin(trial, melds, this.index, options).win) winning.push(i);
      trial[i]!--;
    }
    return winning;
  }

  // —— 合法动作 ——
  legalOptions(seat: Seat): ActionOption[] {
    if (this.phase === 'over') return [];
    if (this.phase === 'claim' && this.claim) {
      if (!this.claim.pendingSeats.includes(seat)) return [];
      if (this.claim.responses.has(seat)) return [];
      return this.claim.options.get(seat) ?? [];
    }
    if (this.phase !== 'turn' || seat !== this.currentSeat) return [];
    const p = this.players[seat]!;
    const opts: ActionOption[] = [];
    if (this.drewTile !== null && this.canSelfWin(seat)) {
      opts.push({ type: 'hu' });
    }
    for (let i = 0; i < p.hand.length; i++) {
      if (p.hand[i] === 4) opts.push({ type: 'ankang', tile: this.index.tile(i) });
    }
    for (let i = 0; i < p.hand.length; i++) {
      const tile = this.index.tile(i);
      if (p.hand[i]! >= 1 && this.hasPengOf(seat, tile) && this.canClaimTile(tile)) {
        opts.push({ type: 'bugang', tile });
      }
    }
    for (let i = 0; i < p.hand.length; i++) {
      if (p.hand[i]! > 0) opts.push({ type: 'discard', tile: this.index.tile(i) });
    }
    return opts;
  }

  private hasPengOf(seat: Seat, tile: TileId): boolean {
    return this.players[seat]!.melds.some((m) => m.type === 'peng' && m.tile === tile);
  }

  private canSelfWin(seat: Seat): boolean {
    return checkWin([...this.players[seat]!.hand], this.players[seat]!.melds, this.index, this.winCheckOpts()).win;
  }

  private canWinWith(seat: Seat, tile: TileId): { win: boolean; thirteenOrphans: boolean } {
    const p = this.players[seat]!;
    const counts = [...p.hand];
    counts[this.index.idx(tile)]!++;
    const r = checkWin(counts, p.melds, this.index, this.winCheckOpts());
    return { win: r.win, thirteenOrphans: r.thirteenOrphans };
  }

  // —— 动作入口 ——
  action(seat: Seat, action: PlayerAction): void {
    if (this.phase === 'over') throw new IllegalActionError('E_OVER', '对局已结束');
    if (this.phase === 'claim') {
      this.submitClaim(seat, action);
      return;
    }
    if (this.phase !== 'turn') throw new IllegalActionError('E_STATE', `当前阶段 ${this.phase} 不接受动作`);
    if (seat !== this.currentSeat) {
      throw new IllegalActionError('E_NOT_YOUR_TURN', `非当前玩家回合（当前: ${this.currentSeat}）`);
    }
    const legal = this.legalOptions(seat);
    const ok = legal.some(
      (o) => o.type === action.type && (o.tile === undefined || action.tile === undefined || o.tile === action.tile),
    );
    if (!ok) throw new IllegalActionError('E_ILLEGAL_ACTION', `非法动作 ${JSON.stringify(action)}`);

    switch (action.type) {
      case 'discard':
        this.doDiscard(seat, action.tile!);
        return;
      case 'hu':
        this.doWin(seat, 'self', this.drewTile!, undefined);
        this.finishWin();
        return;
      case 'ankang':
        this.beginKong(seat, 'ankang', action.tile!);
        return;
      case 'bugang':
        this.beginKong(seat, 'bugang', action.tile!);
        return;
      default:
        throw new IllegalActionError('E_ILLEGAL_ACTION', `回合阶段不支持动作 ${action.type}`);
    }
  }

  private submitClaim(seat: Seat, action: PlayerAction): void {
    const claim = this.claim;
    if (!claim) throw new IllegalActionError('E_STATE', '当前无宣告窗口');
    if (!claim.pendingSeats.includes(seat)) {
      throw new IllegalActionError('E_NOT_ELIGIBLE', `座位 ${seat} 无权响应本次宣告`);
    }
    if (claim.responses.has(seat)) throw new IllegalActionError('E_ALREADY', '该座位已响应');
    const legal = claim.options.get(seat) ?? [];
    const ok = legal.some(
      (o) => o.type === action.type && (o.tile === undefined || action.tile === undefined || o.tile === action.tile),
    );
    if (!ok) throw new IllegalActionError('E_ILLEGAL_ACTION', `非法宣告 ${JSON.stringify(action)}`);
    claim.responses.set(seat, action);
    this.tryResolveClaims();
  }

  /** 超时未响应 → 自动过（服务端托管用） */
  autoPassPending(): void {
    if (!this.claim) return;
    for (const seat of this.claim.pendingSeats) {
      if (!this.claim.responses.has(seat)) this.claim.responses.set(seat, { type: 'pass' });
    }
    this.tryResolveClaims();
  }

  private tryResolveClaims(): void {
    const claim = this.claim;
    if (!claim) return;
    if (claim.pendingSeats.some((s) => !claim.responses.has(s))) return;
    this.claim = null;
    this.resolveClaims(claim);
  }

  private lockMissed(seat: Seat, tile: TileId, hadHuOption: boolean): void {
    if (hadHuOption && this.rules.missedWinLock) {
      this.players[seat]!.missLocks.add(tile);
      this.events.push({ type: 'missLock', seat, tile });
    }
  }

  private resolveClaims(claim: ClaimWindow): void {
    const dist = (s: Seat) => (s - claim.fromSeat + this.playerCount) % this.playerCount;
    const huSeats = claim.pendingSeats
      .filter((s) => claim.responses.get(s)!.type === 'hu')
      .sort((a, b) => dist(a) - dist(b));

    if (huSeats.length > 0) {
      const winners = this.rules.multiWinEnabled ? huSeats : [huSeats[0]!];
      for (const s of claim.pendingSeats) {
        if (!winners.includes(s)) {
          const hadHu = (claim.options.get(s) ?? []).some((o) => o.type === 'hu');
          this.lockMissed(s, claim.tile, hadHu);
        }
      }
      for (const w of winners) {
        this.doWin(
          w,
          claim.kind === 'discard' ? 'discard' : 'robKong',
          claim.tile,
          claim.fromSeat,
        );
      }
      this.finishWin();
      return;
    }

    // 全部放弃：漏胡锁
    for (const s of claim.pendingSeats) {
      const hadHu = (claim.options.get(s) ?? []).some((o) => o.type === 'hu');
      this.lockMissed(s, claim.tile, hadHu);
    }

    if (claim.kind !== 'discard') {
      // 抢杠全部放弃 → 杠成立
      this.completeKongAfterRobberyCheck();
      return;
    }

    const claimers = claim.pendingSeats
      .filter((s) => ['peng', 'mingang'].includes(claim.responses.get(s)!.type))
      .sort((a, b) => dist(a) - dist(b));
    const claimer = claimers[0];
    if (claimer === undefined) {
      this.afterDiscardNoClaim(claim.fromSeat);
      return;
    }
    const resp = claim.responses.get(claimer)!;
    if (resp.type === 'peng') this.applyPeng(claimer, claim.tile, claim.fromSeat);
    else this.applyMingang(claimer, claim.tile, claim.fromSeat);
  }

  // —— 出牌 ——
  private doDiscard(seat: Seat, tile: TileId): void {
    const p = this.players[seat]!;
    p.hand[this.index.idx(tile)]!--;
    p.discards.push(tile);
    this.drewTile = null;
    this.drewFromKong = false;
    this.lastDiscard = { seat, tile };
    this.events.push({ type: 'discard', seat, tile });
    this.openClaimWindow(tile, seat, 'discard');
  }

  /** 出牌无人宣告：下家摸牌或流局 */
  private afterDiscardNoClaim(discarder: Seat): void {
    if (this.wall.exhausted) {
      this.doDrawGame();
      return;
    }
    this.currentSeat = (discarder + 1) % this.playerCount;
    this.mingangGiver = null;
    this.drawFor(this.currentSeat, false);
    this.phase = 'turn';
  }

  /** 计算各家对目标牌的合法响应，打开宣告窗口 */
  private openClaimWindow(tile: TileId, fromSeat: Seat, kind: ClaimWindow['kind']): void {
    if (kind !== 'discard') {
      this.pendingKong = { seat: fromSeat, kind: kind === 'robBugang' ? 'bugang' : 'ankang', tile };
    }
    const options = new Map<Seat, ActionOption[]>();
    const pending: Seat[] = [];
    for (let s = 0; s < this.playerCount; s++) {
      if (s === fromSeat) continue;
      const p = this.players[s]!;
      const seatOpts: ActionOption[] = [];
      const canClaimHu = (kind !== 'discard' || this.rules.allowDiscardHu !== false) &&
        !p.missLocks.has(tile) && !this.resolved.redCenterDrawOnly;
      if (canClaimHu) {
        const w = this.canWinWith(s, tile);
        if (w.win && (kind !== 'robAnkang' || (w.thirteenOrphans && this.rules.robConcealedKongForThirteenOrphans))) {
          seatOpts.push({ type: 'hu' });
        }
      }
      if (kind === 'discard') {
        if (p.hand[this.index.idx(tile)]! >= 2 && this.canClaimTile(tile)) {
          seatOpts.push({ type: 'peng', tile });
        }
        if (p.hand[this.index.idx(tile)] === 3 && this.canClaimTile(tile)) {
          seatOpts.push({ type: 'mingang', tile });
        }
      }
      seatOpts.push({ type: 'pass' });
      options.set(s, seatOpts);
      if (seatOpts.length > 1) pending.push(s);
    }
    if (pending.length === 0) {
      if (kind === 'discard') {
        this.afterDiscardNoClaim(fromSeat);
      } else {
        this.completeKongAfterRobberyCheck();
      }
      return;
    }
    this.claim = { tile, fromSeat, kind, pendingSeats: pending, options, responses: new Map() };
    this.phase = 'claim';
  }

  /** 抢杠窗口全部放弃 → 完成杠 */
  private completeKongAfterRobberyCheck(): void {
    const pk = this.pendingKong!;
    this.pendingKong = null;
    if (pk.kind === 'bugang') this.applyBugang(pk.seat, pk.tile);
    else this.applyAnkang(pk.seat, pk.tile);
  }

  // —— 碰 / 杠 ——
  private applyPeng(seat: Seat, tile: TileId, from: Seat): void {
    const p = this.players[seat]!;
    p.hand[this.index.idx(tile)] -= 2;
    this.players[from]!.discards.pop();
    p.melds.push({ type: 'peng', tile, fromSeat: from });
    p.missLocks.clear(); // 碰解除漏胡锁
    this.events.push({ type: 'peng', seat, tile, from });
    this.updateTwelfthSupplier(seat, from);
    this.afterClaimTurn(seat, false);
  }

  private applyMingang(seat: Seat, tile: TileId, from: Seat): void {
    const p = this.players[seat]!;
    p.hand[this.index.idx(tile)] -= 3;
    this.players[from]!.discards.pop();
    p.melds.push({ type: 'mingang', tile, fromSeat: from });
    p.missLocks.clear();
    this.kongCount++;
    this.settleKongScore(from, seat, 'mingang');
    this.events.push({ type: 'mingang', seat, tile, from });
    this.mingangGiver = from;
    this.updateTwelfthSupplier(seat, from);
    this.afterClaimTurn(seat, true); // 墙尾补牌
  }

  private applyAnkang(seat: Seat, tile: TileId): void {
    const p = this.players[seat]!;
    p.hand[this.index.idx(tile)] -= 4;
    p.melds.push({ type: 'ankang', tile });
    this.kongCount++;
    this.settleKongScoreAll(seat, 'ankang');
    this.events.push({ type: 'ankang', seat, tile });
    this.afterClaimTurn(seat, true); // 墙尾补牌
  }

  private applyBugang(seat: Seat, tile: TileId): void {
    const p = this.players[seat]!;
    p.hand[this.index.idx(tile)]!--;
    const meld = p.melds.find((m) => m.type === 'peng' && m.tile === tile);
    if (!meld) throw new IllegalActionError('E_ILLEGAL_ACTION', '补杠缺少对应碰');
    meld.type = 'bugang';
    this.kongCount++;
    this.settleKongScoreAll(seat, 'bugang');
    this.events.push({ type: 'bugang', seat, tile });
    this.afterClaimTurn(seat, false); // 补杠无补牌
  }

  private beginKong(seat: Seat, kind: 'ankang' | 'bugang', tile: TileId): void {
    if (kind === 'bugang' && !this.canClaimTile(tile)) {
      throw new IllegalActionError('E_WILD_KONG', 'wild 模式红中不能补杠');
    }
    this.openClaimWindow(tile, seat, kind === 'bugang' ? 'robBugang' : 'robAnkang');
  }

  /** 宣告（碰/杠）后的回合状态 */
  private afterClaimTurn(seat: Seat, kongReplace: boolean): void {
    this.currentSeat = seat;
    if (kongReplace) {
      this.drawFor(seat, true);
    } else {
      this.drewTile = null;
      this.drewFromKong = false;
    }
    this.phase = 'turn';
  }

  private kongAmount(kind: 'mingang' | 'bugang' | 'ankang'): number {
    const ks = this.rules.kongScores;
    const mult =
      kind === 'mingang'
        ? (ks.mingangPayerMultiplier ?? 3)
        : kind === 'bugang'
          ? (ks.bugangEach ?? 1)
          : (ks.ankangEach ?? 2);
    return this.resolved.scoring.baseScore * mult;
  }

  private settleKongScore(from: Seat, to: Seat, kind: 'mingang' | 'bugang' | 'ankang'): void {
    const amount = this.kongAmount(kind);
    this.scores[from]! -= amount;
    this.scores[to]! += amount;
    this.kongLedger.push({ from, to, amount });
    this.events.push({ type: 'kongScore', from, to, amount, kind });
  }

  private settleKongScoreAll(to: Seat, kind: 'bugang' | 'ankang'): void {
    for (let s = 0; s < this.playerCount; s++) {
      if (s !== to) this.settleKongScore(s, to, kind);
    }
  }

  private updateTwelfthSupplier(seat: Seat, from: Seat): void {
    if (this.players[seat]!.melds.length === 4 && this.twelfthSupplier[seat] === null) {
      this.twelfthSupplier[seat] = from;
    }
  }

  // —— 胡牌 ——
  private doWin(winnerSeat: Seat, via: 'self' | 'discard' | 'robKong', tile: TileId, fromSeat: Seat | undefined): void {
    const winner = this.players[winnerSeat]!;
    // 点炮/抢杠：完成牌从供牌方转入胜者手牌
    if (via !== 'self') {
      const from = this.players[fromSeat!]!;
      const riverIdx = from.discards.lastIndexOf(tile);
      if (riverIdx >= 0) from.discards.splice(riverIdx, 1);
      else if (via === 'robKong') {
        // 抢杠：牌仍在被抢杠者手牌中（补杠尚未成立），从其手牌转移
        from.hand[this.index.idx(tile)]!--;
      }
      winner.hand[this.index.idx(tile)]++;
    }
    const concealed = this.handTiles(winnerSeat);
    const kongBlossom = via === 'self' && this.drewFromKong;
    const evaluation = settleWin(this.resolved, this.index, {
      winnerSeat,
      completingTile: tile,
      via,
      concealedTiles: concealed,
      exposedMelds: winner.melds,
      kongBlossom,
      seatWind: SEAT_WINDS[winnerSeat]!,
      roundWind: this.roundWind,
      dealer: winnerSeat === this.dealer,
      kongCount: this.kongCount,
      wallTiles: this.wall.liveRemaining,
      playerCount: this.playerCount,
      roomLevel: this.roomLevel,
    });

    // —— 支付与包三家（PRD 5.6）——
    let paymentKind: WinnerSettlement['paymentKind'];
    let payerSeat: Seat | null;
    const baoReasons: string[] = [];
    if (via === 'self') {
      payerSeat = null;
      paymentKind = 'selfDraw';
      if (kongBlossom && this.mingangGiver !== null && this.rules.baoKongBlossom) {
        paymentKind = 'bao';
        payerSeat = this.mingangGiver;
        baoReasons.push('放杠致杠上开花');
      }
      if (
        paymentKind === 'selfDraw' &&
        winner.melds.length === 4 &&
        this.twelfthSupplier[winnerSeat] !== null &&
        this.rules.baoTwelveExposed
      ) {
        paymentKind = 'bao';
        payerSeat = this.twelfthSupplier[winnerSeat]!;
        baoReasons.push('十二张落地单吊自摸');
      }
    } else if (via === 'robKong') {
      // 补杠被抢杠 → 被抢杠者包三家
      payerSeat = fromSeat!;
      paymentKind = this.rules.baoRobKong ? 'bao' : 'discard';
      if (paymentKind === 'bao') baoReasons.push('补杠被抢杠');
    } else {
      const discarder = fromSeat!;
      payerSeat = discarder;
      paymentKind = 'discard';
      if (this.rules.baoTwelveExposed && this.players[discarder]!.melds.length === 4) {
        paymentKind = 'bao';
        baoReasons.push('十二张落地后点炮');
      }
      if (
        this.rules.baoBigDragonWind &&
        winner.melds.length === 4 &&
        winner.melds[3]!.fromSeat === discarder &&
        evaluation.fanEval.matched.some((m) => m.fanId === 'bigDragons' || m.fanId === 'bigWinds')
      ) {
        paymentKind = 'bao';
        baoReasons.push('大三元/大四喜最后一组由同一人打出');
      }
    }

    const score = evaluation.score;
    const deltas = Array<number>(this.playerCount).fill(0);
    if (paymentKind === 'bao') {
      deltas[payerSeat!]! -= score * (this.playerCount - 1);
      deltas[winnerSeat]! += score * (this.playerCount - 1);
      this.events.push({
        type: 'payment',
        from: payerSeat!,
        to: winnerSeat,
        amount: score * (this.playerCount - 1),
        reason: `包三家（${baoReasons.join('；')}）`,
      });
    } else if (paymentKind === 'selfDraw') {
      for (let s = 0; s < this.playerCount; s++) {
        if (s !== winnerSeat) {
          deltas[s]! -= score;
          deltas[winnerSeat]! += score;
          this.events.push({ type: 'payment', from: s, to: winnerSeat, amount: score, reason: '自摸' });
        }
      }
    } else {
      deltas[payerSeat!]! -= score;
      deltas[winnerSeat]! += score;
      this.events.push({ type: 'payment', from: payerSeat!, to: winnerSeat, amount: score, reason: '点炮' });
    }
    for (let s = 0; s < this.playerCount; s++) this.scores[s]! += deltas[s]!;

    const settlement: WinnerSettlement = {
      winnerSeat,
      completingTile: tile,
      via,
      payerSeat,
      paymentKind,
      baoReasons,
      score,
      finalFan: evaluation.finalFan,
      structureKind: evaluation.structureKind,
      fans: evaluation.fanEval.matched.map((m) => ({ fanId: m.fanId, name: m.name, value: m.value })),
      suppressed: evaluation.fanEval.suppressed.map((m) => ({ fanId: m.fanId, name: m.name, value: m.value })),
      bonus: evaluation.fanEval.bonus.map((b) => ({ fanId: b.fanId, name: b.name, value: b.value, count: b.count })),
      chicken: evaluation.fanEval.chickenApplied,
      lines: evaluation.lines,
      meta: evaluation.scoreResult.meta,
    };
    this.events.push({ type: 'hu', seat: winnerSeat, tile, via, fromSeat, evaluation });
    this.lastSettlements.push(settlement);
  }

  // —— 流局 ——
  private doDrawGame(): void {
    let refund = 0;
    for (const entry of this.kongLedger) {
      this.scores[entry.from]! += entry.amount;
      this.scores[entry.to]! -= entry.amount;
      refund += entry.amount;
    }
    this.phase = 'over';
    const deltas = [...this.scores];
    this.events.push({ type: 'drawGame', reason: 'wallExhausted', refund, deltas });
    this.result = {
      outcome: 'draw',
      winnerSeats: [],
      settlements: [],
      deltas,
      reason: 'wallExhausted',
      dealerNext: this.dealer, // 庄家流局连庄
      replayMeta: this.buildReplayMeta(),
    };
  }

  private buildReplayMeta(): ReplayMeta {
    const cap = this.resolved.scoring.cap;
    return {
      playerCount: this.playerCount,
      fanConfigVersion: this.resolved.version,
      configHash: this.resolved.configHash,
      tileSetPresetId: this.resolved.tileSetPresetId,
      resolvedFanConfigHash: this.resolved.resolvedFanConfigHash,
      seed: this.seed,
      dealer: this.dealer,
      roundWind: this.roundWind,
      roomLevel: this.roomLevel,
      capValueType: cap.value.type,
      capScope: cap.scope,
      hardCap: resolveHardCap(this.resolved),
      maxScore: cap.maxScore ?? -1,
    };
  }

  private finishWin(): void {
    const deltas = [...this.scores];
    const winners = this.lastSettlements.map((s) => s.winnerSeat);
    let dealerNext = this.dealer;
    if (winners.length > 0 && !winners.includes(this.dealer)) {
      dealerNext = (winners[0]! + 1) % this.playerCount; // 闲家胡牌下家坐庄；一炮多响含庄家则连庄
    }
    this.events.push({ type: 'settle', settlements: this.lastSettlements, deltas });
    this.result = {
      outcome: 'win',
      winnerSeats: winners,
      settlements: [...this.lastSettlements],
      deltas,
      dealerNext,
      replayMeta: this.buildReplayMeta(),
    };
    this.phase = 'over';
  }
}
