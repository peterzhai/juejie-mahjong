/**
 * 雀界·广东麻将 H5 调试客户端（联机 + 本地 PVE 双模式）
 * DOM 渲染，data-testid 锚点供端到端自动化使用。
 */

import type { ClientMessage, ServerMessage, Seat } from '@quejie/protocol';
import {
  MahjongGame,
  aiDecide,
  mulberry32,
  type PlayerAction,
} from '@quejie/mahjong-core';
import { defaultFanConfig, resolveFanConfig, tileLabel, type ResolvedFanConfig } from '@quejie/fan-config';

// —— 模式与状态 ——
let ws: WebSocket | null = null;
let token = '';
let mySeat: Seat = 0;
let roomCode = '';
let serverState: Extract<ServerMessage, { type: 'gameState' }> | null = null;
let selectedTile: string | null = null;
let local: {
  game: MahjongGame;
  resolved: ResolvedFanConfig;
  scores: number[];
  rngSeed: number;
} | null = null;

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const autoPlayBox = $('auto-play') as HTMLInputElement;

function log(msg: string): void {
  const el = $('log');
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.prepend(line);
}

function showPanel(id: string): void {
  for (const p of ['room-panel', 'table-panel']) {
    $(p).classList.toggle('hidden', p !== id);
  }
}

function capOf(mode: string): { capType?: string; capFixed?: number } {
  switch (mode) {
    case 'fixed3': return { capType: 'fixed', capFixed: 3 };
    case 'fixed5': return { capType: 'fixed', capFixed: 5 };
    case 'tiered': return { capType: 'tiered' };
    case 'formula': return { capType: 'formula' };
    case 'unlimited': return { capType: 'unlimited' };
    default: return {};
  }
}

function seatName(seat: number): string {
  return serverState?.seats[seat]?.name ?? `座位${seat}`;
}

// —— 联机 ——
function connectWs(): Promise<void> {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('ws 连接失败'));
    ws.onclose = () => {
      $('conn-status').textContent = '已断开';
      log('WebSocket 断开');
    };
    ws.onmessage = (ev) => onServerMessage(JSON.parse(String(ev.data)) as ServerMessage);
  });
}

function send(msg: ClientMessage): void {
  ws?.send(JSON.stringify(msg));
}

function onServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case 'welcome':
      token = msg.token;
      mySeat = msg.seat;
      $('conn-status').textContent = `座位 ${msg.seat}`;
      break;
    case 'roomState':
      roomCode = msg.roomCode;
      $('room-code').textContent = String(msg.roomCode);
      $('rules-summary').textContent =
        `${msg.rulesSummary.presetId}｜${msg.rulesSummary.totalTiles}张｜牌墙${msg.rulesSummary.wallTiles}｜` +
        `红中:${msg.rulesSummary.redCenterMode}｜${msg.rulesSummary.capDesc}｜${msg.rulesSummary.scoringMode}`;
      renderPlayers(msg.players);
      if (msg.phase === 'playing') showPanel('table-panel');
      break;
    case 'gameState':
      serverState = msg;
      selectedTile = null;
      renderTable();
      break;
    case 'gameEvent':
      logEventMsg(msg.event);
      break;
    case 'gameOver':
      renderSettle(msg.settlements, msg.outcome, msg.scores);
      log(`对局结束：${msg.outcome === 'win' ? '胡牌' : '流局'}`);
      break;
    case 'error':
      log(`[错误] ${msg.code}: ${msg.message}`);
      break;
    default:
      break;
  }
}

function logEventMsg(event: { kind: string; [k: string]: unknown }): void {
  const seatOf = (s: unknown) => seatName(s as number);
  switch (event.kind) {
    case 'discard': log(`${seatOf(event.seat)} 打出 ${tileLabel(String(event.tile))}`); break;
    case 'peng': log(`${seatOf(event.seat)} 碰 ${tileLabel(String(event.tile))}`); break;
    case 'mingang': log(`${seatOf(event.seat)} 明杠 ${tileLabel(String(event.tile))}`); break;
    case 'ankang': log(`${seatOf(event.seat)} 暗杠`); break;
    case 'bugang': log(`${seatOf(event.seat)} 补杠 ${tileLabel(String(event.tile))}`); break;
    case 'hu': log(`${seatOf(event.seat)} 胡牌！（${event.via === 'self' ? '自摸' : event.via === 'robKong' ? '抢杠' : '点炮'}）`); break;
    case 'kongScore': log(`杠分：${seatOf(event.from)} → ${seatOf(event.to)} ${event.amount} 分`); break;
  }
}

