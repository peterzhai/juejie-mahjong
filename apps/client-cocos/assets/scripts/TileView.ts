/**
 * 单张麻将牌视图：Label 显示牌名兜底 + Sprite 换图接口，node.name 携带 tileId 数据标记。
 * 无图集资源时以文字牌面（如 "三筒"）渲染，接入牌面图后自动切换为图片显示。
 */

import { _decorator, Color, Component, Graphics, Label, Node, Sprite, SpriteFrame, UITransform, Vec3 } from 'cc';
import { tileLabel } from '@quejie/mahjong-core';

const { ccclass, property } = _decorator;

/** 牌面图静态解析器：由 TableScene 根据图集注册（SpriteFrame.name 必须等于 tileId，如 "C1"、"HR"） */
let faceResolver: ((tileId: string) => SpriteFrame | null) | null = null;

/** 注册全局牌面图解析器（name → SpriteFrame 映射，见 README 图集接入） */
export function setTileFaceResolver(resolver: ((tileId: string) => SpriteFrame | null) | null): void {
  faceResolver = resolver;
}

const COLOR_TEXT = new Color(28, 28, 28, 255);
const COLOR_RED = new Color(190, 32, 32, 255); // 红中
const COLOR_GREEN = new Color(24, 118, 58, 255); // 绿发
const COLOR_FACE_DOWN = new Color(31, 121, 89, 255);
const BACK_PHOTO_TINT = new Color(53, 255, 166);

@ccclass('TileView')
export class TileView extends Component {
  @property({ tooltip: '本牌的牌面 ID（数据标记，如 C1/B3/HR）' })
  public tileId = '';

  @property(Label)
  public label: Label | null = null;

  @property(Sprite)
  public sprite: Sprite | null = null;

  /** 牌尺寸缓存（布局用） */
  public tileWidth = 64;
  public tileHeight = 88;

  /** 是否牌背（暗杠隐藏张 / 他人手牌背面） */
  private faceDown = false;
  private selected = false;
  private background: Graphics | null = null;

  /**
   * 工厂方法：动态构建一张牌（无需预制体）。
   * 结构：node(UITransform+Sprite+TileView) / label 子节点(Label)。
   */
  public static create(parent: Node | null, tileId: string, width = 64, height = 88): TileView {
    const node = new Node(`tile_${tileId}`);
    const ut = node.addComponent(UITransform);
    ut.setContentSize(width, height);
    const view = node.addComponent(TileView);
    view.tileId = tileId;
    view.tileWidth = width;
    view.tileHeight = height;

    const sprite = node.addComponent(Sprite);
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    sprite.type = Sprite.Type.SIMPLE;
    view.sprite = sprite;

    const background = new Node('background');
    background.addComponent(UITransform).setContentSize(width, height);
    view.background = background.addComponent(Graphics);
    node.addChild(background);

    const labelNode = new Node('face');
    const lut = labelNode.addComponent(UITransform);
    lut.setContentSize(width, height);
    const label = labelNode.addComponent(Label);
    label.fontSize = Math.round(height * 0.34);
    label.lineHeight = Math.round(height * 0.4);
    label.horizontalAlign = Label.HorizontalAlign.CENTER;
    label.verticalAlign = Label.VerticalAlign.CENTER;
    label.overflow = Label.Overflow.SHRINK;
    label.color = COLOR_TEXT;
    view.label = label;
    node.addChild(labelNode);

    if (parent) parent.addChild(node);
    view.refreshFace();
    return view;
  }

  /** 设置牌面并刷新显示（换图或文字牌名） */
  public setup(tileId: string): void {
    this.tileId = tileId;
    this.node.name = `tile_${tileId}`;
    this.refreshFace();
  }

  /** 牌背/正面切换（暗杠第一张、他人手牌背面用） */
  public setFaceDown(down: boolean): void {
    this.faceDown = down;
    this.refreshFace();
  }

  /** 选中态：轻微放大（手牌触摸选牌视觉反馈） */
  public setSelected(sel: boolean): void {
    if (this.selected === sel) return;
    this.selected = sel;
    const s = sel ? 1.14 : 1.0;
    this.node.setScale(new Vec3(s, s, 1));
  }

  /** 刷新牌面：优先图集（静态解析器），否则文字牌名兜底 */
  public refreshFace(): void {
    const label = this.label;
    if (!label) return;
    const frame = faceResolver?.(this.faceDown ? 'back' : this.tileId) ?? null;
    if (this.sprite) {
      this.sprite.spriteFrame = frame;
      this.sprite.color = this.faceDown ? BACK_PHOTO_TINT : Color.WHITE;
    }
    if (this.background) {
      this.background.node.active = !frame;
      this.background.clear();
      if (!frame) {
        this.background.fillColor = this.faceDown ? COLOR_FACE_DOWN : new Color(246, 239, 220);
        this.background.roundRect(-this.tileWidth / 2, -this.tileHeight / 2, this.tileWidth, this.tileHeight, 4);
        this.background.fill();
      }
    }
    label.node.active = !frame && !this.faceDown;
    label.string = this.faceDown ? '' : safeLabel(this.tileId);
    label.color = suitColor(this.tileId);
    if (this.selected) {
      this.node.setScale(new Vec3(1.14, 1.14, 1));
    }
  }
}

/** 牌名（未知牌面 ID 不抛错，显示原始 ID） */
function safeLabel(tileId: string): string {
  try {
    return tileLabel(tileId);
  } catch (e) {
    void e;
    return tileId;
  }
}

/** 经典花色配色：万红、条绿、筒蓝；中红、发绿。 */
function suitColor(tileId: string): Color {
  if (tileId.startsWith('C') || tileId === 'HR') return COLOR_RED;
  if (tileId.startsWith('B') || tileId === 'HG') return COLOR_GREEN;
  if (tileId.startsWith('D')) return new Color(32, 92, 165, 255);
  return COLOR_TEXT;
}
