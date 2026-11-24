/**
 * 自己手牌渲染与触摸交互：TileView 生成、间距布局（摸牌尾距加宽）、选中态管理。
 * 交互约定：点击选中 → 再点同一张 = 确认打出（回调 onDiscardRequest），或点"出牌"按钮。
 */

import { _decorator, Component, EventTouch, Node, UITransform, Vec3 } from 'cc';
import { TILE_ORDER } from '@quejie/mahjong-core';
import { TileView } from './TileView';

const { ccclass } = _decorator;

/** 手牌区中心锚点下的布局参数 */
const TILE_W = 64;
const TILE_H = 88;
const GAP = 4;
const DREW_GAP = 16; // 摸牌与手牌的额外间距

@ccclass('HandView')
export class HandView extends Component {
  /** 点击已选中牌再次点击时确认打出的回调（由 TableScene 注入 → GameManager 转发） */
  public onDiscardRequest: ((tileId: string) => void) | null = null;
  public onSelectionChanged: (() => void) | null = null;
  public canSelect: ((tileId: string) => boolean) | null = null;
  public directDiscard: (() => boolean) | null = null;
  private compact = false;

  /** 当前选中的牌（tileId；同 tileId 多张时选中最靠右的一张实例） */
  public selectedTile: string | null = null;

  /** 当前手牌（渲染顺序） */
  private tiles: string[] = [];
  private drewTile: string | null = null;
  private views: TileView[] = [];

  /** 牌面序（TILE_ORDER 顺序：万条筒 → 风 → 箭） */
  private static orderMap: ReadonlyMap<string, number> | null = null;

  private static tileOrder(tileId: string): number {
    if (HandView.orderMap === null) {
      const m = new Map<string, number>();
      TILE_ORDER.forEach((d, i) => m.set(d.id, i));
      HandView.orderMap = m;
    }
    return HandView.orderMap.get(tileId) ?? Number.MAX_SAFE_INTEGER;
  }

  /**
   * 设置手牌并重建视图。
   * @param tiles 手牌列表（引擎顺序，不要求有序）
   * @param drewTile 本轮刚摸到的牌（尾距加宽展示；可为 null）
   */
  public setHand(tiles: string[], drewTile: string | null): void {
    this.tiles = [...tiles].sort((a, b) => HandView.tileOrder(a) - HandView.tileOrder(b));
    const drawnIndex = drewTile === null ? -1 : this.tiles.lastIndexOf(drewTile);
    this.drewTile = drawnIndex < 0 ? null : drewTile;
    if (drawnIndex >= 0) this.tiles.splice(drawnIndex, 1);
    this.selectedTile = null;
    this.rebuild();
  }

  /** 清空手牌 */
  public clear(): void {
    this.tiles = [];
    this.drewTile = null;
    this.selectedTile = null;
    this.rebuild();
  }

  /** 取当前选中牌（"出牌"按钮用），无选中返回 null */
  public consumeSelected(): string | null {
    return this.selectedTile;
  }

  public setCompact(compact: boolean): void {
    if (compact === this.compact) return;
    this.compact = compact;
    this.rebuild();
    this.refreshSelection();
  }

  /** 重建手牌节点：先清空容器再逐张生成 TileView 并排布 */
  private rebuild(): void {
    for (const child of [...this.node.children]) { child.removeFromParent(); child.destroy(); }
    this.views = [];

    const count = this.tiles.length + (this.drewTile ? 1 : 0);
    if (this.compact) {
      const ids = this.drewTile ? [...this.tiles, this.drewTile] : this.tiles;
      const columns = 8;
      // Reserve the lower row when the hand gets shorter after a meld.
      const topCount = Math.max(0, count - columns);
      for (const [row, rowTiles] of [ids.slice(0, topCount), ids.slice(topCount)].entries()) {
        rowTiles.forEach((tile, i) => this.placeTile(tile, (i - (rowTiles.length - 1) / 2) * (TILE_W + GAP), false, row === 0 ? 51 : -47));
      }
      return;
    }
    const totalW = count * TILE_W + Math.max(0, count - 1) * GAP + (this.drewTile ? DREW_GAP : 0);
    let x = -totalW / 2 + TILE_W / 2;

    for (const id of this.tiles) {
      x = this.placeTile(id, x, false);
    }
    if (this.drewTile) {
      x += DREW_GAP;
      this.placeTile(this.drewTile, x, true);
    }
  }

  /** 生成单张并返回下一个 x 起点 */
  private placeTile(tileId: string, x: number, isDrew: boolean, y = 0): number {
    const view = TileView.create(this.node, tileId, TILE_W, TILE_H);
    view.node.setPosition(new Vec3(x, y + (isDrew ? 10 : 0), 0));
    view.node.on(Node.EventType.TOUCH_END, this.onTileTouch, this);
    this.views.push(view);
    return x + TILE_W / 2 + GAP + TILE_W / 2;
  }

  /** 触摸：未选中 → 选中；已选中同一张 → 请求打出；其他 → 切换选中 */
  private onTileTouch(event: EventTouch): void {
    const target = event.currentTarget as Node | null;
    if (!target) return;
    const view = this.findViewByNode(target);
    if (!view) return;
    const id = view.tileId;
    if (this.canSelect && !this.canSelect(id)) return;
    if (this.selectedTile === id || this.directDiscard?.()) {
      // 再点确认打出（合法性由 TableScene 校验，非法时 Tips 提示并保持选中）
      this.selectedTile = null;
      this.refreshSelection();
      this.onSelectionChanged?.();
      if (this.onDiscardRequest) this.onDiscardRequest(id);
      return;
    }
    this.selectedTile = id;
    this.refreshSelection();
    this.onSelectionChanged?.();
  }

  /** 按节点反查 TileView */
  private findViewByNode(node: Node): TileView | null {
    for (const v of this.views) {
      if (v.node === node) return v;
    }
    return null;
  }

  /** 刷新全部选中态 */
  private refreshSelection(): void {
    for (const v of this.views) {
      v.setSelected(v.tileId === this.selectedTile);
    }
  }

  /** 容器尺寸（供锚点节点自适应参考） */
  public get layoutWidth(): number {
    const count = this.tiles.length + (this.drewTile ? 1 : 0);
    return count * TILE_W + Math.max(0, count - 1) * GAP + (this.drewTile ? DREW_GAP : 0);
  }

  protected override onLoad(): void {
    const ut = this.node.getComponent(UITransform) ?? this.node.addComponent(UITransform);
    ut.setContentSize(this.layoutWidth, TILE_H);
  }
}
