/**
 * WebSocket 网络客户端封装：连接、心跳 ping/pong、指数退避断线重连（reconnect 消息 + token）、
 * 按 ServerMessage.type 的消息分发（on/off）。纯 TS 类，不依赖 Cocos 组件。
 */

import type { ClientMessage, ServerMessage } from '@quejie/protocol';

/** 消息处理器：收到的原始 ServerMessage */
export type MessageHandler = (msg: ServerMessage) => void;

/** 心跳间隔（ms）：每 15s 发一次 ping */
const HEARTBEAT_INTERVAL_MS = 15000;
const MAX_MISSED_HEARTBEATS = 2;
/** 重连退避：1s 起步，翻倍，封顶 15s */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

export class NetClient {
  private ws: WebSocket | null = null;
  private url = '';
  private handlers = new Map<string, Set<MessageHandler>>();

  /** 连接状态 */
  private connected = false;
  private manualClosed = false;

  /** 重连凭据：进入房间后由 GameManager 注入（roomCode + welcome 返回的 token） */
  private roomCode = '';
  private token = '';
  private hasJoinedRoom = false; // 一旦真正进过房间，断线重连才携带 reconnect 消息
  private awaitingRoom = false;

  /** 心跳定时器（setTimeout/setInterval 在 web 与微信小游戏均可用） */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private missedHeartbeats = 0;
  private lastHeartbeatAt = 0;

  /** 重连尝试计数 */
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** 出站缓冲：连接未就绪时暂存消息，open 后按序补发（大厅建房/加入场景） */
  private outbox: ClientMessage[] = [];

  /** 生命周期回调（由 GameManager 注册） */
  public onOpenChanged: ((connected: boolean) => void) | null = null;
  public onReconnected: (() => void) | null = null;
  public onSessionLost: ((message: string) => void) | null = null;

  /** 是否处于连接状态 */
  public get isConnected(): boolean {
    return this.connected;
  }

  // —— 连接管理 ——

  /** 建立连接（若已有连接则先关闭旧连接） */
  public connect(url: string): void {
    this.disconnect();
    this.url = url;
    this.manualClosed = false;
    this.reconnectAttempts = 0;
    this.openSocket();
  }

  /** 主动断开（离开房间/退出游戏），不触发自动重连 */
  public disconnect(): void {
    this.manualClosed = true;
    this.stopHeartbeat();
    this.cancelReconnect();
    this.awaitingRoom = false;
    this.outbox = [];
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      try {
        socket.onclose = null;
        socket.onmessage = null;
        socket.onopen = null;
        socket.onerror = null;
        socket.close();
      } catch (e) {
        void e;
      }
    }
    const was = this.connected;
    this.connected = false;
    if (was) this.onOpenChanged?.(false);
  }

  /** 清空重连凭据（彻底退出房间后调用） */
  public clearReconnectInfo(): void {
    this.roomCode = '';
    this.token = '';
    this.hasJoinedRoom = false;
  }

  /** 注入重连凭据（房间创建/加入成功后调用） */
  public setReconnectInfo(roomCode: string, token: string): void {
    this.roomCode = roomCode;
    this.token = token;
    this.hasJoinedRoom = true;
  }

  // —— 消息 ——

  /** 注册某类型服务端消息处理器 */
  public on(type: ServerMessage['type'], handler: MessageHandler): void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
  }

  /** 注销处理器 */
  public off(type: ServerMessage['type'], handler: MessageHandler): void {
    this.handlers.get(type)?.delete(handler);
  }

  /**
   * 发送客户端消息。
   * 连接已打开：立即发送；否则入缓冲（上限 32 条，溢出丢最旧），open 后补发。
   * 主动断开（manualClosed）时返回 false 不入缓冲。
   */
  public send(msg: ClientMessage): boolean {
    if (!this.awaitingRoom && this.ws?.readyState === WebSocket.OPEN) {
      return this.sendRaw(msg);
    }
    if (this.manualClosed || msg.type === 'action') return false;
    if (this.outbox.length >= 32) this.outbox.shift();
    this.outbox.push(msg);
    return true;
  }

  /** 真正的 socket 发送 */
  private sendRaw(msg: ClientMessage): boolean {
    try {
      this.ws?.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      void e;
      return false;
    }
  }

  /** 连接建立后补发缓冲消息 */
  private flushOutbox(): void {
    const pending = this.outbox.splice(0, this.outbox.length);
    for (const msg of pending) {
      this.sendRaw(msg);
    }
  }

  // —— 内部：连接与事件 ——

  private openSocket(): void {
    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      void e;
      this.scheduleReconnect();
      return;
    }
    const socket = this.ws;
    if (!socket) return;

    socket.onopen = () => {
      if (this.ws !== socket) return;
      this.startHeartbeat();
      this.awaitingRoom = this.hasJoinedRoom && !!this.roomCode && !!this.token;
      if (this.awaitingRoom) {
        this.sendRaw({ type: 'reconnect', roomCode: this.roomCode, token: this.token });
      } else {
        this.markConnected();
      }
    };

    socket.onmessage = (ev: MessageEvent) => {
      if (this.ws === socket) this.dispatch(ev.data);
    };

    socket.onerror = () => {
      // 错误后统一走 onclose 的重连逻辑
    };

    socket.onclose = (event) => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.awaitingRoom = false;
      const was = this.connected;
      this.connected = false;
      this.stopHeartbeat();
      if (event.code === 4001) {
        this.disconnect();
        this.onSessionLost?.('该座位已在另一条连接上恢复。');
        return;
      }
      if (was) this.onOpenChanged?.(false);
      if (!this.manualClosed) {
        this.scheduleReconnect();
      }
    };
  }

  /** 指数退避重连 */
  private scheduleReconnect(): void {
    if (this.manualClosed) return;
    this.cancelReconnect();
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts), RECONNECT_MAX_MS);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manualClosed) this.openSocket();
    }, delay + Math.random() * 400);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // —— 内部：心跳 ——

  private markConnected(): void {
    this.connected = true;
    this.reconnectAttempts = 0;
    this.onOpenChanged?.(true);
    this.flushOutbox();
  }

  /** 连续错过心跳才重连，后台挂起后的第一次检查重新计时。 */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastHeartbeatAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      if (now - this.lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS * 2) this.missedHeartbeats = 0;
      this.lastHeartbeatAt = now;
      if (this.missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
        this.ws?.close();
        return;
      }
      this.missedHeartbeats++;
      this.sendRaw({ type: 'ping' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.missedHeartbeats = 0;
  }

  // —— 内部：分发 ——

  /** 解析服务端消息并按 type 分发 */
  private dispatch(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch (e) {
      void e;
      return; // 非 JSON 帧忽略
    }
    if (!msg || typeof msg.type !== 'string') return;
    this.missedHeartbeats = 0;
    if (this.awaitingRoom && msg.type === 'error' && ['E_NO_ROOM', 'E_TOKEN', 'E_IN_ROOM'].includes(msg.code)) {
      this.disconnect();
      this.onSessionLost?.(msg.message);
      return;
    }
    if (this.awaitingRoom && (msg.type === 'gameState' || (msg.type === 'roomState' && msg.phase !== 'playing'))) {
      this.awaitingRoom = false;
      this.markConnected();
      this.onReconnected?.();
    }
    const set = this.handlers.get(msg.type);
    if (!set) return;
    for (const h of Array.from(set)) {
      try {
        h(msg);
      } catch (e) {
        void e; // 单个 handler 异常不阻断分发
      }
    }
  }
}
