/** PRD 6.3 启动校验（fail-fast） + 6.5.6 cap 校验规则 8–12 */

import type {
  BypassConditionType,
  CapConfig,
  FanConfig,
  FanDefinition,
} from './schema.js';
import { computeTileMath, faceEnabled, enabledSuitCount, anyHonorEnabled, faceConfig } from './math.js';
import { TERMINALS_AND_HONORS_13, faceToTiles, tileLabel, type FaceName } from './tiles.js';
import { compileExpr, EXPR_FUNC_NAMES, EXPR_VARS, ExprError } from './expr.js';

export interface ValidationIssue {
  code: string;
  message: string;
  fanId?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface ValidateOptions {
  /**
   * true（默认）：依赖不满足且 enabled=true → 报错（PRD 6.3 第 3 条）。
   * false：依赖不满足只记录为不可用（resolve 时 available=false），用于预设自动禁用流程。
   */
  strictDependency?: boolean;
}

const BYPASS_CONDITION_TYPES: readonly BypassConditionType[] = [
  'selfDraw', 'kongBlossom', 'noRedCenter', 'robbingKong',
];

function err(code: string, message: string, fanId?: string): ValidationIssue {
  return { code, message, fanId };
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** TileId → 配置牌面名 */
function tileToFace(id: string): FaceName {
  if (id.startsWith('W')) {
    return ({ E: 'east', S: 'south', W: 'west', N: 'north' } as Record<string, FaceName>)[id[1]!]!;
  }
  if (id.startsWith('H')) {
    return ({ R: 'red', G: 'green', W: 'white' } as Record<string, FaceName>)[id[1]!]!;
  }
  return id[0] === 'C' ? 'character' : id[0] === 'B' ? 'bamboo' : 'dot';
}

/** 依赖缺失信息：返回缺失牌面 label 列表；orphan13 时同时返回可用种数 */
function dependencyMissingTiles(fan: FanDefinition, config: FanConfig): { missing: string[]; orphanAvailable: number } {
  const tileSet = config.tileSet;
  const missing: string[] = [];
  let orphanAvailable = TERMINALS_AND_HONORS_13.length;
  for (const req of fan.requiresTiles ?? []) {
    if (req === 'terminalsAndHonors13') {
      const missingTiles = TERMINALS_AND_HONORS_13.filter((id) => !faceEnabled(tileSet, tileToFace(id))).map(tileLabel);
      missing.push(...missingTiles);
      orphanAvailable = TERMINALS_AND_HONORS_13.length - missingTiles.length;
      continue;
    }
    const face = req as FaceName;
    if (!faceEnabled(tileSet, face)) {
      missing.push(...faceToTiles(face).map(tileLabel));
    }
  }
  return { missing, orphanAvailable };
}

function checkFanDependency(fan: FanDefinition, config: FanConfig, strict: boolean, out: ValidationResult): boolean {
  const tileSet = config.tileSet;
  let met = true;

  if (fan.requiresTiles?.length) {
    const { missing, orphanAvailable } = dependencyMissingTiles(fan, config);
    if (missing.length > 0) {
      met = false;
      let msg = `番型"${fan.name}"(${fan.id}) 依赖的牌面缺失: ${missing.join('、')}`;
      if (fan.requiresTiles.includes('terminalsAndHonors13')) {
        msg += `；幺九字牌仅 ${orphanAvailable} 种（需 13 种）`;
      }
      out.errors.push(err('E_FAN_DEPENDENCY_MISSING_TILES', msg, fan.id));
    }
  }
  if (typeof fan.requiresSuits === 'number') {
    const n = enabledSuitCount(tileSet);
    if (n < fan.requiresSuits) {
      met = false;
      out.errors.push(err(
        'E_FAN_DEPENDENCY_MISSING_SUIT',
        `番型"${fan.name}"(${fan.id}) 依赖 ${fan.requiresSuits} 种数字花色，当前仅启用 ${n} 种`,
        fan.id,
      ));
    }
  }
  if (fan.requiresHonors && !anyHonorEnabled(tileSet)) {
    met = false;
    out.errors.push(err(
      'E_FAN_DEPENDENCY_MISSING_HONOR',
      `番型"${fan.name}"(${fan.id}) 依赖字牌，当前 tileSet 未启用任何字牌`,
      fan.id,
    ));
  }
  if (fan.onlyWhenWild && tileSet.redCenterMode !== 'wild') {
    met = false;
    out.errors.push(err(
      'E_FAN_ONLY_WHEN_WILD',
      `番型"${fan.name}"(${fan.id}) 标记 onlyWhenWild，仅 redCenterMode="wild" 时可用`,
      fan.id,
    ));
  }

  if (!met && !strict) {
    // 非严格模式：撤销刚才加入的依赖类错误，改为可用性问题（resolve 记录）
    out.errors = out.errors.filter((e) => e.fanId !== fan.id || !e.code.startsWith('E_FAN_'));
  }
  return met;
}

function checkCap(cap: CapConfig, config: FanConfig, out: ValidationResult): void {
  const fanIds = new Set(config.fans.map((f) => f.id));
  const enabledFanIds = new Set(config.fans.filter((f) => f.enabled).map((f) => f.id));

  // —— 规则 8：value.type 枚举与必填字段 ——
  const value = cap.value;
  let effectiveHardCap: number | undefined = cap.hardCap;
  if ('hardCap' in value && value.hardCap !== undefined) {
    if (!isNonNegInt(value.hardCap) || value.hardCap <= 0) {
      out.errors.push(err('E_CAP_HARDCAP', `cap.value.hardCap 必须为正整数，得到 ${value.hardCap}`));
    } else {
      effectiveHardCap = value.hardCap;
    }
  }
  if (cap.hardCap !== undefined && (!isNonNegInt(cap.hardCap) || cap.hardCap <= 0)) {
    out.errors.push(err('E_CAP_HARDCAP', `cap.hardCap 必须为正整数，得到 ${cap.hardCap}`));
  }

  const capFanResults: number[] = [];
  const minFan = cap.minFan ?? 0;

  switch (value.type) {
    case 'fixed': {
      if (!isNonNegInt(value.fixed)) {
        out.errors.push(err('E_CAP_FIXED', `cap.value.fixed 必须为非负整数，得到 ${value.fixed}`));
      } else {
        capFanResults.push(value.fixed);
      }
      break;
    }
    case 'tiered': {
      if (!Array.isArray(value.tiers) || value.tiers.length === 0) {
        out.errors.push(err('E_CAP_TIERS', 'cap.value.tiers 必须为非空数组'));
      } else {
        for (let i = 0; i < value.tiers.length; i++) {
          const t = value.tiers[i]!;
          if (!isNonNegInt(t)) {
            out.errors.push(err('E_CAP_TIERS', `cap.value.tiers[${i}] 必须为非负整数，得到 ${t}`));
          }
          if (i > 0 && t <= value.tiers[i - 1]!) {
            out.errors.push(err('E_CAP_TIERS', 'cap.value.tiers 必须严格升序'));
          }
          capFanResults.push(t);
        }
      }
      if (value.tierSelector !== 'roomLevel') {
        out.errors.push(err('E_CAP_TIER_SELECTOR', `cap.value.tierSelector 仅支持 "roomLevel"，得到 "${value.tierSelector}"`));
      }
      break;
    }
    case 'formula': {
      if (!value.hardCap) {
        out.errors.push(err('E_CAP_FORMULA_HARDCAP', 'cap.value.type="formula" 时 value.hardCap 必填'));
      }
      try {
        const compiled = compileExpr(value.formula);
        const refCtx = {
          base: minFan,
          kongCount: 0,
          wallTiles: 1,
          playerCount: 4,
          minFan,
          hardCap: effectiveHardCap ?? Number.MAX_SAFE_INTEGER,
        };
        const result = compiled.eval(refCtx);
        capFanResults.push(result);
        if (!Number.isFinite(result)) {
          out.errors.push(err('E_CAP_FORMULA_NOT_FINITE', 'formula 参考求值结果不是有限数'));
        }
      } catch (e) {
        const msg = e instanceof ExprError ? e.message : String(e);
        out.errors.push(err('E_CAP_FORMULA_INVALID', `formula 表达式非法: ${msg}`));
      }
      break;
    }
    case 'unlimited': {
      if (cap.hardCap === undefined && !('hardCap' in value && value.hardCap !== undefined)) {
        out.errors.push(err('E_CAP_UNLIMITED_HARDCAP', 'cap.value.type="unlimited" 时 hardCap 必填'));
      }
      if (cap.maxScore === undefined) {
        out.errors.push(err('E_CAP_UNLIMITED_MAXSCORE', 'cap.value.type="unlimited" 时 maxScore 必填'));
      }
      break;
    }
    default:
      out.errors.push(err('E_CAP_VALUE_TYPE', `cap.value.type 非法: ${(value as { type: string }).type}`));
  }

  if (cap.enabled) {
    // —— 规则 9：minFan ≤ 任一 capFan 结果；minFan ≤ hardCap；maxScore > 0 ——
    if (!isNonNegInt(minFan)) {
      out.errors.push(err('E_CAP_MIN_FAN', `cap.minFan 必须为非负整数，得到 ${minFan}`));
    }
    if (effectiveHardCap !== undefined && minFan > effectiveHardCap) {
      out.errors.push(err('E_CAP_MIN_FAN_HARDCAP', `cap.minFan(${minFan}) 不得大于 hardCap(${effectiveHardCap})`));
    }
    if (cap.maxScore !== undefined && (!Number.isFinite(cap.maxScore) || cap.maxScore <= 0)) {
      out.errors.push(err('E_CAP_MAX_SCORE', 'cap.maxScore 必须为正有限数'));
    }
    for (const r of capFanResults) {
      if (Number.isFinite(r) && minFan > r) {
        out.errors.push(err('E_CAP_MIN_FAN_ABOVE_CAPFAN', `cap.minFan(${minFan}) 不得大于封顶值(${r})`));
      }
    }

    // —— 作用域 ——
    if (!['global', 'group', 'player'].includes(cap.scope)) {
      out.errors.push(err('E_CAP_SCOPE', `cap.scope 非法: ${cap.scope}`));
    }
    if (cap.scope === 'group' && (!cap.groups || cap.groups.length === 0)) {
      out.errors.push(err('E_CAP_SCOPE_GROUP_EMPTY', 'cap.scope="group" 时 groups 不能为空'));
    }
    if (cap.scope === 'player' && !cap.playerOffsets) {
      out.warnings.push(err('W_CAP_PLAYER_NO_OFFSETS', 'cap.scope="player" 但未配置 playerOffsets，封顶值不会变化'));
    }

    // —— 规则 10：分组 ——
    const groupedFans = new Set<string>();
    const groupIds = new Set<string>();
    for (const g of cap.groups ?? []) {
      if (!g.id) out.errors.push(err('E_CAP_GROUP_ID', 'cap.groups[].id 不能为空'));
      if (groupIds.has(g.id)) out.errors.push(err('E_CAP_GROUP_DUP', `分组 id "${g.id}" 重复`));
      groupIds.add(g.id);
      if (!isNonNegInt(g.capFan)) {
        out.errors.push(err('E_CAP_GROUP_FAN', `分组 "${g.id}" capFan 必须为非负整数`));
      } else if (minFan > g.capFan) {
        out.errors.push(err('E_CAP_GROUP_FAN', `分组 "${g.id}" capFan(${g.capFan}) 不得小于 minFan(${minFan})`));
      }
      if (!Array.isArray(g.fanIds) || g.fanIds.length === 0) {
        out.errors.push(err('E_CAP_GROUP_FANIDS', `分组 "${g.id}" fanIds 不能为空`));
        continue;
      }
      for (const fid of g.fanIds) {
        if (!fanIds.has(fid)) {
          out.errors.push(err('E_CAP_GROUP_FAN_MISSING', `分组 "${g.id}" 引用不存在的番型 "${fid}"`));
        } else if (!enabledFanIds.has(fid)) {
          out.errors.push(err('E_CAP_GROUP_FAN_DISABLED', `分组 "${g.id}" 引用未启用的番型 "${fid}"`));
        }
        if (groupedFans.has(fid)) {
          out.errors.push(err('E_CAP_GROUP_FAN_MULTI', `番型 "${fid}" 出现在多个分组`));
        }
        groupedFans.add(fid);
      }
    }

    // —— 规则 11：bypass ——
    for (const fid of cap.bypass?.fanIds ?? []) {
      if (!fanIds.has(fid)) {
        out.errors.push(err('E_CAP_BYPASS_FAN_MISSING', `bypass.fanIds 引用不存在的番型 "${fid}"`));
      } else if (!enabledFanIds.has(fid)) {
        out.errors.push(err('E_CAP_BYPASS_FAN_DISABLED', `bypass.fanIds 引用未启用的番型 "${fid}"`));
      }
    }
    for (const c of cap.bypass?.conditions ?? []) {
      if (!BYPASS_CONDITION_TYPES.includes(c.type)) {
        out.errors.push(err('E_CAP_BYPASS_CONDITION', `bypass.conditions[].type 非法: ${c.type}（白名单: ${BYPASS_CONDITION_TYPES.join(', ')}）`));
      }
      if (typeof c.enabled !== 'boolean') {
        out.errors.push(err('E_CAP_BYPASS_CONDITION', `bypass.conditions[${c.type}].enabled 必须为布尔值`));
      }
    }
  }
}

/** 启动校验（PRD 6.3） */
export function validateFanConfig(config: FanConfig, options: ValidateOptions = {}): ValidationResult {
  const strict = options.strictDependency ?? true;
  const out: ValidationResult = { ok: true, errors: [], warnings: [] };
  const tileSet = config.tileSet;

  // —— 1. schema 基础 ——
  if (!config.version) out.errors.push(err('E_VERSION', '配置缺少 version'));
  if (!['max', 'additive'].includes(config.scoring.mode)) {
    out.errors.push(err('E_SCORING_MODE', `scoring.mode 非法: ${config.scoring.mode}`));
  }
  if (!isNonNegInt(config.scoring.baseScore) || config.scoring.baseScore <= 0) {
    out.errors.push(err('E_BASE_SCORE', 'scoring.baseScore 必须为正整数'));
  }
  if (!['wild', 'normal', 'off'].includes(tileSet.redCenterMode)) {
    out.errors.push(err('E_RED_MODE', `tileSet.redCenterMode 非法: ${tileSet.redCenterMode}`));
  }
  if (!isNonNegInt(tileSet.dealerExtraTile) || tileSet.dealerExtraTile > 4) {
    out.errors.push(err('E_DEALER_EXTRA', 'tileSet.dealerExtraTile 必须为 0..4 的整数'));
  }
  const fanIdSet = new Set<string>();
  let hasEnabledFallback = false;
  for (const fan of config.fans) {
    if (!fan.id || !fan.name) out.errors.push(err('E_FAN_FIELD', '番型缺少 id 或 name'));
    if (fanIdSet.has(fan.id)) out.errors.push(err('E_FAN_DUP_ID', `番型 id "${fan.id}" 重复`));
    fanIdSet.add(fan.id);
    if (!isNonNegInt(fan.value)) out.errors.push(err('E_FAN_VALUE', `番型 "${fan.id}" value 必须为非负整数`));
    if (typeof fan.enabled !== 'boolean') out.errors.push(err('E_FAN_ENABLED', `番型 "${fan.id}" enabled 必须为布尔值`));
    if (fan.fallback && fan.enabled) hasEnabledFallback = true;
    if (fan.fallback && fan.exclusiveGroup) {
      out.warnings.push(err('W_FALLBACK_EXCLUSIVE', `兜底番 "${fan.id}" 不应设置 exclusiveGroup`, fan.id));
    }
  }
  if (!hasEnabledFallback) out.errors.push(err('E_NO_FALLBACK', '至少需要一个 enabled=true 的 fallback 兜底番'));

  for (const bf of config.bonusFans) {
    if (!bf.id || !bf.name) out.errors.push(err('E_BONUS_FIELD', '附加番缺少 id 或 name'));
    if (!isNonNegInt(bf.value)) out.errors.push(err('E_BONUS_VALUE', `附加番 "${bf.id}" value 必须为非负整数`));
  }

  // —— 花牌（v0.2 预留） ——
  if (tileSet.flowers.enabled) {
    out.errors.push(err('E_FLOWERS_RESERVED', '花牌玩法为 v0.2 预留：当前版本 tileSet.flowers.enabled 必须为 false（gd144 预设仅供张数核算）'));
  }

  // 每个牌面 copies 范围
  const faces: FaceName[] = ['character', 'bamboo', 'dot', 'east', 'south', 'west', 'north', 'red', 'green', 'white', 'flowers'];
  for (const face of faces) {
    const cfg = faceConfig(tileSet, face);
    if (!isNonNegInt(cfg.copies) || cfg.copies > 8) {
      out.errors.push(err('E_FACE_COPIES', `牌面 ${face} copies 必须为 0..8 整数，得到 ${cfg.copies}`));
    }
    if (cfg.enabled && cfg.copies <= 0) {
      out.errors.push(err('E_FACE_COPIES', `牌面 ${face} enabled=true 但 copies=${cfg.copies}`));
    }
    if (typeof cfg.enabled !== 'boolean') {
      out.errors.push(err('E_FACE_ENABLED', `牌面 ${face} enabled 必须为布尔值`));
    }
  }

  // —— 2. 牌张一致性 ——
  const math = computeTileMath(tileSet);
  if (math.totalTiles < math.dealTiles) {
    out.errors.push(err('E_TILES_INSUFFICIENT', `总张数(${math.totalTiles})不足以开局：需发 ${math.dealTiles} 张`));
  } else if (!(math.wallTiles > math.deadWallCount + 1)) {
    out.errors.push(err('E_WALL_TOO_SMALL', `牌墙张数(${math.wallTiles})必须大于 deadWallCount+1(${math.deadWallCount + 1})`));
  }

  // —— 4. 红中一致性 ——
  if (tileSet.redCenterMode === 'wild' && !faceEnabled(tileSet, 'red')) {
    out.errors.push(err('E_WILD_NEEDS_RED', 'redCenterMode="wild" 要求红中在牌墙中（honors.red.enabled=true）'));
  }
  if (tileSet.redCenterMode === 'off' && faceEnabled(tileSet, 'red')) {
    out.errors.push(err('E_OFF_WITH_RED', 'redCenterMode="off" 时红中必须关闭（honors.red.enabled=false）'));
  }
  if (config.scoring.redCenterBonus.enabled && tileSet.redCenterMode !== 'wild') {
    out.errors.push(err('E_BONUS_NEEDS_WILD', `redCenterMode="${tileSet.redCenterMode}" 时 redCenterBonus 必须关闭（仅 wild 模式支持无红中加成）`));
  }
  if (config.scoring.redCenterBonus.enabled) {
    const rb = config.scoring.redCenterBonus;
    if (rb.mode === 'addFan' && (!isNonNegInt(rb.addFan) || rb.addFan === undefined)) {
      out.errors.push(err('E_BONUS_ADDFAN', 'redCenterBonus.mode="addFan" 时 addFan 必须为非负整数'));
    }
  }

  // —— 3. 番型依赖 ——
  for (const fan of config.fans) {
    if (!fan.enabled && strict) continue;
    checkFanDependency(fan, config, strict, out);
  }

  // —— 6. cap 校验 ——
  checkCap(config.scoring.cap, config, out);

  // —— 冲突告警（PRD 风险表：fanDouble 与封顶冲突） ——
  if (config.scoring.redCenterBonus.enabled && config.scoring.redCenterBonus.mode === 'fanDouble' && config.scoring.cap.enabled) {
    out.warnings.push(err(
      'W_FAN_DOUBLE_CAP',
      `fanDouble 模式在封顶下可能无效：番数×2 后会被 capFan(${config.scoring.cap.value.type === 'fixed' ? config.scoring.cap.value.fixed : '动态'}) 截断，建议使用 scoreDouble`,
    ));
  }

  out.ok = out.errors.length === 0;
  return out;
}

export { EXPR_FUNC_NAMES, EXPR_VARS };
