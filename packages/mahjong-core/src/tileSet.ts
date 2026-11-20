/** 牌墙构建与摸牌（PRD 4.2 动态计算 + 回放确定性种子） */

import type { ResolvedFanConfig } from '@quejie/fan-config';
import { computeTileMath, faceConfig } from '@quejie/fan-config';
import type { FaceName } from '@quejie/fan-config';
import { faceToTiles } from '@quejie/fan-config';

/** mulberry32 PRNG：可种子复现，供回放/测试 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(arr: T[], rng: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** 从已解析配置构建全部实体牌（含 copies 复制），按启用牌面动态生成（不硬编码 34 种） */
export function buildWallTiles(resolved: ResolvedFanConfig): string[] {
  const tileSet = resolved.tileSet;
  const faces: FaceName[] = [
    'character', 'bamboo', 'dot',
    'east', 'south', 'west', 'north', 'red', 'green', 'white', 'flowers',
  ];
  const tiles: string[] = [];
  for (const face of faces) {
    const cfg = faceConfig(tileSet, face);
    if (!cfg.enabled) continue;
    const ids = faceToTiles(face);
    for (let i = 0; i < cfg.copies; i++) tiles.push(...ids);
  }
  return tiles;
}

/**
 * 牌墙：正面常规摸牌，尾部杠后补牌。
 * 流局条件：liveRemaining ≤ deadWallCount（PRD 5.6）。
 */
export class Wall {
  private order: string[];
  private head = 0;
  private tail: number;
  readonly deadWallCount: number;

  constructor(resolved: ResolvedFanConfig, seed: number) {
    const math = resolved.tileMath ?? computeTileMath(resolved.tileSet);
    this.deadWallCount = math.deadWallCount;
    this.order = shuffle(buildWallTiles(resolved), mulberry32(seed));
    this.tail = this.order.length;
  }

  /** 常规摸牌（墙头） */
  drawFromHead(): string | null {
    if (this.head >= this.tail) return null;
    return this.order[this.head++]!;
  }

  /** 杠后补牌（墙尾） */
  drawFromTail(): string | null {
    if (this.tail <= this.head) return null;
    return this.order[--this.tail]!;
  }

  /** 剩余可摸张数（不含死墙） */
  get liveRemaining(): number {
    return this.tail - this.head;
  }

  /** 是否只剩死墙（流局判定） */
  get exhausted(): boolean {
    return this.liveRemaining <= this.deadWallCount;
  }
}
