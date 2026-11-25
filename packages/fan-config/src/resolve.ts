/** 启动校验后生成运行时只读配置（PRD 2 术语 resolvedFanConfig / 6.5.7 元数据） */

import type {
  BonusFanDefinition,
  FanConfig,
  FanDefinition,
  RuleToggles,
  ScoringConfig,
  TileSetConfig,
} from './schema.js';
import { computeTileMath, faceEnabled, enabledSuitCount, anyHonorEnabled, faceConfig, type TileMath } from './math.js';
import { validateFanConfig, type ValidateOptions, type ValidationIssue } from './validate.js';
import { RED_CENTER_TILE, TERMINALS_AND_HONORS_13, tileToFaceSafe, tileLabel } from './tiles.js';
import type { FaceName } from './tiles.js';
import { cloneConfigData } from './cloneConfigData.js';

export interface ResolvedFanEntry {
  id: string;
  name: string;
  value: number;
  enabled: boolean;
  /** 依赖是否被当前 tileSet 满足（与 enabled 无关） */
  available: boolean;
  /** 依赖不满足时给出的原因（含缺失牌面列表） */
  unavailableReason?: string;
  exclusiveGroup?: string;
  fallback?: boolean;
  onlyWhenWild?: boolean;
  requiresTiles?: string[];
  requiresSuits?: number;
  requiresHonors?: boolean;
}

export interface ResolvedFanConfig {
  version: string;
  tileSet: TileSetConfig;
  tileSetPresetId?: string;
  tileMath: TileMath;
  redCenterMode: TileSetConfig['redCenterMode'];
  /** 万能牌 TileId（wild 模式为 HR，否则 null） */
  wildcardTile: string | null;
  redCenterDrawOnly: boolean;
  sevenPairsWithWild: boolean;
  fans: ResolvedFanEntry[];
  bonusFans: BonusFanDefinition[];
  scoring: ScoringConfig;
  rules: Required<RuleToggles>;
  configHash: string;
  resolvedFanConfigHash: string;
}

/** 稳定序列化（键排序），用于哈希 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** FNV-1a 32 位哈希（hex） */
export function hash32(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export const DEFAULT_RULES: Required<RuleToggles> = {
  allowDiscardHu: true,
  missedWinLock: true,
  multiWinEnabled: false,
  robConcealedKongForThirteenOrphans: true,
  baoRobKong: true,
  baoKongBlossom: true,
  baoTwelveExposed: true,
  baoBigDragonWind: true,
  kongScores: { mingangPayerMultiplier: 3, bugangEach: 1, ankangEach: 2 },
};

/** 番型依赖是否满足（不区分 enabled） */
function fanDependencyMet(fan: FanDefinition, config: FanConfig): { met: boolean; reason?: string } {
  const tileSet = config.tileSet;
  const missing: string[] = [];
  let orphanAvailable = TERMINALS_AND_HONORS_13.length;

  for (const req of fan.requiresTiles ?? []) {
    if (req === 'terminalsAndHonors13') {
      const missingTiles = TERMINALS_AND_HONORS_13.filter((id) => !faceEnabled(tileSet, tileToFaceSafe(id))).map(tileLabel);
      missing.push(...missingTiles);
      orphanAvailable = TERMINALS_AND_HONORS_13.length - missingTiles.length;
      continue;
    }
    const face = req as FaceName;
    if (!faceEnabled(tileSet, face)) missing.push(...(tileToFaceSafeFaceTiles(face)));
  }
  if (missing.length > 0) {
    let reason = `缺少牌面: ${missing.join('、')}`;
    if (fan.requiresTiles?.includes('terminalsAndHonors13')) {
      reason += `（幺九字牌仅 ${orphanAvailable} 种，需 13 种）`;
    }
    return { met: false, reason };
  }
  if (typeof fan.requiresSuits === 'number' && enabledSuitCount(tileSet) < fan.requiresSuits) {
    return { met: false, reason: `需要 ${fan.requiresSuits} 种数字花色，当前 ${enabledSuitCount(tileSet)} 种` };
  }
  if (fan.requiresHonors && !anyHonorEnabled(tileSet)) {
    return { met: false, reason: '需要启用至少一种字牌' };
  }
  if (fan.onlyWhenWild && tileSet.redCenterMode !== 'wild') {
    return { met: false, reason: '仅 redCenterMode="wild" 时可用' };
  }
  return { met: true };
}

function tileToFaceSafeFaceTiles(face: FaceName): string[] {
  const map: Record<string, string[]> = {
    character: ['一万', '九万'], bamboo: ['一条', '九条'], dot: ['一筒', '九筒'],
    east: ['东'], south: ['南'], west: ['西'], north: ['北'],
    red: ['中'], green: ['发'], white: ['白'], flowers: [],
  };
  return map[face] ?? [];
}

export interface ResolveResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  resolved?: ResolvedFanConfig;
}

