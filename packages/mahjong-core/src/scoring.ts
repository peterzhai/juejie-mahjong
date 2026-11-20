/**
 * 计分流水线（PRD 6.4 / 6.5.5 固定运算顺序，单测锁定）：
 * 基础番 → 附加番 → 无红中加成(bypassCap=false) → 计算 capFan → 作用域 → 封顶
 * → bypass 判断 → minFan 保底 → 无红中加成(bypassCap=true) → hardCap → 分数(scoreDouble/maxScore)
 */

import type { ResolvedFanConfig } from '@quejie/fan-config';
import { compileExpr } from '@quejie/fan-config';
import type { ScoreContext, FanEvaluation } from './fans.js';
import { TileIndex } from './tileIndex.js';

export interface PipelineContext extends ScoreContext {
  /** 全场杠数（formula 变量） */
  kongCount: number;
  /** 胡牌时牌墙余量（formula 变量） */
  wallTiles: number;
  playerCount: number;
  /** tiered 房间等级（1 起） */
  roomLevel: number;
  /** player 作用域角色 */
  dealer: boolean;
}

export interface SettlementLine {
  key: string;
  label: string;
  detail: string;
}

export interface ScoreResult {
  finalFan: number;
  score: number;
  lines: SettlementLine[];
  meta: {
    capValueType: string;
    resolvedCapFan: number | null;
    capScope: string;
    bypassTriggered: { fanIds: string[]; conditions: string[] } | null;
    formulaSnapshot?: Record<string, number>;
    hardCap: number;
    maxScore: number;
    redCenterBonusApplied: boolean;
    redCenterBonusMode: string;
    hasRedCenter: boolean;
    minFanFloorApplied: boolean;
    hardCapApplied: boolean;
    maxScoreApplied: boolean;
  };
}

const formulaCache = new Map<string, ReturnType<typeof compileExpr>>();

/** 计算 capFan（value.type 四种来源） */
export function computeCapFan(
  resolved: ResolvedFanConfig,
  ctx: PipelineContext,
  preCapFan: number,
): { capFan: number; formulaSnapshot?: Record<string, number> } {
  const cap = resolved.scoring.cap;
  const value = cap.value;
  const minFan = cap.minFan ?? 0;
  const hardCap = resolveHardCap(resolved);

  switch (value.type) {
    case 'fixed':
      return { capFan: value.fixed };
    case 'tiered': {
      const idx = Math.min(Math.max(ctx.roomLevel - 1, 0), value.tiers.length - 1);
      return { capFan: value.tiers[idx]! };
    }
    case 'formula': {
      let compiled = formulaCache.get(value.formula);
      if (!compiled) {
        compiled = compileExpr(value.formula);
        formulaCache.set(value.formula, compiled);
      }
      const snapshot = {
        base: preCapFan,
        kongCount: ctx.kongCount,
        wallTiles: ctx.wallTiles,
        playerCount: ctx.playerCount,
        minFan,
        hardCap,
      };
      const result = compiled.eval(snapshot);
      return { capFan: result, formulaSnapshot: snapshot };
    }
    case 'unlimited':
      return { capFan: Number.POSITIVE_INFINITY };
  }
}

export function resolveHardCap(resolved: ResolvedFanConfig): number {
  const cap = resolved.scoring.cap;
  const valueHardCap = (cap.value as { hardCap?: number }).hardCap;
  return valueHardCap ?? cap.hardCap ?? Number.POSITIVE_INFINITY;
}

