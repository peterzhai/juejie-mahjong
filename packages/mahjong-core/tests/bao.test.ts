/** P5：包三家四条件（PRD 5.6）确定性测试 */

import { describe, expect, it } from 'vitest';
import type { ResolvedFanConfig } from '@quejie/fan-config';
import { makeConfig, autoPlay, scanSeeds } from './helpers.js';
import { MahjongGame, type MeldData, type Seat } from '../src/index.js';

const gd136 = makeConfig('gd136');

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

function respondAll(game: MahjongGame, intended: Partial<Record<Seat, { type: string; tile?: string }>> = {}): void {
  let guard = 0;
  while (game.phase === 'claim' && guard++ < 20) {
    const pending = game.claim!.pendingSeats.filter((s) => !game.claim!.responses.has(s));
    if (pending.length === 0) {
      game.autoPassPending();
      return;
    }
    const seat = pending[0]!;
    game.action(seat, (intended[seat] ?? { type: 'pass' }) as never);
  }
}

describe('包三家 ②：放杠导致杠上开花 → 点杠者包三家', () => {
  it('大明杠后墙尾补牌即胡，包牌者为供杠者', () => {
    // 座位 0 手牌：C1×3 + C2C3C4 C5C6C7 + B2B3B4B5 + D9（弃 D9 后听 B2/B5）
    const hands = [
      ['C1', 'C1', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'B2', 'B3', 'B4', 'B5', 'D9'],
      ['C1', 'D1', 'D2', 'D3', 'D4', 'D6', 'D7', 'D8', 'B6', 'B7', 'B8', 'B9', 'C9'],
      ['WE', 'WS', 'WW', 'WN', 'HR', 'HG', 'HW', 'C9', 'B9', 'D9', 'D1', 'D2', 'D3'],
      ['WE', 'WS', 'WW', 'WN', 'HR', 'HG', 'HW', 'C9', 'B9', 'D9', 'D4', 'D5', 'D6'],
    ];
    const found = scanSeeds(
      gd136,
      (r) => {
        void r;
        return undefined;
      },
      { count: 1 },
    );
    void found;
    // 逐种子直接驱动（扫描到杠上开花包三家为止）
    for (let seed = 1; seed <= 400; seed++) {
      const game = setup(gd136, seed, hands);
      try {
        game.action(0, { type: 'discard', tile: 'D9' });
        respondAll(game);
        // 座位 1 摸牌后打 C1
        if (game.result || game.currentSeat !== 1) continue;
        game.action(1, { type: 'discard', tile: 'C1' });
        if (game.phase !== 'claim') continue;
        if (!game.legalOptions(0).some((o) => o.type === 'mingang')) continue;
        respondAll(game, { 0: { type: 'mingang' } });
        if (game.result || game.currentSeat !== 0) continue;
        // 杠后补牌若成胡 → 杠上开花
        if (!game.legalOptions(0).some((o) => o.type === 'hu')) continue;
        game.action(0, { type: 'hu' });
        const s = game.result!.settlements[0]!;
        expect(s.paymentKind).toBe('bao');
        expect(s.payerSeat).toBe(1); // 点杠者（放杠者）包三家
        expect(s.baoReasons.join(';')).toContain('放杠致杠上开花');
        expect(game.events.some((e) => e.type === 'payment' && e.from === 1 && e.amount === s.score * 3)).toBe(true);
        return;
      } catch {
        // 该种子流程不匹配，继续
      }
    }
    throw new Error('400 个种子内未复现杠上开花包三家');
  });
});

