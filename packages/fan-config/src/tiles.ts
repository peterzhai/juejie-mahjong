/**
 * 牌面注册表：唯一事实来源（PRD 4.1 组合式配置的牌面名 → 具体 TileId）。
 * 牌 ID：C1..C9 万 / B1..B9 条 / D1..D9 筒 / WE WS WW WN 风 / HR HG HW 中发白 / F1..F8 花(v0.2)
 */

export type TileId = string;

export type SuitFaceName = 'character' | 'bamboo' | 'dot';
export type HonorFaceName = 'east' | 'south' | 'west' | 'north' | 'red' | 'green' | 'white';
export type FaceName = SuitFaceName | HonorFaceName | 'flowers';
export type TileSuit = 'character' | 'bamboo' | 'dot' | 'wind' | 'dragon' | 'flower';

export interface TileDef {
  id: TileId;
  face: FaceName;
  suit: TileSuit;
  /** 数字牌 1..9；字牌/花牌为 null */
  rank: number | null;
  label: string;
}

export const SUIT_FACES: readonly SuitFaceName[] = ['character', 'bamboo', 'dot'];
export const WIND_FACES: readonly HonorFaceName[] = ['east', 'south', 'west', 'north'];
export const DRAGON_FACES: readonly HonorFaceName[] = ['red', 'green', 'white'];
export const HONOR_FACES: readonly HonorFaceName[] = [...WIND_FACES, ...DRAGON_FACES];

const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九'] as const;
const SUIT_PREFIX: Record<SuitFaceName, string> = { character: '万', bamboo: '条', dot: '筒' };
const SUIT_ID_PREFIX: Record<SuitFaceName, string> = { character: 'C', bamboo: 'B', dot: 'D' };
const WIND_LABEL: Record<string, string> = { east: '东', south: '南', west: '西', north: '北' };
const DRAGON_LABEL: Record<string, string> = { red: '中', green: '发', white: '白' };

function build(): TileDef[] {
  const defs: TileDef[] = [];
  for (const face of SUIT_FACES) {
    for (let n = 1; n <= 9; n++) {
      defs.push({
        id: `${SUIT_ID_PREFIX[face]}${n}`,
        face,
        suit: face,
        rank: n,
        label: `${CN_NUM[n - 1]}${SUIT_PREFIX[face]}`,
      });
    }
  }
  for (const face of WIND_FACES) {
    defs.push({ id: `W${face[0].toUpperCase()}`, face, suit: 'wind', rank: null, label: WIND_LABEL[face] });
  }
  for (const face of DRAGON_FACES) {
    defs.push({ id: `H${face[0].toUpperCase()}`, face, suit: 'dragon', rank: null, label: DRAGON_LABEL[face] });
  }
  for (let n = 1; n <= 8; n++) {
    defs.push({ id: `F${n}`, face: 'flowers', suit: 'flower', rank: n, label: `花${n}` });
  }
  return defs;
}

export const TILE_ORDER: readonly TileDef[] = build();
export const TILE_BY_ID: ReadonlyMap<TileId, TileDef> = new Map(TILE_ORDER.map((d) => [d.id, d]));

export function tileDef(id: TileId): TileDef {
  const d = TILE_BY_ID.get(id);
  if (!d) throw new Error(`未知牌面 ID: ${id}`);
  return d;
}

export function tileLabel(id: TileId): string {
  return tileDef(id).label;
}

export function isHonorTile(id: TileId): boolean {
  const s = tileDef(id).suit;
  return s === 'wind' || s === 'dragon';
}

export function isTerminalTile(id: TileId): boolean {
  const d = tileDef(id);
  return d.rank === 1 || d.rank === 9;
}

export function isOrphanTile(id: TileId): boolean {
  return isTerminalTile(id) || isHonorTile(id);
}

/** 十三幺标准 13 种幺九字牌 */
export const TERMINALS_AND_HONORS_13: readonly TileId[] = [
  'C1', 'C9', 'B1', 'B9', 'D1', 'D9', 'WE', 'WS', 'WW', 'WN', 'HR', 'HG', 'HW',
];

/** 配置牌面名 → 该牌面包含的所有 TileId */
export function faceToTiles(face: FaceName): TileId[] {
  if (face === 'flowers') return TILE_ORDER.filter((d) => d.suit === 'flower').map((d) => d.id);
  return TILE_ORDER.filter((d) => d.face === face).map((d) => d.id);
}

/** 万能牌（红中）固定 ID */
export const RED_CENTER_TILE: TileId = 'HR';

/** TileId → 配置牌面名（供依赖校验使用） */
export function tileToFaceSafe(id: TileId): FaceName {
  if (id.startsWith('W')) {
    return ({ E: 'east', S: 'south', W: 'west', N: 'north' } as Record<string, FaceName>)[id[1]!]!;
  }
  if (id.startsWith('H')) {
    return ({ R: 'red', G: 'green', W: 'white' } as Record<string, FaceName>)[id[1]!]!;
  }
  return id[0] === 'C' ? 'character' : id[0] === 'B' ? 'bamboo' : 'dot';
}
