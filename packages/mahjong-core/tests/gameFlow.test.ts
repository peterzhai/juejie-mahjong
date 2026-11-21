/**
 * P3/P5：对局状态机确定性测试（手牌/副露注入，覆盖碰杠抢杠/漏胡锁/流局/连庄）
 */

import { describe, expect, it } from 'vitest';
import type { ResolvedFanConfig } from '@quejie/fan-config';
import { makeConfig, autoPlay } from './helpers.js';
import { MahjongGame, IllegalActionError, type MeldData, type PlayerAction, type Seat } from '../src/index.js';

const gd136 = makeConfig('gd136');
const gd128 = makeConfig('gd128');

/** 注入手牌（覆盖式）并开局。hands[dealer] 为 14 张（含首摸），其余 13 张 */
function setup(
  resolved: ResolvedFanConfig,
  seed: number,
  hands: string[][],
  melds: MeldData[][] = [[], [], [], []],
  dealer: Seat = 0,
): MahjongGame {
  const game = new MahjongGame({ resolved, seed, dealer, roundWind: 'east' });
  game.start();
  for (let s = 0; s < 4; s++) {
    const p = game.players[s]!;
    p.hand.fill(0);
    for (const t of hands[s]!) p.hand[game.index.idx(t)]!++;
    p.melds = melds[s]!.map((m) => ({ ...m }));
    p.discards = [];
    p.missLocks.clear();
  }
  return game;
}

function tilesOf(game: MahjongGame, seat: Seat): string[] {
  const p = game.players[seat]!;
  const out: string[] = [];
  p.hand.forEach((c, i) => {
    for (let k = 0; k < c; k++) out.push(game.index.tile(i));
  });
  return out;
}

const hasOpt = (game: MahjongGame, seat: Seat, type: string, tile?: string) =>
  game.legalOptions(seat).some((o) => o.type === type && (tile === undefined || o.tile === tile));

/** 响应宣告窗口：意图座位用给定动作，其余自动过 */
function respondAll(game: MahjongGame, intended: Partial<Record<Seat, PlayerAction>> = {}): void {
  let guard = 0;
  while (game.phase === 'claim' && guard++ < 20) {
    const pending = game.claim!.pendingSeats.filter((s) => !game.claim!.responses.has(s));
    if (pending.length === 0) {
      game.autoPassPending();
      return;
    }
    const seat = pending[0]!;
    game.action(seat, intended[seat] ?? { type: 'pass' });
  }
}

/** 推进：当前玩家打出第一张弃牌选项，直到条件满足 */
function drive(game: MahjongGame, until: () => boolean, maxSteps = 40): void {
  let guard = 0;
  while (!game.result && !until() && guard++ < maxSteps) {
    if (game.phase === 'claim') {
      respondAll(game);
      continue;
    }
    const options = game.legalOptions(game.currentSeat);
    const discard = options.find((o) => o.type === 'discard');
    if (!discard) throw new Error('无可出牌');
    game.action(game.currentSeat, { type: 'discard', tile: discard.tile });
  }
}

