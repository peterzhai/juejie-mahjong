import { autoDisableUnmetFans, clonePreset, defaultFanConfig, resolveFanConfig, TILE_SET_PRESETS, type FanConfig } from '@quejie/fan-config';
import {
  _decorator, Button, Color, Component, EditBox, Graphics, Label, macro, Node,
  ResolutionPolicy, resources, screen, Sprite, SpriteFrame, sys, Texture2D, UITransform, view,
} from 'cc';
import { GameManager } from './GameManager';
import { TableScene } from './TableScene';
import { addLabel, addScrollableText, addTextButton, card, drawModal, GOLD, MUTED, TEXT } from './ui/ModalText';
import { Tips } from './ui/Tips';

const { ccclass } = _decorator;
const BACKGROUND = new Color(13, 29, 25);
const INSET = new Color(14, 35, 28);
const FELT = new Color(24, 70, 60);
const presets = Object.keys(TILE_SET_PRESETS);
const levels = ['easy', 'normal', 'hard'] as const;
const caps = ['3 番', '5 番', '分档 3/4/5 番', '动态封顶', '不封顶'] as const;
const redModes = ['wild', 'normal', 'off'] as const;
const redNames = { wild: '红中变', normal: '普通红中', off: '关闭红中变' };
type ScreenName = 'Lobby' | 'Room' | 'Table';
type Overlay = 'rules' | 'controls' | 'advanced' | 'json' | 'fans' | 'history' | 'logs' | 'leave';

interface Preferences {
  preset: string;
  playerCount: number;
  allowDiscardHu: boolean;
  difficulty: (typeof levels)[number];
  cap: (typeof caps)[number];
  redMode: (typeof redModes)[number];
  redDrawOnly: boolean;
  aiDelay: number;
  singleClick: boolean;
  reduceMotion: boolean;
  autoPlay: boolean;
  config: FanConfig | null;
  fans: Record<string, { enabled: boolean; value: number }>;
  serverUrl: string;
  nickname: string;
}

function next<T>(options: readonly T[], current: T): T {
  return options[(options.indexOf(current) + 1) % options.length]!;
}

@ccclass('ClientBootstrap')
export class ClientBootstrap extends Component {
  private page: Node | null = null;
  private overlay: Node | null = null;
  private currentPage: ScreenName = 'Lobby';
  private currentOverlay: Overlay | null = null;
  private tableView: TableScene | null = null;
  private gm!: GameManager;
  private width = 1280;
  private height = 720;
  private portrait = false;
  private boardPhoto: SpriteFrame | null = null;
  private lobbyRules: Label | null = null;
  private roomCode = '';
  private jsonDraft = '';
  private configError = '';
  private fanPage = 0;
  private logPage = 0;
  private editFields: { name?: EditBox; code?: EditBox; server?: EditBox; json?: EditBox } = {};
  private prefs: Preferences = {
    preset: 'gd128', playerCount: 4, allowDiscardHu: false, difficulty: 'normal', cap: '3 番',
    redMode: 'wild', redDrawOnly: false, aiDelay: 600, singleClick: false, reduceMotion: false, autoPlay: false,
    config: null, fans: {}, serverUrl: '', nickname: '玩家',
  };

