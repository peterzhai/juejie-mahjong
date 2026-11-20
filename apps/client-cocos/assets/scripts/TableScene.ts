/**
 * 牌桌主场景控制器：座位布局（下=自己/右=下家/上=对家/左=上家）、
 * 手牌/副露/弃牌河/牌墙/风位渲染、合法动作面板、触摸选牌出牌、结算面板、规则面板入口。
 * 数据统一来自 GameManager（联机 GameStateMsg 或 PVE 同构快照），动作经 GameManager 转发。
 */

import { _decorator, Button, Color, Component, Graphics, Label, Node, SpriteFrame, UITransform } from 'cc';
import { SEAT_WIND_NAMES, tileLabel } from '@quejie/mahjong-core';
import type { GameEventMsg, GameOverMsg, GameStateMsg, LegalOption, MeldView } from '@quejie/protocol';
import { GameManager } from './GameManager';
import { HandView } from './HandView';
import { ActionPanel } from './ActionPanel';
import { SettlePanel } from './SettlePanel';
import { RulePanel } from './RulePanel';
import { WallCounter } from './WallCounter';
import { TileView, setTileFaceResolver } from './TileView';
import { SoundManager } from './SoundManager';
import { Tips } from './ui/Tips';

const { ccclass, property } = _decorator;

/** 座位相对位置约定：0=下(自己) 1=右(下家) 2=上(对家) 3=左(上家)，与 seatNodes 数组下标对应 */

/** 弃牌河网格参数 */
const DISCARD_COLS = 8;
const DISCARD_W = 46;
const DISCARD_H = 62;
const DISCARD_GAP = 2;

/** 副露参数 */
const MELD_W = 42;
const MELD_H = 58;
const MELD_GAP = 2;
const MELD_GROUP_GAP = 12;

/** 他人手牌背面参数 */
const BACK_W = 30;
const BACK_H = 42;

const COLOR_CURRENT = new Color(250, 210, 90, 255);
const COLOR_IDLE = new Color(235, 230, 220, 255);

@ccclass('TableScene')
export class TableScene extends Component {
  // —— 子视图引用（编辑器绑定；缺失时程序化兜底创建） ——
  @property(HandView)
  public handView: HandView | null = null;

  @property(ActionPanel)
  public actionPanel: ActionPanel | null = null;

  @property(SettlePanel)
  public settlePanel: SettlePanel | null = null;

  @property(RulePanel)
  public rulePanel: RulePanel | null = null;

  @property(WallCounter)
  public wallCounter: WallCounter | null = null;

  /** 四个座位节点，按下标 = 相对座位（0 下 / 1 右 / 2 上 / 3 左） */
  @property({ type: [Node] })
  public seatNodes: Node[] = [];

  /** 牌面图集（SpriteFrame.name 必须等于 tileId，如 C1/B2/HR） */
  @property({ type: [SpriteFrame] })
  public tileFaces: SpriteFrame[] = [];

  @property(Button)
  public btnDiscard: Button | null = null;

  @property(Button)
  public btnRule: Button | null = null;

  @property(Label)
  public statusLabel: Label | null = null;

  // —— 运行时状态 ——
  private viewSeat = 0;
  private seatNames = ['', '', '', ''];
  private lastState: GameStateMsg | null = null;
  private lastWallRemaining = -1;
  private maxWallSeen = 0;
  /** 回合倒计时（actionDeadlineMs） */
  private deadlineAt = 0;
  private faceMap: Map<string, SpriteFrame> = new Map();

  // —— 生命周期 ——

  protected onLoad(): void {
    const gm = GameManager.ensureInstance();


    // 牌面图集注册（name → SpriteFrame）
    this.faceMap = new Map();
    for (const f of this.tileFaces) {
      if (f && f.name) this.faceMap.set(f.name, f);
    }
    setTileFaceResolver((tileId) => this.faceMap.get(tileId) ?? null);

    this.ensureSubviews();
    this.bindButtons();
    this.setStatus('等待开局…');
    gm.attachTable(this);
  }

  protected onDestroy(): void {
    setTileFaceResolver(null);
    GameManager.instance?.detachTable(this);
  }

  protected update(_dt: number): void {
    // 回合倒计时显示
    if (this.deadlineAt > 0 && this.statusLabel) {
      const remain = Math.ceil((this.deadlineAt - Date.now()) / 1000);
      if (remain <= 0) {
        this.deadlineAt = 0;
      } else if (this.lastState && this.lastState.currentSeat === this.viewSeat) {
        this.statusLabel.string = `轮到你出牌（${remain}s）`;
      }
    }
  }

  // —— 数据入口（GameManager 转发） ——

