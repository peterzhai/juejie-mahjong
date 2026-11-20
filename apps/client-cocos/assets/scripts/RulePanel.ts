/**
 * 规则展示面板：牌张配置 / 番型表 / 封顶规则 / 红中规则。
 * 数据源：联机取 roomState.rulesSummary；本地 PVE 取 LocalPveDriver 的 resolved 配置。
 */

import { _decorator, Color, Component, Graphics, Label, Node, UITransform } from 'cc';
import type { ResolvedFanConfig } from '@quejie/fan-config';
import type { RoomStateMsg } from '@quejie/protocol';

const { ccclass, property } = _decorator;

const PANEL_W = 760;
const PANEL_H = 520;
const COLOR_BG = new Color(16, 22, 30, 236);
const COLOR_BORDER = new Color(120, 160, 210, 255);
const COLOR_TEXT = new Color(226, 230, 238, 255);

type RulesSummary = RoomStateMsg['rulesSummary'];

@ccclass('RulePanel')
export class RulePanel extends Component {
  @property(Label)
  public contentLabel: Label | null = null;

  /** 关闭按钮回调（TableScene 注入） */
  public onClose: (() => void) | null = null;

  protected onLoad(): void {
    this.ensureBackground();
    this.ensureContentLabel();
    this.ensureCloseButton();
    this.node.active = false;
  }

  /**
   * 显示规则：两个数据源可同时给（联机时 rulesSummary 权威；PVE 时 resolved 详细）。
   * 优先用 resolved 逐项渲染番型表；无 resolved 时退回 rulesSummary 文案。
   */
  public show(summary: RulesSummary | null, resolved: ResolvedFanConfig | null): void {
    this.node.active = true;
    const parts: string[] = [];
    parts.push('—— 规则 ——');

    // 1) 牌张配置
    if (resolved) {
      parts.push(`牌张预设: ${resolved.tileSetPresetId ?? 'custom'}    总张数: ${resolved.tileMath.totalTiles}    牌墙: ${resolved.tileMath.wallTiles}    死墙: ${resolved.tileMath.deadWallCount}`);
    } else if (summary) {
      parts.push(`牌张预设: ${summary.presetId}    总张数: ${summary.totalTiles}    牌墙: ${summary.wallTiles}`);
    }

    // 2) 红中规则
    const redMode = resolved ? resolved.redCenterMode : (summary?.redCenterMode ?? '-');
    const redDesc = redMode === 'wild' ? '红中=万能牌（可替代任意牌；不可碰/明杠/补杠，可暗杠）' : redMode === 'normal' ? '红中为普通字牌' : redMode;
    const drawOnly = resolved?.redCenterDrawOnly ? '；红中只摸不打可不按万能计（drawOnly）' : '';
    parts.push(`红中规则: ${redMode}（${redDesc}${drawOnly}）`);

    // 3) 计分与封顶
    const scoringMode = resolved ? resolved.scoring.mode : (summary?.scoringMode ?? '-');
    parts.push(`计分模式: ${scoringMode === 'max' ? '取最高番（max）' : scoringMode === 'additive' ? '累加番（additive）' : scoringMode}`);
    if (resolved) {
      parts.push(this.describeCap(resolved));
    } else if (summary) {
      parts.push(`封顶: ${summary.capDesc}`);
    }

    // 4) 番型表（resolved 逐项；含不可用原因）
    if (resolved) {
      parts.push('');
      parts.push('—— 番型表 ——');
      for (const f of resolved.fans) {
        if (!f.enabled) continue;
        const valueText = f.fallback ? `${f.value}（fallback）` : `${f.value}`;
        const state = f.available ? '' : `（当前牌集不可用: ${f.unavailableReason ?? '依赖不满足'}）`;
        parts.push(`  ${f.name}: ${valueText} 番${f.exclusiveGroup ? ` [互斥组:${f.exclusiveGroup}]` : ''}${state}`);
      }
      if (resolved.bonusFans.length > 0) {
        const bonusText = resolved.bonusFans
          .filter((b) => b.enabled)
          .map((b) => `${b.name}+${b.value}`)
          .join('、');
        if (bonusText) parts.push(`附加番: ${bonusText}`);
      }
    }

    parts.push('');
    parts.push('十二张落地包牌 / 补杠被抢杠包三家 / 放杠杠上开花包三家（以房间配置为准）');
    parts.push('流局: 牌墙只剩死墙时流局，杠分退回，庄家连庄。');

    if (this.contentLabel) this.contentLabel.string = parts.join('\n');
  }

