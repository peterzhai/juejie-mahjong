/** 非功能性能基准（PRD 8：单局操作响应 <100ms；formula 求值 <10ms） */

import { describe, expect, it } from 'vitest';
import { compileExpr } from '@quejie/fan-config';
import { settleWin } from '../src/settle.js';
import { TileIndex } from '../src/tileIndex.js';
import { makeConfig } from './helpers.js';

const gd128 = makeConfig('gd128', { capEnabled: true, bonusEnabled: true, bonusMode: 'scoreDouble' });

describe('性能基准', () => {
  it('单次胡牌判定+计分（含万能牌枚举）平均 < 100ms', () => {
    const index = new TileIndex(gd128);
    const hands = [
      ['C1', 'C1', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'HR', 'HR', 'HR', 'B2', 'B2'],
      ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'HR', 'HR', 'B1', 'B2', 'B3'],
      ['C1', 'C1', 'C1', 'C2', 'C2', 'C2', 'C3', 'C3', 'C3', 'C4', 'C4', 'C4', 'B9', 'B9'],
    ];
    const N = 2000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      const tiles = hands[i % hands.length]!;
      settleWin(gd128, index, {
        winnerSeat: 0,
        completingTile: tiles[tiles.length - 1]!,
        via: 'self',
        concealedTiles: tiles,
        exposedMelds: [],
        kongBlossom: i % 2 === 0,
        seatWind: 'east',
        roundWind: 'east',
        dealer: true,
        kongCount: i % 5,
        wallTiles: 30,
        playerCount: 4,
        roomLevel: 1,
      });
    }
    const avg = (performance.now() - t0) / N;
    console.log(`[perf] settleWin 平均 ${avg.toFixed(3)}ms（N=${N}）`);
    expect(avg).toBeLessThan(100);
  });

  it('formula 编译一次求值 10 万次平均 < 10ms', () => {
    const compiled = compileExpr('clamp(3 + floor(kongCount / 2), minFan, hardCap)');
    const ctx = { base: 5, kongCount: 3, wallTiles: 40, playerCount: 4, minFan: 1, hardCap: 10 };
    const N = 100000;
    // 预热
    for (let i = 0; i < 1000; i++) compiled.eval(ctx);
    const t0 = performance.now();
    for (let i = 0; i < N; i++) compiled.eval(ctx);
    const avgUs = ((performance.now() - t0) / N) * 1000;
    console.log(`[perf] formula 单次求值 ${avgUs.toFixed(2)}µs`);
    expect(avgUs).toBeLessThan(10000); // 10ms = 10000µs
  });
});
