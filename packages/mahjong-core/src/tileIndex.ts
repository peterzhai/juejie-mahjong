/** 动态牌索引：按启用牌面生成（不硬编码 34 种），供胡牌判定/AI 使用 */

import type { ResolvedFanConfig, SuitFaceName, TileSuit } from '@quejie/fan-config';
import { faceConfig, faceToTiles, RED_CENTER_TILE, tileDef } from '@quejie/fan-config';
import type { FaceName, TileId } from '@quejie/fan-config';

export class TileIndex {
  /** 启用牌面的去重 ID，顺序：万条筒（各 9）→ 风 → 箭 */
  readonly ids: readonly TileId[];
  readonly indexOf: ReadonlyMap<TileId, number>;
  readonly wildIndex: number;
  readonly wildcardTile: TileId | null;
  /** 每种花色的 rank(1..9) → 索引（仅启用的花色） */
  readonly suitRanks: ReadonlyMap<SuitFaceName, readonly number[]>;

  constructor(resolved: ResolvedFanConfig) {
    const tileSet = resolved.tileSet;
    const faces: FaceName[] = ['character', 'bamboo', 'dot', 'east', 'south', 'west', 'north', 'red', 'green', 'white'];
    const ids: TileId[] = [];
    const suitRanks = new Map<SuitFaceName, number[]>();
    for (const face of faces) {
      if (!faceConfig(tileSet, face).enabled) continue;
      const tiles = faceToTiles(face);
      if (face === 'character' || face === 'bamboo' || face === 'dot') {
        suitRanks.set(face, tiles.map((t) => ids.length + tiles.indexOf(t)));
        ids.push(...tiles);
      } else {
        ids.push(...tiles);
      }
    }
    this.ids = ids;
    this.suitRanks = suitRanks;
    const map = new Map<string, number>();
    ids.forEach((id, i) => map.set(id, i));
    this.indexOf = map;
    this.wildcardTile = resolved.wildcardTile;
    this.wildIndex = resolved.wildcardTile ? (map.get(resolved.wildcardTile) ?? -1) : -1;
  }

  idx(tile: TileId): number {
    const i = this.indexOf.get(tile);
    if (i === undefined) throw new Error(`牌 ${tile} 不在当前牌集中`);
    return i;
  }

  tile(i: number): TileId {
    return this.ids[i]!;
  }

  isWildcard(i: number): boolean {
    return this.wildIndex >= 0 && i === this.wildIndex;
  }

  /** 数字牌 rank（1..9），非数字牌返回 null */
  rankOf(i: number): number | null {
    return tileDef(this.ids[i]!).rank;
  }

  suitFaceOf(i: number): SuitFaceName | null {
    const suit = tileDef(this.ids[i]!).suit;
    return suit === 'character' || suit === 'bamboo' || suit === 'dot' ? suit : null;
  }

  /** 同花色 rank+1 的索引，越界/非数字牌返回 -1 */
  nextInSuit(i: number): number {
    const face = this.suitFaceOf(i);
    const rank = this.rankOf(i);
    if (!face || !rank || rank >= 9) return -1;
    const ranks = this.suitRanks.get(face)!;
    return ranks[rank]!; // ranks[rank] 即 rank+1（数组 0 基 = rank1）
  }

  prevInSuit(i: number): number {
    const face = this.suitFaceOf(i);
    const rank = this.rankOf(i);
    if (!face || !rank || rank <= 1) return -1;
    const ranks = this.suitRanks.get(face)!;
    return ranks[rank - 2]!;
  }

  /** 手牌/副露中是否存在红中（含暗杠；不含弃牌区与他家副露）——无红中加成判定用 */
  static hasRedCenter(tiles: TileId[], melds: { tile: TileId }[], wildcardTile: TileId | null): boolean {
    if (wildcardTile !== null) {
      if (tiles.includes(RED_CENTER_TILE)) return true;
      return melds.some((m) => m.tile === RED_CENTER_TILE);
    }
    return tiles.includes(RED_CENTER_TILE) || melds.some((m) => m.tile === RED_CENTER_TILE);
  }
}

export function countsOf(tiles: TileId[], index: TileIndex): number[] {
  const counts = new Array<number>(index.ids.length).fill(0);
  for (const t of tiles) counts[index.idx(t)]!++;
  return counts;
}
