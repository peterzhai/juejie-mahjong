/**
 * 全局入口与总控：WebSocket 连接（NetClient 封装）、场景切换（Lobby ↔ Table）、
 * 房间状态机（lobby/playing/settle）、本地 PVE 模式（LocalPveDriver）。
 * 所有事件回调（网络/手牌触摸/面板按钮）经此集中转发，子组件不直接互调。
 */

import { _decorator, Component, director, EditBox, Node } from 'cc';
import type { FanConfig, ResolvedFanConfig } from '@quejie/fan-config';
import type {
  ActionPayload,
  CreateRoomMsg,
  GameEventMsg,
  GameOverMsg,
  GameStateMsg,
  HandScoreRecord,
  RoomStateMsg,
  ServerMessage,
  WelcomeMsg,
  ErrorMsg,
} from '@quejie/protocol';
import { NetClient } from './NetClient';
import type { TableScene } from './TableScene';
import { LocalPveDriver } from './LocalPveDriver';
import { SoundManager } from './SoundManager';
import { Tips } from './ui/Tips';
import { getPlatformAdapter } from './platform/IPlatform';
import { tileLabel } from '@quejie/mahjong-core';

const { ccclass, property } = _decorator;

/** 房间状态机的四个状态（idle=未进入任何房间） */
export type RoomPhase = 'idle' | 'lobby' | 'playing' | 'settle';

const DEFAULT_SERVER_URL = 'ws://127.0.0.1:8080';
const DEFAULT_PRESET = 'gd128';

@ccclass('GameManager')
export class GameManager extends Component {
  /** 全局单例（跨场景持久化；TableScene 会在缺失时自动补建） */
  public static instance: GameManager | null = null;

  // —— 编辑器可配 ——
  @property({ tooltip: '联机服务地址（WebSocket）' })
  public serverUrl = DEFAULT_SERVER_URL;

  @property(EditBox)
  public roomCodeInput: EditBox | null = null;

  @property({ tooltip: '本地 PVE 默认预设（gd100~gd144）' })
  public pvePreset = DEFAULT_PRESET;
  public playerCount = 4;
  public allowDiscardHu = true;
  public customConfig: FanConfig | null = null;
  public singleClick = false;
  public reduceMotion = false;
  public aiDelay = 600;
  public autoPlay = false;
  public openSettings: (() => void) | null = null;
  public openHistory: (() => void) | null = null;
  public openLogs: (() => void) | null = null;
  public confirmLeave: (() => void) | null = null;

  // —— 运行时状态（只读供 UI 查询） ——
  /** 网络客户端（心跳/重连/分发封装） */
  public readonly net = new NetClient();
  /** 当前模式：离线未用 / 联机 / 本地 PVE */
  public mode: 'idle' | 'online' | 'pve' = 'idle';
  /** 房间状态机当前状态 */
  public phase: RoomPhase = 'idle';
  /** 最近一次 roomState（房间码/玩家列表/规则摘要） */
  public roomState: RoomStateMsg | null = null;
  /** 最近一次 gameState */
  public lastGameState: GameStateMsg | null = null;
  /** 最近一次结算 */
  public lastGameOver: GameOverMsg | null = null;
  /** 我的座位（welcome 下发） */
  public mySeat: number | null = null;
  /** 我的昵称 */
  public myName = '玩家';
  public handHistory: HandScoreRecord[] = [];
  public readonly gameLog: string[] = [];

  public get matchNames(): string[] {
    return this.lastGameState?.seats.map((seat) => seat.name) ?? this.roomState?.players.map((seat) => seat.name) ?? [];
  }

  // —— 内部 ——
  private token = '';
  private tableScene: TableScene | null = null;
  private pveDriver: LocalPveDriver | null = null;
  private roomRequestPending = false;
  /** 场景切换期间的入队缓存（Table 场景 onLoad 后统一冲刷） */
  private pendingStates: GameStateMsg[] = [];
  private pendingEvents: GameEventMsg['event'][] = [];
  private pendingOver: GameOverMsg | null = null;