describe('点炮胡与结算', () => {
  it('不点炮关闭弃牌胡，保留对同一张牌的碰与自摸胡', () => {
    const hands = [
      ['D1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D5', 'D6', 'D7', 'D8'],
      ['D1', 'D1', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'B2', 'B2'],
      [], [],
    ];
    const normal = setup(gd136, 42, hands);
    normal.action(0, { type: 'discard', tile: 'D1' });
    expect(hasOpt(normal, 1, 'hu')).toBe(true);

    const noDiscardHu = { ...gd136, rules: { ...gd136.rules, allowDiscardHu: false } };
    const game = setup(noDiscardHu, 42, hands);
    game.action(0, { type: 'discard', tile: 'D1' });
    expect(hasOpt(game, 1, 'hu')).toBe(false);
    expect(hasOpt(game, 1, 'peng', 'D1')).toBe(true);
    expect(() => game.action(1, { type: 'hu' })).toThrow(IllegalActionError);

    const selfDraw = setup(noDiscardHu, 42, [hands[0]!, [...hands[1]!, 'D1'], [], []], undefined, 1);
    selfDraw.drewTile = 'D1';
    expect(hasOpt(selfDraw, 1, 'hu')).toBe(true);
  });

  it('庄家打 D1，闲家胡（鸡胡 0 番），点炮者付 1 分，下家坐庄', () => {
    const game = setup(gd136, 42, [
      ['D1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D5', 'D6', 'D7', 'D8'],
      ['C1', 'C1', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C8', 'C8', 'D1'],
      ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D1', 'D2', 'D3', 'D4'],
      ['C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'B2', 'B3', 'B4', 'D2', 'D4'],
    ]);
    expect(hasOpt(game, 0, 'discard', 'D1')).toBe(true);
    game.action(0, { type: 'discard', tile: 'D1' });
    expect(hasOpt(game, 1, 'hu')).toBe(true);
    respondAll(game, { 1: { type: 'hu' } });
    expect(game.result!.outcome).toBe('win');
    const s = game.result!.settlements[0]!;
    expect(s.winnerSeat).toBe(1);
    expect(s.paymentKind).toBe('discard');
    expect(s.payerSeat).toBe(0);
    expect(s.score).toBe(1); // 鸡胡 0 番
    expect(game.result!.deltas).toEqual([-1, 1, 0, 0]);
    expect(game.result!.dealerNext).toBe(2); // 闲家胡牌下家坐庄（验收 19）
  });

  it('庄家自摸：三家各付，庄家连庄', () => {
    const game = setup(gd136, 42, [
      ['C1', 'C1', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C8', 'C8', 'D1', 'D1'],
      ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D2', 'D3', 'D4', 'D5'],
      ['C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'B2', 'B3', 'B4', 'D6', 'D7'],
      ['B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'C9', 'D8', 'D9', 'WE', 'WS'],
    ]);
    expect(hasOpt(game, 0, 'hu')).toBe(true);
    game.action(0, { type: 'hu' });
    expect(game.result!.settlements[0]!.paymentKind).toBe('selfDraw');
    expect(game.result!.deltas).toEqual([3, -1, -1, -1]);
    expect(game.result!.dealerNext).toBe(0); // 庄家胡连庄
  });

  it('胡优先于碰：座位 2 胡、座位 1 碰被优先级压制', () => {
    const game = setup(gd136, 42, [
      ['D1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D5', 'D6', 'D7', 'D8'],
      ['D1', 'D1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D2', 'D3'],
      ['C1', 'C1', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C8', 'C8', 'D1'],
      ['B2', 'B3', 'B4', 'C5', 'C6', 'C7', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'WE'],
    ]);
    game.action(0, { type: 'discard', tile: 'D1' });
    expect(hasOpt(game, 1, 'peng')).toBe(true);
    expect(hasOpt(game, 2, 'hu')).toBe(true);
    respondAll(game, { 2: { type: 'hu' } });
    expect(game.result!.winnerSeats).toEqual([2]);
    expect(game.players[1]!.melds.length).toBe(0); // 碰未成立
  });
});

describe('碰与三种杠（确定性）', () => {
  it('碰：副露成立、河牌移除、碰者续打出牌', () => {
    const game = setup(gd136, 42, [
      ['C1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D5', 'D6', 'D7', 'D8'],
      ['C1', 'C1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D2', 'D3'],
      ['C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'D1', 'D2', 'D3', 'D4', 'D5'],
      ['C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'B2', 'B3', 'B4', 'D6', 'D7', 'D8', 'D9'],
    ]);
    game.action(0, { type: 'discard', tile: 'C1' });
    expect(hasOpt(game, 1, 'peng', 'C1')).toBe(true);
    expect(hasOpt(game, 1, 'mingang', 'C1')).toBe(false);
    respondAll(game, { 1: { type: 'peng' } });
    const p1 = game.players[1]!;
    expect(p1.melds).toEqual([{ type: 'peng', tile: 'C1', fromSeat: 0 }]);
    expect(game.players[0]!.discards.filter((t) => t === 'C1').length).toBe(0);
    expect(game.currentSeat).toBe(1);
    expect(game.phase).toBe('turn');
    expect(tilesOf(game, 1).length).toBe(11);
    expect(hasOpt(game, 1, 'hu')).toBe(false);
    expect(hasOpt(game, 1, 'discard', 'B1')).toBe(true);
  });

  it('大明杠：点杠者付 3 倍底分，杠后墙尾补牌', () => {
    const game = setup(gd136, 42, [
      ['C1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D5', 'D6', 'D7', 'D8'],
      ['C1', 'C1', 'C1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'D2', 'D3'],
      ['C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'D1', 'D2', 'D3', 'D4', 'D5'],
      ['C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'B2', 'B3', 'B4', 'D6', 'D7', 'D8', 'D9'],
    ]);
    game.action(0, { type: 'discard', tile: 'C1' });
    expect(hasOpt(game, 1, 'mingang', 'C1')).toBe(true);
    respondAll(game, { 1: { type: 'mingang' } });
    expect(game.players[1]!.melds[0]!.type).toBe('mingang');
    const ks = game.events.find((e) => e.type === 'kongScore' && e.kind === 'mingang')!;
    expect(ks.from).toBe(0);
    expect(ks.to).toBe(1);
    expect(ks.amount).toBe(3);
    const last = game.events[game.events.length - 1]!;
    expect(last.type === 'draw' && last.fromKong).toBe(true);
    expect(game.currentSeat).toBe(1);
  });

  it('暗杠：三家各付 2 倍，补牌后可杠上开花', () => {
    const game = setup(gd136, 42, [
      ['C1', 'C1', 'C1', 'C1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'D5', 'D6'],
      ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D1', 'D2', 'D3', 'D4'],
      ['C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'D7', 'D8', 'D9', 'WE', 'WS'],
      ['C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'B2', 'B3', 'B4', 'WW', 'WN', 'HG', 'HW'],
    ]);
    expect(hasOpt(game, 0, 'ankang', 'C1')).toBe(true);
    game.action(0, { type: 'ankang', tile: 'C1' });
    const pays = game.events.filter((e) => e.type === 'kongScore' && e.kind === 'ankang');
    expect(pays.length).toBe(3);
    for (const p of pays) expect(p.amount).toBe(2);
    const last = game.events[game.events.length - 1]!;
    expect(last.type === 'draw' && last.fromKong).toBe(true);
  });

  it('补杠：碰升级为杠，三家各付 1 倍，无补牌，之后必须出牌', () => {
    const game = setup(gd136, 42, [
      ['C2', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D5', 'D6', 'D7', 'D8'],
      ['C1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D2', 'D3', 'D4'],
      ['C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6'],
      ['C5', 'C6', 'C7', 'C8', 'C9', 'B2', 'B3', 'B4', 'D7', 'D8', 'D9', 'WE', 'WS'],
    ], [
      [],
      [{ type: 'peng', tile: 'C1', fromSeat: 0 }],
      [],
      [],
    ], 1); // 座位 1 为庄 → 开局即可补杠
    expect(hasOpt(game, 1, 'bugang', 'C1')).toBe(true);
    game.action(1, { type: 'bugang', tile: 'C1' });
    respondAll(game);
    expect(game.players[1]!.melds[0]!.type).toBe('bugang');
    const pays = game.events.filter((e) => e.type === 'kongScore' && e.kind === 'bugang');
    expect(pays.length).toBe(3);
    for (const p of pays) expect(p.amount).toBe(1);
    const last = game.events[game.events.length - 1]!;
    expect(!(last.type === 'draw' && last.fromKong)).toBe(true);
    expect(game.currentSeat).toBe(1);
    expect(hasOpt(game, 1, 'discard', 'B1')).toBe(true);
  });

  it('非法动作被引擎拒绝', () => {
    const game = setup(gd136, 42, [
      ['C1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D5', 'D6', 'D7', 'D8'],
      ['C1', 'C1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D2', 'D3'],
      ['C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'D1', 'D2', 'D3', 'D4', 'D5'],
      ['C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'B2', 'B3', 'B4', 'D6', 'D7', 'D8', 'D9'],
    ]);
    expect(() => game.action(2, { type: 'discard', tile: 'C2' })).toThrowError(IllegalActionError);
    game.action(0, { type: 'discard', tile: 'C1' });
    expect(() => game.action(2, { type: 'peng' })).toThrowError(IllegalActionError);
  });
});

describe('抢杠（确定性）', () => {
  it('补杠可被抢：抢杠胡 + 被抢杠者包三家（验收 18）', () => {
    const game = setup(gd136, 42, [
      ['C2', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D5', 'D6', 'D7', 'D8'],
      ['C1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D2', 'D3', 'D4'],
      ['C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'D1', 'D2', 'D3', 'D4', 'D5'],
      ['C5', 'C6', 'C7', 'C8', 'C9', 'B2', 'B3', 'B4', 'D7', 'D8', 'D9', 'WE', 'WS'],
    ], [
      [],
      [{ type: 'peng', tile: 'C1', fromSeat: 0 }],
      [],
      [],
    ], 1); // 座位 1 为庄
    // 座位 2 = 3 组副露 + 手牌 C1 C1 D1 D1（胡 C1 → C1C1C1 刻 + D1D1 对）
    const p2 = game.players[2]!;
    p2.hand.fill(0);
    for (const t of ['C1', 'C1', 'D1', 'D1']) p2.hand[game.index.idx(t)]!++;
    p2.melds = [
      { type: 'peng', tile: 'B2', fromSeat: 3 },
      { type: 'peng', tile: 'B5', fromSeat: 0 },
      { type: 'peng', tile: 'B8', fromSeat: 1 },
    ];
    game.action(1, { type: 'bugang', tile: 'C1' });
    expect(game.phase).toBe('claim');
    expect(hasOpt(game, 2, 'hu')).toBe(true);
    expect(hasOpt(game, 3, 'hu')).toBe(false);
    respondAll(game, { 2: { type: 'hu' } });
    const s = game.result!.settlements[0]!;
    expect(s.via).toBe('robKong');
    expect(s.paymentKind).toBe('bao');
    expect(s.payerSeat).toBe(1); // 被抢杠者包三家
    expect(s.baoReasons.join(';')).toContain('补杠被抢杠');
    expect(game.events.some((e) => e.type === 'payment' && e.amount === s.score * 3 && e.from === 1)).toBe(true);
    expect(game.players[1]!.melds[0]!.type).toBe('peng'); // 杠未成立
  });

  it('暗杠不被普通手牌抢（窗口不出现）', () => {
    const game = setup(gd136, 42, [
      ['C1', 'C1', 'C1', 'C1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'D5', 'D6'],
      ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D1', 'D2', 'D3', 'D4'],
      // 座位 2 单吊 C1 的普通手牌（非十三幺）：不构成 C1 胡
      ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'D1', 'D2', 'D3', 'D4'],
      ['C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'B2', 'B3', 'B4', 'WW', 'WN', 'HG', 'HW'],
    ]);
    game.action(0, { type: 'ankang', tile: 'C1' });
    const last = game.events[game.events.length - 1]!;
    expect(last.type === 'draw' && last.fromKong).toBe(true); // 无抢杠窗口，杠直接成立
    expect(game.players[0]!.melds[0]!.type).toBe('ankang');
  });
});

describe('漏胡锁定（确定性）', () => {
  it('放弃胡后同张不可胡；摸牌后解除', () => {
    // 庄家 = 座位 3：座位 3 打 D1 → 座位 1 过（上锁）→ 座位 0 再打 D1 → 座位 1 无 hu 选项 → 座位 1 摸牌后解锁
    const game = setup(gd136, 42, [
      ['D1', 'D1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D5', 'D6'],
      ['C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'B2', 'B3', 'B4', 'D1', 'D1', 'D4', 'D4'],
      ['C8', 'C9', 'D5', 'D6', 'D7', 'D8', 'D9', 'B5', 'B6', 'B7', 'WE', 'WS', 'WW'],
      ['D1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D5', 'D6', 'D7', 'D8'],
    ], [[], [], [], []], 3);
    game.action(3, { type: 'discard', tile: 'D1' });
    expect(hasOpt(game, 1, 'hu')).toBe(true);
    respondAll(game, { 1: { type: 'pass' } });
    expect(game.players[1]!.missLocks.has('D1')).toBe(true); // 上锁（下家为座位 0，未摸牌）
    // 座位 0 打出第二张 D1
    game.action(0, { type: 'discard', tile: 'D1' });
    expect(game.phase).toBe('claim');
    expect(hasOpt(game, 1, 'hu')).toBe(false); // 漏胡锁定生效
    respondAll(game, { 1: { type: 'pass' } });
    // 座位 1 摸牌 → 解锁
    expect(game.currentSeat).toBe(1);
    expect(game.drewTile).not.toBeNull();
    expect(game.players[1]!.missLocks.has('D1')).toBe(false);
  });

  it('missedWinLock=false：不产生锁定', () => {
    const cfg = makeConfig('gd136');
    cfg.rules.missedWinLock = false;
    const game = setup(cfg, 42, [
      ['D1', 'D1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D5', 'D6'],
      ['C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'B2', 'B3', 'B4', 'D1', 'D1', 'D4', 'D4'],
      ['C8', 'C9', 'D5', 'D6', 'D7', 'D8', 'D9', 'B5', 'B6', 'B7', 'WE', 'WS', 'WW'],
      ['D1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D5', 'D6', 'D7', 'D8'],
    ], [[], [], [], []], 3);
    game.action(3, { type: 'discard', tile: 'D1' });
    respondAll(game, { 1: { type: 'pass' } });
    expect(game.players[1]!.missLocks.has('D1')).toBe(false);
    expect(game.events.every((e) => e.type !== 'missLock')).toBe(true);
  });
});

describe('流局与杠分退回（验收 19）', () => {
  it('自然流局：杠分全额退回，庄家连庄', () => {
    const cfg = makeConfig('gd136');
    let found = false;
    for (let seed = 1; seed <= 60 && !found; seed++) {
      const r = autoPlay(cfg, seed, { peng: false, gang: true });
      const kongScores = r.game.events.filter((e) => e.type === 'kongScore');
      if (r.game.result!.outcome === 'draw' && kongScores.length > 0) {
        found = true;
        const refund = kongScores.reduce((a, e) => a + (e as { amount: number }).amount, 0);
        const dg = r.game.events.find((e) => e.type === 'drawGame')!;
        expect(dg.reason).toBe('wallExhausted');
        expect((dg as { refund: number }).refund).toBe(refund);
        const sum = r.game.result!.deltas.reduce((a, b) => a + b, 0);
        expect(sum).toBe(0);
        expect(r.game.result!.dealerNext).toBe(0); // 连庄
      }
    }
    expect(found).toBe(true);
  });
});

describe('wild 模式红中约束（确定性）', () => {
  it('红中不能碰/明杠；可暗杠', () => {
    const game = setup(gd128, 42, [
      ['HR', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D5', 'D6', 'D7', 'D8'],
      ['HR', 'HR', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D2', 'D3'],
      ['C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'D1', 'D2', 'D3', 'D4', 'D5'],
      ['C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'B2', 'B3', 'B4', 'D6', 'D7', 'D8', 'D9'],
    ]);
    game.action(0, { type: 'discard', tile: 'HR' });
    expect(hasOpt(game, 1, 'peng', 'HR')).toBe(false);
    expect(hasOpt(game, 1, 'mingang', 'HR')).toBe(false);
    respondAll(game);
    // 座位 1 回合补齐 4 张红中 → 暗杠合法
    let guard = 0;
    while (!game.result && game.currentSeat !== 1 && guard++ < 30) {
      if (game.phase === 'claim') {
        respondAll(game);
        continue;
      }
      const options = game.legalOptions(game.currentSeat);
      const discard = options.find((o) => o.type === 'discard')!;
      game.action(game.currentSeat, { type: 'discard', tile: discard.tile });
    }
    if (!game.result && game.currentSeat === 1) {
      // 座位 1 处于摸牌状态才能暗杠：若已出牌则跳过直接改手牌后等待其摸牌回合
      if (game.drewTile !== null) {
        game.players[1]!.hand[game.index.idx('HR')] = 4;
        expect(hasOpt(game, 1, 'ankang', 'HR')).toBe(true);
        game.action(1, { type: 'ankang', tile: 'HR' });
        expect(game.players[1]!.melds.some((m) => m.type === 'ankang' && m.tile === 'HR')).toBe(true);
        return;
      }
      // 推进到座位 1 摸牌
      let g2 = 0;
      while (!game.result && game.currentSeat !== 1 && g2++ < 30) {
        if (game.phase === 'claim') {
          respondAll(game);
          continue;
        }
        const options = game.legalOptions(game.currentSeat);
        const discard = options.find((o) => o.type === 'discard')!;
        game.action(game.currentSeat, { type: 'discard', tile: discard.tile });
      }
      if (!game.result && game.currentSeat === 1 && game.drewTile !== null) {
        game.players[1]!.hand[game.index.idx('HR')] = 4;
        expect(hasOpt(game, 1, 'ankang', 'HR')).toBe(true);
        game.action(1, { type: 'ankang', tile: 'HR' });
        expect(game.players[1]!.melds.some((m) => m.type === 'ankang' && m.tile === 'HR')).toBe(true);
      }
    }
  });
});

describe('结算明细（PRD 7.4）', () => {
  it('结算逐项列出番型与最终番数分数', () => {
    const game = setup(gd136, 42, [
      ['D1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D5', 'D6', 'D7', 'D8'],
      ['C1', 'C1', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C8', 'C8', 'D1'],
      ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D1', 'D2', 'D3', 'D4'],
      ['C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'B2', 'B3', 'B4', 'D2', 'D4'],
    ]);
    game.action(0, { type: 'discard', tile: 'D1' });
    respondAll(game, { 1: { type: 'hu' } });
    const s = game.result!.settlements[0]!;
    expect(s.lines.length).toBeGreaterThan(0);
    expect(s.lines.some((l) => l.key === 'finalFan')).toBe(true);
    expect(s.lines.some((l) => l.key === 'score')).toBe(true);
    expect(s.fans.length).toBeGreaterThan(0);
    expect(s.meta).toBeDefined();
    expect(game.result!.replayMeta.resolvedFanConfigHash).toMatch(/^[0-9a-f]{8}$/);
  });
});
