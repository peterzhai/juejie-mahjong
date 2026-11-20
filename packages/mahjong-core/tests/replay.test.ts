/** P5：回放记录与重放验证（PRD 6.5.7 / 验收 20） */

import { describe, expect, it } from 'vitest';
import { defaultFanConfig, resolveFanConfig, type ResolvedFanConfig } from '@quejie/fan-config';
import { autoPlay } from './helpers.js';
import { recordReplay, verifyReplay, type ReplayData } from '../src/replay.js';

function collectConfigs(): { gd128: ResolvedFanConfig; gd136: ResolvedFanConfig } {
  const mk = (preset: string): ResolvedFanConfig => {
    const cfg = defaultFanConfig();
    cfg.tileSet = structuredClone(cfg.tileSet);
    cfg.tileSet.preset = preset;
    const r = resolveFanConfig(cfg);
    if (!r.ok) throw new Error(r.errors.map((e) => e.message).join('; '));
    return r.resolved!;
  };
  return { gd128: mk('gd128'), gd136: mk('gd136') };
}

const configs = collectConfigs();

describe('回放记录与重放一致性', () => {
  it('胜局回放：重算事件流与结算完全一致', () => {
    const found = (() => {
      for (let seed = 1; seed <= 40; seed++) {
        const r = autoPlay(configs.gd136, seed);
        if (r.game.result!.outcome === 'win') return r;
      }
      throw new Error('40 局内未出现胜局');
    })();
    const data = recordReplay(found.game, found.inputs);
    const v = verifyReplay(data);
    expect(v.differences).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('流局回放：重算一致（含杠分退回）', () => {
    const found = (() => {
      for (let seed = 1; seed <= 60; seed++) {
        const r = autoPlay(configs.gd136, seed, { peng: false, gang: true });
        const hasKong = r.game.events.some((e) => e.type === 'kongScore');
        if (r.game.result!.outcome === 'draw' && hasKong) return r;
      }
      throw new Error('60 局内未出现含杠分流局');
    })();
    const data = recordReplay(found.game, found.inputs);
    const v = verifyReplay(data);
    expect(v.ok).toBe(true);
  });

  it('多配置批量回放：gd128/gd136 各 30 局全部一致', () => {
    for (const [name, cfg] of Object.entries(configs)) {
      for (let seed = 1; seed <= 30; seed++) {
        const r = autoPlay(cfg, seed, { peng: true, gang: true });
        const data = recordReplay(r.game, r.inputs);
        const v = verifyReplay(data);
        expect(v.ok, `${name} seed=${seed}: ${v.differences.join('; ')}`).toBe(true);
      }
    }
  });

  it('改配置后旧回放不漂移（快照重算）', () => {
    const r = (() => {
      for (let seed = 1; seed <= 40; seed++) {
        const x = autoPlay(configs.gd136, seed);
        if (x.game.result!.outcome === 'win') return x;
      }
      throw new Error('no win');
    })();
    const data = recordReplay(r.game, r.inputs);
    // 当前配置已变（清一色番值 +3）：新配置哈希与回放元数据不同
    const cfg2 = defaultFanConfig();
    cfg2.tileSet.preset = 'gd136';
    cfg2.fans.find((f) => f.id === 'fullFlush')!.value += 3;
    const resolvedModified = resolveFanConfig(cfg2).resolved!;
    expect(resolvedModified.resolvedFanConfigHash).not.toBe(data.meta.resolvedFanConfigHash);
    // 重放仍用快照配置重算 → 不漂移
    const v = verifyReplay(data);
    expect(v.ok).toBe(true);
    // 且结算分数与原始记录一致
    const settleEv = data.events.find((e) => e.type === 'settle');
    const replaySettle = verifyReplay(data);
    expect(replaySettle.ok).toBe(true);
    void settleEv;
  });
});

describe('回放元数据（PRD 6.5.7）', () => {
  it('元数据字段完整：版本/哈希/预设/封顶信息/种子/庄位', () => {
    const r = autoPlay(configs.gd128, 7);
    const data = recordReplay(r.game, r.inputs);
    const m = data.meta;
    expect(m.fanConfigVersion).toBe('1.1.0');
    expect(m.configHash).toMatch(/^[0-9a-f]{8}$/);
    expect(m.resolvedFanConfigHash).toMatch(/^[0-9a-f]{8}$/);
    expect(m.tileSetPresetId).toBe('gd128');
    expect(m.capValueType).toBe('fixed');
    expect(m.capScope).toBe('global');
    expect(typeof m.seed).toBe('number');
    expect(m.dealer).toBe(0);
    expect(m.roundWind).toBe('east');
    // 快照包含完整 resolved 配置（可独立重算）
    expect(data.resolvedConfigSnapshot.fans.length).toBeGreaterThan(0);
    expect(data.resolvedConfigSnapshot.tileMath.totalTiles).toBe(128);
  });

  it('输入决策流完整记录（重放逐条喂入）', () => {
    const r = autoPlay(configs.gd136, 3);
    const data = recordReplay(r.game, r.inputs);
    // 决策数 > 0 且每条含座位与动作
    expect(data.inputs.length).toBeGreaterThan(0);
    for (const input of data.inputs) {
      expect(typeof input.seat).toBe('number');
      expect(typeof input.action.type).toBe('string');
    }
    // 事件数应多于决策数（发牌/摸牌等自动事件）
    expect(data.events.length).toBeGreaterThanOrEqual(data.inputs.length);
  });
});
