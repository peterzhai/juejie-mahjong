import { tileImages } from './tile-images.js';
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
import { defaultFanConfig, TILE_SET_PRESETS, clonePreset, autoDisableUnmetFans, DEFAULT_FANS, DEFAULT_BONUS_FANS, resolveFanConfig, tileLabel, type FanConfig, type ResolvedFanConfig } from '@quejie/fan-config';

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
  while (el.childElementCount > 200) el.lastElementChild?.remove();
}

function showPanel(id: string): void {
  const playing = id === 'table-panel';
  document.body.classList.toggle('in-game', playing);
  $('btn-home').classList.toggle('hidden', !playing);
  if (location.hash !== (playing ? '#game' : '#lobby')) history.pushState(null, '', playing ? '#game' : '#lobby');
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
    const chip = document.createElement('span');
    chip.className = `player-chip${p.seat === mySeat ? ' me' : ''}`;
    chip.dataset.testid = `player-${p.seat}`;
    chip.appendChild(avatarEl(p.seat, p.name, 30));
    const info = document.createElement('span');
    info.textContent = `${p.name}${p.ai ? ' (AI)' : ''} · ${p.ready ? '已准备' : '未准备'}${p.connected ? '' : '（断线）'}`;
    chip.appendChild(info);
    el.appendChild(chip);
  }
}

const SEAT_COLORS = ['#d94f3d', '#3d7dd9', '#e8a13c', '#8a5fd0'];

function avatarEl(seat: number, name: string, size = 34): HTMLElement {
  const el = document.createElement('span');
  el.className = 'avatar';
  el.style.width = el.style.height = `${size}px`;
  el.style.fontSize = `${Math.round(size * 0.48)}px`;
  el.style.background = `linear-gradient(160deg, ${SEAT_COLORS[seat % 4]}, ${SEAT_COLORS[seat % 4]}88)`;
  el.textContent = (name || '玩家')[0] ?? '牌';
  return el;
}

/** 牌排序：万→条→筒→花→风→字 */
function sortTiles(ids: string[]): string[] {
  const key = (id: string): number => {
    const p = id[0]!;
    const suit = p === 'C' ? 0 : p === 'B' ? 1 : p === 'D' ? 2 : p === 'F' ? 3 : p === 'W' ? 4 : p === 'H' ? 5 : 6;
    let rank = 0;
    if (/[CBD]/.test(p)) rank = parseInt(id[1]!, 10);
    else if (p === 'F') rank = parseInt(id[1]!, 10);
    else if (p === 'W') rank = 'ESWN'.indexOf(id[1]!);
    else if (p === 'H') rank = 'RGW'.indexOf(id[1]!);
    return suit * 100 + rank;
  };
  return [...ids].sort((a, b) => key(a) - key(b));
}