  /** 应用完整对局状态快照（联机 gameState / PVE 同构快照共用） */
  public applyGameState(state: GameStateMsg): void {
    this.lastState = state;
    this.viewSeat = state.viewSeat;
    this.seatNames = state.seats.map((s) => s.name);

    // 新一手检测：余牌回增 → 重置进度条满刻度
    if (this.lastWallRemaining >= 0 && state.wallRemaining > this.lastWallRemaining) {
      this.maxWallSeen = state.wallRemaining;
    }
    this.maxWallSeen = Math.max(this.maxWallSeen, state.wallRemaining);
    this.lastWallRemaining = state.wallRemaining;

    // 座位与区域渲染
    for (const sv of state.seats) {
      this.renderSeat(sv.seat, state);
    }
    this.renderSelfHand(state);

    // 牌墙进度
    if (this.wallCounter) {
      this.wallCounter.init(this.maxWallSeen);
      this.wallCounter.updateCount(state.wallRemaining, state.deadWall);
    }

    // 合法动作面板（动作列表驱动：非法动作绝不显示）
    if (this.actionPanel) {
      this.actionPanel.setOptions(state.legalOptions ?? []);
    }

    // 状态条
    this.renderStatus(state);
    this.deadlineAt = state.actionDeadlineMs ? Date.now() + state.actionDeadlineMs : 0;
  }

  /** 应用对局事件：音效反馈 + 轻提示 */
  public applyGameEvent(evt: GameEventMsg['event']): void {
    const sound = SoundManager.instance;
    switch (evt.kind) {
      case 'draw':
        if (evt.seat === this.viewSeat && sound) sound.playDeal();
        break;
      case 'discard':
        if (sound) sound.playDiscard();
        break;
      case 'peng':
        if (sound) sound.playPeng();
        Tips.show(`${this.nameOf(evt.seat)} 碰 ${tileLabel(evt.tile)}`);
        break;
      case 'mingang':
        if (sound) sound.playGang();
        Tips.show(`${this.nameOf(evt.seat)} 明杠 ${tileLabel(evt.tile)}`);
        break;
      case 'bugang':
        if (sound) sound.playGang();
        Tips.show(`${this.nameOf(evt.seat)} 补杠 ${tileLabel(evt.tile)}`);
        break;
      case 'ankang':
        if (sound) sound.playGang();
        Tips.show(`${this.nameOf(evt.seat)} 暗杠`);
        break;
      case 'kongScore':
        if (evt.to === this.viewSeat) Tips.show(`杠分 +${evt.amount}`);
        else if (evt.from === this.viewSeat) Tips.show(`杠分 -${evt.amount}`);
        break;
      case 'missLock':
        if (evt.seat === this.viewSeat) Tips.show(`漏胡锁定：${tileLabel(evt.tile)}`);
        break;
      case 'hu':
        if (sound) sound.playHu();
        Tips.show(`${this.nameOf(evt.seat)} 胡了！`);
        break;
      default:
        break;
    }
  }

  /** 显示结算面板（gameOver） */
  public showGameOver(over: GameOverMsg): void {
    if (this.settlePanel) {
      const gm = GameManager.instance;
      this.settlePanel.onBackToLobby = () => gm?.leaveRoom();
      this.settlePanel.onContinue = gm && gm.mode === 'pve' ? () => gm.pveContinueNextHand() : null;
      this.settlePanel.show(over, this.viewSeat, this.seatNames);
    }
    SoundManager.instance?.playSettle();
    if (this.actionPanel) this.actionPanel.clear();
  }

  /** 打开规则面板（rulesSummary 优先；PVE 用本地 resolved 配置） */
  public showRules(): void {
    const gm = GameManager.instance;
    if (this.rulePanel) {
      this.rulePanel.onClose = () => this.rulePanel?.hide();
      this.rulePanel.show(gm?.roomState?.rulesSummary ?? null, gm?.getPveResolved() ?? null);
    }
  }

  // —— 触摸/按钮交互（统一经 GameManager.sendAction 转发） ——

  /** 手牌触摸请求打出某张（选中后再点确认） */
  private onDiscardRequest(tileId: string): void {
    const gm = GameManager.instance;
    if (!gm) return;
    if (!this.isDiscardLegal(tileId)) {
      Tips.show('非你回合或此牌不可出');
      return;
    }
    gm.sendAction({ type: 'discard', tile: tileId });
  }

  /** "出牌"按钮：打出当前选中牌 */
  private onDiscardButton(): void {
    const tile = this.handView?.consumeSelected() ?? null;
    if (!tile) {
      Tips.show('请先点击选中一张手牌');
      return;
    }
    this.onDiscardRequest(tile);
  }