function renderPlayers(players: { seat: number; name: string; ai: boolean; ready: boolean; connected: boolean }[]): void {
  const el = $('players');
  el.innerHTML = '';
  for (const p of players) {
    const span = document.createElement('span');
    span.className = 'badge';
    span.dataset.testid = `player-${p.seat}`;
    span.textContent = `${p.seat === mySeat ? '★' : ''}${p.name}${p.ai ? '(AI)' : ''}${p.ready ? '✓' : ''}${p.connected ? '' : '(断线)'}`;
    el.appendChild(span);
  }
}

function tileEl(tile: string, small: boolean, onClick?: () => void): HTMLElement {
  const el = document.createElement('span');
  el.className = `tile${small ? ' small' : ''}`;
  el.textContent = tileLabel(tile);
  el.dataset.testid = small ? `tile-sm-${tile}` : `hand-tile-${tile}`;
  el.dataset.tile = tile;
  if (onClick) el.onclick = onClick;
  return el;
}

/** 统一渲染牌桌（联机/本地共用 serverState 快照） */
function renderTable(): void {
  if (!serverState) return;
  const st = serverState;
  $('wall-count').textContent = `牌墙 ${st.wallRemaining - st.deadWall} / ${st.wallRemaining}（死墙 ${st.deadWall}）`;
  $('dealer-info').textContent = `庄家：座位 ${st.dealer}｜本局`;
  $('scores').textContent = `分数 ${st.scores.map((s, i) => `${seatName(i)}:${s}`).join('　')}`;
  $('claim-hint').textContent = st.phase === 'claim' ? `等待响应 ${st.claimTile ?? ''}` : '';

  for (let s = 0; s < 4; s++) {
    const seatEl = $(`seat-${s}`);
    seatEl.innerHTML = '';
    seatEl.classList.toggle('current', s === st.currentSeat && st.phase !== 'over');
    const seat = st.seats[s]!;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `${s === st.viewSeat ? '★' : ''}${seat.name}${seat.ai ? '(AI)' : ''}${seat.connected ? '' : '(断线)'}`;
    seatEl.appendChild(name);
    const melds = document.createElement('span');
    melds.className = 'melds';
    for (const m of seat.melds) {
      const label = document.createElement('span');
      label.textContent = `[${m.type === 'peng' ? '碰' : m.type === 'ankang' ? '暗杠' : m.type === 'bugang' ? '补杠' : '明杠'}]`;
      label.style.color = '#9fd0b2';
      melds.appendChild(label);
      melds.appendChild(tileEl(m.tile, true));
    }
    seatEl.appendChild(melds);
    const river = document.createElement('span');
    river.className = 'river';
    river.dataset.testid = `river-${s}`;
    for (const t of seat.discards) river.appendChild(tileEl(t, true));
    seatEl.appendChild(river);
    if (s === st.viewSeat) {
      const hand = document.createElement('span');
      hand.dataset.testid = 'hand';
      for (const t of st.hand) hand.appendChild(tileEl(t, false, () => onHandTileClick(t)));
      seatEl.appendChild(document.createTextNode(' 手牌: '));
      seatEl.appendChild(hand);
      if (st.drewTile && st.phase === 'turn') {
        const drawn = document.createElement('span');
        drawn.textContent = `（刚摸：${tileLabel(st.drewTile)}）`;
        drawn.style.color = '#e8c56a';
        seatEl.appendChild(drawn);
      }
    } else {
      seatEl.appendChild(document.createTextNode(` 手牌 × ${seat.handCount}`));
    }
  }
  renderActions();
  if (autoPlayBox.checked) autoAct();
}

function onHandTileClick(tile: string): void {
  if (!serverState) return;
  const st = serverState;
  if (st.phase !== 'turn' || st.currentSeat !== st.viewSeat) return;
  const canDiscard = st.legalOptions.some((o) => o.type === 'discard' && o.tile === tile);
  if (!canDiscard) return;
  if (selectedTile === tile) {
    doAction({ type: 'discard', tile });
    selectedTile = null;
  } else {
    selectedTile = tile;
    renderTable();
    const el = document.querySelector(`[data-testid="hand-tile-${tile}"]`) as HTMLElement | null;
    el?.classList.add('sel');
  }
}

function doAction(action: PlayerAction): void {
  if (local) {
    const game = local.game;
    const before = game.events.length;
    game.action(0, action);
    logLocalEvents(before);
    if (game.result) {
      finishLocalHand();
      return;
    }
    renderLocal();
    driveLocalAi();
  } else {
    send({ type: 'action', action });
  }
}