/** 完整计分流水线 */
export function computeScore(
  resolved: ResolvedFanConfig,
  fanEval: FanEvaluation,
  ctx: PipelineContext,
  hasRedCenter: boolean,
): ScoreResult {
  const cap = resolved.scoring.cap;
  const rb = resolved.scoring.redCenterBonus;
  const lines: SettlementLine[] = [];
  // hardCap / maxScore 属于 cap 体系：cap.enabled=false 时不生效
  const hardCap = cap.enabled ? resolveHardCap(resolved) : Number.POSITIVE_INFINITY;
  const maxScore = cap.enabled ? (cap.maxScore ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
  const minFan = cap.minFan ?? 0;

  for (const m of fanEval.matched) {
    lines.push({ key: `fan:${m.fanId}`, label: m.name, detail: `${m.value}番` });
  }
  for (const m of fanEval.suppressed) {
    lines.push({ key: `suppressed:${m.fanId}`, label: `${m.name}（互斥未计）`, detail: `同组取最高，未计 ${m.value}番` });
  }
  const baseFan = fanEval.baseFan;
  lines.push({
    key: 'baseFan',
    label: `基础番（${resolved.scoring.mode === 'additive' ? '叠加' : '取最高'}）`,
    detail: `${baseFan}番`,
  });
  for (const b of fanEval.bonus) {
    const total = b.value * (b.count ?? 1);
    lines.push({
      key: `bonus:${b.fanId}`,
      label: b.name,
      detail: b.count && b.count > 1 ? `${b.value}番 × ${b.count} = ${total}番` : `${total}番`,
    });
  }

  let preCapFan = fanEval.afterBonusFan;
  lines.push({ key: 'afterBonus', label: '附加番后番数', detail: `${preCapFan}番` });

  // 无红中加成（bypassCap=false：封顶前）
  const bonusEligible = rb.enabled && !hasRedCenter;
  const bonusApplied = { applied: false };
  if (bonusEligible && !rb.bypassCap && rb.mode !== 'none') {
    if (rb.mode === 'addFan') preCapFan += rb.addFan ?? 0;
    if (rb.mode === 'fanDouble') preCapFan *= 2;
    bonusApplied.applied = true;
    lines.push({
      key: 'redCenterBonus',
      label: `无红中加成（${rb.mode === 'addFan' ? `加${rb.addFan}番` : rb.mode === 'fanDouble' ? '番数×2' : '分数×2'}）`,
      detail: `封顶前作用 → ${preCapFan}番`,
    });
  } else if (bonusEligible) {
    lines.push({ key: 'redCenterBonus', label: '无红中加成', detail: 'bypassCap=true：封顶后作用' });
  } else if (rb.enabled && hasRedCenter) {
    lines.push({ key: 'redCenterBonus', label: '无红中加成', detail: '手牌含红中，不加成' });
  }

  // 计算 capFan + 作用域
  let capFan: number | null = null;
  let formulaSnapshot: Record<string, number> | undefined;
  if (cap.enabled) {
    const r = computeCapFan(resolved, ctx, preCapFan);
    capFan = r.capFan;
    formulaSnapshot = r.formulaSnapshot;

    // group 作用域：最优番型所属分组覆盖
    if (cap.scope === 'group') {
      const g = (cap.groups ?? []).find((grp) => grp.fanIds.includes(fanEval.bestFanId));
      if (g) {
        capFan = g.capFan;
        lines.push({ key: 'capScope', label: '分组封顶', detail: `番型「${fanEval.bestFanId}」属分组 ${g.id} → capFan=${g.capFan}` });
      } else {
        lines.push({ key: 'capScope', label: '分组封顶', detail: '未命中分组，回落全局 capFan' });
      }
    }
    // player 作用域
    if (cap.scope === 'player') {
      const off = ctx.dealer ? (cap.playerOffsets?.dealer ?? 0) : (cap.playerOffsets?.nonDealer ?? 0);
      if (off !== 0) {
        capFan = (capFan ?? 0) + off;
        lines.push({ key: 'capScope', label: '玩家维度封顶', detail: `${ctx.dealer ? '庄家' : '闲家'}偏移 ${off > 0 ? '+' : ''}${off} → capFan=${capFan}` });
      }
    }
    if (capFan !== Number.POSITIVE_INFINITY && Number.isFinite(capFan)) {
      lines.push({ key: 'capFan', label: '本次封顶值 capFan', detail: `${capFan}番` });
    }
  }

  // bypass 判断
  const bypass = cap.bypass ?? {};
  const fanIdsHit = (bypass.fanIds ?? []).filter((id) => fanEval.matched.some((m) => m.fanId === id));
  const conditions: string[] = [];
  for (const c of bypass.conditions ?? []) {
    if (!c.enabled) continue;
    if (c.type === 'selfDraw' && ctx.selfDraw) conditions.push('selfDraw');
    if (c.type === 'kongBlossom' && ctx.kongBlossom) conditions.push('kongBlossom');
    if (c.type === 'robbingKong' && ctx.robbingKong) conditions.push('robbingKong');
    if (c.type === 'noRedCenter' && !hasRedCenter) conditions.push('noRedCenter');
  }
  const bypassed = cap.enabled && (fanIdsHit.length > 0 || conditions.length > 0);

  let fanAfterCap: number;
  if (cap.enabled && !bypassed && capFan !== null && Number.isFinite(capFan)) {
    fanAfterCap = Math.min(preCapFan, capFan);
    if (fanAfterCap < preCapFan) {
      lines.push({ key: 'capped', label: '封顶', detail: `${preCapFan}番 → ${fanAfterCap}番` });
    } else {
      lines.push({ key: 'capped', label: '封顶', detail: `${preCapFan}番（未触及封顶）` });
    }
  } else {
    fanAfterCap = preCapFan;
    if (bypassed) {
      lines.push({
        key: 'bypass',
        label: '突破封顶（bypass）',
        detail: [
          fanIdsHit.length > 0 ? `番型豁免: ${fanIdsHit.join('、')}` : '',
          conditions.length > 0 ? `条件豁免: ${conditions.join('、')}` : '',
        ]
          .filter(Boolean)
          .join('；'),
      });
    }
  }

  // minFan 保底（封顶后、hardCap 前）
  let fanAfterMin = fanAfterCap;
  let minFanFloorApplied = false;
  if (cap.enabled && fanAfterMin < minFan) {
    fanAfterMin = minFan;
    minFanFloorApplied = true;
    lines.push({ key: 'minFan', label: '保底番', detail: `提升至 minFan=${minFan}番` });
  }

  // 无红中加成（bypassCap=true：封顶后）
  if (bonusEligible && rb.bypassCap && rb.mode !== 'none') {
    if (rb.mode === 'addFan') fanAfterMin += rb.addFan ?? 0;
    if (rb.mode === 'fanDouble') fanAfterMin *= 2;
    bonusApplied.applied = true;
    lines.push({
      key: 'redCenterBonus',
      label: `无红中加成（${rb.mode === 'addFan' ? `加${rb.addFan}番` : rb.mode === 'fanDouble' ? '番数×2' : '分数×2'}）`,
      detail: `封顶后作用 → ${fanAfterMin}番`,
    });
  }

  // hardCap 截断
  let finalFan = fanAfterMin;
  let hardCapApplied = false;
  if (Number.isFinite(hardCap) && finalFan > hardCap) {
    finalFan = hardCap;
    hardCapApplied = true;
    lines.push({ key: 'hardCap', label: 'hardCap 截断', detail: `${fanAfterMin}番 → ${finalFan}番` });
  }

  // 分数（2^finalFan 溢出保护）
  let score = resolved.scoring.baseScore * Math.pow(2, finalFan);
  if (!Number.isFinite(score)) {
    score = Number.MAX_SAFE_INTEGER;
    lines.push({ key: 'overflow', label: '溢出保护', detail: '2^finalFan 溢出，截断为安全整数' });
  }
  // scoreDouble（分数层面）
  if (bonusEligible && rb.mode === 'scoreDouble') {
    score *= 2;
    bonusApplied.applied = true;
    lines.push({ key: 'redCenterBonus', label: '无红中加成（分数×2）', detail: `分数 → ${score}` });
  }

  // maxScore 截断（最后执行）
  let maxScoreApplied = false;
  if (Number.isFinite(maxScore) && score > maxScore) {
    score = maxScore;
    maxScoreApplied = true;
    lines.push({ key: 'maxScore', label: 'maxScore 截断', detail: `分数上限 ${maxScore}` });
  }

  lines.push({ key: 'finalFan', label: '最终番数', detail: `${finalFan}番` });
  lines.push({ key: 'score', label: '分数', detail: `${score}` });

  return {
    finalFan,
    score,
    lines,
    meta: {
      capValueType: cap.value.type,
      resolvedCapFan: capFan !== null && Number.isFinite(capFan) ? capFan : null,
      capScope: cap.scope,
      bypassTriggered: bypassed ? { fanIds: fanIdsHit, conditions } : null,
      formulaSnapshot,
      hardCap: Number.isFinite(hardCap) ? hardCap : -1,
      maxScore: Number.isFinite(maxScore) ? maxScore : -1,
      redCenterBonusApplied: bonusApplied.applied || (bonusEligible && rb.mode === 'scoreDouble'),
      redCenterBonusMode: rb.mode,
      hasRedCenter,
      minFanFloorApplied,
      hardCapApplied,
      maxScoreApplied,
    },
  };
}

export { TileIndex };