  // —— 生命周期 ——

  protected override onLoad(): void {
    if (GameManager.instance && GameManager.instance !== this) {
      this.node.destroy();
      return;
    }
    GameManager.instance = this;
    director.addPersistRootNode(this.node);
    this.ensureSoundManager();
    this.bindNet();
  }

  protected override onDestroy(): void {
    if (GameManager.instance === this) {
      GameManager.instance = null;
    }
  }

  /** 静态兜底获取：无实例时程序化创建（TableScene 直跑调试场景用） */
  public static ensureInstance(): GameManager {
    if (GameManager.instance) return GameManager.instance;
    const scene = director.getScene();
    const node = new Node('GameManager');
    if (scene) scene.addChild(node);
    return node.addComponent(GameManager);
  }

  /** 确保声音管理器存在（SoundManager 自行持久化） */
  private ensureSoundManager(): void {
    if (SoundManager.instance) return;
    const node = new Node('SoundManager');
    this.node.addChild(node);
    node.addComponent(SoundManager);
  }

  // —— 网络消息绑定（集中转发入口） ——

  private bindNet(): void {
    this.net.on('welcome', (m: ServerMessage) => this.onWelcome(m as WelcomeMsg));
    this.net.on('roomState', (m: ServerMessage) => this.onRoomState(m as RoomStateMsg));
    this.net.on('gameState', (m: ServerMessage) => this.onGameState(m as GameStateMsg));
    this.net.on('gameEvent', (m: ServerMessage) => this.routeGameEvent((m as GameEventMsg).event));
    this.net.on('gameOver', (m: ServerMessage) => this.onGameOver(m as GameOverMsg));
    this.net.on('error', (m: ServerMessage) => this.onError(m as ErrorMsg));
    this.net.onOpenChanged = (connected: boolean) => {
      if (!connected && this.mode === 'online' && this.roomState) {
        Tips.show('连接断开，自动重连中…');
      }
    };
    this.net.onReconnected = () => {
      Tips.show('重连成功，恢复对局');
    };
    this.net.onSessionLost = (message) => {
      this.teardownSession();
      this.backToLobby();
      Tips.show(message);
    };
  }

  // —— 对外：联机操作（Lobby 按钮直接绑这些方法） ——

  /** 连接服务器（未连接时调用；连接建立前发送的消息会自动缓冲） */
  public connectOnline(url?: string): void {
    if (this.mode !== 'online' || !this.net.isConnected) {
      this.mode = 'online';
      this.net.connect(url ?? this.serverUrl);
    }
  }

  /** 创建房间（默认 gd128 预设） */
  public createRoom(opts?: Partial<CreateRoomMsg>): void {
    if (!this.beginRoomRequest()) return;
    this.connectOnline();
    this.net.send({ type: 'hello', name: this.myName });
    this.net.send({
      type: 'createRoom', preset: this.pvePreset, roomLevel: 1, playerCount: this.playerCount,
      allowDiscardHu: this.allowDiscardHu, config: this.customConfig ?? undefined, ...opts,
    });
  }

  /** 加入房间 */
  public joinRoom(roomCode: string): void {
    const code = roomCode.trim();
    if (!code) {
      Tips.show('请输入房间码');
      return;
    }
    if (!this.beginRoomRequest()) return;
    this.connectOnline();
    this.net.send({ type: 'hello', name: this.myName });
    this.net.send({ type: 'joinRoom', roomCode: code });
  }

  /** 准备 */
  public ready(): void {
    this.net.send({ type: 'ready' });
  }

  /** AI 填充并开局 */
  public startWithAi(): void {
    this.net.send({ type: 'startWithAi' });
  }

  public readyForNextHand(): void {
    if (this.mode !== 'online' || !this.roomState || this.roomState.phase !== 'lobby') return;
    this.returnToRoom();
    this.ready();
  }

