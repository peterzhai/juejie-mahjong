import { tilePhotoPositions } from './tile-images.js';
/**
 * 雀界·广东麻将 H5 调试客户端（联机 + 本地 PVE 双模式）
 * DOM 渲染，data-testid 锚点供端到端自动化使用。
 */

import type { ClientMessage, HandScoreRecord, ServerMessage, Seat } from '@quejie/protocol';
import {
  MahjongGame,
  aiDecide,
  estimateSelfDraw,
  mulberry32,
  type PlayerAction,
} from '@quejie/mahjong-core';
import { defaultFanConfig, TILE_SET_PRESETS, clonePreset, autoDisableUnmetFans, DEFAULT_FANS, DEFAULT_BONUS_FANS, resolveFanConfig, tileLabel, type FanConfig, type ResolvedFanConfig } from '@quejie/fan-config';

// —— 模式与状态 ——
let ws: WebSocket | null = null;
let roomToken = '';
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectAttempts = 0;
let restoringRoom = false;
let mySeat: Seat = 0;
let roomCode = '';
let handHistory: HandScoreRecord[] = [];
let roomPlayers: string[] = [];
let serverState: Extract<ServerMessage, { type: 'gameState' }> | null = null;
let lastDiscard: { seat: number; tile: string } | null = null;
let selectedTile: string | null = null;
let local: {
  game: MahjongGame;
  resolved: ResolvedFanConfig;
  scores: number[];
  rngSeed: number;
} | null = null;

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const autoPlayBox = $('auto-play') as HTMLInputElement;
const settlementDialog = $('settlement-dialog') as HTMLDialogElement;
const logsDialog = $('logs-dialog') as HTMLDialogElement;
const historyDialog = $('history-dialog') as HTMLDialogElement;
const settingsDialog = $('settings-dialog') as HTMLDialogElement;
const leaveDialog = $('leave-dialog') as HTMLDialogElement;
const oddsDialog = $('odds-dialog') as HTMLDialogElement;
const oddsButton = $('btn-wait-odds') as HTMLButtonElement;
const drawPercent = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });
const settlementButton = $('btn-settlement') as HTMLButtonElement;

function log(msg: string): void {
  const el = $('log');
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.prepend(line);
  while (el.childElementCount > 200) el.lastElementChild?.remove();
}

let activePanel: 'lobby' | 'room-panel' | 'table-panel' = 'lobby';

function showPanel(id: typeof activePanel, updateHistory = true): void {
  const playing = id === 'table-panel';
  const changingView = activePanel !== id;
  activePanel = id;
  if (!playing && oddsDialog.open) oddsDialog.close();
  document.body.classList.toggle('in-game', playing);
  $('home-panel').classList.toggle('hidden', id !== 'lobby');
  $('btn-home').classList.toggle('hidden', !playing);
  const homeLabel = local ? '返回大厅' : '返回房间';
  $('home-label').textContent = homeLabel;
  $('btn-home').setAttribute('aria-label', homeLabel);
  const hash = playing ? '#game' : id === 'room-panel' ? '#room' : '#lobby';
  if (updateHistory && location.hash !== hash) history.pushState(null, '', hash);
  for (const p of ['room-panel', 'table-panel']) {
    $(p).classList.toggle('hidden', p !== id);
  }
  if (changingView) {
    $('game-error').textContent = '';
    window.scrollTo(0, 0);
    const title = id === 'lobby' ? 'lobby-title' : playing ? 'table-title' : 'room-title';
    $(title).focus({ preventScroll: true });
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

function showError(message: string): void {
  $(activePanel === 'lobby' ? 'lobby-error' : 'game-error').textContent = message;
}

// —— 联机 ——
const lobbyButtons = ['btn-local', 'btn-create', 'btn-join'];

function setRoomPending(pending: boolean): void {
  for (const id of lobbyButtons) ($(id) as HTMLButtonElement).disabled = pending;
  $('lobby-status').textContent = pending ? '正在连接并等待房间响应…' : '';
}

let roomRequestTimer: ReturnType<typeof setTimeout> | undefined;
let roomRequestTrigger: HTMLElement | null = null;

function closeOnlineConnection(): void {
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  reconnectAttempts = 0;
  restoringRoom = false;
  roomToken = '';
  const socket = ws;
  ws = null;
  socket?.close();
}

function scheduleRoomReconnect(): void {
  if (!roomCode || !roomToken || reconnectTimer !== undefined) return;
  restoringRoom = true;
  $('conn-status').textContent = '正在恢复连接…';
  const delay = Math.min(1000 * 2 ** reconnectAttempts++, 15000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void connectWs(true).catch(() => scheduleRoomReconnect());
  }, delay + Math.random() * 400);
}

function finishRoomRequest(): void {
  clearTimeout(roomRequestTimer);
  roomRequestTimer = undefined;
  setRoomPending(false);
  if (document.activeElement === document.body) roomRequestTrigger?.focus();
  roomRequestTrigger = null;
}

async function requestRoom(message: ClientMessage): Promise<void> {
  if (roomRequestTimer !== undefined) return;
  showError('');
  $('conn-status').textContent = '';
  roomRequestTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  setRoomPending(true);
  roomRequestTimer = setTimeout(() => {
    closeOnlineConnection();
    finishRoomRequest();
    $('conn-status').textContent = '已断开';
    showError('等待房间响应超时，请重试。');
  }, 10000);
  try {
    await connectWs();
  } catch {
    if (roomRequestTimer === undefined) return;
    finishRoomRequest();
    showError('无法连接联机服务，可重试或开始单机练习。');
    return;
  }
  local = null;
  clearTimeout(autoTimer);
  send({ type: 'hello', name: ($('name-input') as HTMLInputElement).value || '玩家' });
  send(message);
}

function connectWs(resume = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${proto}://${location.host}`);
    const previous = ws;
    ws = socket;
    previous?.close();
    socket.onopen = () => {
      if (resume) socket.send(JSON.stringify({ type: 'reconnect', roomCode, token: roomToken } satisfies ClientMessage));
      resolve();
    };
    socket.onerror = () => reject(new Error('ws 连接失败'));
    socket.onclose = (event) => {
      reject(new Error('ws 已断开'));
      if (ws !== socket) return;
      ws = null;
      if (event.code === 4001) {
        closeOnlineConnection();
        roomCode = '';
        serverState = null;
        showPanel('lobby');
        showError('该座位已在另一条连接上恢复。');
        return;
      }
      if (roomCode && roomToken) {
        scheduleRoomReconnect();
        return;
      }
      if (roomRequestTimer !== undefined) finishRoomRequest();
      $('conn-status').textContent = '已断开';
      showError('联机连接已断开。');
      log('WebSocket 断开');
    };
    socket.onmessage = (ev) => {
      if (ws === socket) onServerMessage(JSON.parse(String(ev.data)) as ServerMessage);
    };
  });
}