  protected override start(): void {
    this.gm = GameManager.ensureInstance();
    const hostname = typeof location !== 'undefined' && location.hostname;
    this.prefs.serverUrl = hostname
      ? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${hostname}:8080`
      : this.gm.serverUrl;
    this.restore();
    this.persist();
    this.gm.navigate = (page) => this.showPage(page);
    this.gm.openSettings = () => this.showOverlay('rules');
    this.gm.openHistory = () => this.showOverlay('history');
    this.gm.openLogs = () => this.showLogs();
    this.gm.confirmLeave = () => this.showOverlay('leave');
    view.setOrientation(macro.ORIENTATION_AUTO);
    view.resizeWithBrowserSize(true);
    screen.on('window-resize', this.reflow, this);
    screen.on('orientation-change', this.reflow, this);
    this.reflow();
    resources.load('mahjong-table/texture', Texture2D, (error, texture) => {
      if (error || !texture || !this.isValid) return;
      const photo = new SpriteFrame();
      photo.texture = texture;
      this.boardPhoto = photo;
      if (this.currentPage === 'Lobby' && !this.currentOverlay) {
        this.captureFields();
        this.showPage('Lobby');
      }
    });
  }

  protected override onDestroy(): void {
    screen.off('window-resize', this.reflow, this);
    screen.off('orientation-change', this.reflow, this);
    if (this.gm?.isValid) {
      this.gm.navigate = this.gm.openSettings = this.gm.openHistory = this.gm.openLogs = this.gm.confirmLeave = null;
    }
  }

  private reflow(): void {
    const size = screen.windowSize;
    const portrait = size.height > size.width;
    const width = portrait ? 540 : Math.max(1120, Math.min(1580, Math.round(size.width / Math.max(1, size.height) * 720)));
    const height = portrait ? Math.max(920, Math.min(1160, Math.round(size.height / Math.max(1, size.width) * width))) : 720;
    if (this.page && width === this.width && height === this.height) return;
    this.captureFields();
    const open = this.currentOverlay;
    this.portrait = portrait;
    this.width = width;
    this.height = height;
    view.setDesignResolutionSize(width, height, ResolutionPolicy.SHOW_ALL);
    if (this.tableView && this.page) {
      this.paintPage(this.page);
      this.tableView.layout(width, height);
      if (open) this.showOverlay(open);
    } else {
      this.showPage(this.currentPage);
      if (open) this.showOverlay(open);
    }
  }

  private captureFields(): void {
    const { name, code, server, json } = this.editFields;
    if (name?.isValid) this.prefs.nickname = name.string;
    if (code?.isValid) this.roomCode = code.string;
    if (server?.isValid) this.prefs.serverUrl = server.string;
    if (json?.isValid) this.jsonDraft = json.string;
  }

  private showPage(name: ScreenName): void {
    this.closeOverlay();
    if (this.tableView) this.gm.detachTable(this.tableView);
    this.tableView = null;
    if (this.page) {
      this.page.removeFromParent();
      this.page.destroy();
    }
    this.editFields = {};
    this.lobbyRules = null;
    this.currentPage = name;
    const page = new Node(name);
    this.node.addChild(page);
    this.page = page;
    this.paintPage(page);
    if (name === 'Lobby') this.lobby(page);
    else if (name === 'Room') this.room(page);
    else this.table(page);
  }

  private paintPage(page: Node): void {
    const { width: w, height: h } = this;
    (page.getComponent(UITransform) ?? page.addComponent(UITransform)).setContentSize(w, h);
    const paint = page.getComponent(Graphics) ?? page.addComponent(Graphics);
    paint.clear();
    paint.fillColor = BACKGROUND;
    paint.rect(-w / 2, -h / 2, w, h);
    paint.fill();
    if (this.currentPage === 'Table') {
      paint.fillColor = FELT;
      paint.strokeColor = new Color(160, 134, 87);
      paint.lineWidth = 2;
      paint.roundRect(-w / 2 + 12, -h / 2 + 14, w - 24, h - 86, 20);
      paint.fill();
      paint.stroke();
    }
  }

  private button(parent: Node, text: string, x: number, y: number, w: number, click: () => void, primary = false, height = 48): Button {
    const button = addTextButton(parent, text, x, y, w, primary, height);
    button.node.on(Button.EventType.CLICK, click);
    return button;
  }

  private lobby(page: Node): void {
    const w = this.portrait ? this.width - 36 : Math.min(this.width - 92, 1160);
    const top = this.height / 2;
    const heroHeight = this.portrait ? 245 : 254;
    const heroY = top - 66 - heroHeight / 2;
    const hero = card(page, 'Hero', 0, heroY, w, heroHeight, FELT);
    if (this.boardPhoto) {
      const artwork = new Node('Mahjong photo');
      hero.addChild(artwork);
      artwork.setPosition(w * .21, 0);
      artwork.addComponent(UITransform).setContentSize(w * .57 - 8, heroHeight - 8);
      const sprite = artwork.addComponent(Sprite);
      sprite.sizeMode = Sprite.SizeMode.CUSTOM;
      sprite.spriteFrame = this.boardPhoto;
    }
    const textW = this.portrait ? w * .4 : w * .44;
    const title = this.portrait ? '雀界\n广东麻将' : '雀界 · 广东麻将';
    const subtitle = this.portrait ? '好友房 · 单机练习' : '红中变 · 好友房 · 单机练习';
    addLabel(hero, title, -w * .28, 18, textW, 96, this.portrait ? 32 : 48, GOLD);
    addLabel(hero, subtitle, -w * .28, -52, textW, 40, 19, TEXT);
    this.button(page, '玩法设置', w / 2 - 70, top - 31, 140, () => this.showOverlay('rules'), false, 40);
    this.button(page, '对局日志', w / 2 - 210, top - 31, 130, () => this.showLogs(), false, 40);

    const fieldsY = heroY - heroHeight / 2 - 64;
    const fields = card(page, '开局信息', 0, fieldsY, w, 104);
    const fieldW = (w - 55) / 2;
    addLabel(fields, '玩家昵称', -w / 4, 30, fieldW, 25, 19, MUTED, true);
    addLabel(fields, '牌组和封顶', w / 4, 30, fieldW, 25, 19, MUTED, true);
    this.editFields.name = this.edit(fields, '玩家昵称', this.prefs.nickname, -w / 4, -13, fieldW, 46, 20);
    const ruleButton = this.button(fields, `${this.prefs.preset} · ${this.prefs.cap}`, w / 4, -13, fieldW, () => this.showOverlay('rules'));
    this.lobbyRules = ruleButton.node.getComponentInChildren(Label);

    const descriptions = [
      { name: '单机练习', detail: '与 AI 对局', action: '开始练习', click: () => this.startMatch(false) },
      { name: '好友开桌', detail: '创建房间后分享房间号', action: '创建房间', click: () => this.startMatch(true) },
      { name: '加入好友', detail: this.portrait ? '输入 4 位房间号' : '输入好友的 4 位房间号', action: '加入房间', click: () => this.joinRoom() },
    ];
    const actionW = this.portrait ? w : (w - 24) / 3;
    descriptions.forEach((item, i) => {
      const x = this.portrait ? 0 : (i - 1) * (actionW + 12);
      const y = fieldsY - (this.portrait ? 124 + i * 120 : 156);
      const action = card(page, item.name, x, y, actionW, this.portrait ? 108 : 176, i === 0 ? new Color(43, 53, 41) : INSET);
      const side = this.portrait ? -actionW / 4 : 0;
      addLabel(action, item.name, side, this.portrait ? 18 : 54, this.portrait ? actionW / 2 - 24 : actionW - 30, 38, 26, i === 0 ? GOLD : TEXT);
      addLabel(action, item.detail, side, this.portrait ? -20 : 20, this.portrait ? actionW / 2 - 22 : actionW - 30, 28, 17, MUTED);
      if (i === 2) {
        const inputW = this.portrait ? 116 : actionW / 2 - 34;
        const inputX = this.portrait ? 8 : -actionW / 4 + 9;
        this.editFields.code = this.edit(action, '房间号', this.roomCode, inputX, this.portrait ? 0 : -44, inputW, 46, 20);
        this.editFields.code.maxLength = 4;
        this.editFields.code.inputMode = EditBox.InputMode.NUMERIC;
        this.editFields.code.node.on(EditBox.EventType.EDITING_RETURN, () => this.joinRoom());
        this.button(action, item.action, this.portrait ? actionW / 2 - 73 : actionW / 4 - 10, this.portrait ? 0 : -44, this.portrait ? 124 : actionW / 2 - 28, item.click);
      } else {
        this.button(action, item.action, this.portrait ? actionW / 4 : 0, this.portrait ? 0 : -42, this.portrait ? 204 : actionW - 36, item.click, i === 0);
      }
    });
  }

  private startMatch(online: boolean): void {
    this.captureFields();
    if (online && !this.useServer()) return;
    const config = this.prefs.config ?? this.quickConfig();
    try {
      const result = resolveFanConfig(config);
      if (!result.ok) {
        Tips.show(result.errors[0]?.message ?? '规则配置有误');
        return;
      }
    } catch {
      Tips.show('规则配置有误，请检查高级规则');
      return;
    }
    this.persist();
    this.gm.customConfig = config;
    if (online) this.gm.uiCreateRoom();
    else this.gm.enterLocalPve(this.prefs.preset, this.prefs.difficulty);
  }

  private joinRoom(): void {
    this.captureFields();
    if (!/^\d{4}$/.test(this.roomCode.trim())) { Tips.show('请输入 4 位房间号'); return; }
    if (!this.useServer()) return;
    this.persist();
    this.gm.joinRoom(this.roomCode);
  }

  private useServer(): boolean {
    if (!/^wss?:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(this.prefs.serverUrl.trim())) {
      Tips.show('请在「操作与联机」中填写 ws:// 或 wss:// 地址');
      return false;
    }
    return true;
  }

  private room(page: Node): void {
    const state = this.gm.roomState;
    if (!state) return;
    const w = this.portrait ? this.width - 36 : 950;
    const top = this.height / 2;
    this.button(page, '离开房间', w / 2 - 80, top - 32, 160, () => this.showOverlay('leave'), false, 40);
    this.button(page, '房间战绩', -w / 2 + 80, top - 32, 160, () => this.showOverlay('history'), false, 40);
    const hero = card(page, '房间信息', 0, top - 153, w, 168);
    addLabel(hero, `房间 ${state.roomCode}`, 0, 30, w - 36, 58, 38, GOLD);
    const summary = state.rulesSummary;
    addLabel(hero, `${summary.presetId} · ${summary.totalTiles} 张 · ${summary.capDesc} · ${summary.allowDiscardHu === false ? '不点炮' : '可点炮'}`, 0, -20, w - 44, 39, 21, MUTED);
    this.button(hero, '复制房间号', 0, -57, 163, () => this.gm.copyRoomCode(), false, 35);
    const col = this.portrait ? 1 : 2;
    const playerW = (w - (col - 1) * 14) / col;
    state.players.forEach((player, i) => {
      const occupied = player.connected || player.ai;
      const status = player.name === '空位' ? '等待加入' : player.ai ? '电脑玩家' : !occupied ? '已断线' : player.ready ? '已准备' : '未准备';
      const note = player.seat === this.gm.mySeat && occupied ? '（你）' : '';
      const row = card(page, '玩家席位', col === 1 ? 0 : (i % 2 === 0 ? -1 : 1) * (playerW + 14) / 2, top - 303 - Math.floor(i / col) * 84, playerW, 72);
      const avatar = card(row, '头像', -playerW / 2 + 42, 0, 47, 47, INSET);
      addLabel(avatar, player.name.slice(0, 1), 0, 0, 40, 40, 26, GOLD);
      addLabel(row, `${player.name}${note}`, -8, 0, playerW - 205, 42, 25, TEXT, true);
      addLabel(row, status, playerW / 2 - 69, 0, 112, 33, 19, MUTED);
    });
    const footerY = top - 316 - Math.ceil(state.players.length / col) * 84;
    const ready = this.button(page, '准备', -w / 4, footerY, w / 2 - 10, () => this.gm.ready(), true);
    const mine = state.players.find((player) => player.seat === this.gm.mySeat);
    if (mine?.ready) {
      ready.interactable = false;
      ready.node.getComponentInChildren(Label)!.string = '已准备';
    }
    this.button(page, '填充 AI 并开局', w / 4, footerY, w / 2 - 10, () => this.gm.startWithAi());
  }

  private table(page: Node): void {
    const root = new Node('TableRoot');
    root.active = false;
    page.addChild(root);
    root.addComponent(UITransform).setContentSize(this.width, this.height);
    const controller = root.addComponent(TableScene);
    for (let i = 0; i < 4; i++) {
      const seat = new Node(`Seat${i}`);
      root.addChild(seat);
      const identity = card(seat, 'Identity', 0, 0, 154, 49, INSET);
      const initials = addLabel(identity, '', -51, 0, 36, 36, 27, GOLD);
      initials.node.name = 'Avatar';
      const name = addLabel(identity, '', 19, 8, 108, 24, 19, TEXT, true);
      name.node.name = 'Name';
      const detail = addLabel(identity, '', 19, -13, 108, 20, 15, MUTED, true);
      detail.node.name = 'Extra';
      for (const regionName of ['Hand', 'Melds', 'Discards']) seat.addChild(new Node(regionName));
      controller.seatNodes.push(seat);
    }
    this.tableView = controller;
    root.active = true;
    controller.layout(this.width, this.height);
  }

  private edit(parent: Node, placeholder: string, value: string, x: number, y: number, w: number, h: number, font: number, multiline = false): EditBox {
    const node = card(parent, placeholder, x, y, w, h, INSET);
    const text = addLabel(node, '', 0, 0, w - 20, h - 12, font, TEXT, true);
    const hint = addLabel(node, placeholder, 0, 0, w - 20, h - 12, font, MUTED, true);
    if (multiline) {
      text.overflow = hint.overflow = Label.Overflow.CLAMP;
      text.verticalAlign = hint.verticalAlign = Label.VerticalAlign.TOP;
    }
    const edit = node.addComponent(EditBox);
    edit.inputMode = multiline ? EditBox.InputMode.ANY : EditBox.InputMode.SINGLE_LINE;
    edit.maxLength = multiline ? -1 : 220;
    edit.textLabel = text;
    edit.placeholderLabel = hint;
    edit.placeholder = placeholder;
    edit.string = value;
    for (const child of [...node.children]) {
      if (child.name === 'TEXT_LABEL' || child.name === 'PLACEHOLDER_LABEL') child.destroy();
    }
    return edit;
  }

  private showOverlay(kind: Overlay): void {
    this.captureFields();
    this.closeOverlay();
    this.currentOverlay = kind;
    const overlay = new Node(kind);
    this.node.addChild(overlay);
    this.overlay = overlay;
    const w = Math.min(this.width - 32, 788);
    const h = kind === 'leave' ? 248 : this.portrait ? 700 : 610;
    drawModal(overlay, w, h, this.width, this.height);
    const titles: Record<Overlay, string> = {
      rules: '牌局设置', controls: '牌局设置', advanced: '牌局设置', json: '完整规则配置',
      fans: '番型与附加番', history: this.gm.mode === 'pve' ? '单机战绩' : '房间战绩',
      logs: '对局日志', leave: '离开房间？',
    };
    addLabel(overlay, titles[kind], -26, h / 2 - 42, w - 158, 48, 30, GOLD);
    this.button(overlay, '关闭', w / 2 - 58, h / 2 - 42, 90, () => this.closeOverlay(), false, 37);
    if (kind === 'history') this.textOverlay(overlay, this.historyText(), w, h);
    else if (kind === 'logs') this.renderLogs(overlay, w, h);
    else if (kind === 'leave') {
      addLabel(overlay, '离开后将返回大厅。', 0, 0, w - 56, 42, 23, MUTED);
      this.button(overlay, '取消', -w / 4, -73, w / 2 - 24, () => this.closeOverlay());
      this.button(overlay, '确认离开', w / 4, -73, w / 2 - 24, () => this.gm.leaveRoom(), true);
    } else if (kind === 'json') this.jsonEditor(overlay, w, h);
    else if (kind === 'fans') this.fanEditor(overlay, w, h);
    else this.settings(overlay, kind, w, h);
  }

  private closeOverlay(): void {
    if (this.overlay) {
      this.captureFields();
      this.overlay.removeFromParent();
      this.overlay.destroy();
    }
    delete this.editFields.server;
    delete this.editFields.json;
    this.overlay = null;
    this.currentOverlay = null;
  }

  private textOverlay(root: Node, content: string, w: number, h: number): void {
    const { label, scroll } = addScrollableText(root, w - 44, h - 126, -18);
    label.string = content;
    label.updateRenderData(true);
    scroll.scrollToTop();
  }

  private showLogs(): void {
    this.logPage = 0;
    this.showOverlay('logs');
  }

  private renderLogs(root: Node, w: number, h: number): void {
    const perPage = 18;
    const pages = Math.max(1, Math.ceil(this.gm.gameLog.length / perPage));
    const start = this.logPage * perPage;
    const lines = [...this.gm.gameLog].reverse().slice(start, start + perPage);
    this.textOverlay(root, lines.join('\n') || '暂无对局记录。', w, h - 100);
    if (pages === 1) return;
    const y = -h / 2 + 42;
    addLabel(root, `${this.logPage + 1} / ${pages}`, 0, y, 113, 38, 20, MUTED);
    const newer = this.button(root, '较新记录', -w / 4, y, w / 3 - 12, () => { this.logPage--; this.showOverlay('logs'); });
    newer.interactable = this.logPage > 0;
    const older = this.button(root, '更早记录', w / 4, y, w / 3 - 12, () => { this.logPage++; this.showOverlay('logs'); });
    older.interactable = this.logPage < pages - 1;
  }

  private historyText(): string {
    const names = this.gm.matchNames;
    const history = this.gm.handHistory;
    const totals = history.at(-1)?.scores ?? this.gm.lastGameState?.scores ?? [];
    const signed = (score: number) => score > 0 ? `+${score}` : String(score);
    const lines = [`${this.gm.roomState ? `房间 ${this.gm.roomState.roomCode} · ` : ''}已结算 ${history.length} 局`, '', '累计分'];
    lines.push(names.map((name, i) => `${name} ${signed(totals[i] ?? 0)}`).join('   /   '));
    if (!history.length) lines.push('', '暂无结算记录。');
    for (const hand of [...history].reverse()) {
      const result = hand.outcome === 'draw' ? '流局' : `${hand.winnerSeats.map((i) => names[i] ?? `座位 ${i + 1}`).join('、')} 胡牌`;
      lines.push('', `第 ${hand.hand} 局 · ${result}`, names.map((name, i) => `${name} ${signed(hand.deltas[i] ?? 0)}`).join('   /   '));
    }
    return lines.join('\n');
  }

  private settings(root: Node, tab: 'rules' | 'controls' | 'advanced', w: number, h: number): void {
    const tabs = [['rules', '开局规则'], ['controls', '操作与联机'], ['advanced', '高级规则']] as const;
    tabs.forEach(([key, label], i) => this.button(root, label, (i - 1) * (w / 3 - 10), h / 2 - 99, w / 3 - 18, () => this.showOverlay(key), tab === key, 42));
    const y = h / 2 - 166;
    const toggle = (name: string, value: string, index: number, change: () => void) => {
      const fieldW = w / 2 - 26;
      const fieldX = (index % 2 === 0 ? -1 : 1) * w / 4;
      const fieldY = y - Math.floor(index / 2) * 80;
      addLabel(root, name, fieldX, fieldY, fieldW, 25, 19, MUTED, true);
      this.button(root, value, fieldX, fieldY - 34, fieldW, () => { change(); this.persist(); this.showOverlay(tab); }, false, 42);
    };
    if (tab === 'rules') {
      toggle('人数', `${this.prefs.playerCount} 人`, 0, () => { this.prefs.playerCount = next([2, 3, 4], this.prefs.playerCount); });
      toggle('牌组', this.prefs.preset, 1, () => { this.prefs.preset = next(presets, this.prefs.preset); });
      toggle('封顶番数', this.prefs.cap, 2, () => { this.prefs.cap = next(caps, this.prefs.cap); });
      toggle('红中模式', redNames[this.prefs.redMode], 3, () => { this.prefs.redMode = next(redModes, this.prefs.redMode); });
      toggle('禁止点炮胡', this.prefs.allowDiscardHu ? '关' : '开', 4, () => { this.prefs.allowDiscardHu = !this.prefs.allowDiscardHu; });
      toggle('红中变仅自摸', this.prefs.redDrawOnly ? '开' : '关', 5, () => { this.prefs.redDrawOnly = !this.prefs.redDrawOnly; });
      addLabel(root, TILE_SET_PRESETS[this.prefs.preset]?.description ?? '', 0, y - 260, w - 48, 34, 18, MUTED);
      addLabel(root, this.prefs.config ? '当前使用高级规则中的完整配置' : '创建房间或开始练习时生效', 0, y - 294, w - 48, 28, 17, MUTED);
    } else if (tab === 'controls') {
      toggle('单机 AI 难度', ['简单', '普通', '困难'][levels.indexOf(this.prefs.difficulty)]!, 0, () => { this.prefs.difficulty = next(levels, this.prefs.difficulty); });
      toggle('AI 出牌间隔', `${this.prefs.aiDelay} ms`, 1, () => { this.prefs.aiDelay = next([150, 600, 1200], this.prefs.aiDelay); });
      toggle('单击直接出牌', this.prefs.singleClick ? '开' : '关', 2, () => { this.prefs.singleClick = !this.prefs.singleClick; });
      toggle('减少动态效果', this.prefs.reduceMotion ? '开' : '关', 3, () => { this.prefs.reduceMotion = !this.prefs.reduceMotion; });
      toggle('自动托管本机', this.prefs.autoPlay ? '开' : '关', 4, () => { this.prefs.autoPlay = !this.prefs.autoPlay; });
      addLabel(root, 'WebSocket 联机地址', 0, y - 241, w - 48, 29, 19, MUTED, true);
      this.editFields.server = this.edit(root, 'ws:// 或 wss://', this.prefs.serverUrl, 0, y - 279, w - 48, 49, 23);
    } else {
      this.button(root, '番型与附加番', 0, y - 34, w - 64, () => { this.fanPage = 0; this.showOverlay('fans'); });
      this.button(root, '完整规则配置', 0, y - 96, w - 64, () => {
        this.jsonDraft = JSON.stringify(this.prefs.config ?? this.quickConfig(), null, 2);
        this.configError = '';
        this.showOverlay('json');
      });
      addLabel(root, this.prefs.config ? '已启用完整配置' : '完整配置保存后优先于快捷选项', 0, y - 148, w - 52, 35, 20, MUTED);
      if (this.tableView) this.button(root, '查看本桌规则', 0, y - 214, w - 64, () => { this.closeOverlay(); this.tableView?.showRules(); });
    }
    this.button(root, '完成', 0, -h / 2 + 39, 180, () => { this.captureFields(); this.persist(); this.closeOverlay(); }, true);
  }

  private jsonEditor(root: Node, w: number, h: number): void {
    this.editFields.json = this.edit(root, '输入规则 JSON', this.jsonDraft, 0, -2, w - 44, h - 218, 18, true);
    addLabel(root, this.configError || '可修改牌张、番型、杠分与包牌规则', 0, -h / 2 + 99, w - 42, 48, 18, MUTED);
    const bw = w / 3 - 20;
    this.button(root, '返回', -w / 3 + 12, -h / 2 + 42, bw, () => this.showOverlay('advanced'));
    this.button(root, '恢复快捷配置', 0, -h / 2 + 42, bw, () => { this.prefs.config = null; this.persist(); this.showOverlay('advanced'); });
    this.button(root, '校验并保存', w / 3 - 12, -h / 2 + 42, bw, () => {
      this.captureFields();
      try {
        const config = JSON.parse(this.jsonDraft) as FanConfig;
        const result = resolveFanConfig(config);
        if (!result.ok) {
          this.configError = result.errors[0]?.message ?? '规则配置有误';
          this.showOverlay('json');
          return;
        }
        this.prefs.config = config;
        this.persist();
        this.showOverlay('advanced');
      } catch {
        this.configError = '无法读取规则配置，请检查 JSON 和必填字段';
        this.showOverlay('json');
      }
    }, true);
  }

  private fanEditor(root: Node, w: number, h: number): void {
    const config = defaultFanConfig();
    const fans = [...config.fans, ...config.bonusFans];
    const perPage = this.portrait ? 8 : 7;
    const pages = Math.ceil(fans.length / perPage);
    this.fanPage = Math.min(this.fanPage, pages - 1);
    const begin = this.fanPage * perPage;
    fans.slice(begin, begin + perPage).forEach((fan, i) => {
      const saved = this.prefs.fans[fan.id] ?? { enabled: fan.enabled !== false, value: fan.value };
      const y = h / 2 - 111 - i * 55;
      addLabel(root, fan.name, -w / 4 + 10, y, w / 2 - 40, 41, 22, TEXT, true);
      this.button(root, saved.enabled ? '启用' : '关闭', w / 4 - 58, y, 80, () => {
        this.prefs.fans[fan.id] = { ...saved, enabled: !saved.enabled };
        this.persist();
        this.showOverlay('fans');
      }, saved.enabled, 37);
      const input = this.edit(root, '番', String(saved.value), w / 2 - 66, y, 98, 37, 20);
      input.inputMode = EditBox.InputMode.NUMERIC;
      input.maxLength = 2;
      input.node.on(EditBox.EventType.EDITING_DID_ENDED, () => {
        const value = Math.min(64, Math.max(0, Math.round(Number(input.string) || 0)));
        this.prefs.fans[fan.id] = { ...this.prefs.fans[fan.id] ?? saved, value };
        input.string = String(value);
        this.persist();
      });
    });
    addLabel(root, `${this.fanPage + 1} / ${pages}`, 0, -h / 2 + 96, 100, 28, 18, MUTED);
    this.button(root, '上一页', -w / 3, -h / 2 + 42, w / 3 - 18, () => { this.fanPage = (this.fanPage + pages - 1) % pages; this.showOverlay('fans'); });
    this.button(root, '完成', 0, -h / 2 + 42, w / 3 - 18, () => this.showOverlay('advanced'), true);
    this.button(root, '下一页', w / 3, -h / 2 + 42, w / 3 - 18, () => { this.fanPage = (this.fanPage + 1) % pages; this.showOverlay('fans'); });
  }

  private quickConfig(): FanConfig {
    const config = defaultFanConfig();
    config.tileSet = clonePreset(this.prefs.preset);
    config.tileSet.preset = this.prefs.preset;
    config.tileSet.redCenterMode = this.prefs.redMode;
    config.tileSet.redCenterDrawOnly = this.prefs.redDrawOnly;
    if (this.prefs.redMode !== 'off') config.tileSet.honors.red = { enabled: true, copies: 4 };
    if (this.prefs.redMode !== 'wild') config.scoring.redCenterBonus.enabled = false;
    config.rules = { ...config.rules, allowDiscardHu: this.prefs.allowDiscardHu };
    const cap = config.scoring.cap;
    switch (this.prefs.cap) {
      case '3 番': cap.value = { type: 'fixed', fixed: 3 }; break;
      case '5 番': cap.value = { type: 'fixed', fixed: 5 }; break;
      case '分档 3/4/5 番': cap.value = { type: 'tiered', tiers: [3, 4, 5], tierSelector: 'roomLevel' }; break;
      case '动态封顶': cap.value = { type: 'formula', formula: 'clamp(3 + floor(kongCount / 2), minFan, hardCap)', hardCap: 10 }; break;
      case '不封顶': cap.value = { type: 'unlimited' }; break;
    }
    for (const fan of [...config.fans, ...config.bonusFans]) {
      const saved = this.prefs.fans[fan.id];
      if (saved) Object.assign(fan, saved);
    }
    return autoDisableUnmetFans(config).config;
  }

  private restore(): void {
    try {
      const saved = JSON.parse(sys.localStorage.getItem('quejie-cocos-settings') ??
        sys.localStorage.getItem('quejie-settings') ?? '{}') as Partial<Preferences>;
      const config = saved.config;
      this.prefs = {
        ...this.prefs, ...saved, config: null,
        nickname: typeof saved.nickname === 'string' ? saved.nickname : this.prefs.nickname,
        serverUrl: typeof saved.serverUrl === 'string' ? saved.serverUrl : this.prefs.serverUrl,
        fans: saved.fans && typeof saved.fans === 'object' ? saved.fans : {},
      };
      if (!presets.includes(this.prefs.preset)) this.prefs.preset = 'gd128';
      if (![2, 3, 4].includes(this.prefs.playerCount)) this.prefs.playerCount = 4;
      if (!levels.includes(this.prefs.difficulty)) this.prefs.difficulty = 'normal';
      if (!caps.includes(this.prefs.cap)) this.prefs.cap = caps[0];
      if (!redModes.includes(this.prefs.redMode)) this.prefs.redMode = 'wild';
      if (![150, 600, 1200].includes(this.prefs.aiDelay)) this.prefs.aiDelay = 600;
      if (config && resolveFanConfig(config).ok) this.prefs.config = config;
    } catch { /* Defaults are usable without persisted settings. */ }
  }

  private persist(): void {
    this.gm.playerCount = this.prefs.playerCount;
    this.gm.allowDiscardHu = this.prefs.allowDiscardHu;
    this.gm.pvePreset = this.prefs.preset;
    if (this.gm.mode === 'idle') this.gm.customConfig = this.prefs.config;
    this.gm.myName = this.prefs.nickname.trim().slice(0, 20) || '玩家';
    this.gm.serverUrl = this.prefs.serverUrl.trim();
    this.gm.singleClick = this.prefs.singleClick;
    this.gm.reduceMotion = this.prefs.reduceMotion;
    this.gm.aiDelay = this.prefs.aiDelay;
    this.gm.autoPlay = this.prefs.autoPlay;
    this.gm.syncAutoPlay();
    if (this.lobbyRules) this.lobbyRules.string = `${this.prefs.preset} · ${this.prefs.cap}`;
    try { sys.localStorage.setItem('quejie-cocos-settings', JSON.stringify(this.prefs)); }
    catch { /* Changes still apply in this session. */ }
  }
}