function renderActions(): void {
  const bar = $('action-bar');
  bar.innerHTML = '';
  if (!serverState) return;
  const st = serverState;
  const addBtn = (testid: string, text: string, cls: string, onClick: () => void): void => {
    const b = document.createElement('button');
    b.dataset.testid = testid;
    b.textContent = text;
    b.className = cls;
    b.onclick = onClick;
    bar.appendChild(b);
  };
  const myTurn = st.phase === 'turn' && st.currentSeat === st.viewSeat && !(local && local.game.result);
  if (myTurn) {
    const hu = st.legalOptions.find((o) => o.type === 'hu');
    if (hu) addBtn('btn-hu', '胡牌！', 'hu', () => doAction({ type: 'hu' }));
    for (const o of st.legalOptions) {
      if (o.type === 'ankang') addBtn('btn-ankang', `暗杠 ${tileLabel(o.tile!)}`, '', () => doAction({ type: 'ankang', tile: o.tile }));
      if (o.type === 'bugang') addBtn('btn-bugang', `补杠 ${tileLabel(o.tile!)}`, '', () => doAction({ type: 'bugang', tile: o.tile }));
    }
    if (selectedTile) {
      addBtn('btn-discard', `出牌 ${tileLabel(selectedTile)}`, 'primary', () => {
        doAction({ type: 'discard', tile: selectedTile! });
        selectedTile = null;
      });
    }
  }
  if (st.phase === 'claim' && st.legalOptions.length > 0) {
    const has = (t: string) => st.legalOptions.some((o) => o.type === t);
    if (has('hu')) addBtn('btn-hu', '胡！', 'hu', () => doAction({ type: 'hu' }));
    if (has('peng')) addBtn('btn-peng', '碰', '', () => doAction({ type: 'peng' }));
    if (has('mingang')) addBtn('btn-mingang', '明杠', '', () => doAction({ type: 'mingang' }));
    addBtn('btn-pass', '过', '', () => doAction({ type: 'pass' }));
  }
}

function autoAct(): void {
  if (!serverState || local?.game.result) return;
  const st = serverState;
  setTimeout(() => {
    if (st.phase === 'turn' && st.currentSeat === st.viewSeat) {
      const hu = st.legalOptions.find((o) => o.type === 'hu');
      if (hu) return doAction({ type: 'hu' });
      const gang = st.legalOptions.find((o) => o.type === 'ankang' || o.type === 'bugang');
      if (gang) return doAction({ type: gang.type as 'ankang' | 'bugang', tile: gang.tile });
      const discard = st.legalOptions.find((o) => o.type === 'discard');
      if (discard) doAction({ type: 'discard', tile: discard.tile });
    } else if (st.phase === 'claim' && st.legalOptions.length > 0) {
      const hu = st.legalOptions.find((o) => o.type === 'hu');
      const peng = st.legalOptions.find((o) => o.type === 'peng');
      if (hu) doAction({ type: 'hu' });
      else if (peng) doAction({ type: 'peng' });
      else doAction({ type: 'pass' });
    }
  }, 80);
}

interface SettleLineView { key: string; label: string; detail: string }
interface SettleView {
  winnerSeat: number;
  lines: SettleLineView[];
  paymentKind: string;
  payerSeat: number | null;
  score: number;
  baoReasons: string[];
}

function renderSettle(settlements: SettleView[], outcome: string, scores: number[]): void {
  const el = $('settle');
  el.innerHTML = '';
  const head = document.createElement('div');
  head.textContent = outcome === 'win' ? '胡牌结算' : '流局（杠分退回）';
  head.style.color = '#e8c56a';
  el.appendChild(head);
  for (const s of settlements) {
    const seatLine = document.createElement('div');
    seatLine.style.fontWeight = '700';
    seatLine.dataset.testid = 'settle-winner';
    seatLine.textContent =
      `${seatName(s.winnerSeat)} 胡牌｜${s.paymentKind === 'bao' ? `包三家（${s.baoReasons.join(';')}）` : s.paymentKind === 'selfDraw' ? '自摸' : '点炮'}｜${s.score} 分`;
    el.appendChild(seatLine);
    for (const l of s.lines) {
      const line = document.createElement('div');
      line.className = 'l';
      line.dataset.testid = `settle-line-${l.key}`;
      line.innerHTML = `<span>${l.label}</span><b>${l.detail}</b>`;
      el.appendChild(line);
    }
  }
  const total = document.createElement('div');
  total.style.marginTop = '6px';
  total.textContent = `累计分数：${scores.map((v, i) => `${seatName(i)}:${v}`).join('　')}`;
  el.appendChild(total);
}

