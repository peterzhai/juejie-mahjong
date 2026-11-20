/** PRD 4.3 内置牌张预设（快捷填充，仍需统一校验） */

import type { TileFaceConfig, TileSetConfig } from './schema.js';
import type { HonorFaceName, SuitFaceName } from './tiles.js';

export interface TileSetPreset extends TileSetConfig {
  preset: string;
  description: string;
  reserved?: boolean;
}

const on = (copies = 4): TileFaceConfig => ({ enabled: true, copies });
const off: TileFaceConfig = { enabled: false, copies: 0 };

function suits(spec: Partial<Record<SuitFaceName, TileFaceConfig>>): TileSetConfig['suits'] {
  return {
    character: spec.character ?? off,
    bamboo: spec.bamboo ?? off,
    dot: spec.dot ?? off,
  };
}

function honors(spec: Partial<Record<HonorFaceName, TileFaceConfig>>): TileSetConfig['honors'] {
  return {
    east: spec.east ?? off,
    south: spec.south ?? off,
    west: spec.west ?? off,
    north: spec.north ?? off,
    red: spec.red ?? off,
    green: spec.green ?? off,
    white: spec.white ?? off,
  };
}

const ALL_SUITS_ON = { character: on(), bamboo: on(), dot: on() };
const ALL_WINDS = { east: on(), south: on(), west: on(), north: on() };
const ALL_DRAGONS = { red: on(), green: on(), white: on() };
const ALL_HONORS = { ...ALL_WINDS, ...ALL_DRAGONS };

export const TILE_SET_PRESETS: Record<string, TileSetPreset> = {
  gd100: {
    preset: 'gd100',
    description: '条+筒+东南西北中发白，红中变常见（无万）',
    suits: suits({ bamboo: on(), dot: on() }),
    honors: honors(ALL_HONORS),
    flowers: off,
    dealerExtraTile: 1,
    redCenterMode: 'wild',
    redCenterDrawOnly: false,
    sevenPairsWithWild: true,
  },
  gd108: {
    preset: 'gd108',
    description: '万+条+筒，推倒胡无字牌',
    suits: suits(ALL_SUITS_ON),
    honors: honors({}),
    flowers: off,
    dealerExtraTile: 1,
    redCenterMode: 'off',
    redCenterDrawOnly: false,
    sevenPairsWithWild: true,
  },
  gd112: {
    preset: 'gd112',
    description: '万+条+筒+东南西北，风牌局',
    // PRD 4.3 表格总张数 112 = 万条筒 108 + 东南西北共 4 张（风向牌 copies=1）。
    // 注：PRD 组成描述与总张数列存在内部不一致，按表格黄金值为准。
    suits: suits(ALL_SUITS_ON),
    honors: honors({ east: on(1), south: on(1), west: on(1), north: on(1) }),
    flowers: off,
    dealerExtraTile: 1,
    redCenterMode: 'off',
    redCenterDrawOnly: false,
    sevenPairsWithWild: true,
  },
  gd116: {
    preset: 'gd116',
    description: '112 + 红中×4，红中变（无发白）',
    suits: suits(ALL_SUITS_ON),
    honors: honors({ east: on(1), south: on(1), west: on(1), north: on(1), red: on() }),
    flowers: off,
    dealerExtraTile: 1,
    redCenterMode: 'wild',
    redCenterDrawOnly: false,
    sevenPairsWithWild: true,
  },
  gd120: {
    preset: 'gd120',
    description: '108 + 中发白×4，箭牌局',
    suits: suits(ALL_SUITS_ON),
    honors: honors(ALL_DRAGONS),
    flowers: off,
    dealerExtraTile: 1,
    redCenterMode: 'normal',
    redCenterDrawOnly: false,
    sevenPairsWithWild: true,
  },
  gd124: {
    preset: 'gd124',
    description: '全字牌无红中（万条筒 + 东南西北×2 + 发白×4 = 124）',
    // PRD 组成描述"112 + 中发白×4"与其说明"无红中"矛盾，按说明（无红中）与总张数 124 取：
    // 万条筒 108 + 东南西北×2 = 8 + 发白×4 = 8 → 124
    suits: suits(ALL_SUITS_ON),
    honors: honors({ east: on(2), south: on(2), west: on(2), north: on(2), green: on(), white: on() }),
    flowers: off,
    dealerExtraTile: 1,
    redCenterMode: 'off',
    redCenterDrawOnly: false,
    sevenPairsWithWild: true,
  },
  gd128: {
    preset: 'gd128',
    description: '万+条+筒+东南西北+红中×4，红中变主流',
    suits: suits(ALL_SUITS_ON),
    honors: honors({ ...ALL_WINDS, red: on() }),
    flowers: off,
    dealerExtraTile: 1,
    redCenterMode: 'wild',
    redCenterDrawOnly: false,
    sevenPairsWithWild: true,
  },
  gd136: {
    preset: 'gd136',
    description: '全牌（万条筒+全字牌），标准全牌',
    suits: suits(ALL_SUITS_ON),
    honors: honors(ALL_HONORS),
    flowers: off,
    dealerExtraTile: 1,
    redCenterMode: 'normal',
    redCenterDrawOnly: false,
    sevenPairsWithWild: true,
  },
  gd144: {
    preset: 'gd144',
    description: '136 + 8 花牌，带花变体（v0.2 预留，仅供张数核算）',
    reserved: true,
    suits: suits(ALL_SUITS_ON),
    honors: honors(ALL_HONORS),
    flowers: on(1),
    dealerExtraTile: 1,
    redCenterMode: 'normal',
    redCenterDrawOnly: false,
    sevenPairsWithWild: true,
  },
};

export function getPreset(id: string): TileSetPreset {
  const p = TILE_SET_PRESETS[id];
  if (!p) throw new Error(`未知牌张预设: ${id}（可用: ${Object.keys(TILE_SET_PRESETS).join(', ')}）`);
  return p;
}

export function clonePreset(id: string): TileSetPreset {
  return structuredClone(getPreset(id));
}
