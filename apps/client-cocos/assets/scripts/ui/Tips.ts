/**
 * 轻提示（Toast）：屏幕中下方浮出一条半透明提示，自动淡出销毁。
 * 全局静态入口 Tips.show(msg, duration)，无需挂载预制体（Graphics 画底 + Label 文本）。
 */

import { _decorator, Color, Component, director, Graphics, Label, Node, tween, UITransform, UIOpacity, Vec3 } from 'cc';

const { ccclass } = _decorator;

const BG_COLOR = new Color(0, 0, 0, 180);
const TEXT_COLOR = new Color(245, 242, 230, 255);
const TIP_W = 520;
const TIP_H = 64;
const OFFSET_Y = -160; // 相对屏幕中心的纵向偏移

@ccclass('Tips')
export class Tips extends Component {
  /**
   * 全局入口：在当前场景 Canvas 下弹一条提示。
   * @param message 文案
   * @param duration 展示时长（秒），默认 1.6s
   */
  public static show(message: string, duration = 1.6): void {
    const scene = director.getScene();
    const canvas = scene ? scene.getChildByName('Canvas') : null;
    if (!canvas) return; // 无 Canvas 时静默（README 接线要求 Canvas 命名为 Canvas）

    const node = new Node('tips');
    const ut = node.addComponent(UITransform);
    ut.setContentSize(TIP_W, TIP_H);
    node.setPosition(new Vec3(0, OFFSET_Y, 0));

    const g = node.addComponent(Graphics);
    g.fillColor = BG_COLOR;
    g.roundRect(-TIP_W / 2, -TIP_H / 2, TIP_W, TIP_H, 12);
    g.fill();

    const labelNode = new Node('text');
    const lut = labelNode.addComponent(UITransform);
    lut.setContentSize(TIP_W - 32, TIP_H - 12);
    const label = labelNode.addComponent(Label);
    label.fontSize = 26;
    label.lineHeight = 32;
    label.overflow = Label.Overflow.SHRINK;
    label.horizontalAlign = Label.HorizontalAlign.CENTER;
    label.verticalAlign = Label.VerticalAlign.CENTER;
    label.color = TEXT_COLOR;
    label.string = message;
    node.addChild(labelNode);

    const opacity = node.addComponent(UIOpacity);
    opacity.opacity = 0;
    canvas.addChild(node);

    // 淡入 → 停留 → 淡出销毁
    const comp = node.addComponent(Tips);
    comp.play(opacity, duration);
  }

  /** 提示动画（独立组件仅承载 tween 生命周期，节点销毁自动停止） */
  private play(opacity: UIOpacity, duration: number): void {
    tweenIn(opacity);
    this.scheduleOnce(() => {
      const c = opacity.getComponent(UIOpacity);
      if (!c) return;
      tweenOut(c, () => {
        this.node.destroy();
      });
    }, duration);
  }
}

function tweenIn(opacity: UIOpacity): void {
  tween(opacity).to(0.12, { opacity: 255 }).start();
}

function tweenOut(opacity: UIOpacity, done: () => void): void {
  tween(opacity)
    .to(0.25, { opacity: 0 })
    .call(done)
    .start();
}