// —— 本地 PVE ——
function buildLocalConfig(preset: string, capMode: string): { resolved: ResolvedFanConfig | null; errors: string } {
  const cap = capOf(capMode);
  const cfg = defaultFanConfig();
  cfg.tileSet = structuredClone(cfg.tileSet);
  cfg.tileSet.preset = preset;
  if (cfg.tileSet.redCenterMode !== 'wild') cfg.scoring.redCenterBonus.enabled = false;
  if (cap.capType === 'unlimited') {
    cfg.scoring.cap = { enabled: true, value: { type: 'unlimited' }, hardCap: 10, maxScore: 1000000, minFan: 0, scope: 'global', groups: [], bypass: cfg.scoring.cap.bypass };
  } else if (cap.capType === 'tiered') {
    cfg.scoring.cap = { enabled: true, value: { type: 'tiered', tiers: [3, 4, 5], tierSelector: 'roomLevel' }, hardCap: 10, minFan: 1, maxScore: 1000000, scope: 'global', groups: [], bypass: cfg.scoring.cap.bypass };
  } else if (cap.capType === 'formula') {
    cfg.scoring.cap = { enabled: true, value: { type: 'formula', formula: 'clamp(3 + floor(kongCount / 2), minFan, hardCap)', hardCap: 10 }, minFan: 1, maxScore: 1000000, scope: 'global', groups: [], bypass: cfg.scoring.cap.bypass };
  } else if (cap.capType === 'fixed') {
    cfg.scoring.cap.value = { type: 'fixed', fixed: cap.capFixed ?? 3 };
  }
  const r = resolveFanConfig(cfg);
  return { resolved: r.resolved ?? null, errors: r.errors.map((e) => e.message).join('; ') };
}

function startLocal(): void {
  const name = ($('name-input') as HTMLInputElement).value || '玩家';
  const preset = ($('preset-select') as HTMLSelectElement).value;
  const capMode = ($('cap-select') as HTMLSelectElement).value;
  const { resolved, errors } = buildLocalConfig(preset, capMode);
  if (!resolved) {
    alert(`配置错误: ${errors}`);
    return;
  }
  const seed = Date.now() & 0x7fffffff;
  local = {
    game: new MahjongGame({
      resolved,
      seed,
      dealer: 0,
      roundWind: 'east',
      roomLevel: 1,
      playerNames: [name, 'AI·东', 'AI·南', 'AI·西'],
    }),
    resolved,
    scores: [0, 0, 0, 0],
    rngSeed: seed + 1,
  };
  local.game.start();
  roomCode = '本地单机';
  $('room-code').textContent = '本地单机';
  const cap = resolved.scoring.cap;
  $('rules-summary').textContent =
    `${preset}｜${resolved.tileMath.totalTiles}张｜红中:${resolved.redCenterMode}｜${!cap.enabled ? '不封顶' : cap.value.type === 'fixed' ? `封顶 ${cap.value.fixed} 番` : `封顶(${cap.value.type})`}`;
  showPanel('table-panel');
  renderLocal();
  driveLocalAi();
}

/** 将本地引擎状态投影为 serverState 快照并渲染 */
function renderLocal(): void {
  const game = local!.game;
  const hand: string[] = [];
  game.players[0]!.hand.forEach((c, i) => {
    for (let k = 0; k < c; k++) hand.push(game.index.tile(i));
  });
  serverState = {
    type: 'gameState',
    viewSeat: 0,
    dealer: game.dealer,
    currentSeat: game.currentSeat,
    phase: game.phase,
    seats: game.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      handCount: p.hand.reduce((a, b) => a + b, 0),
      melds: p.melds.map((m) => ({ type: m.type, tile: m.tile, fromSeat: m.fromSeat })),
      discards: [...p.discards],
      connected: true,
      ai: p.seat !== 0,
    })),
    hand,
    drewTile: game.drewTile,
    wallRemaining: game.wall.liveRemaining,
    deadWall: game.wall.deadWallCount,
    legalOptions: game.legalOptions(0),
    claimTile: game.claim?.tile,
    claimFrom: game.claim?.fromSeat,
    scores: local!.scores,
  };
  renderTable();
}

