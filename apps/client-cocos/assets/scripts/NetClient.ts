/**
 * WebSocket 网络客户端封装：连接、心跳 ping/pong、指数退避断线重连（reconnect 消息 + token）、
 * 按 ServerMessage.type 的消息分发（on/off）。纯 TS 类，不依赖 Cocos 组件。
 */

import type { ClientMessage, ServerMessage } from '@quejie/protocol';

/** 消息处理器：收到的原始 ServerMessage */
export type MessageHandler = (msg: ServerMessage) => void;

/** 心跳间隔（ms）：每 15s 发一次 ping */
const HEARTBEAT_INTERVAL_MS = 15000;
/** pong 超时（ms）：发出 ping 后 8s 未收到 pong 视为链路死亡，主动断开重连 */
const PONG_TIMEOUT_MS = 8000;
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
  private everOpened = false;

  /** 重连凭据：进入房间后由 GameManager 注入（roomCode + welcome 返回的 token） */
  private roomCode = '';
  private token = '';
  private hasJoinedRoom = false; // 一旦真正进过房间，断线重连才携带 reconnect 消息

  /** 心跳定时器（setTimeout/setInterval 在 web 与微信小游戏均可用） */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongDeadline = 0;
  private heartbeatChecker: ReturnType<typeof setInterval> | null = null;

  /** 重连尝试计数 */
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** 出站缓冲：连接未就绪时暂存消息，open 后按序补发（大厅建房/加入场景） */
  private outbox: ClientMessage[] = [];

  /** 生命周期回调（由 GameManager 注册） */
  public onOpenChanged: ((connected: boolean) => void) | null = null;
  public onReconnected: (() => void) | null = null;

  /** 是否处于连接状态 */
  public get isConnected(): boolean {
    return this.connected;
  }

  /** 是否曾经打开过连接（区分首连与重连） */
  public get hasEverOpened(): boolean {
    return this.everOpened;
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
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.sendRaw(msg);
    }
    if (this.manualClosed) return false;
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
      const wasReconnect = this.everOpened;
      this.connected = true;
      this.everOpened = true;
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.onOpenChanged?.(true);
      // 断线重连：携 token 恢复对局（服务端返回完整 gameState）
      if (wasReconnect && this.hasJoinedRoom && this.roomCode && this.token) {
        this.sendRaw({ type: 'reconnect', roomCode: this.roomCode, token: this.token });
        this.onReconnected?.();
      }
      // 补发连接建立前缓冲的消息（首连与重连均适用）
      this.flushOutbox();
    };

    socket.onmessage = (ev: MessageEvent) => {
      this.dispatch(ev.data);
    };

    socket.onerror = () => {
      // 错误后统一走 onclose 的重连逻辑
    };

    socket.onclose = () => {
      const was = this.connected;
      this.connected = false;
      this.stopHeartbeat();
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
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // —— 内部：心跳 ——

  /** 启动心跳：定时 ping + pong 超时检测 */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'ping' });
      this.pongDeadline = Date.now() + PONG_TIMEOUT_MS;
    }, HEARTBEAT_INTERVAL_MS);
    // 高频轻量检查 pong 是否超时
    this.heartbeatChecker = setInterval(() => {
      if (this.pongDeadline > 0 && Date.now() > this.pongDeadline) {
        this.pongDeadline = 0;
        // 视为链路死亡：主动关闭，onclose 触发重连
        try {
          this.ws?.close();
        } catch (e) {
          void e;
        }
      }
    }, 2000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatChecker !== null) {
      clearInterval(this.heartbeatChecker);
      this.heartbeatChecker = null;
    }
    this.pongDeadline = 0;
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
