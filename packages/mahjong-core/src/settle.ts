/** 胡牌结算编排：checkWin → 结构×指派 → 番型 → 计分 → 取最优 */

import type { ResolvedFanConfig, TileId } from '@quejie/fan-config';
import type { MeldData } from './winCheck.js';
import { checkWin } from './winCheck.js';
import { buildStructures, detectFans, enumerateAssignments, type FanEvaluation } from './fans.js';
import { computeScore, type PipelineContext, type ScoreResult, type SettlementLine } from './scoring.js';
import { TileIndex } from './tileIndex.js';

export interface WinInfo {
  winnerSeat: number;
  completingTile: TileId;
  via: 'self' | 'discard' | 'robKong';
  concealedTiles: TileId[];
  exposedMelds: MeldData[];
  kongBlossom: boolean;
  seatWind: string;
  roundWind: string;
  dealer: boolean;
  kongCount: number;
  wallTiles: number;
  playerCount: number;
  roomLevel: number;
}

export interface WinEvaluation {
  winnerSeat: number;
  via: WinInfo['via'];
  completingTile: TileId;
  structureKind: 'standard' | 'sevenPairs' | 'thirteenOrphans';
  fanEval: FanEvaluation;
  scoreResult: ScoreResult;
  score: number;
  finalFan: number;
  lines: SettlementLine[];
}

export function settleWin(
  resolved: ResolvedFanConfig,
  index: TileIndex,
  info: WinInfo,
): WinEvaluation {
  const fan = (id: string) => resolved.fans.find((f) => f.id === id)!;
  const winCheck = checkWin(
    countsOfTiles(info.concealedTiles, index),
    info.exposedMelds,
    index,
    {
      sevenPairsEnabled: fan('sevenPairs')?.enabled === true,
      sevenPairsWithWild: resolved.sevenPairsWithWild,
      thirteenOrphansEnabled: fan('thirteenOrphans')?.enabled === true,
    },
  );
  if (!winCheck.win) {
    throw new Error(`非法胡牌：seat ${info.winnerSeat} 的手牌不构成胡牌形`);
  }

  const structures = buildStructures(winCheck, info.concealedTiles, info.exposedMelds, index);
  const hasRed = TileIndex.hasRedCenter(
    info.concealedTiles,
    info.exposedMelds,
    index.wildcardTile,
  );
  const ctx: PipelineContext = {
    selfDraw: info.via === 'self',
    kongBlossom: info.kongBlossom,
    robbingKong: info.via === 'robKong',
    seatWind: info.seatWind,
    roundWind: info.roundWind,
    kongCount: info.kongCount,
    wallTiles: info.wallTiles,
    playerCount: info.playerCount,
    roomLevel: info.roomLevel,
    dealer: info.dealer,
  };

  let best: WinEvaluation | null = null;
  structures.forEach((structure, si) => {
    for (const assignments of enumerateAssignments(structure, index)) {
      const fanEval = detectFans(resolved, structure, assignments, ctx);
      const scoreResult = computeScore(resolved, fanEval, ctx, hasRed);
      const better =
        best === null ||
        scoreResult.score > best.score ||
        (scoreResult.score === best.score && scoreResult.finalFan > best.finalFan);
      if (better) {
        best = {
          winnerSeat: info.winnerSeat,
          via: info.via,
          completingTile: info.completingTile,
          structureKind: structure.structural.thirteenOrphans
            ? 'thirteenOrphans'
            : structure.structural.sevenPairs
              ? 'sevenPairs'
              : 'standard',
          fanEval,
          scoreResult,
          score: scoreResult.score,
          finalFan: scoreResult.finalFan,
          lines: scoreResult.lines,
        };
      }
    }
    void si;
  });
  return best!;
}

function countsOfTiles(tiles: TileId[], index: TileIndex): number[] {
  const counts = new Array<number>(index.ids.length).fill(0);
  for (const t of tiles) counts[index.idx(t)]!++;
  return counts;
}