  /** 动作面板回调（胡/碰/杠/过） */
  private onActionPicked(opt: LegalOption): void {
    const gm = GameManager.instance;
    if (!gm) return;
    SoundManager.instance?.playClick();
    gm.sendAction({ type: opt.type, tile: opt.tile });
    if (this.actionPanel) this.actionPanel.clear();
  }

  /** 校验 discard 合法性（以最近快照的 legalOptions 为准） */
  private isDiscardLegal(tileId: string): boolean {
    const options = this.lastState?.legalOptions ?? [];
    return options.some((o) => o.type === 'discard' && (o.tile === undefined || o.tile === tileId));
  }

  // —— 渲染 ——

  /** 渲染一个座位（名称/风位/分数/副露/弃牌河/他人手牌背面） */
  private renderSeat(seat: number, state: GameStateMsg): void {
    const rel = this.relSeat(seat);
    const seatNode = this.seatNodes[rel];
    if (!seatNode) return;
    const sv = state.seats[seat];
    if (!sv) return;

    // 文本标签
    const nameLabel = this.findLabel(seatNode, 'Name');
    if (nameLabel) {
      const dealerMark = seat === state.dealer ? '〔庄〕' : '';
      const selfMark = seat === this.viewSeat ? '（你）' : '';
      nameLabel.string = `${sv.name}${selfMark}${dealerMark}`;
    }
    const windLabel = this.findLabel(seatNode, 'Wind');
    if (windLabel) {
      windLabel.string = SEAT_WIND_NAMES[seat] ?? '';
      // 当前行动者高亮
      windLabel.color = seat === state.currentSeat ? COLOR_CURRENT : COLOR_IDLE;
    }
    const extraLabel = this.findLabel(seatNode, 'Extra');
    if (extraLabel) {
      const score = state.scores[seat] ?? 0;
      const tags: string[] = [`分 ${score}`];
      if (sv.ai) tags.push('AI');
      if (!sv.connected) tags.push('断线');
      extraLabel.string = tags.join(' · ');
    }

    // 副露
    const meldsNode = this.findChild(seatNode, 'Melds');
    if (meldsNode) {
      meldsNode.removeAllChildren();
      let x = 0;
      for (const meld of sv.melds) {
        x = this.renderMeld(meldsNode, meld, x);
      }
    }

    // 弃牌河
    const discardsNode = this.findChild(seatNode, 'Discards');
    if (discardsNode) {
      discardsNode.removeAllChildren();
      sv.discards.forEach((tileId, i) => {
        const col = i % DISCARD_COLS;
        const row = Math.floor(i / DISCARD_COLS);
        const tv = TileView.create(discardsNode, tileId, DISCARD_W, DISCARD_H);
        tv.node.setPosition(col * (DISCARD_W + DISCARD_GAP), -row * (DISCARD_H + DISCARD_GAP));
      });
    }

    // 他人手牌背面（自己不渲染背面，走底部 HandView）
    const handNode = this.findChild(seatNode, 'Hand');
    if (handNode) {
      handNode.removeAllChildren();
      if (seat !== this.viewSeat) {
        const count = Math.min(sv.handCount, 13);
        for (let i = 0; i < count; i++) {
          const tv = TileView.create(handNode, `back_${seat}_${i}`, BACK_W, BACK_H);
          tv.setFaceDown(true);
          tv.node.setPosition(i * (BACK_W + 1), 0);
        }
        const handCountLabel = this.findLabel(seatNode, 'HandCount');
        if (handCountLabel) handCountLabel.string = `×${sv.handCount}`;
      }
    }
  }

  /** 渲染一组副露（碰 3 张 / 杠 4 张；暗杠首张背面），返回下一个 x 起点 */
  private renderMeld(parent: Node, meld: MeldView, startX: number): number {
    const tiles = meld.type === 'peng' ? [meld.tile, meld.tile, meld.tile] : [meld.tile, meld.tile, meld.tile, meld.tile];
    let x = startX;
    tiles.forEach((tileId, i) => {
      const tv = TileView.create(parent, tileId, MELD_W, MELD_H);
      // 暗杠第一张扣置
      tv.setFaceDown(meld.type === 'ankang' && i === 0);
      tv.node.setPosition(x + MELD_W / 2, 0);
      x += MELD_W + MELD_GAP;
    });
    return x + MELD_GROUP_GAP;
  }

  /** 自己的手牌 + 摸牌尾距 */
  private renderSelfHand(state: GameStateMsg): void {
    if (!this.handView) return;
    this.handView.setHand(state.hand ?? [], state.drewTile ?? null);
  }