function send(msg: ClientMessage): void {
  if (!restoringRoom && ws?.readyState === WebSocket.OPEN) {
    if (activePanel !== 'lobby') showError('');
    ws.send(JSON.stringify(msg));
  } else {
    showError(restoringRoom ? '正在恢复对局，请稍后操作。' : '联机已断开，操作未发送。');
  }
}

function onServerMessage(msg: ServerMessage): void {
  if (restoringRoom && (msg.type === 'gameState' || (msg.type === 'roomState' && msg.phase !== 'playing'))) {
    restoringRoom = false;
    reconnectAttempts = 0;
    showError('');
  }
  switch (msg.type) {
    case 'welcome':
      mySeat = msg.seat;
      roomToken = msg.token;
      $('conn-status').textContent = `座位 ${msg.seat}`;
      break;
    case 'roomState':
      if (roomRequestTimer !== undefined) finishRoomRequest();
      if (roomCode !== msg.roomCode) {
        serverState = null;
        handHistory = [];
      }
      roomCode = msg.roomCode;
      roomPlayers = msg.players.map((player) => player.name);
      handHistory = msg.handHistory ?? handHistory;
      $('room-code').textContent = String(msg.roomCode);
      $('rules-summary').textContent =
        `${msg.rulesSummary.presetId}｜${msg.rulesSummary.totalTiles}张｜牌墙${msg.rulesSummary.wallTiles}｜` +
        `红中:${msg.rulesSummary.redCenterMode}｜${msg.rulesSummary.capDesc}｜${msg.rulesSummary.scoringMode}｜` +
        (msg.rulesSummary.allowDiscardHu === false ? '不点炮' : '可点炮');
      renderPlayers(msg.players);
      if (msg.phase === 'playing') showPanel('table-panel');
      else if (activePanel === 'lobby') showPanel('room-panel');
      if (historyDialog.open) renderRoomHistory();
      break;
    case 'gameState':
      if (!serverState || serverState.phase === 'over' || msg.wallRemaining > serverState.wallRemaining) {
        lastDiscard = null;
      }
      serverState = msg;
      selectedTile = null;
      renderTable();
      break;
    case 'gameEvent':
      if (msg.event.kind === 'discard') {
        lastDiscard = msg.event;
        highlightLastDiscard();
      }
      logEventMsg(msg.event);
      break;
    case 'gameOver':
      recordHand({
        hand: typeof msg.replayMeta.hands === 'number' ? msg.replayMeta.hands : (handHistory.at(-1)?.hand ?? 0) + 1,
        outcome: msg.outcome,
        winnerSeats: msg.settlements.map((settlement) => settlement.winnerSeat),
        deltas: msg.deltas,
        scores: msg.scores,
      });
      if (serverState && serverState.phase !== 'over') {
        serverState = { ...serverState, phase: 'over', drewTile: null, legalOptions: [], scores: msg.scores };
        selectedTile = null;
        renderTable();
      }
      renderSettle(msg.settlements, msg.outcome, msg.scores);
      log(`对局结束：${msg.outcome === 'win' ? '胡牌' : '流局'}`);
      break;
    case 'error':
      log(`[错误] ${msg.code}: ${msg.message}`);
      if (roomRequestTimer !== undefined) finishRoomRequest();
      if (restoringRoom && (msg.code === 'E_NO_ROOM' || msg.code === 'E_TOKEN' || msg.code === 'E_IN_ROOM')) {
        closeOnlineConnection();
        roomCode = '';
        serverState = null;
        showPanel('lobby');
      }
      showError(msg.message);
      break;
    default:
      break;
  }
}

