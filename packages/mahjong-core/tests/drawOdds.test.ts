import { describe, expect, it } from 'vitest';
import { aiDecide, chanceToHit, countsOf, drawPool, estimateSelfDraw, MahjongGame } from '../src/index.js';
import { makeConfig } from './helpers.js';

const readyHand = ['C1', 'C1', 'C1', 'C2', 'C3', 'C4', 'B2', 'B3', 'B4', 'D5', 'D6', 'D7', 'WE'];

function setup() {
  const game = new MahjongGame({ resolved: makeConfig('gd136'), seed: 1, dealer: 0 });
  game.start();
  game.players[0]!.hand = countsOf(readyHand, game.index);
  game.currentSeat = 1;
  return game;
}

describe('听牌与未见牌概率', () => {
  it('按无放回抽样估算至少摸到一张目标牌', () => {
    expect(chanceToHit(10, 2, 1)).toBe(0.2);
    expect(chanceToHit(10, 2, 2)).toBeCloseTo(1 - 8 / 10 * 7 / 9);
    expect(chanceToHit(10, 2, 9)).toBe(1);
    expect(chanceToHit(10, 2, 0)).toBe(0);
  });

  it('识别听口，随公开弃牌更新，并保持其他玩家暗牌私密', () => {
    const game = setup();
    const unseen = game.resolved.tileMath.totalTiles - readyHand.length;
    const initial = estimateSelfDraw(game, 0)!;
    expect(initial.waiting).toEqual([{ tile: 'WE', unseenCopies: 3 }]);
    expect(initial.nextDrawChance).toBe(3 / unseen);
    expect(initial.drawsRemaining).toBe(Math.floor((game.wall.liveRemaining - game.wall.deadWallCount + 1) / 4));
    expect(initial.selfDrawChance).toBeCloseTo(chanceToHit(unseen, 3, initial.drawsRemaining));

    game.players[1]!.hand = countsOf(['WE', 'WE', 'WE'], game.index);
    game.players[2]!.melds = [{ type: 'ankang', tile: 'D1' }];
    expect(estimateSelfDraw(game, 0)).toEqual(initial);

    game.players[1]!.discards.push('WE');
    expect(estimateSelfDraw(game, 0)?.nextDrawChance).toBe(2 / (unseen - 1));
    game.players[1]!.discards.push('WE', 'WE');
    expect(estimateSelfDraw(game, 0)).toMatchObject({
      waiting: [{ tile: 'WE', unseenCopies: 0 }], nextDrawChance: 0, selfDrawChance: 0,
    });
    game.phase = 'over';
    expect(estimateSelfDraw(game, 0)).toBeUndefined();
  });

  it('AI 能识别杠的四张牌，并随公开牌变化改听另一张', () => {
    const game = setup();
    const player = game.players[0]!;
    game.currentSeat = 0;
    player.hand = countsOf([...readyHand, 'WS'], game.index);
    game.players[1]!.melds = [{ type: 'mingang', tile: 'D1', fromSeat: 2 }];
    expect(drawPool(game, 0).remaining[game.index.idx('D1')]).toBe(0);

    const decide = () => aiDecide(game, 0, { difficulty: 'normal', rng: () => 0, timeBudgetMs: 200 });
    game.players[1]!.discards = ['WE', 'WE', 'WE'];
    expect(decide()).toEqual({ type: 'discard', tile: 'WE' });
    game.players[1]!.discards = ['WS', 'WS', 'WS'];
    expect(decide()).toEqual({ type: 'discard', tile: 'WS' });
  });
});