function logLocalEvents(from: number): void {
  const game = local!.game;
  for (let i = from; i < game.events.length; i++) {
    const e = game.events[i]!;
    if (e.type === 'discard') log(`${game.players[e.seat]!.name} 打出 ${tileLabel(e.tile)}`);
    else if (e.type === 'peng') log(`${game.players[e.seat]!.name} 碰 ${tileLabel(e.tile)}`);
    else if (e.type === 'mingang') log(`${game.players[e.seat]!.name} 明杠 ${tileLabel(e.tile)}`);
    else if (e.type === 'ankang') log(`${game.players[e.seat]!.name} 暗杠`);
    else if (e.type === 'bugang') log(`${game.players[e.seat]!.name} 补杠 ${tileLabel(e.tile)}`);
    else if (e.type === 'hu') log(`${game.players[e.seat]!.name} 胡牌！`);
    else if (e.type === 'kongScore') log(`杠分 ${game.players[e.from]!.name} → ${game.players[e.to]!.name}`);
  }
}

function driveLocalAi(): void {
  const game = local!.game;
  if (game.result) {
    finishLocalHand();
    return;
  }
  if (game.phase === 'claim') {
    const pending = game.claim!.pendingSeats.filter((s) => !game.claim!.responses.has(s));
    if (pending.length === 0) {
      const before = game.events.length;
      game.autoPassPending();
      logLocalEvents(before);
      if (game.result) {
        finishLocalHand();
        return;
      }
      renderLocal();
      driveLocalAi();
      return;
    }
    const seat = pending[0]!;
    if (seat === 0) return; // 等待人类响应
    setTimeout(() => {
      if (!local || !local.game.claim || local.game.phase !== 'claim') return;
      const g = local.game;
      const before = g.events.length;
      const action = aiDecide(g, seat, { difficulty: 'hard', rng: mulberry32(local.rngSeed++), timeBudgetMs: 60 });
      g.action(seat, action);
      logLocalEvents(before);
      if (g.result) {
        finishLocalHand();
        return;
      }
      renderLocal();
      driveLocalAi();
    }, 120);
    return;
  }
  const seat = game.currentSeat;
  if (seat === 0) return; // 等待人类
  setTimeout(() => {
    if (!local) return;
    const g = local.game;
    if (g.result) {
      finishLocalHand();
      return;
    }
    if (g.currentSeat !== seat || g.phase !== 'turn') {
      driveLocalAi();
      return;
    }
    const before = g.events.length;
    const action = aiDecide(g, seat, { difficulty: 'hard', rng: mulberry32(local.rngSeed++), timeBudgetMs: 60 });
    g.action(seat, action);
    logLocalEvents(before);
    if (g.result) {
      finishLocalHand();
      return;
    }
    renderLocal();
    driveLocalAi();
  }, 150);
}

function finishLocalHand(): void {
  const result = local!.game.result!;
  for (let s = 0; s < 4; s++) local!.scores[s]! += result.deltas[s]!;
  renderLocal();
  renderSettle(result.settlements, result.outcome, local!.scores);
  log(`本地对局结束：${result.outcome === 'win' ? '胡牌' : '流局'}，庄家下一局：座位 ${result.dealerNext}`);
}

// —— 事件绑定 ——
$('btn-local').onclick = () => {
  mySeat = 0;
  startLocal();
};
$('btn-create').onclick = async () => {
  try {
    await connectWs();
  } catch {
    log('无法连接服务端（本地单机仍可用）');
    return;
  }
  const preset = ($('preset-select') as HTMLSelectElement).value;
  const cap = capOf(($('cap-select') as HTMLSelectElement).value);
  send({ type: 'hello', name: ($('name-input') as HTMLInputElement).value || '玩家' });
  send({
    type: 'createRoom',
    preset,
    roomLevel: 1,
    capType: cap.capType as 'fixed' | 'tiered' | 'formula' | 'unlimited' | undefined,
    capFixed: cap.capFixed,
  });
  showPanel('room-panel');
};
$('btn-join').onclick = async () => {
  const code = ($('join-code') as HTMLInputElement).value.trim();
  if (!code) return;
  try {
    await connectWs();
  } catch {
    return;
  }
  send({ type: 'hello', name: ($('name-input') as HTMLInputElement).value || '玩家' });
  send({ type: 'joinRoom', roomCode: code });
  showPanel('room-panel');
};
$('btn-ready').onclick = () => send({ type: 'ready' });
$('btn-start-ai').onclick = () => send({ type: 'startWithAi' });
$('btn-leave').onclick = () => {
  send({ type: 'leaveRoom' });
  showPanel('room-panel');
  $('table-panel').classList.add('hidden');
};
void roomCode;
void token;