function recordHand(record: HandScoreRecord): void {
  const index = handHistory.findIndex((hand) => hand.hand === record.hand);
  if (index < 0) handHistory.push(record);
  else handHistory[index] = record;
  if (historyDialog.open) renderRoomHistory();
}

function renderRoomHistory(): void {
  const players = roomPlayers.length ? roomPlayers : serverState?.seats.map((seat) => seat.name) ?? [];
  const totals = handHistory.at(-1)?.scores ?? serverState?.scores ?? [];
  const container = $('room-history');
  $('history-title').textContent = local ? '单机战绩' : '房间战绩';
  $('history-summary').textContent = `${local ? '' : `房间 ${roomCode} · `}已结算 ${handHistory.length} 局`;
  container.replaceChildren();
  const table = document.createElement('table');
  table.className = 'history-table';
  const heading = table.createTHead().insertRow();
  for (const label of ['局次', ...players]) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    heading.append(cell);
  }
  const body = table.createTBody();
  const total = body.insertRow();
  total.className = 'history-total';
  addHistoryRow(total, '累计分', players.map((_, seat) => totals[seat] ?? 0));
  for (const hand of [...handHistory].reverse()) {
    const result = hand.outcome === 'draw' ? '流局' : hand.winnerSeats.map((seat) => players[seat]).join('、') + ' 胡牌';
    addHistoryRow(body.insertRow(), `第 ${hand.hand} 局`, hand.deltas, result);
  }
  container.appendChild(table);
  $('history-empty').hidden = handHistory.length > 0;
}

