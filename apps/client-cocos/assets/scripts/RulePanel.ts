/**
 * 规则展示面板：牌张配置 / 番型表 / 封顶规则 / 红中规则。
 * 数据源：联机取 roomState.rulesSummary；本地 PVE 取 LocalPveDriver 的 resolved 配置。
 */

import { _decorator, Button, Component, Label, ScrollView } from 'cc';
import type { ResolvedFanConfig } from '@quejie/fan-config';
import type { RoomStateMsg } from '@quejie/protocol';
import { addLabel, addScrollableText, addTextButton, drawModal, GOLD, modalSize } from './ui/ModalText';

const { ccclass, property } = _decorator;

type RulesSummary = RoomStateMsg['rulesSummary'];

@ccclass('RulePanel')
export class RulePanel extends Component {
  @property(Label)
  public contentLabel: Label | null = null;

  /** 关闭按钮回调（TableScene 注入） */
  public onClose: (() => void) | null = null;

  private scroll: ScrollView | null = null;
  private title: Label | null = null;
  private closeButton: Button | null = null;

  protected override onLoad(): void {
    this.layout();
    this.node.active = false;
  }

  /**
   * 显示规则：两个数据源可同时给（联机时 rulesSummary 权威；PVE 时 resolved 详细）。
   * 优先用 resolved 逐项渲染番型表；无 resolved 时退回 rulesSummary 文案。
   */
  public show(summary: RulesSummary | null, resolved: ResolvedFanConfig | null): void {
    this.node.active = true;
    this.node.setSiblingIndex(this.node.parent!.children.length - 1);
    const parts: string[] = [];

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
    parts.push((resolved?.rules.allowDiscardHu ?? summary?.allowDiscardHu) === false ? '不点炮胡' : '允许点炮胡');

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

    if (this.contentLabel) {
      this.contentLabel.string = parts.join('\n');
      this.contentLabel.updateRenderData(true);
    }
    this.scroll?.scrollToTop();
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

  public layout(): void {
    const { width, height } = modalSize(this.node);
    drawModal(this.node, width, height);
    if (!this.title) this.title = addLabel(this.node, '本桌规则', 0, 0, width - 50, 43, 29, GOLD);
    this.title.node.setPosition(0, height / 2 - 38);
    const content = this.contentLabel?.string ?? '';
    if (this.scroll || !this.contentLabel) {
      this.scroll?.node.removeFromParent();
      this.scroll?.node.destroy();
      const { label, scroll } = addScrollableText(this.node, width - 50, height - 165, -2);
      this.contentLabel = label;
      this.scroll = scroll;
      label.string = content;
      if (label.node.activeInHierarchy) label.updateRenderData(true);
    }
    if (!this.closeButton) {
      this.closeButton = addTextButton(this.node, '关闭规则', 0, 0, 192, false, 46);
      this.closeButton.node.on(Button.EventType.CLICK, () => {
        this.hide();
        this.onClose?.();
      });
    }
    this.closeButton.node.setPosition(0, -height / 2 + 42);
  }
}
