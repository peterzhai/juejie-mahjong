import type { FanConfig } from '@quejie/fan-config';
/** 前后端共享消息协议（PRD 3.2：客户端只提交意图，服务端权威裁决） */

export type Seat = number;

/** 协议版本 */
export const PROTOCOL_VERSION = '1';

export interface ActionPayload {
  type: 'discard' | 'peng' | 'mingang' | 'bugang' | 'ankang' | 'hu' | 'pass';
  tile?: string;
}

// —— C2S 客户端 → 服务端 ——

export interface HelloMsg {
  type: 'hello';
  name: string;
}
export interface CreateRoomMsg {
  type: 'createRoom';
  config?: FanConfig;
  playerCount?: number;
  preset?: string;
  roomLevel?: number;
  scoringMode?: 'max' | 'additive';
  capType?: 'fixed' | 'tiered' | 'formula' | 'unlimited';
  capFixed?: number;
}
export interface JoinRoomMsg {
  type: 'joinRoom';
  roomCode: string;
}
export interface ReadyMsg {
  type: 'ready';
}
export interface StartMsg {
  type: 'startWithAi';
}
export interface ActionMsg {
  type: 'action';
  action: ActionPayload;
}
export interface ReconnectMsg {
  type: 'reconnect';
  roomCode: string;
  token: string;
}
export interface LeaveMsg {
  type: 'leaveRoom';
}
export interface PingMsg {
  type: 'ping';
}

export type ClientMessage =
  | HelloMsg
  | CreateRoomMsg
  | JoinRoomMsg
  | ReadyMsg
  | StartMsg
  | ActionMsg
  | ReconnectMsg
  | LeaveMsg
  | PingMsg;

// —— S2C 服务端 → 客户端 ——

export interface PlayerInfo {
  seat: Seat;
  name: string;
  ready: boolean;
  connected: boolean;
  ai: boolean;
}

export interface RoomStateMsg {
  type: 'roomState';
  roomCode: string;
  phase: 'lobby' | 'playing' | 'finished';
  players: PlayerInfo[];
  rulesSummary: {
    presetId: string;
    totalTiles: number;
    wallTiles: number;
    redCenterMode: string;
    capDesc: string;
    scoringMode: string;
  };
}

export interface WelcomeMsg {
  type: 'welcome';
  token: string;
  seat: Seat;
  name: string;
}

export interface HandViewTile {
  id: string;
}

export interface MeldView {
  type: 'peng' | 'mingang' | 'ankang' | 'bugang';
  tile: string;
  fromSeat?: Seat;
}

export interface SeatView {
  seat: Seat;
  name: string;
  handCount: number;
  melds: MeldView[];
  discards: string[];
  connected: boolean;
  ai: boolean;
}

export interface LegalOption {
  type: ActionPayload['type'];
  tile?: string;
}

export interface GameStateMsg {
  type: 'gameState';
  /** 视角座位 */
  viewSeat: Seat;
  dealer: Seat;
  currentSeat: Seat;
  phase: string;
  seats: SeatView[];
  /** 自己的手牌（仅本人可见） */
  hand: string[];
  drewTile: string | null;
  wallRemaining: number;
  deadWall: number;
  legalOptions: LegalOption[];
  claimTile?: string;
  claimFrom?: Seat;
  /** 累计分数（本房间） */
  scores: number[];
  /** 回合限时（ms） */
  actionDeadlineMs?: number;
}

export interface GameEventMsg {
  type: 'gameEvent';
  event:
    | { kind: 'draw'; seat: Seat }
    | { kind: 'discard'; seat: Seat; tile: string }
    | { kind: 'peng'; seat: Seat; tile: string; from: Seat }
    | { kind: 'mingang'; seat: Seat; tile: string; from: Seat }
    | { kind: 'ankang'; seat: Seat; tile: string }
    | { kind: 'bugang'; seat: Seat; tile: string }
    | { kind: 'kongScore'; from: Seat; to: Seat; amount: number }
    | { kind: 'missLock'; seat: Seat; tile: string }
    | { kind: 'hu'; seat: Seat; via: string; fromSeat?: Seat };
}

export interface SettlementView {
  winnerSeat: Seat;
  via: string;
  payerSeat: Seat | null;
  paymentKind: string;
  baoReasons: string[];
  score: number;
  finalFan: number;
  fans: { fanId: string; name: string; value: number }[];
  bonus: { fanId: string; name: string; value: number; count?: number }[];
  chicken: boolean;
  lines: { key: string; label: string; detail: string }[];
}

export interface GameOverMsg {
  type: 'gameOver';
  outcome: 'win' | 'draw';
  settlements: SettlementView[];
  deltas: number[];
  scores: number[];
  dealerNext: Seat;
  replayMeta: Record<string, unknown>;
}

export interface ErrorMsg {
  type: 'error';
  code: string;
  message: string;
}

export interface PongMsg {
  type: 'pong';
}

export type ServerMessage =
  | WelcomeMsg
  | RoomStateMsg
  | GameStateMsg
  | GameEventMsg
  | GameOverMsg
  | ErrorMsg
  | PongMsg;
