/**
 * 牌墙进度条：实时显示墙内余牌（wallRemaining）与死墙（deadWall），Graphics 绘制免图片资源。
 * 进度含义：余牌占"总可摸牌"比例，死墙到达时对局流局。
 */

import { _decorator, Color, Component, Graphics, Label, Node, UITransform } from 'cc';

const { ccclass, property } = _decorator;

const BAR_W = 320;
const BAR_H = 14;
const COLOR_BG = new Color(0, 0, 0, 110);
const COLOR_FILL = new Color(232, 192, 92, 255);
const COLOR_TEXT = new Color(240, 232, 214, 255);

@ccclass('WallCounter')
export class WallCounter extends Component {
  @property(Label)
  public label: Label | null = null;

  @property({ tooltip: '本次对局的可摸总张数（总牌墙 - 死墙），用于计算进度；0 表示未初始化' })
  private totalLiveTiles = 0;

  private wallRemaining = 0;
  private deadWall = 0;

  protected onLoad(): void {
    const ut = this.node.getComponent(UITransform) ?? this.node.addComponent(UITransform);
    ut.setContentSize(BAR_W, BAR_H + 30);
    this.ensureLabel();
    this.redraw();
  }

  /** 初始化总量（开局调用一次：总可摸 = wallTiles - deadWall） */
  public init(totalLive: number): void {
    this.totalLiveTiles = totalLive;
  }

  /** 刷新显示（来自 gameState.wallRemaining / deadWall） */
  public updateCount(wallRemaining: number, deadWall: number): void {
    this.wallRemaining = wallRemaining;
    this.deadWall = deadWall;
    this.redraw();
  }

  private ensureLabel(): void {
    if (this.label) return;
    const node = new Node('count');
    const ut = node.addComponent(UITransform);
    ut.setContentSize(BAR_W, 24);
    const label = node.addComponent(Label);
    label.fontSize = 20;
    label.color = COLOR_TEXT;
    node.setPosition(0, BAR_H);
    this.node.addChild(node);
    this.label = label;
  }

  /** 重绘：底槽 + 填充条 + 文本 */
  private redraw(): void {
    const g = this.node.getComponent(Graphics) ?? this.node.addComponent(Graphics);
    g.clear();
    g.fillColor = COLOR_BG;
    g.roundRect(-BAR_W / 2, -BAR_H / 2, BAR_W, BAR_H, 7);
    g.fill();

    let ratio = 0;
    if (this.totalLiveTiles > 0) {
      ratio = Math.max(0, Math.min(1, this.wallRemaining / this.totalLiveTiles));
    }
    if (ratio > 0) {
      const w = Math.max(4, BAR_W * ratio);
      g.fillColor = COLOR_FILL;
      g.roundRect(-BAR_W / 2, -BAR_H / 2 + 2, w, BAR_H - 4, 5);
      g.fill();
    }

    if (this.label) {
      this.label.string = `余牌 ${this.wallRemaining} · 死墙 ${this.deadWall}`;
    }
  }
}