  /** 隐藏面板 */
  public hide(): void {
    this.node.active = false;
  }

  /** 封顶配置的人类可读描述（fixed/tiered/formula/unlimited + hardCap/minFan/maxScore/bypass） */
  private describeCap(resolved: ResolvedFanConfig): string {
    const cap = resolved.scoring.cap;
    if (!cap.enabled) return '封顶: 未启用';
    let desc = '';
    const value = cap.value;
    if (value.type === 'fixed') desc = `固定 ${value.fixed} 番`;
    else if (value.type === 'tiered') desc = `分段 ${value.tiers.join('/')} 番（按房间等级）`;
    else if (value.type === 'formula') desc = `公式 ${value.formula}`;
    else desc = '无封顶（unlimited）';
    const extras: string[] = [];
    if (cap.hardCap) extras.push(`硬上限 ${cap.hardCap} 番`);
    if (cap.minFan) extras.push(`保底 ${cap.minFan} 番`);
    if (cap.maxScore && cap.maxScore < 1_000_000) extras.push(`单局分上限 ${cap.maxScore}`);
    const scope = cap.scope === 'global' ? '' : `（作用域 ${cap.scope}）`;
    const bypassIds = cap.bypass?.fanIds ?? [];
    if (bypassIds.length > 0) extras.push(`突破封顶: ${bypassIds.join('/')}`);
    return `封顶: ${desc}${scope}${extras.length > 0 ? '；' + extras.join('；') : ''}`;
  }

  // —— 程序化 UI ——

  private ensureBackground(): void {
    const ut = this.node.getComponent(UITransform) ?? this.node.addComponent(UITransform);
    ut.setContentSize(PANEL_W, PANEL_H);
    let g = this.node.getComponent(Graphics);
    if (!g) g = this.node.addComponent(Graphics);
    g.clear();
    g.fillColor = COLOR_BG;
    g.roundRect(-PANEL_W / 2, -PANEL_H / 2, PANEL_W, PANEL_H, 18);
    g.fill();
    g.lineWidth = 3;
    g.strokeColor = COLOR_BORDER;
    g.roundRect(-PANEL_W / 2, -PANEL_H / 2, PANEL_W, PANEL_H, 18);
    g.stroke();
  }

  private ensureContentLabel(): void {
    if (this.contentLabel) return;
    const node = new Node('content');
    const ut = node.addComponent(UITransform);
    ut.setContentSize(PANEL_W - 60, PANEL_H - 110);
    const label = node.addComponent(Label);
    label.fontSize = 20;
    label.lineHeight = 28;
    label.overflow = Label.Overflow.CLAMP;
    label.horizontalAlign = Label.HorizontalAlign.LEFT;
    label.verticalAlign = Label.VerticalAlign.TOP;
    label.color = COLOR_TEXT;
    node.setPosition(0, 15);
    this.node.addChild(node);
    this.contentLabel = label;
  }

  private ensureCloseButton(): void {
    const node = new Node('btn_close');
    const ut = node.addComponent(UITransform);
    ut.setContentSize(120, 46);
    node.setPosition(PANEL_W / 2 - 80, PANEL_H / 2 - 40);
    const g = node.addComponent(Graphics);
    g.fillColor = new Color(62, 92, 140, 255);
    g.roundRect(-60, -23, 120, 46, 8);
    g.fill();
    const labelNode = new Node('text');
    const lut = labelNode.addComponent(UITransform);
    lut.setContentSize(110, 40);
    const label = labelNode.addComponent(Label);
    label.fontSize = 24;
    label.overflow = Label.Overflow.SHRINK;
    label.horizontalAlign = Label.HorizontalAlign.CENTER;
    label.verticalAlign = Label.VerticalAlign.CENTER;
    label.color = COLOR_TEXT;
    label.string = '关闭';
    node.addChild(labelNode);
    node.on(Node.EventType.TOUCH_END, () => this.onClose?.());
    this.node.addChild(node);
  }
}
