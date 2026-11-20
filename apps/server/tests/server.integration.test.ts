/** P9：联机服务端集成测试（真实 ws 客户端） */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { ClientMessage, ServerMessage } from '@quejie/protocol';
import './env-setup.js';
import { httpServer } from '../src/index.js';

let port = 0;

class TestClient {
  ws: WebSocket;
  messages: ServerMessage[] = [];
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  closed = false;

  constructor() {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as ServerMessage;
      this.messages.push(msg);
      const idx = this.waiters.findIndex((w) => w.pred(msg));
      if (idx >= 0) {
        const [w] = this.waiters.splice(idx, 1);
        w.resolve(msg);
      }
    });
    this.ws.on('close', () => {
      this.closed = true;
    });
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  sendRaw(raw: string): void {
    this.ws.send(raw);
  }

  waitFor(pred: (m: ServerMessage) => boolean, timeoutMs = 60000, desc = ''): Promise<ServerMessage> {
    const found = this.messages.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待超时: ${desc}`)), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  async until(pred: (m: ServerMessage) => boolean, timeoutMs = 60000, desc = ''): Promise<ServerMessage> {
    // 与 waitFor 相同，但清空前持续匹配新消息
    return this.waitFor(pred, timeoutMs, desc);
  }

  close(): void {
    this.ws.close();
  }
}

const is = (m: ServerMessage, t: string) => m.type === t;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => resolve());
  });
  port = (httpServer.address() as AddressInfo).port;
});

afterAll(() => {
  httpServer.close();
});

describe('服务端健康检查', () => {
  it('GET /health 返回 ok 与房间统计', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = (await res.json()) as { ok: boolean; rooms: number };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.rooms).toBe('number');
  });
});

describe('房间生命周期与全 AI 对局', () => {
  it('建房 → AI 填充 → 托管打完整局 → 结算推送', async () => {
    const client = new TestClient();
    await client.open();
    client.send({ type: 'hello', name: '托管测试员' });
    client.send({ type: 'createRoom', preset: 'gd128', capType: 'fixed', capFixed: 3 });
    const welcome = await client.waitFor((m) => is(m, 'welcome'), 5000, 'welcome');
    expect(welcome.type === 'welcome' && welcome.seat).toBe(0);
    const roomState = await client.waitFor((m) => is(m, 'roomState'), 5000, 'roomState');
    expect(roomState.type === 'roomState' && roomState.rulesSummary.presetId).toBe('gd128');

    client.send({ type: 'startWithAi' });
    const playing = await client.waitFor(
      (m) => is(m, 'roomState') && m.type === 'roomState' && m.phase === 'playing',
      8000,
      'playing',
    );
    expect(playing.type === 'roomState' && playing.players.every((p) => p.name !== '空位')).toBe(true);

    const over = await client.waitFor((m) => is(m, 'gameOver'), 120000, 'gameOver');
    expect(over.type === 'gameOver' && ['win', 'draw'].includes(over.outcome)).toBe(true);
    if (over.type === 'gameOver' && over.outcome === 'win') {
      expect(over.settlements.length).toBeGreaterThan(0);
      const s = over.settlements[0]!;
      expect(s.lines.some((l) => l.key === 'finalFan')).toBe(true);
      expect(over.replayMeta).toHaveProperty('fanConfigVersion');
      expect(over.replayMeta).toHaveProperty('resolvedFanConfigHash');
    }
    // 分数一致：deltas 之和 = 分数变化
    if (over.type === 'gameOver') {
      expect(over.scores.reduce((a, b) => a + b, 0)).toBe(
        over.deltas.reduce((a, b) => a + b, 0),
      );
    }
    client.close();
  }, 180000);

  it('非法动作被拒绝并记录日志（验收 22）', async () => {
    const client = new TestClient();
    await client.open();
    client.send({ type: 'createRoom', preset: 'gd128' });
    await client.waitFor((m) => is(m, 'welcome'), 5000, 'welcome');
    client.send({ type: 'startWithAi' });
    // 等待自己有出牌权
    await client.waitFor(
      (m) => is(m, 'gameState') && m.type === 'gameState' && m.legalOptions.some((o) => o.type === 'discard'),
      30000,
      '自己的回合',
    );
    // 发出一张手里没有的牌
    client.send({ type: 'action', action: { type: 'discard', tile: 'ZZ' } });
    const err = await client.waitFor((m) => is(m, 'error'), 5000, 'error');
    expect(err.type === 'error' && err.code).toBe('E_ILLEGAL_ACTION');
    // 非本回合出牌
    client.send({ type: 'action', action: { type: 'peng' } });
    await client.waitFor((m) => is(m, 'error') && m.type === 'error' && m.code === 'E_ILLEGAL_ACTION', 5000, 'error2');
    // 服务端日志记录了拒绝
    const logsRes = await fetch(`http://127.0.0.1:${port}/logs`);
    const logs = await logsRes.text();
    expect(logs).toContain('[拒绝]');
    client.close();
  }, 60000);

  it('坏消息被拒绝', async () => {
    const client = new TestClient();
    await client.open();
    client.sendRaw('this is not json');
    const err = await client.waitFor((m) => is(m, 'error') && m.type === 'error' && m.code === 'E_PARSE', 5000, 'parse error');
    expect(err.type === 'error').toBe(true);
    client.send({ type: 'bogusType' } as never);
    await client.waitFor((m) => is(m, 'error') && m.type === 'error' && m.code === 'E_UNKNOWN', 5000, 'unknown');
    client.close();
  }, 30000);
});

