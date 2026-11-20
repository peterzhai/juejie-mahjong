/** 牌张数学（PRD 4.2 动态计算，不写死任何张数） */

import type { TileFaceConfig, TileSetConfig } from './schema.js';
import { faceToTiles, type FaceName } from './tiles.js';

export interface TileMath {
  totalTiles: number;
  dealTiles: number;
  wallTiles: number;
  deadWallCount: number;
}

const GAME_FACES: FaceName[] = [
  'character', 'bamboo', 'dot',
  'east', 'south', 'west', 'north', 'red', 'green', 'white', 'flowers',
];

export function faceConfig(tileSet: TileSetConfig, face: FaceName): TileFaceConfig {
  switch (face) {
    case 'character': return tileSet.suits.character;
    case 'bamboo': return tileSet.suits.bamboo;
    case 'dot': return tileSet.suits.dot;
    case 'east': return tileSet.honors.east;
    case 'south': return tileSet.honors.south;
    case 'west': return tileSet.honors.west;
    case 'north': return tileSet.honors.north;
    case 'red': return tileSet.honors.red;
    case 'green': return tileSet.honors.green;
    case 'white': return tileSet.honors.white;
    case 'flowers': return tileSet.flowers;
  }
}

export function faceEnabled(tileSet: TileSetConfig, face: FaceName): boolean {
  return faceConfig(tileSet, face).enabled;
}

export function enabledSuitCount(tileSet: TileSetConfig): number {
  return (['character', 'bamboo', 'dot'] as const).filter((f) => tileSet.suits[f].enabled).length;
}

export function anyHonorEnabled(tileSet: TileSetConfig): boolean {
  return (['east', 'south', 'west', 'north', 'red', 'green', 'white'] as const)
    .some((f) => tileSet.honors[f].enabled);
}

/** 启用牌面 → 全部实体 TileId 列表（含重复 copies） */
export function buildTileList(tileSet: TileSetConfig): string[] {
  const tiles: string[] = [];
  for (const face of GAME_FACES) {
    const cfg = faceConfig(tileSet, face);
    if (!cfg.enabled) continue;
    const ids = faceToTiles(face);
    for (let i = 0; i < cfg.copies; i++) tiles.push(...ids);
  }
  return tiles;
}

export function computeTileMath(tileSet: TileSetConfig): TileMath {
  const totalTiles = buildTileList(tileSet).length;
  const dealTiles = 4 * 13 + tileSet.dealerExtraTile;
  const wallTiles = totalTiles - dealTiles;
  const deadWallCount = Math.max(7, Math.ceil(wallTiles * 0.15));
  return { totalTiles, dealTiles, wallTiles, deadWallCount };
}
