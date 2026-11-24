import type { MahjongGame, Seat } from './game.js';

/** 视角内已知的牌：自己的手牌、弃牌河和公开副露。 */
export function drawPool(game: MahjongGame, seat: Seat) {
  const hand = game.players[seat]!.hand;
  const visible = new Array<number>(game.index.ids.length).fill(0);
  for (const player of game.players) {
    for (const tile of player.discards) visible[game.index.idx(tile)]!++;
    for (const meld of player.melds) {
      if (meld.type === 'ankang' && player.seat !== seat) continue;
      visible[game.index.idx(meld.tile)]! += meld.type === 'peng' ? 3 : 4;
    }
  }
  const remaining = game.index.copies.map((copies, i) => Math.max(0, copies - hand[i]! - visible[i]!));
  const known = hand.reduce((total, count, i) => total + count + visible[i]!, 0);
  return { visible, remaining, unseenTiles: Math.max(0, game.resolved.tileMath.totalTiles - known) };
}

/** 从未见牌中无放回抽取，至少摸到一张目标牌的概率。 */
export function chanceToHit(unseen: number, copies: number, draws: number): number {
  if (unseen <= 0 || copies <= 0 || draws <= 0) return 0;
  if (draws === 1) return Math.min(1, copies / unseen);
  if (draws > unseen - copies) return 1;
  let miss = 1;
  for (let i = 0; i < draws; i++) miss *= 1 - copies / (unseen - i);
  return 1 - miss;
}

const waitsByGame = new WeakMap<MahjongGame, Map<Seat, { key: string; waits: number[] }>>();

function cachedWaits(game: MahjongGame, seat: Seat): number[] {
  const { hand, melds } = game.players[seat]!;
  const key = `${hand.join(',')}/${melds.map((meld) => `${meld.type}:${meld.tile}`).join(',')}`;
  let cache = waitsByGame.get(game);
  if (!cache) waitsByGame.set(game, cache = new Map());
  const entry = cache.get(seat);
  if (entry?.key === key) return entry.waits;
  const waits = game.winningDraws(seat);
  cache.set(seat, { key, waits });
  return waits;
}

export function estimateSelfDraw(game: MahjongGame, seat: Seat) {
  if (game.phase !== 'turn' && game.phase !== 'claim') return undefined;
  const waits = cachedWaits(game, seat);
  if (waits.length === 0) return undefined;

  const { remaining, unseenTiles } = drawPool(game, seat);
  const live = Math.max(0, game.wall.liveRemaining - game.wall.deadWallCount);
  const { playerCount } = game;
  const anchor = game.claim?.fromSeat ?? game.currentSeat;
  const distance = (seat - anchor + playerCount) % playerCount || playerCount;
  const drawsRemaining = Math.max(0, 1 + Math.floor((live - distance) / playerCount));
  const waiting = waits.map((idx) => ({ tile: game.index.tile(idx), unseenCopies: remaining[idx]! }));
  const copies = waiting.reduce((total, tile) => total + tile.unseenCopies, 0);
  return {
    waiting,
    unseenTiles,
    drawsRemaining,
    nextDrawChance: chanceToHit(unseenTiles, copies, drawsRemaining > 0 ? 1 : 0),
    selfDrawChance: chanceToHit(unseenTiles, copies, drawsRemaining),
  };
}
