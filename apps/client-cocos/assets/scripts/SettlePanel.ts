/**
 * 结算面板（PRD 7.4）：逐项渲染番型/附加番/封顶过程 lines、包三家原因、最终番数与分数、
 * 四家本局分差与累计分。文本行方式渲染（滚动容器内 Label），由 TableScene 在 gameOver 时调用。
 */

import { _decorator, Color, Component, Graphics, Label, Node, UITransform, UIOpacity } from 'cc';
import type { GameOverMsg, SettlementView } from '@quejie/protocol';

const { ccclass, property } = _decorator;

const PANEL_W = 760;
const PANEL_H = 520;
const COLOR_BG = new Color(16, 22, 30, 236);
const COLOR_BORDER = new Color(210, 178, 110, 255);
const COLOR_TEXT = new Color(238, 233, 220, 255);

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

  protected onLoad(): void {
    this.ensureBackground();
    this.ensureContentLabel();
    this.node.active = false;
  }

  /** 显示结算（本局可能多家胡：逐个 SettlementView 渲染） */
  public show(over: GameOverMsg, mySeat: number, seatNames: string[]): void {
    this.node.active = true;
    const parts: string[] = [];

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

    if (this.contentLabel) this.contentLabel.string = parts.join('\n');
    this.buildButtons(over);
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

  /** 半透明底板 + 金色描边（Graphics 免图片资源） */
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

  /** 内容文本（若编辑器未绑定则程序化创建） */
  private ensureContentLabel(): void {
    if (this.contentLabel) return;
    const node = new Node('content');
    const ut = node.addComponent(UITransform);
    ut.setContentSize(PANEL_W - 60, PANEL_H - 130);
    const label = node.addComponent(Label);
    label.fontSize = 22;
    label.lineHeight = 30;
    label.overflow = Label.Overflow.CLAMP;
    label.horizontalAlign = Label.HorizontalAlign.LEFT;
    label.verticalAlign = Label.VerticalAlign.TOP;
    label.color = COLOR_TEXT;
    node.setPosition(0, 25);
    this.node.addChild(node);
    this.contentLabel = label;
  }

  /** 底部按钮：继续 / 返回大厅 */
  private buildButtons(_over: GameOverMsg): void {
    if (this.btnRoot) this.btnRoot.destroy();
    const root = new Node('buttons');
    const ut = root.addComponent(UITransform);
    ut.setContentSize(PANEL_W, 70);
    root.setPosition(0, -PANEL_H / 2 + 45);
    this.node.addChild(root);
    this.btnRoot = root;

    if (this.onContinue) {
      this.makeButton(root, '继续（连庄下一局）', -160, () => this.onContinue?.());
    }
    this.makeButton(root, '返回大厅', this.onContinue ? 40 : 0, () => this.onBackToLobby?.());
    // 淡入
    const op = this.node.getComponent(UIOpacity) ?? this.node.addComponent(UIOpacity);
    op.opacity = 255;
  }

  /** 简单文字按钮（Graphics 底 + TOUCH_END） */
  private makeButton(parent: Node, text: string, x: number, onTap: () => void): void {
    const node = new Node(`btn_${text}`);
    const ut = node.addComponent(UITransform);
    ut.setContentSize(230, 56);
    node.setPosition(x, 0);
    const g = node.addComponent(Graphics);
    g.fillColor = new Color(62, 92, 140, 255);
    g.roundRect(-115, -28, 230, 56, 10);
    g.fill();
    const labelNode = new Node('text');
    const lut = labelNode.addComponent(UITransform);
    lut.setContentSize(218, 48);
    const label = labelNode.addComponent(Label);
    label.fontSize = 26;
    label.overflow = Label.Overflow.SHRINK;
    label.horizontalAlign = Label.HorizontalAlign.CENTER;
    label.verticalAlign = Label.VerticalAlign.CENTER;
    label.color = COLOR_TEXT;
    label.string = text;
    node.addChild(labelNode);
    node.on(Node.EventType.TOUCH_END, onTap);
    parent.addChild(node);
  }
}
