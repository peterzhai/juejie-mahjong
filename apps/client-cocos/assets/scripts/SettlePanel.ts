/**
 * 结算面板（PRD 7.4）：逐项渲染番型/附加番/封顶过程 lines、包三家原因、最终番数与分数、
 * 四家本局分差与累计分。文本行方式渲染（滚动容器内 Label），由 TableScene 在 gameOver 时调用。
 */

import { _decorator, Button, Component, Label, Node, ScrollView, UITransform } from 'cc';
import type { GameOverMsg, SettlementView } from '@quejie/protocol';
import { addLabel, addScrollableText, addTextButton, drawModal, GOLD, modalSize } from './ui/ModalText';

const { ccclass, property } = _decorator;

@ccclass('SettlePanel')
export class SettlePanel extends Component {
  /** 返回大厅回调（TableScene 注入 → GameManager.leaveAndBackToLobby） */
  public onBackToLobby: (() => void) | null = null;
  /** 继续按钮回调（本地 PVE 连庄下一局） */
  public onContinue: (() => void) | null = null;

  @property(Label)
  public contentLabel: Label | null = null;

  /** 底部按钮容器（程序化创建） */
  private btnRoot: Node | null = null;
  private scroll: ScrollView | null = null;
  private title: Label | null = null;

  protected override onLoad(): void {
    this.layout();
    this.node.active = false;
  }

  /** 显示结算（本局可能多家胡：逐个 SettlementView 渲染） */
  public show(over: GameOverMsg, mySeat: number, seatNames: string[]): void {
    this.node.active = true;
    this.node.setSiblingIndex(this.node.parent!.children.length - 1);
    const parts: string[] = [];
    if (this.title) this.title.string = over.outcome === 'draw' ? '流局结算' : '结算明细';

    if (over.outcome === 'draw') {
      parts.push('—— 流局 ——');
      parts.push('牌墙耗尽，杠分已退回账本。');
    } else {
      for (const s of over.settlements) {
        parts.push(...this.renderSettlement(s, seatNames));
        parts.push('');
      }
    }

    // 四家分差与累计分
    parts.push('—— 本局分差 / 累计 ——');
    for (let seat = 0; seat < over.deltas.length; seat++) {
      const d = over.deltas[seat] ?? 0;
      const sc = over.scores[seat] ?? 0;
      const mark = seat === mySeat ? '（你）' : '';
      const sign = d >= 0 ? `+${d}` : `${d}`;
      parts.push(`${seatNames[seat] ?? `座位${seat}`}${mark}: ${sign} → 累计 ${sc}`);
    }
    const nextDealer = over.dealerNext;
    parts.push(`下一局庄家: ${seatNames[nextDealer] ?? `座位${nextDealer}`}`);

    if (this.contentLabel) {
      this.contentLabel.string = parts.join('\n');
      this.contentLabel.updateRenderData(true);
    }
    this.scroll?.scrollToTop();
    this.buildButtons();
  }

  /** 隐藏面板 */
  public hide(): void {
    this.node.active = false;
  }

  /** 单个胜者结算的逐项行（番型 → 附加番 → 封顶 lines → 包三家 → 汇总） */
  private renderSettlement(s: SettlementView, seatNames: string[]): string[] {
    const lines: string[] = [];
    const winner = seatNames[s.winnerSeat] ?? `座位${s.winnerSeat}`;
    const viaText = s.via === 'self' ? '自摸' : s.via === 'robKong' ? '抢杠胡' : '点炮';
    lines.push(`—— ${winner} 胡（${viaText}）——`);

    if (s.fans.length === 0 && !s.chicken) {
      lines.push('（无匹配番型）');
    }
    for (const f of s.fans) {
      lines.push(`  番型  ${f.name}: ${f.value} 番`);
    }
    if (s.chicken) {
      lines.push('  番型  鸡胡（fallback 保底）');
    }
    for (const b of s.bonus) {
      const count = b.count ? `×${b.count}` : '';
      lines.push(`  附加  ${b.name}: +${b.value}${count}`);
    }

    // 封顶过程：引擎 lines 逐项原样渲染（key 已含阶段语义，label+detail 可读）
    if (s.lines.length > 0) {
      lines.push('  计分明细:');
      for (const l of s.lines) {
        lines.push(`    · ${l.label}: ${l.detail}`);
      }
    }

    // 包三家
    if (s.paymentKind === 'bao') {
      const payer = s.payerSeat !== null ? (seatNames[s.payerSeat] ?? `座位${s.payerSeat}`) : '-';
      lines.push(`  ★ 包三家: ${payer} 独付三倍（原因: ${s.baoReasons.join('；') || '规则判定'}）`);
    } else if (s.paymentKind === 'discard' && s.payerSeat !== null) {
      const payer = seatNames[s.payerSeat] ?? `座位${s.payerSeat}`;
      lines.push(`  点炮者: ${payer}`);
    }

    lines.push(`  最终番数: ${s.finalFan} 番    结算分: ${s.score}`);
    return lines;
  }

  // —— 程序化 UI ——

  /** 内容文本（若编辑器未绑定则程序化创建） */
  public layout(): void {
    const { width, height } = modalSize(this.node);
    drawModal(this.node, width, height);
    if (!this.title) this.title = addLabel(this.node, '结算明细', 0, 0, width - 52, 42, 29, GOLD);
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
    if (this.node.active && this.btnRoot) this.buildButtons();
  }

  private buildButtons(): void {
    if (this.btnRoot) {
      this.btnRoot.removeFromParent();
      this.btnRoot.destroy();
    }
    const root = new Node('buttons');
    const { width, height } = modalSize(this.node);
    const ut = root.addComponent(UITransform);
    ut.setContentSize(width, 70);
    root.setPosition(0, -height / 2 + 42);
    this.node.addChild(root);
    this.btnRoot = root;

    const cell = (width - 36) / (this.onContinue ? 3 : 2);
    const offset = cell * (this.onContinue ? 1 : .5);
    this.makeButton(root, '关闭', -offset, cell - 8, () => this.hide());
    this.makeButton(root, '返回大厅', offset, cell - 8, () => this.onBackToLobby?.());
    if (this.onContinue) this.makeButton(root, '下一局', 0, cell - 8, () => {
      this.hide();
      this.onContinue?.();
    }, true);
  }

  private makeButton(parent: Node, text: string, x: number, width: number, onTap: () => void, primary = false): void {
    const button = addTextButton(parent, text, x, 0, width, primary, 46);
    button.node.on(Button.EventType.CLICK, onTap);
  }
}
