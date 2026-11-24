/**
 * 安全区适配组件（微信刘海屏 / 打孔屏）：按平台适配器返回的物理像素安全区，
 * 换算为设计分辨率后写入本节点 Widget 的 top/bottom 边距。
 */

import { _decorator, Component, Widget, view } from 'cc';
import { getPlatformAdapter } from './platform/IPlatform';

const { ccclass, property } = _decorator;

@ccclass('SafeArea')
export class SafeArea extends Component {
  @property({ tooltip: '是否适配顶部（状态栏/刘海）' })
  public alignTop = true;

  @property({ tooltip: '是否适配底部（小白条）' })
  public alignBottom = false;

  @property({ tooltip: '顶部额外留白（设计单位）' })
  public extraTop = 0;

  @property({ tooltip: '底部额外留白（设计单位）' })
  public extraBottom = 0;

  protected override onLoad(): void {
    this.apply();
    // 分辨率/屏幕旋转变化时重算（API 存在性守卫，兼容不同 Creator 小版本）
    if (typeof view.setResizeCallback === 'function') {
      view.setResizeCallback(() => this.apply());
    }
  }

  protected override onEnable(): void {
    this.apply();
  }

  /** 计算并写入 Widget 边距 */
  public apply(): void {
    const adapter = getPlatformAdapter();
    const sa = adapter.getSafeAreaPx();
    const design = view.getVisibleSize();
    const pixel = view.getVisibleSizeInPixel();

    // 物理像素 → 设计单位换算系数（横屏游戏按高度换算；等比缩放假设见 README）
    const k = pixel.height > 0 ? design.height / pixel.height : 1;

    let widget = this.node.getComponent(Widget);
    if (!widget) {
      widget = this.node.addComponent(Widget);
    }
    if (this.alignTop) {
      widget.isAlignTop = true;
      widget.top = sa.top * k + this.extraTop;
    }
    if (this.alignBottom) {
      widget.isAlignBottom = true;
      widget.bottom = sa.bottom * k + this.extraBottom;
    }
    widget.updateAlignment();
  }
}