export function resolveFanConfig(config: FanConfig, options: ValidateOptions = {}): ResolveResult {
  const validation = validateFanConfig(config, options);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors, warnings: validation.warnings };
  }

  const tileSet = config.tileSet;
  const tileMath = computeTileMath(tileSet);
  const redCenterMode = tileSet.redCenterMode;

  const fans: ResolvedFanEntry[] = config.fans.map((fan) => {
    const dep = fanDependencyMet(fan, config);
    return {
      id: fan.id,
      name: fan.name,
      value: fan.value,
      enabled: fan.enabled,
      available: dep.met,
      unavailableReason: dep.met ? undefined : dep.reason,
      exclusiveGroup: fan.exclusiveGroup,
      fallback: fan.fallback,
      onlyWhenWild: fan.onlyWhenWild,
      requiresTiles: fan.requiresTiles,
      requiresSuits: fan.requiresSuits,
      requiresHonors: fan.requiresHonors,
    };
  });

  const resolved: ResolvedFanConfig = {
    version: config.version,
    tileSet: cloneConfigData(tileSet),
    tileSetPresetId: tileSet.preset,
    tileMath,
    redCenterMode,
    wildcardTile: redCenterMode === 'wild' ? RED_CENTER_TILE : null,
    redCenterDrawOnly: tileSet.redCenterDrawOnly ?? false,
    sevenPairsWithWild: tileSet.sevenPairsWithWild ?? true,
    fans,
    bonusFans: cloneConfigData(config.bonusFans),
    scoring: cloneConfigData(config.scoring),
    rules: {
      ...DEFAULT_RULES,
      ...config.rules,
      kongScores: { ...DEFAULT_RULES.kongScores, ...config.rules?.kongScores },
    },
    configHash: hash32(stableStringify(config)),
    resolvedFanConfigHash: hash32(stableStringify({ fans, tileSet, scoring: config.scoring })),
  };

  return { ok: true, errors: [], warnings: validation.warnings, resolved };
}

export interface AutoDisableResult {
  config: FanConfig;
  disabled: { fanId: string; fanName: string; reason: string }[];
}

/** 预设应用流程：将依赖不满足且 enabled 的番型自动禁用（PRD 5.5/12：如十三幺因缺发白自动禁用） */
export function autoDisableUnmetFans(config: FanConfig): AutoDisableResult {
  const out = cloneConfigData(config);
  const disabled: AutoDisableResult['disabled'] = [];
  const disabledIds = new Set<string>();
  for (const fan of out.fans) {
    if (!fan.enabled) continue;
    const dep = fanDependencyMet(fan, out);
    if (!dep.met) {
      fan.enabled = false;
      disabledIds.add(fan.id);
      disabled.push({ fanId: fan.id, fanName: fan.name, reason: dep.reason ?? '' });
    }
  }
  // 同步清理 cap 引用，保证 6.5.6 规则 10/11（bypass.fanIds 与 groups 必须引用 enabled 番型）
  const cap = out.scoring.cap;
  if (cap.bypass?.fanIds) {
    cap.bypass.fanIds = cap.bypass.fanIds.filter((id) => !disabledIds.has(id));
  }
  for (const g of cap.groups ?? []) {
    g.fanIds = g.fanIds.filter((id) => !disabledIds.has(id));
  }
  return { config: out, disabled };
}

/** 汇总当前配置的番型可用性矩阵（供规则展示 UI） */
export function fanAvailabilityMatrix(resolved: ResolvedFanConfig): Record<string, { available: boolean; enabled: boolean; reason?: string }> {
  const out: Record<string, { available: boolean; enabled: boolean; reason?: string }> = {};
  for (const f of resolved.fans) {
    out[f.id] = { available: f.available, enabled: f.enabled, reason: f.unavailableReason };
  }
  return out;
}

// re-export 便于上层使用
export { computeTileMath, faceEnabled, faceConfig };
