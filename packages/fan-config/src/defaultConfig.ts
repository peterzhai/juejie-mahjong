/** PRD 12 默认推荐配置（gd128 红中变 + 3 番封顶 + 无红中 scoreDouble + 特殊牌型突破） */

import { FAN_CONFIG_VERSION } from './version.js';
import { clonePreset } from './presets.js';
import { autoDisableUnmetFans } from './resolve.js';
import { cloneConfigData } from './cloneConfigData.js';
import type { BonusFanDefinition, FanConfig, FanDefinition } from './schema.js';

/** PRD 5.5 默认番型表（全部可配） */
export const DEFAULT_FANS: FanDefinition[] = [
  { id: 'chicken', name: '鸡胡', value: 0, enabled: true, fallback: true },
  { id: 'allSequences', name: '平胡', value: 1, enabled: true, exclusiveGroup: 'structure' },
  { id: 'allTriplets', name: '碰碰胡', value: 2, enabled: true, exclusiveGroup: 'structure' },
  { id: 'halfFlush', name: '混一色', value: 2, enabled: true, requiresSuits: 1, requiresHonors: true, exclusiveGroup: 'flush' },
  { id: 'fullFlush', name: '清一色', value: 3, enabled: true, requiresSuits: 1, exclusiveGroup: 'flush' },
  { id: 'halfFlushTriplets', name: '混碰', value: 3, enabled: true, requiresSuits: 1, requiresHonors: true, exclusiveGroup: 'flush' },
  { id: 'fullFlushTriplets', name: '清碰', value: 4, enabled: true, requiresSuits: 1, exclusiveGroup: 'flush' },
  { id: 'mixedTerminals', name: '混幺九', value: 4, enabled: true },
  { id: 'allTerminals', name: '清幺九', value: 5, enabled: true },
  { id: 'smallDragons', name: '小三元', value: 5, enabled: true, requiresTiles: ['red', 'green', 'white'] },
  { id: 'smallWinds', name: '小四喜', value: 5, enabled: true, requiresTiles: ['east', 'south', 'west', 'north'] },
  { id: 'allHonors', name: '字一色', value: 5, enabled: true, requiresTiles: ['east', 'south', 'west', 'north', 'red', 'green', 'white'] },
  { id: 'bigDragons', name: '大三元', value: 6, enabled: true, requiresTiles: ['red', 'green', 'white'] },
  { id: 'bigWinds', name: '大四喜', value: 6, enabled: true, requiresTiles: ['east', 'south', 'west', 'north'] },
  { id: 'nineGates', name: '九莲宝灯', value: 6, enabled: true, requiresSuits: 1 },
  { id: 'sevenPairs', name: '七对', value: 2, enabled: true, requiresTiles: [] },
  { id: 'thirteenOrphans', name: '十三幺', value: 8, enabled: true, requiresTiles: ['terminalsAndHonors13'] },
];

/** PRD 5.5 附加番（均 +1，可开关） */
export const DEFAULT_BONUS_FANS: BonusFanDefinition[] = [
  { id: 'selfDraw', name: '自摸', value: 1, enabled: true },
  { id: 'seatWindTriplet', name: '门风刻', value: 1, enabled: true },
  { id: 'roundWindTriplet', name: '圈风刻', value: 1, enabled: true },
  { id: 'dragonTriplet', name: '箭牌刻', value: 1, enabled: true },
  { id: 'kongBlossom', name: '杠上开花', value: 1, enabled: true },
  { id: 'robbingKong', name: '抢杠胡', value: 1, enabled: true },
];

/**
 * 默认推荐配置：
 * - tileSet: gd128 + redCenterMode=wild
 * - scoring: max / baseScore 1 / cap fixed=3 (hardCap 10, minFan 1, maxScore 1e6, global)
 *   bypass.fanIds = 清一色/清碰/大三元/大四喜/九莲宝灯；conditions selfDraw 默认关
 * - redCenterBonus: scoreDouble / bypassCap false / onlyWhenWild true
 * - 十三幺因缺发白自动禁用（autoDisableUnmetFans）
 */
export function defaultFanConfig(): FanConfig {
  const config: FanConfig = {
    version: FAN_CONFIG_VERSION,
    tileSet: clonePreset('gd128'),
    scoring: {
      mode: 'max',
      baseScore: 1,
      cap: {
        enabled: true,
        value: { type: 'fixed', fixed: 3 },
        hardCap: 10,
        minFan: 1,
        maxScore: 1000000,
        scope: 'global',
        groups: [],
        bypass: {
          fanIds: ['fullFlush', 'fullFlushTriplets', 'bigDragons', 'bigWinds', 'nineGates'],
          conditions: [{ type: 'selfDraw', enabled: false }],
        },
      },
      redCenterBonus: {
        enabled: true,
        mode: 'scoreDouble',
        addFan: 1,
        bypassCap: false,
        onlyWhenWild: true,
      },
    },
    fans: cloneConfigData(DEFAULT_FANS),
    bonusFans: cloneConfigData(DEFAULT_BONUS_FANS),
    rules: {
      missedWinLock: true,
      multiWinEnabled: false,
      robConcealedKongForThirteenOrphans: true,
      baoRobKong: true,
      baoKongBlossom: true,
      baoTwelveExposed: true,
      baoBigDragonWind: true,
      kongScores: { mingangPayerMultiplier: 3, bugangEach: 1, ankangEach: 2 },
    },
  };
  const { config: resolved } = autoDisableUnmetFans(config);
  return resolved;
}
