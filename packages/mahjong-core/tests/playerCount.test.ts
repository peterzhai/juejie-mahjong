import { describe, it, expect } from 'vitest';
import { MahjongGame } from '../src/game.js';
import { aiDecide } from '../src/ai/agent.js';
import { recordReplay, verifyReplay } from '../src/replay.js';
import { defaultFanConfig, resolveFanConfig } from '@quejie/fan-config';
describe('configurable player count', () => {
  for (const playerCount of [2, 3, 4]) it(`${playerCount} players finish and replay with conserved scores`, () => {
    const resolved = resolveFanConfig(defaultFanConfig()).resolved!;
    const game = new MahjongGame({ resolved, seed: 42, dealer: 0, playerCount });
    game.start(); const inputs = []; let steps = 0;
    while (!game.result && steps++ < 2000) {
      const seat = game.phase === 'claim' ? game.claim!.pendingSeats.find(s => !game.claim!.responses.has(s)) : game.currentSeat;
      if (seat === undefined) { game.autoPassPending(); continue; }
      const action = aiDecide(game, seat, { difficulty:'easy', rng:() => .5, timeBudgetMs:5 });
      inputs.push({ seat, action }); game.action(seat, action);
    }
    expect(game.result).toBeTruthy();
    expect(game.result!.deltas).toHaveLength(playerCount);
    expect(game.result!.deltas.reduce((a,b) => a+b,0)).toBe(0);
    expect(verifyReplay(recordReplay(game, inputs)).ok).toBe(true);
  });
});
