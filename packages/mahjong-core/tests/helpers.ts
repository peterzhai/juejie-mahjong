/** 引擎测试共享工具：配置构造 + 自动对局驱动器 */

import {
  autoDisableUnmetFans,
  clonePreset,
  defaultFanConfig,
  resolveFanConfig,
  type ResolvedFanConfig,
} from '@quejie/fan-config';
import {
  MahjongGame,
  type ActionOption,
  type ReplayInput,
  type Seat,
} from '../src/index.js';

/** 从番型表全量启用出发构造指定预设的解析配置（cap/bonus 可定制） */
export function makeConfig(
  preset = 'gd128',
  opts: {
    capEnabled?: boolean;
    bonusEnabled?: boolean;
    bonusMode?: 'none' | 'addFan' | 'fanDouble' | 'scoreDouble';
    bypassCap?: boolean;
    scoringMode?: 'max' | 'additive';
    roomLevel?: number;
    /** 附加番开关（默认关闭，便于观察裸番数） */
    bonusFansOn?: boolean;
  } = {},
): ResolvedFanConfig {
  const cfg = defaultFanConfig();
  cfg.tileSet = clonePreset(preset);
  cfg.tileSet.preset = preset;
  if (cfg.tileSet.redCenterMode !== 'wild') cfg.scoring.redCenterBonus.enabled = false;
  for (const fan of cfg.fans) fan.enabled = true;
  const { config } = autoDisableUnmetFans(cfg);
  config.scoring.cap.enabled = opts.capEnabled ?? false;
  config.scoring.mode = opts.scoringMode ?? 'max';
  config.scoring.redCenterBonus.enabled = opts.bonusEnabled ?? false;
  config.scoring.redCenterBonus.mode = opts.bonusMode ?? 'none';
  config.scoring.redCenterBonus.bypassCap = opts.bypassCap ?? false;
  if (!(opts.bonusFansOn ?? false)) {
    for (const b of config.bonusFans) b.enabled = false;
  }
  const r = resolveFanConfig(config);
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join('; '));
  return r.resolved!;
}

export interface AutoPlayOptions {
  gang?: boolean;
  peng?: boolean;
  /** 这些座位第一次胡牌宣告机会选择放弃（测漏胡锁） */
  huDenyOnce?: Set<number>;
  maxSteps?: number;
}

export interface ClaimSnapshot {
  tile: string;
  fromSeat: Seat;
  kind: string;
  options: [Seat, ActionOption[]][];
}

export interface AutoPlayResult {
  game: MahjongGame;
  inputs: ReplayInput[];
  claims: ClaimSnapshot[];
}

/** 确定性自动对局：胡必胡（除 deny 座位首次）、可杠则杠、可碰则碰、否则出第一张手牌 */
export function autoPlay(
  resolved: ResolvedFanConfig,
  seed: number,
  opts: AutoPlayOptions = {},
  dealer: Seat = 0,
): AutoPlayResult {
  const gang = opts.gang ?? true;
  const peng = opts.peng ?? true;
  const game = new MahjongGame({
    resolved,
    seed,
    dealer,
    roundWind: 'east',
    roomLevel: 1,
    playerNames: ['东家', '南家', '西家', '北家'],
  });
  game.start();
  const inputs: ReplayInput[] = [];
  const claims: ClaimSnapshot[] = [];
  const denied = new Set<Seat>();
  let windowSnapshotted = false;
  let steps = 0;
  const maxSteps = opts.maxSteps ?? 4000;

  const submit = (seat: Seat, action: { type: string; tile?: string }) => {
    game.action(seat, action as never);
    inputs.push({ seat, action: action as never });
  };

  while (!game.result && steps++ < maxSteps) {
    if (game.phase === 'claim') {
      if (!windowSnapshotted && game.claim) {
        claims.push({
          tile: game.claim.tile,
          fromSeat: game.claim.fromSeat,
          kind: game.claim.kind,
          options: [...game.claim.options.entries()].map(([s, o]) => [s, [...o]] as [Seat, ActionOption[]]),
        });
        windowSnapshotted = true;
      }
      // （窗口快照在离开 claim 阶段后重置，见下方 else 分支）
      const pending = game.claim!.pendingSeats.filter((s) => !game.claim!.responses.has(s));
      if (pending.length === 0) {
        game.autoPassPending();
        continue;
      }
      const seat = pending[0]!;
      const options = game.legalOptions(seat);
      const hu = options.find((o) => o.type === 'hu');
      if (hu) {
        if (opts.huDenyOnce?.has(seat) && !denied.has(seat)) {
          denied.add(seat);
          submit(seat, { type: 'pass' });
        } else {
          submit(seat, { type: 'hu' });
        }
        continue;
      }
      if (peng && options.some((o) => o.type === 'peng')) {
        submit(seat, { type: 'peng' });
        continue;
      }
      if (gang && options.some((o) => o.type === 'mingang')) {
        submit(seat, { type: 'mingang' });
        continue;
      }
      submit(seat, { type: 'pass' });
      continue;
    }
    windowSnapshotted = false;
    const seat = game.currentSeat;
    const options = game.legalOptions(seat);
    const hu = options.find((o) => o.type === 'hu');
    if (hu) {
      submit(seat, { type: 'hu' });
      continue;
    }
    if (gang && options.some((o) => o.type === 'ankang')) {
      const a = options.find((o) => o.type === 'ankang')!;
      submit(seat, { type: 'ankang', tile: a.tile });
      continue;
    }
    if (gang && options.some((o) => o.type === 'bugang')) {
      const b = options.find((o) => o.type === 'bugang')!;
      submit(seat, { type: 'bugang', tile: b.tile });
      continue;
    }
    const discard = options.find((o) => o.type === 'discard');
    if (!discard) {
      throw new Error(`座位 ${seat} 无可行动作（phase=${game.phase}）`);
    }
    submit(seat, { type: 'discard', tile: discard.tile });
  }
  if (!game.result) throw new Error(`对局未结束（steps=${steps}，phase=${game.phase}）`);
  return { game, inputs, claims };
}

/** 扫描种子直到条件满足 */
export function scanSeeds<T>(
  resolved: ResolvedFanConfig,
  predicate: (r: AutoPlayResult, seed: number) => T | undefined,
  opts: { from?: number; count?: number; autoOpts?: AutoPlayOptions; dealer?: Seat } = {},
): { seed: number; result: AutoPlayResult; value: T } | null {
  const from = opts.from ?? 1;
  const count = opts.count ?? 300;
  for (let seed = from; seed < from + count; seed++) {
    const r = autoPlay(resolved, seed, opts.autoOpts ?? {}, opts.dealer ?? 0);
    const v = predicate(r, seed);
    if (v !== undefined) return { seed, result: r, value: v };
  }
  return null;
}