function addHistoryRow(row: HTMLTableRowElement, name: string, scores: number[], result?: string): void {
  const heading = document.createElement('th');
  heading.scope = 'row';
  heading.textContent = name;
  if (result) {
    const detail = document.createElement('small');
    detail.textContent = result;
    heading.append(detail);
  }
  row.append(heading);
  for (const score of scores) {
    const cell = row.insertCell();
    cell.textContent = score > 0 ? `+${score}` : String(score);
    if (score !== 0) cell.className = score > 0 ? 'gain' : 'loss';
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

const SEAT_COLORS = ['#a34035', '#315d9a', '#915c24', '#684485'];

function avatarEl(seat: number, name: string, size = 34): HTMLElement {
  const el = document.createElement('span');
  el.className = 'avatar';
  el.setAttribute('aria-hidden', 'true');
  el.style.setProperty('--avatar-size', `${size}px`);
  el.style.setProperty('--avatar-font-size', `${Math.round(size * 0.48)}px`);
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

function tileEl(tile: string, small: false): HTMLButtonElement;
function tileEl(tile: string, small: true): HTMLSpanElement;
function tileEl(tile: string, small: boolean): HTMLElement {
  const el = document.createElement(small ? 'span' : 'button');
  el.className = `tile${small ? ' small' : ''}`;
  const label = tileLabel(tile);
  const photoPosition = tilePhotoPositions.get(tile);
  if (photoPosition) {
    el.classList.add('photo');
    el.style.backgroundPosition = photoPosition;
    if (small) el.setAttribute('role', 'img');
    el.setAttribute('aria-label', label);
  } else {
    el.textContent = label;
  }
  el.title = label;
  el.dataset.testid = small ? `tile-sm-${tile}` : `hand-tile-${tile}`;
  el.dataset.tile = tile;
  return el;
}

function tileBackEl(): HTMLElement {
  const el = document.createElement('span');
  el.className = 'tile small photo back';
  el.style.backgroundPosition = tilePhotoPositions.get('back')!;
  el.setAttribute('aria-hidden', 'true');
  return el;
}

function tableTile(tile: string | null): HTMLElement {
  const slot = document.createElement('span');
  slot.className = 'tile-slot';
  slot.appendChild(tile === null ? tileBackEl() : tileEl(tile, true));
  return slot;
}

const turnDial = $('turn-dial');
const turnNeedle = $('turn-needle');
const tablePanel = $('table-panel');

function pointToCurrentSeat(): void {
  const seatEl = tablePanel.querySelector('.seat.current');
  const dialBounds = turnDial.getBoundingClientRect();
  turnNeedle.hidden = !seatEl || dialBounds.width === 0;
  if (!seatEl || turnNeedle.hidden) return;

  const seatBounds = seatEl.getBoundingClientRect();
  const dx = seatBounds.left + seatBounds.width / 2 - (dialBounds.left + dialBounds.width / 2);
  const dy = seatBounds.top + seatBounds.height / 2 - (dialBounds.top + dialBounds.height / 2);
  turnNeedle.style.setProperty('--turn-angle', `${Math.atan2(dx, -dy)}rad`);
}

new ResizeObserver(pointToCurrentSeat).observe(tablePanel);
$('playfield').addEventListener('scroll', pointToCurrentSeat, { capture: true, passive: true });
window.addEventListener('resize', pointToCurrentSeat);
function updateHandSelection(preferred?: HTMLButtonElement): void {
  const tiles = Array.from(tablePanel.querySelectorAll<HTMLButtonElement>('button.tile'));
  const selectedTileButton = preferred ?? tiles.find((tile) => !tile.disabled && tile.dataset.tile === selectedTile);
  for (const tile of tiles) {
    const selected = tile === selectedTileButton;
    tile.classList.toggle('sel', selected);
    if (!tile.disabled) tile.setAttribute('aria-pressed', String(selected));
  }
}

function highlightLastDiscard(): void {
  tablePanel.querySelector('.tile.last')?.classList.remove('last');
  if (!lastDiscard) return;
  const river = tablePanel.querySelector(`[data-testid="river-${lastDiscard.seat}"]`);
  const newest = river?.querySelector<HTMLElement>('.discard-line:last-child .tile-slot:last-child .tile');
  if (newest?.dataset.tile === lastDiscard.tile) newest.classList.add('last');
}

/** 统一渲染牌桌（联机/本地共用 serverState 快照） */
function renderSelfDrawOdds(state: NonNullable<typeof serverState>): void {
  const odds = state.phase === 'over' ? undefined : state.selfDrawOdds;
  oddsButton.hidden = !odds || state.legalOptions.length > 0;
  if (!odds) {
    if (oddsDialog.open) oddsDialog.close();
    return;
  }
  oddsButton.textContent = `听牌 · 下次自摸 ${drawPercent.format(odds.nextDrawChance)}`;
  if (!oddsDialog.open) return;
  const rows = [
    ['下次摸牌自摸', drawPercent.format(odds.nextDrawChance)],
    ['预计流局前自摸', drawPercent.format(odds.selfDrawChance)],
    ['预计还能摸牌', `${odds.drawsRemaining} 次`],
    ...odds.waiting.map(({ tile, unseenCopies }) => [`听 ${tileLabel(tile)}`, `未见 ${unseenCopies} 张`]),
  ];
  $('odds-details').replaceChildren(...rows.map(([name, value]) => {
    const row = document.createElement('div');
    row.className = 'l';
    const label = document.createElement('span');
    label.textContent = name!;
    const detail = document.createElement('b');
    detail.textContent = value!;
    row.append(label, detail);
    return row;
  }));
}

function renderTable(): void {
  if (!serverState) return;
  const active = document.activeElement as HTMLElement | null;
  const focusKey = active && tablePanel.contains(active) ? active.dataset.focusKey : undefined;
  const st = serverState;
  settlementButton.disabled = st.phase !== 'over';
  if (settlementButton.disabled && settlementDialog.open) settlementDialog.close();
  $('live-wall-count').textContent = `牌墙 ${st.wallRemaining} 张`;
  $('dead-wall').textContent = ` · 死墙 ${st.deadWall}`;
  $('dial-count').textContent = String(Math.max(0, st.wallRemaining - st.deadWall));
  $('dealer-info').textContent = `庄家 · ${seatName(st.dealer)}`;
  const scores = st.scores.map((score, seat) => `${seatName(seat)} ${score}`).join(' / ');
  $('score-values').textContent = ` · ${scores}`;
  $('scores').title = `战绩 · ${scores}`;
  const hint = $('claim-hint');
  let instruction = '';
  if (st.phase === 'claim') {
    if (st.legalOptions.length || !st.selfDrawOdds) {
      instruction = `${st.legalOptions.length ? '请选择响应' : '等待其他玩家响应'} · ${tileLabel(st.claimTile ?? '')}`;
    }
  } else if (st.phase === 'turn' && st.currentSeat === st.viewSeat) {
    instruction = ($('single-click') as HTMLInputElement).checked
      ? '点选手牌即可出牌'
      : '选一张手牌，再点一次或按「出牌」';
  }
  if (hint.textContent !== instruction) hint.textContent = instruction;
  const turnInfo = document.createElement('div');
  if (st.phase === 'turn') {
    const currentPlayer = document.createElement('b');
    currentPlayer.textContent = seatName(st.currentSeat);
    turnInfo.append('轮到 ', currentPlayer, ' 出牌');
  } else if (st.phase === 'claim' && st.claimTile) {
    turnInfo.textContent = `${tileLabel(st.claimTile)} · 响应中`;
  } else {
    turnInfo.textContent = st.phase === 'over' ? '本局结束' : '等待宣告';
  }
  const centerInfo = $('center-info');
  if (centerInfo.textContent !== turnInfo.textContent) centerInfo.replaceChildren(turnInfo);
  renderSelfDrawOdds(st);

  const count = st.seats.length;
  const positions = count === 2 ? [0, 2] : count === 3 ? [0, 1, 3] : [0, 1, 2, 3];
  for (let position = 0; position < 4; position++) {
    const seatEl = $(`seat-${position}`);
    seatEl.replaceChildren();
    $(`discard-${position}`).replaceChildren();
    seatEl.classList.remove('current');
    seatEl.classList.toggle('hidden', !positions.includes(position));
  }
  for (let offset = 0; offset < count; offset++) {
    const s = (st.viewSeat + offset) % count;
    const position = positions[offset];
    const seatEl = $(`seat-${position}`);
    seatEl.dataset.seat = String(s);
    const isTurn = s === st.currentSeat && st.phase === 'turn';
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
    nameEl.title = seat.name;
    if (s === st.dealer) {
      const tag = document.createElement('span');
      tag.className = 'dealer-tag';
      tag.textContent = '庄';
      nameEl.appendChild(tag);
    }
    const subEl = document.createElement('div');
    subEl.className = 'sub';
    subEl.textContent = `${seat.handCount} 张${seat.connected || seat.ai ? '' : ' · 断线'}`;
    nameWrap.appendChild(nameEl);
    nameWrap.appendChild(subEl);
    head.appendChild(nameWrap);
    seatEl.appendChild(head);

    if (seat.melds.length > 0) {
      const melds = document.createElement('div');
      melds.className = 'melds';
      for (const m of seat.melds) {
        const group = document.createElement('div');
        group.className = 'meld-group';
        const tag = document.createElement('span');
        tag.className = 'meld-tag';
        tag.textContent = m.type === 'peng' ? '碰' : m.type === 'ankang' ? '暗杠' : m.type === 'bugang' ? '补杠' : '明杠';
        group.appendChild(tag);
        const hidden = m.type === 'ankang' && !isMe && st.phase !== 'over';
        for (let i = 0; i < (m.type === 'peng' ? 3 : 4); i++) group.appendChild(tableTile(hidden ? null : m.tile));
        melds.appendChild(group);
      }
      seatEl.appendChild(melds);
    }

    const river = document.createElement('div');
    river.className = 'river';
    river.dataset.testid = `river-${s}`;
    for (let index = 0; index < seat.discards.length; index += 5) {
      const line = document.createElement('div');
      line.className = 'discard-line';
      for (const tile of seat.discards.slice(index, index + 5)) line.appendChild(tableTile(tile));
      river.appendChild(line);
    }
    $(`discard-${position}`).appendChild(river);
    river.scrollLeft = position === 3 ? -river.scrollWidth : river.scrollWidth;
    river.scrollTop = position === 2 ? -river.scrollHeight : position === 1 ? 0 : river.scrollHeight;

    if (isMe) {
      const handWrap = document.createElement('div');
      handWrap.className = 'hand-row';
      const hand = document.createElement('span');
      hand.dataset.testid = 'hand';
      const discardable = new Set(st.legalOptions.filter((option) => option.type === 'discard').map((option) => option.tile));
      const seen = new Map<string, number>();
      for (const t of sortTiles(st.hand)) {
        const tile = tileEl(t, false);
        const occurrence = seen.get(t) ?? 0;
        seen.set(t, occurrence + 1);
        tile.type = 'button';
        tile.disabled = !isTurn || !discardable.has(t);
        tile.dataset.focusKey = `tile-${t}-${occurrence}`;
        tile.onclick = () => onHandTileClick(t, tile);
        hand.appendChild(tile);
      }
      handWrap.appendChild(hand);
      if (isTurn && st.drewTile) {
        const drawn = document.createElement('span');
        drawn.className = 'drawn-mark';
        drawn.textContent = `摸牌 ${tileLabel(st.drewTile)}`;
        nameWrap.appendChild(drawn);
      }
      seatEl.appendChild(handWrap);
    } else if (seat.handCount > 0) {
      const backs = document.createElement('div');
      backs.className = 'river opponent-hand';
      backs.dataset.testid = `opp-hand-${s}`;
      if (st.phase === 'over' && seat.revealedHand) {
        backs.classList.add('revealed');
        for (const tile of sortTiles(seat.revealedHand)) backs.appendChild(tableTile(tile));
      } else {
        for (let i = 0; i < seat.handCount; i++) backs.appendChild(tableTile(null));
      }
      seatEl.appendChild(backs);
    }
  }
  highlightLastDiscard();
  updateHandSelection();
  pointToCurrentSeat();
  renderActions();
  if (focusKey && !active?.isConnected) {
    const replacement = Array.from(tablePanel.querySelectorAll<HTMLButtonElement>('button[data-focus-key]:enabled'))
      .find((button) => button.dataset.focusKey === focusKey);
    (replacement ?? $('table-title')).focus({ preventScroll: true });
  }
  if (autoPlayBox.checked) autoAct();
}

function onHandTileClick(tile: string, button: HTMLButtonElement): void {
  if (!serverState) return;
  const st = serverState;
  if (st.phase !== 'turn' || st.currentSeat !== st.viewSeat) return;
  const canDiscard = st.legalOptions.some((o) => o.type === 'discard' && o.tile === tile);
  if (!canDiscard) return;
  if (selectedTile === tile || ($('single-click') as HTMLInputElement).checked) {
    selectedTile = null;
    updateHandSelection();
    doAction({ type: 'discard', tile });
  } else {
    selectedTile = tile;
    updateHandSelection(button);
    renderActions();
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
    b.dataset.focusKey = `${testid}:${text}`;
    b.textContent = text;
    b.className = cls;
    b.onclick = onClick;
    bar.appendChild(b);
  };
  const myTurn = st.phase === 'turn' && st.currentSeat === st.viewSeat && !(local && local.game.result);
  if (myTurn) {
    const hu = st.legalOptions.find((o) => o.type === 'hu');
    if (hu) addBtn('btn-hu', '胡牌', 'primary', () => doAction({ type: 'hu' }));
    for (const o of st.legalOptions) {
      if (o.type === 'ankang') addBtn('btn-ankang', `暗杠 ${tileLabel(o.tile!)}`, '', () => doAction({ type: 'ankang', tile: o.tile }));
      if (o.type === 'bugang') addBtn('btn-bugang', `补杠 ${tileLabel(o.tile!)}`, '', () => doAction({ type: 'bugang', tile: o.tile }));
    }
    const tile = selectedTile;
    if (tile) {
      addBtn('btn-discard', `出牌 ${tileLabel(tile)}`, 'primary', () => {
        selectedTile = null;
        updateHandSelection();
        doAction({ type: 'discard', tile });
      });
    }
  }
  if (st.phase === 'claim' && st.legalOptions.length > 0) {
    const has = (t: string) => st.legalOptions.some((o) => o.type === t);
    if (has('hu')) addBtn('btn-hu', '胡牌', 'primary', () => doAction({ type: 'hu' }));
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

function renderSettle(settlements: SettleView[], outcome: 'win' | 'draw', scores: number[]): void {
  const el = $('settle');
  el.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'settle-head';
  head.textContent = outcome === 'win' ? '胡牌结算' : '流局（杠分退回）';
  el.appendChild(head);
  for (const s of settlements) {
    const seatLine = document.createElement('div');
    seatLine.className = 'settle-winner';
    seatLine.dataset.testid = 'settle-winner';
    seatLine.textContent =
      `${seatName(s.winnerSeat)} 胡牌｜${s.paymentKind === 'bao' ? `包三家（${s.baoReasons.join(';')}）` : s.paymentKind === 'selfDraw' ? '自摸' : '点炮'}｜${s.score} 分`;
    el.appendChild(seatLine);
    for (const l of s.lines) {
      const line = document.createElement('div');
      line.className = 'l';
      line.dataset.testid = `settle-line-${l.key}`;
      const label = document.createElement('span');
      label.textContent = l.label;
      const detail = document.createElement('b');
      detail.textContent = l.detail;
      line.append(label, detail);
      el.appendChild(line);
    }
  }
  const total = document.createElement('div');
  total.className = 'settle-total';
  total.textContent = `累计分数：${scores.map((v, i) => `${seatName(i)}:${v}`).join('　')}`;
  el.appendChild(total);
  if (serverState?.seats.some((seat) => seat.revealedHand)) {
    const hands = document.createElement('section');
    hands.className = 'settlement-hands';
    const heading = document.createElement('h2');
    heading.textContent = '本局手牌';
    hands.appendChild(heading);
    for (const seat of serverState.seats) {
      if (!seat.revealedHand) continue;
      const name = document.createElement('h3');
      name.textContent = seat.name;
      const tiles = document.createElement('div');
      tiles.className = 'river';
      for (const tile of sortTiles(seat.revealedHand)) tiles.appendChild(tileEl(tile, true));
      hands.append(name, tiles);
    }
    el.appendChild(hands);
  }
  settlementDialog.scrollTop = 0;
  if (outcome === 'win' && !tablePanel.classList.contains('hidden') && !settlementDialog.open) {
    settlementDialog.showModal();
  }
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
  cfg.rules = { ...cfg.rules, allowDiscardHu: !($('no-discard-hu') as HTMLInputElement).checked };
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
  const text = ($('full-config') as HTMLTextAreaElement).value.trim();
  try {
    if (text) finalConfig = JSON.parse(text) as FanConfig;
  } catch { return { resolved: null, errors: '完整配置 JSON 格式错误' }; }
  try {
    const result = resolveFanConfig(finalConfig);
    lastConfig = finalConfig;
    return { resolved: result.resolved ?? null, errors: result.errors.map((error) => error.message).join('；') };
  } catch (error) {
    if (!text) throw error;
    return { resolved: null, errors: '完整规则配置缺少必要字段，或字段类型有误。' };
  }
}

function startLocal(): void {
  const name = ($('name-input') as HTMLInputElement).value || '玩家';
  const preset = ($('preset-select') as HTMLSelectElement).value;
  const capMode = ($('cap-select') as HTMLSelectElement).value;
  const { resolved, errors } = buildLocalConfig(preset, capMode);
  if (!resolved) {
    showError(`规则配置有误。 ${errors}`);
    return;
  }
  closeOnlineConnection();
  $('conn-status').textContent = '';
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
  lastDiscard = null;
  roomCode = '本地单机';
  roomPlayers = local.game.players.map((player) => player.name);
  handHistory = [];
  $('room-code').textContent = '本地单机';
  const cap = resolved.scoring.cap;
  $('rules-summary').textContent =
    `${preset}｜${resolved.tileMath.totalTiles}张｜红中:${resolved.redCenterMode}｜${resolved.rules.allowDiscardHu ? '可点炮' : '不点炮'}｜` +
    `${!cap.enabled ? '不封顶' : cap.value.type === 'fixed' ? `封顶 ${cap.value.fixed} 番` : `封顶(${cap.value.type})`}`;
  showPanel('table-panel');
  renderLocal();
  driveLocalAi();
}

/** 将本地引擎状态投影为 serverState 快照并渲染 */
function renderLocal(): void {
  const game = local!.game;
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
      revealedHand: game.phase === 'over' ? game.handTiles(p.seat) : undefined,
      melds: p.melds.map((m) => ({ type: m.type, tile: m.tile, fromSeat: m.fromSeat })),
      discards: [...p.discards],
      connected: true,
      ai: p.seat !== 0,
    })),
    hand: game.handTiles(0),
    drewTile: game.phase === 'turn' && game.currentSeat === 0 ? game.drewTile : null,
    selfDrawOdds: estimateSelfDraw(game, 0),
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
    if (e.type === 'discard') {
      lastDiscard = e;
      log(`${game.players[e.seat]!.name} 打出 ${tileLabel(e.tile)}`);
    }
    else if (e.type === 'peng') log(`${game.players[e.seat]!.name} 碰 ${tileLabel(e.tile)}`);
    else if (e.type === 'mingang') log(`${game.players[e.seat]!.name} 明杠 ${tileLabel(e.tile)}`);
    else if (e.type === 'ankang') log(`${game.players[e.seat]!.name} 暗杠`);
    else if (e.type === 'bugang') log(`${game.players[e.seat]!.name} 补杠 ${tileLabel(e.tile)}`);
    else if (e.type === 'hu') log(`${game.players[e.seat]!.name} 胡牌！`);
    else if (e.type === 'kongScore') log(`杠分 ${game.players[e.from]!.name} → ${game.players[e.to]!.name}`);
  }
}

function driveLocalAi(): void {
  const match = local!;
  const game = match.game;
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
      if (local !== match || !local.game.claim || local.game.phase !== 'claim') return;
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
    if (local !== match) return;
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
  if (handHistory.length > 0) return;
  const result = local!.game.result!;
  for (let s = 0; s < local!.scores.length; s++) local!.scores[s]! += result.deltas[s]!;
  recordHand({
    hand: 1, outcome: result.outcome, winnerSeats: result.winnerSeats,
    deltas: result.deltas, scores: [...local!.scores],
  });
  renderLocal();
  renderSettle(result.settlements, result.outcome, local!.scores);
  log(`本地对局结束：${result.outcome === 'win' ? '胡牌' : '流局'}，庄家下一局：座位 ${result.dealerNext}`);
}

// —— 事件绑定 ——
oddsButton.onclick = () => {
  if (!serverState?.selfDrawOdds || oddsButton.hidden) return;
  oddsDialog.showModal();
  renderSelfDrawOdds(serverState);
  oddsDialog.scrollTop = 0;
};
$('btn-logs').onclick = () => { logsDialog.showModal(); logsDialog.scrollTop = 0; };
function openRoomHistory(): void {
  renderRoomHistory();
  historyDialog.showModal();
  historyDialog.scrollTop = 0;
}
$('scores').onclick = openRoomHistory;
$('btn-room-history').onclick = openRoomHistory;
settlementButton.onclick = () => settlementDialog.showModal();
$('btn-home').onclick = () => {
  clearTimeout(autoTimer);
  autoPlayBox.checked = false;
  showPanel(local || !roomCode ? 'lobby' : 'room-panel');
};
window.addEventListener('popstate', () => {
  const panel = location.hash === '#game' && serverState ? 'table-panel' :
    location.hash === '#room' && roomCode && !local ? 'room-panel' : 'lobby';
  showPanel(panel, false);
});
$('btn-local').onclick = () => {
  mySeat = 0;
  showError('');
  startLocal();
};
$('btn-create').onclick = () => {
  const preset = ($('preset-select') as HTMLSelectElement).value;
  const capMode = ($('cap-select') as HTMLSelectElement).value;
  const checked = buildLocalConfig(preset, capMode);
  if (!checked.resolved) {
    showError(checked.errors);
    return;
  }
  const cap = capOf(capMode);
  void requestRoom({
    type: 'createRoom',
    config: lastConfig,
    playerCount: Number(($('player-count') as HTMLSelectElement).value),
    preset,
    roomLevel: 1,
    capType: cap.capType as 'fixed' | 'tiered' | 'formula' | 'unlimited' | undefined,
    capFixed: cap.capFixed,
  });
};
$('join-form').onsubmit = (event) => {
  event.preventDefault();
  const code = ($('join-code') as HTMLInputElement).value.trim();
  if (code) void requestRoom({ type: 'joinRoom', roomCode: code });
  else showError('请输入房间号。');
};
$('btn-ready').onclick = () => send({ type: 'ready' });
$('btn-start-ai').onclick = () => send({ type: 'startWithAi' });
$('btn-leave').onclick = () => {
  leaveDialog.returnValue = '';
  leaveDialog.showModal();
};
leaveDialog.addEventListener('close', () => {
  if (leaveDialog.returnValue !== 'leave') return;
  send({ type: 'leaveRoom' });
  closeOnlineConnection();
  roomCode = '';
  roomPlayers = [];
  handHistory = [];
  serverState = null;
  $('conn-status').textContent = '';
  showPanel('lobby');
});

// 设置持久化；存储不可用时仍保留当前会话的设置。
function aiDelay(): number { return Number(($('ai-delay') as HTMLSelectElement).value) || 600; }
for (const fan of [...DEFAULT_FANS, ...DEFAULT_BONUS_FANS]) {
  const row = document.createElement('div');
  row.className = 'fan-row';
  row.innerHTML = `<label><input type="checkbox" id="enabled-${fan.id}" checked> ${fan.name}</label><input id="fan-${fan.id}" aria-label="${fan.name}番数" type="number" min="0" max="64" step="1" value="${fan.value}">`;
  $('fan-list').appendChild(row);
}
const editor = $('config-editor');
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
const names: Record<string, string> = { tileSet:'牌张组成', suits:'数字花色', character:'万', bamboo:'条', dot:'筒', honors:'字牌', flowers:'花牌', copies:'张数', enabled:'启用', scoring:'计分', mode:'模式', baseScore:'底分', cap:'封顶', value:'番数/参数', fixed:'固定番数', hardCap:'安全上限', minFan:'保底番', maxScore:'分数上限', scope:'封顶范围', groups:'分组封顶', bypass:'突破封顶', fanIds:'番型ID', conditions:'条件', redCenterBonus:'无红中加成', addFan:'增加番数', bypassCap:'封顶后加成', onlyWhenWild:'仅万能牌模式', rules:'玩法规则', missedWinLock:'漏胡锁定', multiWinEnabled:'一炮多响', robConcealedKongForThirteenOrphans:'十三幺抢暗杠', baoRobKong:'抢杠包牌', baoKongBlossom:'杠开包牌', baoTwelveExposed:'十二张落地包牌', baoBigDragonWind:'大三元大四喜包牌', kongScores:'杠分', mingangPayerMultiplier:'明杠支付倍数', bugangEach:'补杠各付', ankangEach:'暗杠各付', redCenterMode:'红中模式', redCenterDrawOnly:'仅自摸', sevenPairsWithWild:'七对允许万能牌', dealerExtraTile:'庄家额外牌', fans:'基础番型', bonusFans:'附加番', name:'名称', playerOffsets:'庄闲封顶偏移', dealer:'庄家', nonDealer:'闲家', type:'类型', tiers:'分档番数', formula:'计算公式' };
function renderConfigEditor(): void {
  editor.replaceChildren();
  const area = $('full-config') as HTMLTextAreaElement;
  let parsed: unknown;
  try { parsed = JSON.parse(area.value); } catch { return; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const data = parsed as Record<string, unknown>;
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
    input.checked = value === true; input.value = Array.isArray(value) ? JSON.stringify(value) : String(value ?? '');
    input.onchange = () => { try { object[key] = Array.isArray(value) ? JSON.parse(input.value) : typeof value === 'boolean' ? input.checked : typeof value === 'number' ? Number(input.value) : input.value; input.setCustomValidity(''); persist(); } catch { input.setCustomValidity('请输入有效 JSON 数组'); input.reportValidity(); } };
    row.appendChild(input); parent.appendChild(row);
  }
  for (const key of Object.keys(data)) visit(editor, data, key);
}
$('full-config').addEventListener('change', renderConfigEditor);
const presetSelect = $('preset-select') as HTMLSelectElement;
presetSelect.replaceChildren();
for (const [id, preset] of Object.entries(TILE_SET_PRESETS)) {
  const option = document.createElement('option'); option.value = id; option.textContent = `${id} · ${preset.description}`; presetSelect.appendChild(option);
}
const preferenceIds = ['full-config', 'name-input', 'preset-select', 'cap-select', 'ai-delay', 'single-click', 'reduce-motion', 'player-count', 'no-discard-hu', 'red-mode', 'draw-only', ...[...DEFAULT_FANS, ...DEFAULT_BONUS_FANS].flatMap(f => ['fan-' + f.id, 'enabled-' + f.id])];
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
document.body.classList.toggle('reduce-motion', ($('reduce-motion') as HTMLInputElement).checked);
renderConfigEditor();
function openSettings(): void {
  settingsDialog.showModal();
  settingsDialog.scrollTop = 0;
}
$('btn-settings').onclick = openSettings;
$('btn-rule-settings').onclick = openSettings;
settingsDialog.addEventListener('close', () => {
  if (activePanel === 'table-panel') renderTable();
});
autoPlayBox.onchange = () => { if (autoPlayBox.checked) autoAct(); else clearTimeout(autoTimer); };