  public returnToRoom(): void {
    if (this.mode !== 'online' || this.roomState?.phase !== 'lobby') return;
    this.phase = 'lobby';
    this.navigate?.('Room');
  }

  /** 离开房间并回大厅（同时清理 PVE） */
  public leaveRoom(): void {
    if (this.mode === 'online') this.net.send({ type: 'leaveRoom' });
    this.teardownSession();
    this.backToLobby();
  }

  /** 复制房间码到剪贴板（平台适配） */
  public copyRoomCode(): void {
    const code = this.roomState?.roomCode ?? '';
    if (!code) {
      Tips.show('尚无房间');
      return;
    }
    void getPlatformAdapter()
      .setClipboardText(code)
      .then((ok) => Tips.show(ok ? `房间码 ${code} 已复制` : '复制失败，请手动记录'));
  }

  // —— 对外：本地 PVE ——

  /** 进入本地单机（1 人类 + 3 AI，离线可玩） */
  public enterLocalPve(presetId?: string, difficulty?: 'easy' | 'normal' | 'hard'): void {
    this.teardownSession();
    this.mode = 'pve';
    this.phase = 'playing';
    const driver = this.ensureDriver();
    if (difficulty) driver.difficulty = difficulty;
    driver.aiTurnDelayMs = this.aiDelay;
    driver.onSnapshot = (s) => {
      this.lastGameState = s;
      this.routeGameState(s);
    };
    driver.onEvent = (e) => this.routeGameEvent(e);
    driver.onOver = (o) => this.onGameOver(o);
    driver.startMatch({
      presetId: presetId ?? this.pvePreset, playerCount: this.playerCount,
      allowDiscardHu: this.allowDiscardHu, config: this.customConfig ?? undefined,
      playerNames: [this.myName, 'AI·下家', 'AI·对家', 'AI·上家'],
    });
  }

  /** PVE 结算后继续（连庄下一局，累计分保留） */
  public pveContinueNextHand(): void {
    if (this.mode !== 'pve' || this.phase !== 'settle') return;
    this.phase = 'playing';
    this.lastGameOver = null;
    this.pendingOver = null;
    this.ensureDriver().startNextHand();
  }

  /** PVE 规则配置（RulePanel 数据源） */
  public getPveResolved(): ResolvedFanConfig | null {
    return this.pveDriver?.resolved ?? null;
  }

  // —— 对外：动作提交（TableScene 触摸/按钮统一走这里） ——

  /** 提交玩家动作：联机发服务端裁决；PVE 交本地引擎 */
  public sendAction(action: ActionPayload): void {
    this.unschedule(this.playAutomatically);
    if (this.mode === 'online') {
      if (!this.net.send({ type: 'action', action })) Tips.show('正在恢复对局，请稍后操作。');
    } else if (this.mode === 'pve') {
      this.pveDriver?.submitHuman(action);
    }
  }

  public syncAutoPlay(): void {
    this.unschedule(this.playAutomatically);
    if (this.autoPlay && this.lastGameState?.phase !== 'over' && this.lastGameState?.legalOptions.length) {
      this.scheduleOnce(this.playAutomatically, 0.32);
    }
  }

  private playAutomatically(): void {
    const options = this.lastGameState?.legalOptions ?? [];
    for (const type of ['hu', 'mingang', 'ankang', 'bugang', 'peng', 'discard', 'pass'] as const) {
      const option = options.find((item) => item.type === type);
      if (option) { this.sendAction(option); return; }
    }
  }

  // —— 对内：场景与 TableScene 注册 ——

  /** TableScene onLoad 时注册（场景就绪后冲刷缓存消息） */
  public attachTable(scene: TableScene): void {
    this.tableScene = scene;
    // 冲刷场景切换期间缓存的状态/事件/结算
    for (const s of this.pendingStates.splice(0)) this.routeGameState(s);
    for (const e of this.pendingEvents.splice(0)) this.tableScene?.applyGameEvent(e);
    if (this.pendingOver) {
      const over = this.pendingOver;
      this.pendingOver = null;
      this.tableScene?.showGameOver(over);
    }
  }

