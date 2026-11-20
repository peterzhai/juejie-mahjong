/**
 * 合法动作按钮面板：胡/碰/明杠/补杠/暗杠/过 按钮动态生成（动作列表驱动，非法动作不显示），
 * 点击回调经 TableScene 转发至 GameManager 执行。程序化构建按钮，免预制体。
 */

import { _decorator, Button, Color, Component, Graphics, Label, Node, Sprite, SpriteFrame, UITransform } from 'cc';
import { tileLabel } from '@quejie/mahjong-core';
import type { LegalOption } from '@quejie/protocol';

const { ccclass, property } = _decorator;

/** 动作按钮尺寸与间距 */
const BTN_W = 132;
const BTN_H = 62;
const BTN_GAP = 14;

const COLOR_HU = new Color(178, 34, 34, 235);
const COLOR_MELD = new Color(34, 110, 178, 235);
const COLOR_PASS = new Color(70, 70, 70, 235);
const COLOR_TEXT = new Color(255, 255, 255, 255);

/** 动作类型 → 中文标签 */
const ACTION_LABEL: Record<string, string> = {
  hu: '胡',
  peng: '碰',
  mingang: '明杠',
  bugang: '补杠',
  ankang: '暗杠',
  pass: '过',
};

@ccclass('ActionPanel')
export class ActionPanel extends Component {
  /** 动作选中回调（TableScene 注入 → GameManager.performAction） */
  public onActionPicked: ((option: LegalOption) => void) | null = null;

  /** 复用的白色 SpriteFrame（按钮底图，任何纯白 2x2 图均可；缺省用 Graphics 纯色块） */
  @property(SpriteFrame)
  public btnFrame: SpriteFrame | null = null;

  protected onLoad(): void {
    this.clear();
  }

  /**
   * 按合法动作列表重建按钮。
   * discard 动作由手牌触摸承担，不进面板；其余动作逐一生成。
   */
  public setOptions(options: LegalOption[]): void {
    this.clear();
    const shown = options.filter((o) => o.type !== 'discard');
    if (shown.length === 0) {
      this.node.active = false;
      return;
    }
    this.node.active = true;
    let x = (-(shown.length * BTN_W + (shown.length - 1) * BTN_GAP)) / 2 + BTN_W / 2;
    for (const opt of shown) {
      const btn = this.createButton(opt, x);
      this.node.addChild(btn);
      x += BTN_W + BTN_GAP;
    }
  }

  /** 清空面板并隐藏 */
  public clear(): void {
    this.node.removeAllChildren();
    this.node.active = false;
  }

  /** 程序化创建一个动作按钮（Sprite 底 + Button + Label） */
  private createButton(opt: LegalOption, x: number): Node {
    const node = new Node(`act_${opt.type}${opt.tile ? `_${opt.tile}` : ''}`);
    const ut = node.addComponent(UITransform);
    ut.setContentSize(BTN_W, BTN_H);
    node.setPosition(x, 0);

    // 底色：优先 Sprite（btnFrame），否则 Graphics 纯色兜底
    if (this.btnFrame) {
      const sp = node.addComponent(Sprite);
      sp.spriteFrame = this.btnFrame;
      sp.sizeMode = Sprite.SizeMode.CUSTOM;
      sp.color = colorFor(opt);
    } else {
      const g = node.addComponent(Graphics);
      g.fillColor = colorFor(opt);
      g.roundRect(-BTN_W / 2, -BTN_H / 2, BTN_W, BTN_H, 10);
      g.fill();
    }

    const labelNode = new Node('text');
    const lut = labelNode.addComponent(UITransform);
    lut.setContentSize(BTN_W - 12, BTN_H - 12);
    const label = labelNode.addComponent(Label);
    label.fontSize = 30;
    label.lineHeight = 34;
    label.overflow = Label.Overflow.SHRINK;
    label.horizontalAlign = Label.HorizontalAlign.CENTER;
    label.verticalAlign = Label.VerticalAlign.CENTER;
    label.color = COLOR_TEXT;
    label.string = labelText(opt);
    label.isBold = true;
    node.addChild(labelNode);

    // 点击：Button 组件提供点击态，监听 CLICK 转发回调
    const btn = node.addComponent(Button);
    btn.transition = Button.Transition.SCALE;
    node.on(Button.EventType.CLICK, () => {
      if (this.onActionPicked) this.onActionPicked(opt);
    });
    return node;
  }
}

/** 按钮配色：胡最醒目，碰/杠次之，过灰 */
function colorFor(opt: LegalOption): Color {
  if (opt.type === 'hu') return COLOR_HU;
  if (opt.type === 'pass') return COLOR_PASS;
  return COLOR_MELD;
}

/** 按钮文案：同类型多选项（如多个暗杠）附牌名 */
function labelText(opt: LegalOption): string {
  const base = ACTION_LABEL[opt.type] ?? opt.type;
  if (opt.tile && (opt.type === 'ankang' || opt.type === 'bugang')) {
    return `${base}·${tileLabel(opt.tile)}`;
  }
  return base;
}