describe('包三家 ③：十二张落地', () => {
  it('落地者点炮 → 自己包三家', () => {
    // 庄家 = 座位 1（已 4 组副露，剩 C9/B9 两张），打 C9 → 座位 2 胡
    const game = setup(gd136, 42, [
      ['B1', 'B2', 'B3', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'WE'],
      ['C9', 'B9'],
      ['C9', 'C9', 'D1', 'D1'],
      ['B1', 'B2', 'B3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'WE', 'WS', 'WW', 'WN'],
    ], [
      [],
      [
        { type: 'peng', tile: 'C1', fromSeat: 2 },
        { type: 'peng', tile: 'C2', fromSeat: 3 },
        { type: 'peng', tile: 'C3', fromSeat: 0 },
        { type: 'peng', tile: 'C4', fromSeat: 2 },
      ],
      [
        { type: 'peng', tile: 'B2', fromSeat: 1 },
        { type: 'peng', tile: 'B5', fromSeat: 0 },
        { type: 'peng', tile: 'B8', fromSeat: 3 },
      ],
      [],
    ], 1);
    expect(game.currentSeat).toBe(1);
    game.action(1, { type: 'discard', tile: 'C9' });
    respondAll(game, { 2: { type: 'hu' } });
    expect(game.result!.outcome).toBe('win');
    const s = game.result!.settlements[0]!;
    expect(s.winnerSeat).toBe(2);
    expect(s.paymentKind).toBe('bao');
    expect(s.payerSeat).toBe(1); // 十二张落地者自己包
    expect(s.baoReasons.join(';')).toContain('十二张落地后点炮');
  });

  it('落地者单吊自摸 → 供给第 4 组者包三家', () => {
    const game = setup(gd136, 42, [
      ['B1', 'B2', 'B3', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'WE', 'WS'],
      ['C9', 'C9'],
      ['B1', 'B2', 'B3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'WW', 'WN', 'HG', 'HW'],
      ['B1', 'B2', 'B3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'WW', 'WN', 'HG', 'HW'],
    ], [
      [],
      [
        { type: 'peng', tile: 'C1', fromSeat: 2 },
        { type: 'peng', tile: 'C2', fromSeat: 3 },
        { type: 'peng', tile: 'C3', fromSeat: 0 },
        { type: 'peng', tile: 'C4', fromSeat: 0 }, // 第 4 组由座位 0 供给
      ],
      [],
      [],
    ], 1);
    game.twelfthSupplier[1] = 0; // 模拟第 4 组副露成立时记录的供给者
    expect(game.currentSeat).toBe(1);
    expect(game.legalOptions(1).some((o) => o.type === 'hu')).toBe(true); // C9C9 对将自摸
    game.action(1, { type: 'hu' });
    const s = game.result!.settlements[0]!;
    expect(s.paymentKind).toBe('bao');
    expect(s.payerSeat).toBe(0); // 供给者包
    expect(s.baoReasons.join(';')).toContain('十二张落地单吊自摸');
  });
});

describe('包三家 ④：大三元/大四喜最后一组由同一人打出', () => {
  it('大四喜：4 组副露均由座位 1 供给，其打 C9 点炮 → 包三家', () => {
    const game = setup(gd136, 42, [
      ['B1', 'B2', 'B3', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'C9'],
      ['C9', 'B9', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'D9', 'D1', 'D2', 'D3'],
      ['C9'],
      ['B1', 'B2', 'B3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'HR', 'HG', 'HW', 'C1'],
    ], [
      [],
      [],
      [
        { type: 'peng', tile: 'WE', fromSeat: 1 },
        { type: 'peng', tile: 'WS', fromSeat: 1 },
        { type: 'peng', tile: 'WW', fromSeat: 1 },
        { type: 'peng', tile: 'WN', fromSeat: 1 },
      ],
      [],
    ], 1);
    // 座位 2：4 组副露 + 单张 C9，胡 C9 成对 → 大四喜
    const p2 = game.players[2]!;
    p2.hand.fill(0);
    p2.hand[game.index.idx('C9')]!++;
    game.action(1, { type: 'discard', tile: 'C9' });
    respondAll(game, { 2: { type: 'hu' } });
    expect(game.result!.outcome).toBe('win');
    const s = game.result!.settlements[0]!;
    expect(s.winnerSeat).toBe(2);
    expect(s.fans.some((f) => f.fanId === 'bigWinds')).toBe(true);
    expect(s.paymentKind).toBe('bao');
    expect(s.payerSeat).toBe(1);
    expect(s.baoReasons.join(';')).toContain('大三元/大四喜');
  });

  it('规则关闭时（baoBigDragonWind=false）按普通点炮结算', () => {
    const cfg = makeConfig('gd136');
    cfg.rules.baoBigDragonWind = false;
    const game = setup(cfg, 42, [
      ['B1', 'B2', 'B3', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'C9'],
      ['C9', 'B9', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'D9', 'D1', 'D2', 'D3'],
      ['C9'],
      ['B1', 'B2', 'B3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'HR', 'HG', 'HW', 'C1'],
    ], [
      [],
      [],
      [
        { type: 'peng', tile: 'WE', fromSeat: 1 },
        { type: 'peng', tile: 'WS', fromSeat: 1 },
        { type: 'peng', tile: 'WW', fromSeat: 1 },
        { type: 'peng', tile: 'WN', fromSeat: 1 },
      ],
      [],
    ], 1);
    const p2 = game.players[2]!;
    p2.hand.fill(0);
    p2.hand[game.index.idx('C9')]!++;
    game.action(1, { type: 'discard', tile: 'C9' });
    respondAll(game, { 2: { type: 'hu' } });
    const s = game.result!.settlements[0]!;
    expect(s.paymentKind).toBe('discard');
    expect(s.payerSeat).toBe(1);
  });
});

describe('包三家 ①：补杠被抢杠（规则开关）', () => {
  it('baoRobKong=false 时按普通点炮（单倍）结算', () => {
    const cfg = makeConfig('gd136');
    cfg.rules.baoRobKong = false;
    const game = setup(cfg, 42, [
      ['C2', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D5', 'D6', 'D7', 'D8'],
      ['C1', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'D2', 'D3', 'D4'],
      ['C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'D1', 'D2', 'D3', 'D4', 'D5'],
      ['C5', 'C6', 'C7', 'C8', 'C9', 'B2', 'B3', 'B4', 'D7', 'D8', 'D9', 'WE', 'WS'],
    ], [
      [],
      [{ type: 'peng', tile: 'C1', fromSeat: 0 }],
      [],
      [],
    ], 1);
    const p2 = game.players[2]!;
    p2.hand.fill(0);
    for (const t of ['C1', 'C1', 'D1', 'D1']) p2.hand[game.index.idx(t)]!++;
    p2.melds = [
      { type: 'peng', tile: 'B2', fromSeat: 3 },
      { type: 'peng', tile: 'B5', fromSeat: 0 },
      { type: 'peng', tile: 'B8', fromSeat: 1 },
    ];
    game.action(1, { type: 'bugang', tile: 'C1' });
    respondAll(game, { 2: { type: 'hu' } });
    const s = game.result!.settlements[0]!;
    expect(s.via).toBe('robKong');
    expect(s.paymentKind).toBe('discard'); // 不包，仅点杠者单倍
    expect(s.payerSeat).toBe(1);
    expect(game.events.some((e) => e.type === 'payment' && e.amount === s.score)).toBe(true);
  });
});