function tileEl(tile: string, small: boolean, onClick?: () => void): HTMLElement {
  const el = document.createElement('span');
  el.className = `tile${small ? ' small' : ''}`;
  const artwork = tileImages[tile];
  if (artwork) {
    const img = document.createElement('img');
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(artwork)}`;
    img.alt = tileLabel(tile);
    img.draggable = false;
    el.appendChild(img);
  } else el.textContent = tileLabel(tile);
  el.title = tileLabel(tile);
  el.dataset.testid = small ? `tile-sm-${tile}` : `hand-tile-${tile}`;
  el.dataset.tile = tile;
  if (onClick) el.onclick = onClick;
  return el;
}

function tileBackEl(small: boolean): HTMLElement {
  const el = document.createElement('span');
  el.className = `tile back${small ? ' small' : ''}`;
  return el;
}

/** 统一渲染牌桌（联机/本地共用 serverState 快照） */
function renderTable(): void {
  if (!serverState) return;
  const st = serverState;
  $('wall-count').textContent = `牌墙 ${st.wallRemaining - st.deadWall} / ${st.wallRemaining}（死墙 ${st.deadWall}）`;
  $('dealer-info').textContent = `庄家：座位 ${st.dealer}｜本局`;
  $('scores').textContent = `分数 ${st.scores.map((s, i) => `${seatName(i)}:${s}`).join('　')}`;
  const hint = $('claim-hint');
  if (st.phase === 'claim') {
    hint.textContent = `等待响应 ${tileLabel(st.claimTile ?? '')}（碰 / 杠 / 胡 / 过）`;
    hint.className = 'claim-banner';
  } else {
    hint.textContent = '';
    hint.className = '';
  }
  $('center-info').innerHTML =
    `轮到 <b>${seatName(st.currentSeat)}</b> ${st.phase === 'claim' ? '等待宣告' : st.phase === 'turn' ? '出牌' : st.phase === 'over' ? '' : ''}<br>` +
    `阶段：${st.phase}｜剩余手牌 ${st.hand.length} 张`;

  const count = st.seats.length;
  const positions = count === 2 ? [0, 2] : count === 3 ? [0, 1, 3] : [0, 1, 2, 3];
  for (let position = 0; position < 4; position++) {
    const seatEl = $(`seat-${position}`);
    seatEl.replaceChildren();
    seatEl.classList.remove('current');
    seatEl.classList.toggle('hidden', !positions.includes(position));
  }
  for (let offset = 0; offset < count; offset++) {
    const s = (st.viewSeat + offset) % count;
    const seatEl = $(`seat-${positions[offset]}`);
    seatEl.dataset.seat = String(s);
    const isTurn = s === st.currentSeat && st.phase !== 'over';
    seatEl.classList.toggle('current', isTurn);
    const seat = st.seats[s]!;
    const isMe = s === st.viewSeat;

    const head = document.createElement('div');
    head.className = 'head';
    head.appendChild(avatarEl(s, seat.name, 34));
    const nameWrap = document.createElement('div');
    const nameEl = document.createElement('div');
    nameEl.className = 'name';
    nameEl.textContent = `${isMe ? '★ ' : ''}${seat.name}`;
    if (s === st.dealer) {
      const tag = document.createElement('span');
      tag.className = 'dealer-tag';
      tag.textContent = '庄';
      nameEl.appendChild(tag);
    }
    const subEl = document.createElement('div');
    subEl.className = 'sub';
    subEl.textContent = `${seat.ai ? 'AI · ' : ''}手牌 ${seat.handCount} 张${seat.connected ? '' : ' · 断线'}`;
    nameWrap.appendChild(nameEl);
    nameWrap.appendChild(subEl);
    head.appendChild(nameWrap);
    seatEl.appendChild(head);

    if (seat.melds.length > 0) {
      const melds = document.createElement('div');
      melds.className = 'melds';
      for (const m of seat.melds) {
        const tag = document.createElement('span');
        tag.className = 'meld-tag';
        tag.textContent = m.type === 'peng' ? '碰' : m.type === 'ankang' ? '暗杠' : m.type === 'bugang' ? '补杠' : '明杠';
        melds.appendChild(tag);
        melds.appendChild(tileEl(m.tile, true));
      }
      seatEl.appendChild(melds);
    }

    const river = document.createElement('div');
    river.className = 'river';
    river.dataset.testid = `river-${s}`;
    let lastTile: HTMLElement | null = null;
    for (const t of seat.discards) {
      lastTile = tileEl(t, true);
      river.appendChild(lastTile);
    }
    lastTile?.classList.add('last');
    seatEl.appendChild(river);

    if (isMe) {
      const handWrap = document.createElement('div');
      handWrap.className = 'hand-row';
      const hand = document.createElement('span');
      hand.dataset.testid = 'hand';
      for (const t of sortTiles(st.hand)) hand.appendChild(tileEl(t, false, () => onHandTileClick(t)));
      handWrap.appendChild(hand);
      if (st.drewTile && st.phase === 'turn') {
        const drawn = document.createElement('span');
        drawn.className = 'drawn-mark';
        drawn.textContent = `摸牌 ${tileLabel(st.drewTile)}`;
        handWrap.appendChild(drawn);
      }
      seatEl.appendChild(handWrap);
    } else if (seat.handCount > 0) {
      const backs = document.createElement('div');
      backs.className = 'river';
      backs.style.marginTop = '6px';
      backs.dataset.testid = `opp-hand-${s}`;
      for (let i = 0; i < seat.handCount; i++) backs.appendChild(tileBackEl(true));
      seatEl.appendChild(backs);
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
  if (selectedTile === tile || ($('single-click') as HTMLInputElement).checked) {
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

let autoTimer: ReturnType<typeof setTimeout> | undefined;
function autoAct(): void {
  clearTimeout(autoTimer);
  if (!serverState || local?.game.result) return;
  const st = serverState;
  autoTimer = setTimeout(() => {
    if (serverState !== st || !autoPlayBox.checked) return;
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
  head.className = 'settle-head';
  head.textContent = outcome === 'win' ? '胡牌结算' : '流局（杠分退回）';
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
let lastConfig: FanConfig | undefined;
function buildLocalConfig(preset: string, capMode: string): { resolved: ResolvedFanConfig | null; errors: string } {
  const cap = capOf(capMode);
  const cfg = defaultFanConfig();
  cfg.tileSet = clonePreset(preset);
  cfg.fans = structuredClone(DEFAULT_FANS);
  cfg.bonusFans = structuredClone(DEFAULT_BONUS_FANS);
  cfg.tileSet.redCenterMode = ($("red-mode") as HTMLSelectElement).value as "wild" | "normal" | "off";
  if (cfg.tileSet.redCenterMode !== "off") cfg.tileSet.honors.red = { enabled: true, copies: 4 };
  cfg.tileSet.redCenterDrawOnly = ($("draw-only") as HTMLInputElement).checked;
  for (const fan of [...cfg.fans, ...cfg.bonusFans]) {
    fan.value = Number(($("fan-" + fan.id) as HTMLInputElement).value);
    fan.enabled = ($("enabled-" + fan.id) as HTMLInputElement).checked;
  }
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
  let finalConfig = autoDisableUnmetFans(cfg).config;
  try {
    const text = ($('full-config') as HTMLTextAreaElement).value.trim();
    if (text) finalConfig = JSON.parse(text) as FanConfig;
  } catch { return { resolved: null, errors: '完整配置 JSON 格式错误' }; }
  lastConfig = finalConfig;
  const r = resolveFanConfig(finalConfig);
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
      playerCount: Number(($("player-count") as HTMLSelectElement).value),
      seed,
      dealer: 0,
      roundWind: 'east',
      roomLevel: 1,
      playerNames: [name, 'AI·东', 'AI·南', 'AI·西'],
    }),
    resolved,
    scores: Array(Number(($("player-count") as HTMLSelectElement).value)).fill(0),
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
    }, aiDelay());
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
  }, aiDelay());
}

function finishLocalHand(): void {
  const result = local!.game.result!;
  for (let s = 0; s < local!.scores.length; s++) local!.scores[s]! += result.deltas[s]!;
  renderLocal();
  renderSettle(result.settlements, result.outcome, local!.scores);
  log(`本地对局结束：${result.outcome === 'win' ? '胡牌' : '流局'}，庄家下一局：座位 ${result.dealerNext}`);
}

// —— 事件绑定 ——
$('btn-home').onclick = () => {
  clearTimeout(autoTimer);
  autoPlayBox.checked = false;
  showPanel('room-panel');
};
window.addEventListener('popstate', () => showPanel(location.hash === '#game' && serverState ? 'table-panel' : 'room-panel'));
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
  const checked = buildLocalConfig(preset, ($('cap-select') as HTMLSelectElement).value);
  if (!checked.resolved) { alert(checked.errors); return; }
  const cap = capOf(($('cap-select') as HTMLSelectElement).value);
  send({ type: 'hello', name: ($('name-input') as HTMLInputElement).value || '玩家' });
  send({
    type: 'createRoom',
    config: lastConfig,
    playerCount: Number(($('player-count') as HTMLSelectElement).value),
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

// 设置持久化；存储不可用时仍保留当前会话的设置。
function aiDelay(): number { return Number(($('ai-delay') as HTMLSelectElement).value) || 600; }
const advanced = document.createElement('div');
advanced.innerHTML = `<p>以下高级规则用于本地单机。联机房间暂沿用服务端规则。红中变会在所选牌组中加入四张红中，无红中的方案总张数会增加四张。</p><label>人数<select id="player-count"><option value="2">2 人</option><option value="3">3 人</option><option value="4" selected>4 人</option></select></label><label>红中模式<select id="red-mode"><option value="wild">红中变（万能牌）</option><option value="normal">普通红中</option><option value="off">关闭红中变</option></select></label><label>红中变仅自摸<input type="checkbox" id="draw-only"></label><h2>番型与附加番</h2><p>勾选启用，右侧填写番数；缺少所需牌张的番型将自动禁用。</p>`;
for (const fan of [...DEFAULT_FANS, ...DEFAULT_BONUS_FANS]) {
  const row = document.createElement('label');
  row.innerHTML = `<span><input type="checkbox" id="enabled-${fan.id}" checked> ${fan.name}</span><input id="fan-${fan.id}" aria-label="${fan.name}番数" type="number" min="0" max="64" step="1" value="${fan.value}" style="width:80px">`;
  advanced.appendChild(row);
}
$('rule-settings').appendChild(advanced);
const full = document.createElement('details');
full.innerHTML = `<summary>完整规则配置（高级）</summary><p>完整配置优先于快捷选项。包含牌张数量、七对万能牌、番型、计分方式、底分、封顶范围/分组/突破条件、无红中加成、杠分、漏胡、一炮多响及包牌开关。</p><button type="button" id="load-config">载入当前快捷配置</button><button type="button" id="clear-config">恢复快捷配置</button><textarea id="full-config" aria-label="完整规则 JSON" rows="20" style="width:100%;font-family:monospace"></textarea>`;
$('rule-settings').appendChild(full);
$('load-config').onclick = () => {
  const area = $('full-config') as HTMLTextAreaElement;
  const previous = area.value; area.value = '';
  const result = buildLocalConfig(($('preset-select') as HTMLSelectElement).value, ($('cap-select') as HTMLSelectElement).value);
  area.value = result.resolved ? JSON.stringify(lastConfig, null, 2) : previous;
  renderConfigEditor();
  savePreferences();
};
$('clear-config').onclick = () => { ($('full-config') as HTMLTextAreaElement).value = ''; editor.replaceChildren(); savePreferences(); };
// A recursive editor exposes every field of the validated configuration, including arrays.
const editor = document.createElement('div');
full.appendChild(editor);
const names: Record<string, string> = { tileSet:'牌张组成', suits:'数字花色', character:'万', bamboo:'条', dot:'筒', honors:'字牌', flowers:'花牌', copies:'张数', enabled:'启用', scoring:'计分', mode:'模式', baseScore:'底分', cap:'封顶', value:'番数/参数', fixed:'固定番数', hardCap:'安全上限', minFan:'保底番', maxScore:'分数上限', scope:'封顶范围', groups:'分组封顶', bypass:'突破封顶', fanIds:'番型ID', conditions:'条件', redCenterBonus:'无红中加成', addFan:'增加番数', bypassCap:'封顶后加成', onlyWhenWild:'仅万能牌模式', rules:'玩法规则', missedWinLock:'漏胡锁定', multiWinEnabled:'一炮多响', robConcealedKongForThirteenOrphans:'十三幺抢暗杠', baoRobKong:'抢杠包牌', baoKongBlossom:'杠开包牌', baoTwelveExposed:'十二张落地包牌', baoBigDragonWind:'大三元大四喜包牌', kongScores:'杠分', mingangPayerMultiplier:'明杠支付倍数', bugangEach:'补杠各付', ankangEach:'暗杠各付', redCenterMode:'红中模式', redCenterDrawOnly:'仅自摸', sevenPairsWithWild:'七对允许万能牌', dealerExtraTile:'庄家额外牌', fans:'基础番型', bonusFans:'附加番', name:'名称', playerOffsets:'庄闲封顶偏移', dealer:'庄家', nonDealer:'闲家', type:'类型', tiers:'分档番数', formula:'计算公式' };
function renderConfigEditor(): void {
  editor.replaceChildren();
  const area = $('full-config') as HTMLTextAreaElement;
  let data: Record<string, unknown>;
  try { data = JSON.parse(area.value); } catch { return; }
  const persist = () => { area.value = JSON.stringify(data, null, 2); savePreferences(); };
  function visit(parent: HTMLElement, object: Record<string, unknown>, key: string): void {
    const value = object[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const section = document.createElement('details'); section.open = ['scoring', 'rules'].includes(key);
      const title = document.createElement('summary'); title.textContent = names[key] || key; section.appendChild(title);
      for (const child of Object.keys(value)) visit(section, value as Record<string, unknown>, child);
      parent.appendChild(section); return;
    }
    const row = document.createElement('label'); const title = document.createElement('span'); title.textContent = names[key] || key; row.appendChild(title);
    const input = document.createElement('input'); input.type = typeof value === 'boolean' ? 'checkbox' : typeof value === 'number' ? 'number' : 'text';
    input.style.width = '55%'; input.checked = value === true; input.value = Array.isArray(value) ? JSON.stringify(value) : String(value ?? '');
    input.onchange = () => { try { object[key] = Array.isArray(value) ? JSON.parse(input.value) : typeof value === 'boolean' ? input.checked : typeof value === 'number' ? Number(input.value) : input.value; input.setCustomValidity(''); persist(); } catch { input.setCustomValidity('请输入有效 JSON 数组'); input.reportValidity(); } };
    row.appendChild(input); parent.appendChild(row);
  }
  for (const key of Object.keys(data)) visit(editor, data, key);
}
$('load-config').addEventListener('click', renderConfigEditor);
$('full-config').addEventListener('change', renderConfigEditor);
$('clear-config').addEventListener('click', () => editor.replaceChildren());
const presetSelect = $('preset-select') as HTMLSelectElement;
presetSelect.replaceChildren();
for (const [id, preset] of Object.entries(TILE_SET_PRESETS)) {
  const option = document.createElement('option'); option.value = id; option.textContent = `${id} · ${preset.description}`; presetSelect.appendChild(option);
}
const preferenceIds = ['full-config', 'name-input', 'preset-select', 'cap-select', 'ai-delay', 'single-click', 'reduce-motion', 'player-count', 'red-mode', 'draw-only', ...[...DEFAULT_FANS, ...DEFAULT_BONUS_FANS].flatMap(f => ['fan-' + f.id, 'enabled-' + f.id])];
for (const id of ['name-input', 'preset-select', 'cap-select']) {
  const field = $(id);
  field.setAttribute('aria-label', id === 'name-input' ? '玩家昵称' : id === 'preset-select' ? '麻将规则' : '封顶番数');
  $('rule-settings').appendChild(field);
}
try {
  const saved = JSON.parse(localStorage.getItem('quejie-settings') || '{}') as Record<string, unknown>;
  for (const id of preferenceIds) {
    const field = $(id) as HTMLInputElement;
    if (!(id in saved)) continue;
    if (field.type === 'checkbox') field.checked = saved[id] === true;
    else if (typeof saved[id] === 'string') field.value = saved[id] as string;
  }
} catch { /* 无效或不可用的存储使用默认值。 */ }
function savePreferences(): void {
  document.body.classList.toggle('reduce-motion', ($('reduce-motion') as HTMLInputElement).checked);
  const values: Record<string, string | boolean> = {};
  for (const id of preferenceIds) { const field = $(id) as HTMLInputElement; values[id] = field.type === 'checkbox' ? field.checked : field.value; }
  try { localStorage.setItem('quejie-settings', JSON.stringify(values)); $('settings-status').textContent = '设置已保存'; }
  catch { $('settings-status').textContent = '设置仅在当前会话生效'; }
}
for (const id of preferenceIds) $(id).addEventListener('change', savePreferences);
savePreferences();
renderConfigEditor();
$('btn-settings').onclick = () => ($('settings-dialog') as HTMLDialogElement).showModal();
autoPlayBox.onchange = () => { if (autoPlayBox.checked) autoAct(); else clearTimeout(autoTimer); };
