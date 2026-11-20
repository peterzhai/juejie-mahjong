/** PRD 6.1 配置 schema 类型定义（前后端共用） */

import type { FaceName, HonorFaceName, SuitFaceName } from './tiles.js';

export type RedCenterMode = 'wild' | 'normal' | 'off';
export type ScoringMode = 'max' | 'additive';
export type CapScope = 'global' | 'group' | 'player';
export type BypassConditionType = 'selfDraw' | 'kongBlossom' | 'noRedCenter' | 'robbingKong';

export interface TileFaceConfig {
  enabled: boolean;
  copies: number;
}

export interface TileSetConfig {
  preset?: string;
  suits: Record<'character' | 'bamboo' | 'dot', TileFaceConfig>;
  honors: Record<HonorFaceName, TileFaceConfig>;
  flowers: TileFaceConfig;
  /** 庄家起始多摸张数（4×13 + dealerExtraTile） */
  dealerExtraTile: number;
  redCenterMode: RedCenterMode;
  /** 万能牌模式下仅自摸可胡（PRD 5.3） */
  redCenterDrawOnly?: boolean;
  /** 七对是否允许含红中万能牌（PRD 5.3） */
  sevenPairsWithWild?: boolean;
}

export interface FanDefinition {
  id: string;
  name: string;
  /** 番数，非负整数 */
  value: number;
  enabled: boolean;
  /** 同组互斥，取最高（PRD 6.2） */
  exclusiveGroup?: string;
  /** 兜底番，任何胡牌至少命中一种 */
  fallback?: boolean;
  /** 依赖牌面（配置牌面名或特殊组 terminalsAndHonors13），与 tileSet 求交 */
  requiresTiles?: string[];
  /** 依赖的数字花色最少种数 */
  requiresSuits?: number;
  /** 要求至少一种字牌启用 */
  requiresHonors?: boolean;
  /** 仅红中为万能牌时生效 */
  onlyWhenWild?: boolean;
}

export interface BonusFanDefinition {
  id: string;
  name: string;
  value: number;
  enabled: boolean;
}

export interface CapValueFixed { type: 'fixed'; fixed: number; hardCap?: number }
export interface CapValueTiered { type: 'tiered'; tiers: number[]; tierSelector: 'roomLevel'; hardCap?: number }
export interface CapValueFormula { type: 'formula'; formula: string; hardCap: number }
export interface CapValueUnlimited { type: 'unlimited'; hardCap?: number }
export type CapValue = CapValueFixed | CapValueTiered | CapValueFormula | CapValueUnlimited;

export interface CapGroup {
  id: string;
  capFan: number;
  fanIds: string[];
}

export interface CapBypass {
  fanIds?: string[];
  conditions?: { type: BypassConditionType; enabled: boolean }[];
}

export interface CapConfig {
  enabled: boolean;
  value: CapValue;
  /** 保底番（封顶后、hardCap 前做下限保护） */
  minFan?: number;
  /** 分数上限（最后执行） */
  maxScore?: number;
  scope: CapScope;
  /** scope=player 时按庄位偏移 capFan */
  playerOffsets?: { dealer?: number; nonDealer?: number };
  groups?: CapGroup[];
  bypass?: CapBypass;
  /** 全局 hardCap（value.hardCap 优先） */
  hardCap?: number;
}

export interface RedCenterBonusConfig {
  enabled: boolean;
  mode: 'none' | 'addFan' | 'fanDouble' | 'scoreDouble';
  /** addFan 模式的加番值 */
  addFan?: number;
  /** true 时无红中加成在封顶之后执行（PRD 6.4 双运算顺序） */
  bypassCap?: boolean;
  onlyWhenWild?: boolean;
}

export interface KongScoreConfig {
  /** 大明杠：点杠者支付底分倍数 */
  mingangPayerMultiplier?: number;
  /** 补杠：其余三家各付底分倍数 */
  bugangEach?: number;
  /** 暗杠：其余三家各付底分倍数 */
  ankangEach?: number;
}

export interface RuleToggles {
  /** 漏胡锁定（同轮同张不可胡） */
  missedWinLock?: boolean;
  /** 一炮多响 */
  multiWinEnabled?: boolean;
  /** 十三幺可抢暗杠 */
  robConcealedKongForThirteenOrphans?: boolean;
  /** 补杠被抢杠 → 被抢杠者包三家 */
  baoRobKong?: boolean;
  /** 放杠导致杠上开花 → 点杠者包三家 */
  baoKongBlossom?: boolean;
  /** 十二张落地后点炮/单吊自摸 → 包三家 */
  baoTwelveExposed?: boolean;
  /** 大三元/大四喜最后一组由同一人打出 → 打出者包三家（可配） */
  baoBigDragonWind?: boolean;
  kongScores?: KongScoreConfig;
}

export interface ScoringConfig {
  mode: ScoringMode;
  baseScore: number;
  cap: CapConfig;
  redCenterBonus: RedCenterBonusConfig;
}

export interface FanConfig {
  version: string;
  tileSet: TileSetConfig;
  scoring: ScoringConfig;
  fans: FanDefinition[];
  bonusFans: BonusFanDefinition[];
  rules?: RuleToggles;
}
