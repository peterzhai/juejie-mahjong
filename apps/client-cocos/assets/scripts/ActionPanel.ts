import { _decorator, Button, Component } from 'cc';
import { tileLabel } from '@quejie/mahjong-core';
import type { LegalOption } from '@quejie/protocol';
import { addTextButton } from './ui/ModalText';

const { ccclass } = _decorator;

const ACTION_LABEL: Record<LegalOption['type'], string> = {
  discard: '出牌', hu: '胡牌', peng: '碰', mingang: '明杠', bugang: '补杠', ankang: '暗杠', pass: '过',
};

@ccclass('ActionPanel')
export class ActionPanel extends Component {
  public onActionPicked: ((option: LegalOption) => void) | null = null;
  public availableWidth = 800;

  public setOptions(options: LegalOption[], selectedDiscard?: string): void {
    this.clear();
    const shown = options.filter((option) => option.type !== 'discard');
    if (selectedDiscard) shown.push({ type: 'discard', tile: selectedDiscard });
    if (!shown.length) return;
    this.node.active = true;
    const gap = 8;
    const width = Math.min(122, (this.availableWidth - (shown.length - 1) * gap) / shown.length);
    shown.forEach((option, i) => {
      const x = (i - (shown.length - 1) / 2) * (width + gap);
      const tile = option.tile && ['ankang', 'bugang', 'discard'].includes(option.type) ? ` ${tileLabel(option.tile)}` : '';
      const button = addTextButton(this.node, ACTION_LABEL[option.type] + tile, x, 0, width, option.type === 'hu' || option.type === 'discard', 46);
      button.node.on(Button.EventType.CLICK, () => this.onActionPicked?.(option));
    });
  }

  public clear(): void {
    for (const node of [...this.node.children]) {
      node.removeFromParent();
      node.destroy();
    }
    this.node.active = false;
  }
}