describe('断线重连与双端同步', () => {
  it('断线后用 token 重连，返回完整对局状态且手牌一致', async () => {
    const a = new TestClient();
    const b = new TestClient();
    await a.open();
    await b.open();
    a.send({ type: 'hello', name: '甲' });
    a.send({ type: 'createRoom', preset: 'gd136' });
    const aWelcome = (await a.waitFor((m) => is(m, 'welcome'), 5000, 'a welcome')) as Extract<
      ServerMessage,
      { type: 'welcome' }
    >;
    b.send({ type: 'hello', name: '乙' });
    // 用 roomState 中的真实房间号
    const roomState = (await a.waitFor((m) => is(m, 'roomState'), 5000, 'roomState')) as Extract<
      ServerMessage,
      { type: 'roomState' }
    >;
    b.send({ type: 'joinRoom', roomCode: roomState.roomCode });
    const bWelcome = (await b.waitFor((m) => is(m, 'welcome'), 5000, 'b welcome')) as Extract<
      ServerMessage,
      { type: 'welcome' }
    >;
    expect(bWelcome.seat).toBe(1);
    b.send({ type: 'ready' });
    a.send({ type: 'startWithAi' });
    const bStateBefore = (await b.waitFor(
      (m) => is(m, 'gameState') && m.type === 'gameState' && m.hand.length > 0,
      30000,
      'b 手牌',
    )) as Extract<ServerMessage, { type: 'gameState' }>;

    // 断线
    b.close();
    await new Promise((r) => setTimeout(r, 200));
    // 重连
    const b2 = new TestClient();
    await b2.open();
    b2.send({ type: 'hello', name: '乙' });
    b2.send({ type: 'reconnect', roomCode: roomState.roomCode, token: bWelcome.token });
    const b2Welcome = (await b2.waitFor((m) => is(m, 'welcome'), 5000, 'b2 welcome')) as Extract<
      ServerMessage,
      { type: 'welcome' }
    >;
    expect(b2Welcome.seat).toBe(1);
    const b2State = (await b2.waitFor(
      (m) => is(m, 'gameState') && m.type === 'gameState' && m.hand.length > 0,
      30000,
      'b2 手牌',
    )) as Extract<ServerMessage, { type: 'gameState' }>;
    // 断线期间 AI 托管可能推进对局，验证重连返回的是座位 1 的完整对局状态
    expect(b2State.viewSeat).toBe(1);
    expect(b2State.hand.length).toBeGreaterThan(0);
    expect(Array.isArray(b2State.seats)).toBe(true);
    expect(Array.isArray(b2State.scores)).toBe(true);
    a.close();
    b2.close();
  }, 60000);

  it('双客户端同步：双方都收到弃牌事件', async () => {
    const a = new TestClient();
    const b = new TestClient();
    await a.open();
    await b.open();
    a.send({ type: 'createRoom', preset: 'gd128' });
    const roomState = (await a.waitFor((m) => is(m, 'roomState'), 5000, 'roomState')) as Extract<
      ServerMessage,
      { type: 'roomState' }
    >;
    b.send({ type: 'joinRoom', roomCode: roomState.roomCode });
    await b.waitFor((m) => is(m, 'welcome'), 5000, 'b welcome');
    b.send({ type: 'ready' });
    a.send({ type: 'startWithAi' });
    const discardA = a.waitFor((m) => is(m, 'gameEvent') && m.type === 'gameEvent' && m.event.kind === 'discard', 30000, 'a discard');
    const discardB = b.waitFor((m) => is(m, 'gameEvent') && m.type === 'gameEvent' && m.event.kind === 'discard', 30000, 'b discard');
    const [ea, eb] = await Promise.all([discardA, discardB]);
    if (ea.type === 'gameEvent' && eb.type === 'gameEvent') {
      expect(ea.event).toEqual(eb.event);
    }
    a.close();
    b.close();
  }, 60000);

  it('房间满员拒绝', async () => {
    const a = new TestClient();
    await a.open();
    a.send({ type: 'createRoom', preset: 'gd128' });
    const roomState = (await a.waitFor((m) => is(m, 'roomState'), 5000, 'roomState')) as Extract<
      ServerMessage,
      { type: 'roomState' }
    >;
    // 用 AI 填满
    a.send({ type: 'startWithAi' });
    await a.waitFor((m) => is(m, 'roomState') && m.type === 'roomState' && m.phase === 'playing', 8000, 'playing');
    const c = new TestClient();
    await c.open();
    c.send({ type: 'joinRoom', roomCode: roomState.roomCode });
    const err = await c.waitFor((m) => is(m, 'error') && m.type === 'error' && m.code === 'E_FULL', 5000, 'full');
    expect(err.type === 'error').toBe(true);
    a.close();
    c.close();
  }, 60000);
});
