/**
 * 联机服务端入口：HTTP 健康检查 + WebSocket 房间服务
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  autoDisableUnmetFans,
  clonePreset,
  defaultFanConfig,
  resolveFanConfig,
  validateFanConfig,
  type ResolvedFanConfig,
  type FanConfig,
} from '@quejie/fan-config';
import type { ClientMessage, Seat } from '@quejie/protocol';
import { Room, randomRoomCode, randomToken, type RoomSession } from './room.js';

const PORT = Number(process.env.PORT ?? 8080);
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS ?? 15000);
const CLAIM_TIMEOUT_MS = Number(process.env.CLAIM_TIMEOUT_MS ?? 8000);
const AI_DELAY_MS = Number(process.env.AI_DELAY_MS ?? 120);

const rooms = new Map<string, Room>();
const logs: string[] = [];

function logEvent(roomCode: string, message: string): void {
  const line = `[${new Date().toISOString()}] [${roomCode}] ${message}`;
  logs.push(line);
  if (logs.length > 5000) logs.shift();
  console.log(line);
}

interface ConnState {
  socket: WebSocket;
  name: string;
  room: Room | null;
  seat: Seat | null;
  token: string | null;
}

function resolvedConfig(preset: string, roomLevel: number, capType?: string, capFixed?: number): ResolvedFanConfig {
  const cfg = defaultFanConfig();
  cfg.tileSet = clonePreset(preset);
  cfg.tileSet.preset = preset;
  if (cfg.tileSet.redCenterMode !== 'wild') {
    cfg.scoring.redCenterBonus.enabled = false;
  }
  const { config, disabled } = autoDisableUnmetFans(cfg);
  for (const d of disabled) logEvent('-', `预设 ${preset} 自动禁用番型: ${d.fanName}（${d.reason}）`);
  if (capType === 'unlimited') {
    config.scoring.cap = {
      enabled: true,
      value: { type: 'unlimited' },
      hardCap: 10,
      maxScore: 1000000,
      minFan: 0,
      scope: 'global',
      groups: [],
      bypass: config.scoring.cap.bypass,
    };
  } else if (capType === 'tiered') {
    config.scoring.cap = {
      enabled: true,
      value: { type: 'tiered', tiers: [3, 4, 5], tierSelector: 'roomLevel' },
      hardCap: 10,
      minFan: 1,
      maxScore: 1000000,
      scope: 'global',
      groups: [],
      bypass: config.scoring.cap.bypass,
    };
  } else if (capType === 'fixed' && typeof capFixed === 'number') {
    config.scoring.cap.value = { type: 'fixed', fixed: capFixed };
  }
  const result = validateFanConfig(config);
  if (!result.ok) {
    throw new Error(`房间配置校验失败: ${result.errors.map((e) => e.message).join('; ')}`);
  }
  const resolved = resolveFanConfig(config, { strictDependency: false });
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('; '));
  void roomLevel;
  return resolved.resolved!;
}

function sendTo(conn: ConnState, msg: unknown): void {
  if (conn.socket.readyState === 1) conn.socket.send(JSON.stringify(msg));
}

function handleCreateRoom(conn: ConnState, preset: string, roomLevel: number, capType?: string, capFixed?: number, config?: FanConfig, playerCount = 4): void {
  if (conn.room) {
    sendTo(conn, { type: 'error', code: 'E_IN_ROOM', message: '已在一个房间中，请先离开' });
    return;
  }
  let code = randomRoomCode();
  while (rooms.has(code)) code = randomRoomCode();
  let resolved: ResolvedFanConfig;
  try {
    if (![2, 3, 4].includes(playerCount)) throw new Error('人数必须为2至4');
    if (config) {
      const checked = resolveFanConfig(config);
      if (!checked.ok || !checked.resolved) throw new Error(checked.errors.map(e => e.message).join('; '));
      resolved = checked.resolved;
    } else resolved = resolvedConfig(preset, roomLevel, capType, capFixed);
  } catch (e) {
    sendTo(conn, { type: 'error', code: 'E_CONFIG', message: String((e as Error).message) });
    return;
  }
  const room = new Room(code, resolved, {
    resolved,
    playerCount,
    roomLevel,
    turnTimeoutMs: TURN_TIMEOUT_MS,
    claimTimeoutMs: CLAIM_TIMEOUT_MS,
    aiDelayMs: AI_DELAY_MS,
    onEvent: logEvent,
  });
  rooms.set(code, room);
  const joinResult = room.join(conn.name);
  if (!joinResult) {
    sendTo(conn, { type: 'error', code: 'E_FULL', message: '房间已满' });
    return;
  }
  conn.room = room;
  conn.seat = joinResult.seat;
  conn.token = joinResult.token;
  const session = room.attach(joinResult.seat, (m) => sendTo(conn, m));
  void session;
  sendTo(conn, { type: 'welcome', token: joinResult.token, seat: joinResult.seat, name: conn.name });
  room.broadcastRoomState();
  logEvent(code, `房间创建（preset=${preset}, cap=${capType ?? 'fixed'}）`);
}

function handleJoinRoom(conn: ConnState, roomCode: string): void {
  const room = rooms.get(roomCode);
  if (!room) {
    sendTo(conn, { type: 'error', code: 'E_NO_ROOM', message: `房间 ${roomCode} 不存在` });
    return;
  }
  if (conn.room) {
    sendTo(conn, { type: 'error', code: 'E_IN_ROOM', message: '已在一个房间中，请先离开' });
    return;
  }
  const joinResult = room.join(conn.name);
  if (!joinResult) {
    sendTo(conn, { type: 'error', code: 'E_FULL', message: '房间已满' });
    return;
  }
  conn.room = room;
  conn.seat = joinResult.seat;
  conn.token = joinResult.token;
  room.attach(joinResult.seat, (m) => sendTo(conn, m));
  sendTo(conn, { type: 'welcome', token: joinResult.token, seat: joinResult.seat, name: conn.name });
  room.broadcastRoomState();
  room.pushState(joinResult.seat);
  logEvent(roomCode, `玩家 ${conn.name} 加入（座位 ${joinResult.seat}）`);
}

function handleReconnect(conn: ConnState, roomCode: string, token: string): void {
  const room = rooms.get(roomCode);
  if (!room) {
    sendTo(conn, { type: 'error', code: 'E_NO_ROOM', message: `房间 ${roomCode} 不存在` });
    return;
  }
  const session = room.seatByToken(token);
  if (!session) {
    sendTo(conn, { type: 'error', code: 'E_TOKEN', message: '令牌无效' });
    return;
  }
  conn.room = room;
  conn.seat = session.seat;
  conn.token = token;
  room.attach(session.seat, (m) => sendTo(conn, m));
  sendTo(conn, { type: 'welcome', token, seat: session.seat, name: conn.name });
  room.broadcastRoomState();
  room.pushState(session.seat);
  logEvent(roomCode, `座位 ${session.seat} 重连成功`);
}

function handleMessage(conn: ConnState, raw: string): void {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    sendTo(conn, { type: 'error', code: 'E_PARSE', message: '消息不是合法 JSON' });
    return;
  }
  if (!msg || typeof msg.type !== 'string') {
    sendTo(conn, { type: 'error', code: 'E_MSG', message: '消息缺少 type' });
    return;
  }
  switch (msg.type) {
    case 'hello':
      // 仅登记昵称（不回 welcome，避免与真实席位 welcome 混淆）
      conn.name = String(msg.name || '玩家').slice(0, 20);
      break;
    case 'createRoom':
      handleCreateRoom(conn, String(msg.preset ?? 'gd128'), Number(msg.roomLevel ?? 1), msg.capType, msg.capFixed, msg.config, msg.playerCount);
      break;
    case 'joinRoom':
      handleJoinRoom(conn, String(msg.roomCode));
      break;
    case 'ready': {
      if (!conn.room || conn.seat === null) {
        sendTo(conn, { type: 'error', code: 'E_STATE', message: '未加入房间' });
        return;
      }
      conn.room.setReady(conn.seat, true);
      conn.room.broadcastRoomState();
      conn.room.maybeAutoStart();
      break;
    }
    case 'startWithAi': {
      if (!conn.room || conn.seat === null) {
        sendTo(conn, { type: 'error', code: 'E_STATE', message: '未加入房间' });
        return;
      }
      const room = conn.room;
      room.fillWithAi();
      room.setReady(conn.seat, true);
      room.broadcastRoomState();
      room.maybeAutoStart();
      break;
    }
    case 'action': {
      if (!conn.room || conn.seat === null) {
        sendTo(conn, { type: 'error', code: 'E_STATE', message: '未加入房间' });
        return;
      }
      if (!msg.action || typeof msg.action.type !== 'string') {
        sendTo(conn, { type: 'error', code: 'E_MSG', message: '动作格式错误' });
        return;
      }
      conn.room.handleAction(conn.seat, msg.action as never);
      break;
    }
    case 'reconnect':
      handleReconnect(conn, String(msg.roomCode), String(msg.token));
      break;
    case 'leaveRoom': {
      if (conn.room && conn.seat !== null) {
        const room = conn.room;
        room.detach(conn.seat);
        room.setReady(conn.seat, false);
        room.broadcastRoomState();
        logEvent(room.code, `座位 ${conn.seat} 离开房间`);
      }
      conn.room = null;
      conn.seat = null;
      conn.token = null;
      break;
    }
    case 'ping':
      sendTo(conn, { type: 'pong' });
      break;
    default:
      sendTo(conn, { type: 'error', code: 'E_UNKNOWN', message: `未知消息类型 ${String((msg as { type: string }).type)}` });
  }
}

const DEMO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'h5-demo');

const httpServer = createServer((req, res) => {
  // H5 调试客户端静态托管
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(join(DEMO_DIR, 'index.html')));
    return;
  }
  if (req.url === '/main.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(readFileSync(join(DEMO_DIR, 'dist', 'main.js')));
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        uptime: process.uptime(),
        rooms: rooms.size,
        handsPlayed: [...rooms.values()].reduce((a, r) => a + r.handCount, 0),
      }),
    );
    return;
  }
  if (req.url === '/logs') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(logs.join('\n'));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (socket: WebSocket) => {
  const conn: ConnState = { socket, name: '玩家', room: null, seat: null, token: null };
  socket.on('message', (data: Parameters<typeof String>[number]) => {
    try {
      handleMessage(conn, String(data));
    } catch (e) {
      logEvent(conn.room?.code ?? '-', `处理消息异常: ${String((e as Error).message)}`);
      sendTo(conn, { type: 'error', code: 'E_INTERNAL', message: '服务端内部错误' });
    }
  });
  socket.on('close', () => {
    if (conn.room && conn.seat !== null) {
      conn.room.detach(conn.seat);
      conn.room.broadcastRoomState();
    }
  });
});

if (process.env.NODE_ENV !== 'test') {
  httpServer.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}（ws + /health）`);
  });
}

export { httpServer, rooms };
export type { ConnState, RoomSession };