  public detachTable(scene: TableScene): void {
    if (this.tableScene === scene) this.tableScene = null;
  }

  /** 确保处于 Table 场景（不在则异步加载） */
  public navigate: ((screen: 'Lobby' | 'Room' | 'Table') => void) | null = null;

  private ensureTableScene(): void {
    if (this.navigate) { if (!this.tableScene) this.navigate('Table'); return; }
    const cur = director.getScene();
    if (cur && cur.name === 'Table') return;
    director.loadScene('Table', (err) => {
      if (err) Tips.show(`进入牌桌失败: ${err.message}`);
    });
  }

  /** 返回大厅场景 */
  public backToLobby(): void {
    if (this.navigate) { this.navigate('Lobby'); return; }
    const cur = director.getScene();
    if (cur && cur.name !== 'Lobby') {
      director.loadScene('Lobby', (err) => {
        if (err) Tips.show(`返回大厅失败: ${err.message}`);
      });
    }
  }

  // —— 对内：消息处理 ——

  private onWelcome(msg: WelcomeMsg): void {
    this.token = msg.token;
    this.mySeat = msg.seat;
    this.myName = msg.name;
  }

  private onRoomState(msg: RoomStateMsg): void {
    this.endRoomRequest();
    this.roomState = msg;
    if (msg.handHistory) this.handHistory = [...msg.handHistory];
    // 房间码 + token 即重连凭据
    if (msg.roomCode && this.token) {
      this.net.setReconnectInfo(msg.roomCode, this.token);
    }
    if (msg.phase === 'playing') {
      this.phase = 'playing';
      this.ensureTableScene();
    } else if (this.phase !== 'settle') {
      this.phase = 'lobby';
      if (this.navigate) this.navigate('Room');
      else Tips.show(`房间 ${msg.roomCode}`);
    }
  }

  private onGameState(msg: GameStateMsg): void {
    this.lastGameState = msg;
    if (msg.phase !== 'over') {
      this.lastGameOver = null;
      this.phase = 'playing';
    }
    this.routeGameState(msg);
  }

  /** gameState 统一路由：场景就绪直推，否则入队 */
  private routeGameState(msg: GameStateMsg): void {
    this.syncAutoPlay();
    if (this.tableScene) {
      this.tableScene.applyGameState(msg);
    } else {
      this.pendingStates.push(msg);
      this.ensureTableScene();
    }
  }

  /** gameEvent 统一路由（音效/动画由 TableScene 消费） */
  private routeGameEvent(evt: GameEventMsg['event']): void {
    const name = 'seat' in evt ? this.matchNames[evt.seat] ?? `座位 ${evt.seat + 1}` : '';
    const tile = 'tile' in evt && evt.tile ? tileLabel(evt.tile) : '';
    switch (evt.kind) {
      case 'draw': this.record(`${name} 摸牌`); break;
      case 'discard': this.record(`${name} 打出 ${tile}`); break;
      case 'peng': this.record(`${name} 碰 ${tile}`); break;
      case 'mingang': this.record(`${name} 明杠 ${tile}`); break;
      case 'bugang': this.record(`${name} 补杠 ${tile}`); break;
      case 'ankang': this.record(`${name} 暗杠`); break;
      case 'hu': this.record(`${name} 胡牌`); break;
      case 'missLock': if (evt.seat === this.lastGameState?.viewSeat) this.record(`漏胡锁定 · ${tile}`); break;
      case 'kongScore': this.record(`${this.matchNames[evt.from]} 向 ${this.matchNames[evt.to]} 支付杠分 ${evt.amount}`); break;
    }
    if (this.tableScene) {
      this.tableScene.applyGameEvent(evt);
    } else {
      if (this.pendingEvents.length > 200) this.pendingEvents.shift();
      this.pendingEvents.push(evt);
    }
  }

