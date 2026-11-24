/**
 * 牌桌主场景控制器：座位布局（下=自己/右=下家/上=对家/左=上家）、
 * 手牌/副露/弃牌河/牌墙/风位渲染、合法动作面板、触摸选牌出牌、结算面板、规则面板入口。
 * 数据统一来自 GameManager（联机 GameStateMsg 或 PVE 同构快照），动作经 GameManager 转发。
 */

import { _decorator, Button, Color, Component, Graphics, Label, Node, SpriteFrame, tween, UITransform, Vec3 } from 'cc';
import { SEAT_WIND_NAMES, tileLabel } from '@quejie/mahjong-core';
import type { GameEventMsg, GameOverMsg, GameStateMsg, LegalOption, MeldView } from '@quejie/protocol';
import { GameManager } from './GameManager';
import { HandView } from './HandView';
import { ActionPanel } from './ActionPanel';
import { SettlePanel } from './SettlePanel';
import { RulePanel } from './RulePanel';
import { WallCounter } from './WallCounter';
import { TileView, setTileFaceResolver } from './TileView';
import { loadTilePhotos } from './TilePhotos';
import { SoundManager } from './SoundManager';
import { Tips } from './ui/Tips';
import { addLabel, addScrollableText, addTextButton, drawModal, GOLD, MUTED, modalSize } from './ui/ModalText';

const { ccclass, property } = _decorator;

/** 座位相对位置约定：0=下(自己) 1=右(下家) 2=上(对家) 3=左(上家)，与 seatNodes 数组下标对应 */

/** 弃牌河网格参数 */
const DISCARD_COLS = 5;
const DISCARD_W = 28;
const DISCARD_H = 36;
const DISCARD_GAP = 2;

/** 副露参数 */
const MELD_W = 18;
const MELD_H = 25;
const MELD_GAP = 2;
const MELD_GROUP_GAP = 5;