  /** 状态条文本 */
  private renderStatus(state: GameStateMsg): void {
    const gm = GameManager.instance;
    const roomText = gm?.mode === 'pve' ? '本地单机' : `房间 ${gm?.roomState?.roomCode ?? '-'}`;
    let turnText: string;
    if (state.phase === 'over') {
      turnText = '本局结束';
    } else if (state.claimTile) {
      turnText = `宣告窗口: ${tileLabel(state.claimTile)}（来自 ${this.nameOf(state.claimFrom ?? -1)}）`;
    } else if (state.currentSeat === this.viewSeat) {
      turnText = '轮到你出牌';
    } else {
      turnText = `等待 ${this.nameOf(state.currentSeat)} 行动`;
    }
    this.setStatus(`${roomText} | ${turnText}`);
  }

  // —— 工具 ——

  /** 座位 → 相对位置（下/右/上/左） */
  private relSeat(seat: number): number {
    return (seat - this.viewSeat + 4) % 4;
  }

  /** 座位名（越界兜底） */
  private nameOf(seat: number): string {
    return this.seatNames[seat] ?? `座位${seat}`;
  }

  /** 直接子节点查找 */
  private findChild(root: Node, name: string): Node | null {
    for (const c of root.children) {
      if (c.name === name) return c;
    }
    return null;
  }

  /** 直接子节点上的 Label 查找 */
  private findLabel(root: Node, name: string): Label | null {
    const child = this.findChild(root, name);
    return child ? child.getComponent(Label) : null;
  }

  /** 子视图缺失兜底：程序化创建 HandView/ActionPanel/面板等容器 */
  private ensureSubviews(): void {
    if (!this.handView) {
      const node = new Node('HandArea');
      this.node.addChild(node);
      node.setPosition(0, -280);
      this.handView = node.addComponent(HandView);
    }
    if (this.handView) {
      this.handView.onDiscardRequest = (tileId) => this.onDiscardRequest(tileId);
    }
    if (!this.actionPanel) {
      const node = new Node('ActionPanel');
      this.node.addChild(node);
      node.setPosition(0, -160);
      this.actionPanel = node.addComponent(ActionPanel);
    }
    if (this.actionPanel) {
      this.actionPanel.onActionPicked = (opt) => this.onActionPicked(opt);
    }
    if (!this.settlePanel) {
      const node = new Node('SettlePanel');
      this.node.addChild(node);
      this.settlePanel = node.addComponent(SettlePanel);
    }
    if (!this.rulePanel) {
      const node = new Node('RulePanel');
      this.node.addChild(node);
      this.rulePanel = node.addComponent(RulePanel);
    }
    if (!this.wallCounter) {
      const node = new Node('WallCounter');
      this.node.addChild(node);
      node.setPosition(0, 300);
      this.wallCounter = node.addComponent(WallCounter);
    }
    if (!this.statusLabel) {
      const node = new Node('Status');
      this.node.addChild(node);
      node.setPosition(0, 330);
      const label = node.addComponent(Label);
      label.fontSize = 24;
      label.color = COLOR_IDLE;
      this.statusLabel = label;
    }
  }

  /** 绑定出牌/规则按钮（编辑器未绑定时程序化创建兜底按钮） */
  private bindButtons(): void {
    if (!this.btnDiscard) {
      this.btnDiscard = this.makeFallbackButton('BtnDiscard', '出牌', 430, -180);
    }
    if (this.btnDiscard) {
      this.btnDiscard.node.on(Button.EventType.CLICK, () => this.onDiscardButton());
    }
    if (!this.btnRule) {
      this.btnRule = this.makeFallbackButton('BtnRule', '规则', 560, 330);
    }
    if (this.btnRule) {
      this.btnRule.node.on(Button.EventType.CLICK, () => this.showRules());
    }
  }

  /** 程序化兜底按钮：UITransform 命中区 + Graphics 底 + Label 文本 + Button */
  private makeFallbackButton(name: string, text: string, x: number, y: number): Button {
    const node = new Node(name);
    const ut = node.addComponent(UITransform);
    ut.setContentSize(120, 52);
    node.setPosition(x, y);
    const g = node.addComponent(Graphics);
    g.fillColor = new Color(62, 92, 140, 255);
    g.roundRect(-60, -26, 120, 52, 10);
    g.fill();
    const labelNode = new Node('text');
    const lut = labelNode.addComponent(UITransform);
    lut.setContentSize(112, 44);
    const label = labelNode.addComponent(Label);
    label.fontSize = 26;
    label.overflow = Label.Overflow.SHRINK;
    label.horizontalAlign = Label.HorizontalAlign.CENTER;
    label.verticalAlign = Label.VerticalAlign.CENTER;
    label.color = COLOR_IDLE;
    label.string = text;
    node.addChild(labelNode);
    this.node.addChild(node);
    return node.addComponent(Button);
  }

  /** 状态条文本 */
  private setStatus(text: string): void {
    if (this.statusLabel) this.statusLabel.string = text;
  }
}