  private onGameOver(msg: GameOverMsg): void {
    if (this.lastGameOver === msg) return;
    this.lastGameOver = msg;
    this.phase = 'settle';
    const previousHand = this.handHistory[this.handHistory.length - 1]?.hand ?? 0;
    const hand = typeof msg.replayMeta.hands === 'number' ? msg.replayMeta.hands : previousHand + 1;
    if (!this.handHistory.some((item) => item.hand === hand)) {
      this.handHistory.push({ hand, outcome: msg.outcome, winnerSeats: msg.settlements.map((item) => item.winnerSeat), deltas: [...msg.deltas], scores: [...msg.scores] });
    }
    this.record(msg.outcome === 'draw' ? '本局流局' : '本局已结算');
    if (this.tableScene) {
      this.tableScene.showGameOver(msg);
    } else {
      this.pendingOver = msg;
      this.ensureTableScene();
    }
  }

  private onError(msg: ErrorMsg): void {
    this.endRoomRequest();
    Tips.show(`错误 ${msg.code}: ${msg.message}`);
  }

  private beginRoomRequest(): boolean {
    if (this.roomRequestPending || this.roomState) return false;
    this.roomRequestPending = true;
    this.scheduleOnce(this.roomRequestTimeout, 10);
    return true;
  }

  private endRoomRequest(): void {
    this.roomRequestPending = false;
    this.unschedule(this.roomRequestTimeout);
  }

  private roomRequestTimeout(): void {
    this.teardownSession();
    Tips.show('连接房间超时，请检查联机地址后重试');
  }

  private record(message: string): void {
    this.gameLog.push(`[${new Date().toLocaleTimeString()}] ${message}`);
    if (this.gameLog.length > 200) this.gameLog.shift();
  }

  // —— 对内：PVE 驱动 ——

  private ensureDriver(): LocalPveDriver {
    if (!this.pveDriver || !this.pveDriver.isValid) {
      const node = new Node('LocalPveDriver');
      this.node.addChild(node);
      this.pveDriver = node.addComponent(LocalPveDriver);
    }
    return this.pveDriver;
  }

  /** 会话清理：断网凭据、缓存队列、PVE 实例 */
  private teardownSession(): void {
    this.endRoomRequest();
    this.unschedule(this.playAutomatically);
    this.net.clearReconnectInfo();
    this.mode = 'idle';
    this.net.disconnect();
    this.phase = 'idle';
    this.roomState = null;
    this.lastGameState = null;
    this.lastGameOver = null;
    this.handHistory = [];
    this.gameLog.length = 0;
    this.mySeat = null;
    this.token = '';
    this.pendingStates = [];
    this.pendingEvents = [];
    this.pendingOver = null;
    this.pveDriver?.stopMatch();
  }

  // —— Lobby UI 按钮直绑（编辑器 Button.ClickEvents 目标） ——

  /** Lobby: 创建房间按钮 */
  public uiCreateRoom(): void {
    SoundManager.instance?.playClick();
    this.createRoom();
    Tips.show('正在创建房间…');
  }

  /** Lobby: 加入房间按钮（读取 roomCodeInput） */
  public uiJoinRoom(): void {
    SoundManager.instance?.playClick();
    this.joinRoom(this.roomCodeInput?.string ?? '');
  }

  /** Lobby: 房间内准备按钮 */
  public uiReady(): void {
    this.ready();
  }

  /** Lobby: AI 填充开局按钮 */
  public uiStartWithAi(): void {
    SoundManager.instance?.playClick();
    this.startWithAi();
  }

  /** Lobby: 本地单机按钮 */
  public uiLocalPve(): void {
    SoundManager.instance?.playClick();
    this.enterLocalPve();
  }

  /** Lobby: 复制房间码按钮 */
  public uiCopyRoomCode(): void {
    this.copyRoomCode();
  }

  /** 牌桌: 离开按钮 */
  public uiLeaveRoom(): void {
    SoundManager.instance?.playClick();
    this.leaveRoom();
  }
}