/** 他人手牌背面参数 */
const BACK_W = 19;
const BACK_H = 26;
const SEAT_ANGLES = [0, 90, 180, -90] as const;

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
  private turnNeedle: Node | null = null;
  private dialCount: Label | null = null;
  private settlementButton: Button | null = null;
  private lastSettlement: GameOverMsg | null = null;
  private logPanel: Node | null = null;
  private oddsButton: Button | null = null;
  private oddsPanel: Node | null = null;
  private oddsDetails: Label | null = null;
  private scoreButton: Button | null = null;
  private logButton: Button | null = null;
  private homeButton: Button | null = null;
  private wallLabel: Label | null = null;
  private width = 1280;
  private height = 720;
  private centerY = 52;
  private actionY = -195;

  public layout(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.node.getComponent(UITransform)?.setContentSize(w, h);
    const portrait = h > w;
    const bottom = -h / 2;
    const top = h / 2;
    this.centerY = portrait ? 46 : 38;
    this.actionY = bottom + (portrait ? 220 : 151);
    const handX = portrait ? 42 : 38;
    const bankX = w / 2 - (portrait ? 39 : 53);
    const bankY = portrait ? 45 : 26;
    const oppositeY = top - 118;
    const handY = bottom + (portrait ? 106 : 67);
    const art = [
      { x: handX, y: handY, badge: [-w / 2 + (portrait ? 57 : 91), handY] },
      { x: bankX, y: bankY, badge: [bankX - 51, bankY - 177] },
      { x: portrait ? -42 : 0, y: oppositeY, badge: [portrait ? w / 2 - 90 : 240, oppositeY] },
      { x: -bankX, y: bankY, badge: [-bankX + 51, bankY + 177] },
    ];
    this.seatNodes.forEach((node, i) => {
      const place = art[i]!;
      node.setPosition(place.x, place.y);
      const identity = this.findChild(node, 'Identity');
      identity?.setPosition(place.badge[0]! - place.x, place.badge[1]! - place.y);
      identity?.setScale(portrait && i === 0 ? .68 : 1, 1);
      const meld = this.findChild(node, 'Melds');
      if (i === 0) meld?.setPosition(0, this.actionY - 31 - handY);
      else if (i === 2) meld?.setPosition(0, -30);
      else meld?.setPosition(i === 1 ? -27 : 27, 0);
      const river = this.findChild(node, 'Discards');
      river?.setPosition(-place.x, this.centerY - place.y);
    });
    this.handView?.node.setPosition(handX, handY);
    if (this.handView) {
      const scale = portrait ? .72 : .86;
      this.handView.node.setScale(scale, scale);
      this.handView.setCompact(portrait);
    }
    if (this.actionPanel) {
      this.actionPanel.availableWidth = w - 58;
      this.actionPanel.node.setPosition(0, this.actionY);
    }
    this.statusLabel?.node.setPosition(0, this.actionY + 41);
    this.oddsButton?.node.setPosition(0, this.actionY + 41);
    this.statusLabel?.node.getComponent(UITransform)?.setContentSize(w - 52, 35);
    this.turnNeedle?.parent?.setPosition(0, this.centerY);
    const buttons = [this.homeButton, this.btnRule, this.logButton, this.settlementButton, this.scoreButton];
    buttons.forEach((button, i) => {
      if (!button) return;
      const holder = button.node.parent;
      const control = holder?.name === 'TableControl' ? holder : button.node;
      control.setPosition(w / 2 - 62 - i * (portrait ? 80 : 113), top - 35);
      if (control === holder) control.setScale(portrait ? .73 : 1, 1);
    });
    const logLabel = this.logButton?.node.getComponentInChildren(Label);
    if (logLabel) logLabel.string = portrait ? '日志' : '对局日志';
    const settleLabel = this.settlementButton?.node.getComponentInChildren(Label);
    if (settleLabel) settleLabel.string = portrait ? '结算' : '本局结算';
    this.wallLabel?.node.setPosition(-w / 2 + (portrait ? 65 : 130), top - 35);
    if (this.wallLabel) this.wallLabel.node.getComponent(UITransform)?.setContentSize(portrait ? 118 : 240, 35);
    if (this.lastState) {
      this.lastState.seats.forEach((seat) => this.renderSeat(seat.seat, this.lastState!));
      this.pointToCurrentSeat(this.lastState);
      this.refreshActions();
      this.renderStatus(this.lastState);
    }
    this.settlePanel?.layout();
    this.rulePanel?.layout();
    if (this.logPanel?.active) this.openLog();
    if (this.oddsPanel) this.openOdds();
  }

  // —— 生命周期 ——

  protected override onLoad(): void {
    const gm = GameManager.ensureInstance();


    // 牌面图集注册（name → SpriteFrame）
    this.faceMap = new Map();
    for (const f of this.tileFaces) {
      if (f && f.name) this.faceMap.set(f.name, f);
    }
    const resolver = (tileId: string) => this.faceMap.get(tileId) ?? null;
    setTileFaceResolver(resolver);

    this.ensureSubviews();
    this.bindButtons();
    this.setStatus('等待开局…');
    gm.attachTable(this);
    void loadTilePhotos().then((frames) => {
      if (!this.isValid) return;
      for (const [id, frame] of frames) {
        if (!this.faceMap.has(id)) this.faceMap.set(id, frame);
      }
      for (const tile of this.node.getComponentsInChildren(TileView)) tile.refreshFace();
    }).catch(() => { /* 资源加载失败时保留文字牌面。 */ });
  }

  protected override onDestroy(): void {
    GameManager.instance?.detachTable(this);
  }

  protected override update(_dt: number): void {
    // 回合倒计时显示
    if (this.deadlineAt > 0 && this.statusLabel) {
      const remain = Math.ceil((this.deadlineAt - Date.now()) / 1000);
      if (remain <= 0) {
        this.deadlineAt = 0;
      } else if (this.lastState?.phase === 'turn' && this.lastState.currentSeat === this.viewSeat) {
        const instruction = GameManager.instance?.singleClick ? '点牌即可出牌' : '选牌后再点一次或按「出牌」';
        this.statusLabel.string = `${instruction} · ${remain}s`;
      }
    }
  }

  // —— 数据入口（GameManager 转发） ——

  /** 应用完整对局状态快照（联机 gameState / PVE 同构快照共用） */
  public applyGameState(state: GameStateMsg): void {
    this.lastState = state;
    this.viewSeat = state.viewSeat;
    this.seatNames = state.seats.map((s) => s.name);
    if (state.phase !== 'over' && this.lastSettlement) {
      this.lastSettlement = null;
      if (this.settlementButton) this.settlementButton.interactable = false;
      this.settlePanel?.hide();
    }

    // 新一手检测：余牌回增 → 重置进度条满刻度
    if (this.lastWallRemaining >= 0 && state.wallRemaining > this.lastWallRemaining) {
      this.maxWallSeen = state.wallRemaining;
    }
    this.maxWallSeen = Math.max(this.maxWallSeen, state.wallRemaining);
    this.lastWallRemaining = state.wallRemaining;

    const positions = state.seats.length === 2 ? [0, 2] : state.seats.length === 3 ? [0, 1, 3] : [0, 1, 2, 3];
    this.seatNodes.forEach((node, index) => { node.active = positions.includes(index); });
    // 座位与区域渲染
    for (const sv of state.seats) {
      this.renderSeat(sv.seat, state);
    }
    this.renderSelfHand(state);
    this.pointToCurrentSeat(state);
    if (this.dialCount) this.dialCount.string = String(Math.max(0, state.wallRemaining - state.deadWall));
    if (this.wallLabel) this.wallLabel.string = this.height > this.width ? `牌墙 ${state.wallRemaining}` : `牌墙 ${state.wallRemaining} 张 · 死墙 ${state.deadWall}`;

    // 牌墙进度
    if (this.wallCounter) {
      this.wallCounter.init(this.maxWallSeen);
      this.wallCounter.updateCount(state.wallRemaining, state.deadWall);
    }

    // 合法动作面板（动作列表驱动：非法动作绝不显示）
    this.refreshActions();
    if (this.btnDiscard) this.btnDiscard.node.active = state.legalOptions.some((option) => option.type === 'discard');

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
        this.announce(`${this.nameOf(evt.seat)} 碰 ${tileLabel(evt.tile)}`);
        break;
      case 'mingang':
        if (sound) sound.playGang();
        this.announce(`${this.nameOf(evt.seat)} 明杠 ${tileLabel(evt.tile)}`);
        break;
      case 'bugang':
        if (sound) sound.playGang();
        this.announce(`${this.nameOf(evt.seat)} 补杠 ${tileLabel(evt.tile)}`);
        break;
      case 'ankang':
        if (sound) sound.playGang();
        this.announce(`${this.nameOf(evt.seat)} 暗杠`);
        break;
      case 'kongScore':
        if (evt.to === this.viewSeat) Tips.show(`杠分 +${evt.amount}`);
        else if (evt.from === this.viewSeat) Tips.show(`杠分 -${evt.amount}`);
        break;
      case 'missLock':
        if (evt.seat === this.viewSeat) this.announce(`漏胡锁定：${tileLabel(evt.tile)}`);
        break;
      case 'hu':
        if (sound) sound.playHu();
        this.announce(`${this.nameOf(evt.seat)} 胡牌`);
        break;
      default:
        break;
    }
  }

  /** 显示结算面板（gameOver） */
  public showGameOver(over: GameOverMsg): void {
    this.lastSettlement = over;
    this.deadlineAt = 0;
    this.setStatus(over.outcome === 'win' ? '本局已结算' : '本局流局');
    if (this.turnNeedle) this.turnNeedle.active = false;
    if (this.settlementButton) this.settlementButton.interactable = true;
    if (this.btnDiscard) this.btnDiscard.node.active = false;
    this.actionPanel?.clear();
    if (over.outcome === 'win') this.openSettlement();
    SoundManager.instance?.playSettle();
  }

  private openSettlement(): void {
    if (!this.settlePanel || !this.lastSettlement) return;
    const gm = GameManager.instance;
    this.settlePanel.onBackToLobby = () => gm?.confirmLeave ? gm.confirmLeave() : gm?.leaveRoom();
    this.settlePanel.onContinue = gm ? () => {
      if (gm.mode === 'pve') gm.pveContinueNextHand();
      else gm.readyForNextHand();
    } : null;
    this.settlePanel.show(this.lastSettlement, this.viewSeat, this.seatNames);
  }

  private announce(message: string): void {
    Tips.show(message);
  }

  private openLog(): void {
    if (GameManager.instance?.openLogs) { GameManager.instance.openLogs(); return; }
    this.logPanel?.removeFromParent();
    this.logPanel?.destroy();
    const panel = new Node('GameLog');
    this.node.addChild(panel);
    this.logPanel = panel;
    const { width, height } = modalSize(panel);
    drawModal(panel, width, height);
    addLabel(panel, '对局日志', 0, height / 2 - 37, width - 58, 44, 29, GOLD);
    const { label, scroll } = addScrollableText(panel, width - 54, height - 150, -5);
    label.string = (GameManager.instance?.gameLog ?? []).slice(-18).reverse().join('\n') || '暂无对局记录。';
    label.updateRenderData(true);
    scroll.scrollToTop();
    const close = addTextButton(panel, '关闭日志', 0, -height / 2 + 39, 192, false, 44);
    close.node.on(Button.EventType.CLICK, () => { panel.active = false; });
  }

  private openOdds(): void {
    if (!this.lastState?.selfDrawOdds || this.lastState.phase === 'over') return;
    this.closeOdds();
    const panel = new Node('SelfDrawOdds');
    this.node.addChild(panel);
    this.oddsPanel = panel;
    const { width, height } = modalSize(panel);
    drawModal(panel, width, height);
    addLabel(panel, '听牌概率', 0, height / 2 - 37, width - 58, 44, 29, GOLD);
    const { label, scroll } = addScrollableText(panel, width - 54, height - 150, -5);
    this.oddsDetails = label;
    this.renderOddsDetails(this.lastState.selfDrawOdds);
    scroll.scrollToTop();
    const close = addTextButton(panel, '关闭', 0, -height / 2 + 39, 192, false, 44);
    close.node.on(Button.EventType.CLICK, () => this.closeOdds());
  }

  private closeOdds(): void {
    this.oddsPanel?.removeFromParent();
    this.oddsPanel?.destroy();
    this.oddsPanel = null;
    this.oddsDetails = null;
  }

  private renderOddsDetails(odds: NonNullable<GameStateMsg['selfDrawOdds']>): void {
    const label = this.oddsDetails;
    if (!label) return;
    const details = [
      `下次摸牌自摸  ${this.drawPercent(odds.nextDrawChance)}`,
      `预计流局前自摸  ${this.drawPercent(odds.selfDrawChance)}`,
      `预计还能摸牌  ${odds.drawsRemaining} 次`,
      '',
      ...odds.waiting.map(({ tile, unseenCopies }) => `听 ${tileLabel(tile)}  ·  未见 ${unseenCopies} 张`),
      '',
      '按自己的手牌和公开牌估算。未见牌包含他家暗牌与死墙。流局前概率按听口和摸牌顺序保持不变计算。',
    ].join('\n');
    if (label.string === details) return;
    label.string = details;
    label.updateRenderData(true);
  }

  private drawPercent(chance: number): string {
    return `${Math.round(chance * 1000) / 10}%`;
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
    if (opt.type === 'discard') { this.onDiscardButton(); return; }
    if (this.actionPanel) this.actionPanel.clear();
    gm.sendAction({ type: opt.type, tile: opt.tile });
  }

  private refreshActions(): void {
    const selected = this.handView?.selectedTile;
    this.actionPanel?.setOptions(this.lastState?.legalOptions ?? [], selected && this.isDiscardLegal(selected) ? selected : undefined);
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
    const identity = this.findChild(seatNode, 'Identity') ?? seatNode;
    const avatar = this.findLabel(identity, 'Avatar');
    if (avatar) avatar.string = sv.name.slice(0, 1);
    const nameLabel = this.findLabel(identity, 'Name');
    if (nameLabel) {
      const dealerMark = seat === state.dealer ? '〔庄〕' : '';
      const selfMark = seat === this.viewSeat ? '（你）' : '';
      nameLabel.string = `${sv.name}${selfMark}${dealerMark}`;
      nameLabel.color = seat === state.currentSeat && state.phase === 'turn' ? COLOR_CURRENT : COLOR_IDLE;
    }
    const windLabel = this.findLabel(seatNode, 'Wind');
    if (windLabel) {
      windLabel.string = SEAT_WIND_NAMES[seat] ?? '';
      // 当前行动者高亮
      windLabel.color = seat === state.currentSeat && state.phase === 'turn' ? COLOR_CURRENT : COLOR_IDLE;
    }
    const extraLabel = this.findLabel(identity, 'Extra');
    if (extraLabel) {
      const score = state.scores[seat] ?? 0;
      const tags: string[] = [`${sv.handCount} 张`, `分 ${score}`];
      if (sv.ai) tags.push('AI');
      if (!sv.connected && !sv.ai) tags.push('断线');
      extraLabel.string = tags.join(' · ');
    }

    // 副露
    const meldsNode = this.findChild(seatNode, 'Melds');
    if (meldsNode) {
      this.clearTiles(meldsNode);
      const length = sv.melds.reduce((total, meld) => total + (meld.type === 'peng' ? 3 : 4) * (MELD_W + MELD_GAP) + MELD_GROUP_GAP, 0);
      let x = -(length - MELD_GROUP_GAP) / 2;
      for (const meld of sv.melds) {
        x = this.renderMeld(meldsNode, meld, x, rel, state.phase === 'over' || seat === this.viewSeat);
      }
    }

    // 弃牌河
    const discardsNode = this.findChild(seatNode, 'Discards');
    if (discardsNode) {
      this.clearTiles(discardsNode);
      const columns = DISCARD_COLS;
      const portrait = this.height > this.width;
      const side = rel === 1 || rel === 3;
      const laneCount = Math.ceil(sv.discards.length / columns);
      const reach = side ? (portrait ? 123 : 355) : rel === 2
        ? this.height / 2 - this.centerY - 224 : this.centerY - this.actionY - 108;
      const scale = Math.min(portrait ? .75 : 1, reach / Math.max(DISCARD_H, laneCount * (DISCARD_H + DISCARD_GAP)));
      const w = DISCARD_W * scale;
      const h = DISCARD_H * scale;
      sv.discards.forEach((tileId, i) => {
        const lane = Math.floor(i / columns);
        const run = Math.min(columns, sv.discards.length - lane * columns);
        const across = (i % columns - (run - 1) / 2) * (w + DISCARD_GAP);
        const away = (side ? 56 : 54) + h / 2 + lane * (h + DISCARD_GAP);
        const tv = TileView.create(discardsNode, tileId, w, h);
        tv.node.angle = SEAT_ANGLES[rel]!;
        if (rel === 1) tv.node.setPosition(away, across);
        else if (rel === 2) tv.node.setPosition(-across, away);
        else if (rel === 3) tv.node.setPosition(-away, -across);
        else tv.node.setPosition(across, -away);
      });
    }

    // 他人手牌背面（自己不渲染背面，走底部 HandView）
    const handNode = this.findChild(seatNode, 'Hand');
    if (handNode) {
      this.clearTiles(handNode);
      if (seat !== this.viewSeat) {
        const revealed = state.phase === 'over' ? sv.revealedHand : undefined;
        for (let i = 0; i < sv.handCount; i++) {
          const face = revealed?.[i];
          const tv = TileView.create(handNode, face ?? 'back', BACK_W, BACK_H);
          tv.node.angle = SEAT_ANGLES[rel]!;
          tv.setFaceDown(!face);
          const spacing = BACK_W + 1;
          const centered = (i - (sv.handCount - 1) / 2) * spacing;
          if (rel === 1) tv.node.setPosition(0, centered);
          else if (rel === 3) tv.node.setPosition(0, -centered);
          else tv.node.setPosition(-centered, 0);
          if (face && !GameManager.instance?.reduceMotion && !this.lastSettlement) {
            tv.node.setScale(0.08, 1, 1);
            tween(tv.node).to(0.24, { scale: new Vec3(1, 1, 1) }).start();
          }
        }
        const handCountLabel = this.findLabel(seatNode, 'HandCount');
        if (handCountLabel) handCountLabel.string = `×${sv.handCount}`;
      }
    }
  }

  private clearTiles(parent: Node): void {
    for (const tile of [...parent.children]) {
      tile.removeFromParent();
      tile.destroy();
    }
  }

  /** 渲染一组副露（碰 3 张 / 杠 4 张；暗杠首张背面），返回下一个 x 起点 */
  private renderMeld(parent: Node, meld: MeldView, startX: number, rel: number, reveal: boolean): number {
    const tiles = meld.type === 'peng' ? [meld.tile, meld.tile, meld.tile] : [meld.tile, meld.tile, meld.tile, meld.tile];
    let x = startX;
    tiles.forEach((tileId) => {
      const tv = TileView.create(parent, tileId, MELD_W, MELD_H);
      tv.setFaceDown(!reveal && meld.type === 'ankang');
      tv.node.angle = SEAT_ANGLES[rel]!;
      if (rel === 1) tv.node.setPosition(0, x);
      else if (rel === 3) tv.node.setPosition(0, -x);
      else tv.node.setPosition((x + MELD_W / 2) * (rel === 2 ? -1 : 1), 0);
      x += MELD_W + MELD_GAP;
    });
    return x + MELD_GROUP_GAP;
  }

  /** 自己的手牌 + 摸牌尾距 */
  private renderSelfHand(state: GameStateMsg): void {
    if (!this.handView) return;
    this.handView.setHand(state.hand, state.phase === 'turn' && state.currentSeat === state.viewSeat ? state.drewTile : null);
  }

  private pointToCurrentSeat(state: GameStateMsg): void {
    if (!this.turnNeedle) return;
    const target = this.seatNodes[this.relSeat(state.currentSeat)];
    this.turnNeedle.active = state.phase === 'turn' && !!target;
    if (!target || !this.turnNeedle.active) return;
    const direction = target.position.clone().subtract(this.turnNeedle.parent!.position);
    this.turnNeedle.angle = Math.atan2(direction.y, direction.x) * 180 / Math.PI - 90;
  }

  /** 状态条文本 */
  private renderStatus(state: GameStateMsg): void {
    const odds = state.phase === 'over' ? undefined : state.selfDrawOdds;
    const showOdds = !!odds && state.legalOptions.length === 0;
    if (this.oddsButton) this.oddsButton.node.active = showOdds;
    if (this.statusLabel) this.statusLabel.node.active = !showOdds;
    if (odds) {
      const label = this.oddsButton?.node.getComponentInChildren(Label);
      if (label) label.string = `听牌 · 下次自摸 ${this.drawPercent(odds.nextDrawChance)}`;
      this.renderOddsDetails(odds);
    } else {
      this.closeOdds();
    }
    let turnText: string;
    if (state.phase === 'over') {
      turnText = '本局结束';
    } else if (state.claimTile) {
      turnText = `${tileLabel(state.claimTile)} · ${state.legalOptions.length ? '请选择响应' : '等待其他玩家响应'}`;
    } else if (state.currentSeat === this.viewSeat) {
      turnText = GameManager.instance?.singleClick ? '点选手牌即可出牌' : '选一张手牌，再点一次或按「出牌」';
    } else {
      turnText = `等待 ${this.nameOf(state.currentSeat)} 行动`;
    }
    this.setStatus(turnText);
    if (this.wallLabel) this.wallLabel.string = this.height > this.width ? `牌墙 ${state.wallRemaining}` : `牌墙 ${state.wallRemaining} 张 · 死墙 ${state.deadWall}`;
  }

  // —— 工具 ——

  /** 座位 → 相对位置（下/右/上/左） */
  private relSeat(seat: number): number {
    const count = this.lastState?.seats.length ?? 4;
    const offset = (seat - this.viewSeat + count) % count;
    const positions = count === 2 ? [0, 2] : count === 3 ? [0, 1, 3] : [0, 1, 2, 3];
    return positions[offset]!;
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
      this.handView.canSelect = (tileId) => this.isDiscardLegal(tileId);
      this.handView.directDiscard = () => GameManager.instance?.singleClick ?? false;
      this.handView.onSelectionChanged = () => this.refreshActions();
    }
    if (!this.actionPanel) {
      const node = new Node('ActionPanel');
      this.node.addChild(node);
      node.setPosition(0, -198);
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
    if (!this.wallCounter) this.wallLabel = addLabel(this.node, '', -500, 320, 240, 35, 20, MUTED);
    if (!this.statusLabel) {
      this.statusLabel = addLabel(this.node, '', 0, -164, 640, 35, 23, GOLD);
    }
    this.makeTurnDial();
  }

  private makeTurnDial(): void {
    const dial = new Node('TurnDial');
    this.node.addChild(dial);
    dial.setPosition(0, 56);
    dial.addComponent(UITransform).setContentSize(84, 84);
    const ring = dial.addComponent(Graphics);
    ring.fillColor = new Color(16, 45, 37);
    ring.strokeColor = new Color(186, 150, 88);
    ring.lineWidth = 2;
    ring.circle(0, 0, 40);
    ring.fill();
    ring.stroke();
    const counter = new Node('WallCount');
    dial.addChild(counter);
    counter.addComponent(UITransform).setContentSize(56, 42);
    const label = counter.addComponent(Label);
    label.fontSize = 26;
    label.horizontalAlign = Label.HorizontalAlign.CENTER;
    label.verticalAlign = Label.VerticalAlign.CENTER;
    label.color = new Color(174, 241, 231);
    this.dialCount = label;
    const needle = new Node('Needle');
    dial.addChild(needle);
    needle.addComponent(UITransform);
    const arrow = needle.addComponent(Graphics);
    arrow.fillColor = COLOR_CURRENT;
    arrow.moveTo(0, 52);
    arrow.lineTo(12, 35);
    arrow.lineTo(5, 35);
    arrow.lineTo(5, 28);
    arrow.lineTo(-5, 28);
    arrow.lineTo(-5, 35);
    arrow.lineTo(-12, 35);
    arrow.close();
    arrow.fill();
    needle.active = false;
    this.turnNeedle = needle;
  }

  /** 绑定出牌/规则按钮（编辑器未绑定时程序化创建兜底按钮） */
  private bindButtons(): void {
    this.oddsButton = addTextButton(this.node, '', 0, this.actionY + 41, 255, false, 38);
    this.oddsButton.node.active = false;
    this.oddsButton.node.on(Button.EventType.CLICK, () => this.openOdds());
    if (this.btnDiscard) {
      this.btnDiscard.node.on(Button.EventType.CLICK, () => this.onDiscardButton());
    }
    if (!this.btnRule) {
      this.btnRule = this.addHeaderButton('设置');
    }
    if (this.btnRule) {
      this.btnRule.node.on(Button.EventType.CLICK, () => {
        if (GameManager.instance?.openSettings) GameManager.instance.openSettings();
        else this.showRules();
      });
    }
    this.homeButton = this.addHeaderButton('返回');
    this.homeButton.node.on(Button.EventType.CLICK, () => {
      const gm = GameManager.instance;
      if (gm?.phase === 'settle' && gm.mode === 'online') gm.returnToRoom();
      else if (gm?.confirmLeave) gm.confirmLeave();
      else gm?.leaveRoom();
    });
    this.scoreButton = this.addHeaderButton('战绩', true);
    this.scoreButton.node.on(Button.EventType.CLICK, () => GameManager.instance?.openHistory?.());
    this.logButton = this.addHeaderButton('对局日志');
    this.logButton.node.on(Button.EventType.CLICK, () => this.openLog());
    this.settlementButton = this.addHeaderButton('本局结算');
    this.settlementButton.node.on(Button.EventType.CLICK, () => this.openSettlement());
    this.settlementButton.interactable = false;
  }

  private addHeaderButton(text: string, primary = false): Button {
    const holder = new Node('TableControl');
    this.node.addChild(holder);
    return addTextButton(holder, text, 0, 0, 104, primary, 43);
  }

  /** 状态条文本 */
  private setStatus(text: string): void {
    if (this.statusLabel) this.statusLabel.string = text;
  }
}
