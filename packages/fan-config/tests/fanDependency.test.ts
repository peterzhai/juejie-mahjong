import { describe, expect, it } from 'vitest';
import {
  autoDisableUnmetFans,
  clonePreset,
  defaultFanConfig,
  fanAvailabilityMatrix,
  resolveFanConfig,
  validateFanConfig,
  type FanConfig,
} from '@quejie/fan-config';
import { configForPreset } from './helpers.js';

function availability(presetId: string): Record<string, { available: boolean; enabled: boolean; reason?: string }> {
  const r = resolveFanConfig(configForPreset(presetId), { strictDependency: false });
  expect(r.ok, `${presetId} 应可解析`).toBe(true);
  return fanAvailabilityMatrix(r.resolved!);
}

describe('验收 3：番型可用性矩阵（黄金用例）', () => {
  // PRD 5.4 矩阵：大三元 / 大四喜 / 字一色 / 十三幺 / 清一色 / 九莲宝灯 × gd100/gd108/gd128/gd136
  const MATRIX: Record<string, Record<string, boolean>> = {
    gd100: { bigDragons: true, bigWinds: true, allHonors: true, thirteenOrphans: false, fullFlush: true, nineGates: true },
    gd108: { bigDragons: false, bigWinds: false, allHonors: false, thirteenOrphans: false, fullFlush: true, nineGates: true },
    gd128: { bigDragons: false, bigWinds: true, allHonors: false, thirteenOrphans: false, fullFlush: true, nineGates: true },
    gd136: { bigDragons: true, bigWinds: true, allHonors: true, thirteenOrphans: true, fullFlush: true, nineGates: true },
  };

  for (const [preset, row] of Object.entries(MATRIX)) {
    for (const [fanId, expected] of Object.entries(row)) {
      it(`${fanId} @ ${preset} → ${expected ? '可用' : '不可用'}`, () => {
        expect(availability(preset)[fanId]!.available).toBe(expected);
      });
    }
  }
});

describe('验收 4：依赖缺失报错文案', () => {
  it('gd128 启用大三元 → 报错并指出缺发白', () => {
    const cfg = configForPreset('gd128');
    cfg.fans.find((f) => f.id === 'bigDragons')!.enabled = true;
    const result = validateFanConfig(cfg);
    expect(result.ok).toBe(false);
    const e = result.errors.find((e) => e.fanId === 'bigDragons');
    expect(e).toBeDefined();
    expect(e!.code).toBe('E_FAN_DEPENDENCY_MISSING_TILES');
    expect(e!.message).toContain('发');
    expect(e!.message).toContain('白');
  });

  it('gd100 启用十三幺 → 报错指出幺九字牌仅 11 种', () => {
    const cfg = configForPreset('gd100');
    cfg.fans.find((f) => f.id === 'thirteenOrphans')!.enabled = true;
    const result = validateFanConfig(cfg);
    expect(result.ok).toBe(false);
    const e = result.errors.find((e) => e.fanId === 'thirteenOrphans');
    expect(e).toBeDefined();
    expect(e!.message).toContain('仅 11 种');
    expect(e!.message).toContain('一万');
    expect(e!.message).toContain('九万');
  });

  it('gd108 启用字一色 → 报错指出缺字牌', () => {
    const cfg = configForPreset('gd108');
    cfg.fans.find((f) => f.id === 'allHonors')!.enabled = true;
    const result = validateFanConfig(cfg);
    expect(result.ok).toBe(false);
    const e = result.errors.find((e) => e.fanId === 'allHonors');
    expect(e!.message).toContain('东');
  });

  it('requiresSuits：单花色需求在多花色牌集下满足', () => {
    const cfg = configForPreset('gd136');
    const result = validateFanConfig(cfg);
    expect(result.errors.filter((e) => e.code === 'E_FAN_DEPENDENCY_MISSING_SUIT')).toEqual([]);
  });
});

describe('自动禁用流程（预设快捷填充）', () => {
  it('gd128 预设自动禁用十三幺/大三元/字一色/小三元并给出原因', () => {
    const cfg = defaultFanConfig();
    cfg.tileSet = clonePreset('gd128');
    cfg.tileSet.preset = 'gd128';
    // 从"全部启用"的原始状态走自动禁用流程（defaultFanConfig 已含一次自动禁用）
    for (const fan of cfg.fans) fan.enabled = true;
    const { config, disabled } = autoDisableUnmetFans(cfg);
    const ids = disabled.map((d) => d.fanId);
    expect(ids).toContain('thirteenOrphans');
    expect(ids).toContain('bigDragons');
    expect(ids).toContain('allHonors');
    for (const d of disabled) expect(d.reason).toContain('缺少牌面');
    // 自动禁用后配置可通过严格校验
    expect(validateFanConfig(config).ok).toBe(true);
  });

  it('自动禁用同步清理 bypass.fanIds 引用（保证规则 11）', () => {
    const cfg = defaultFanConfig();
    cfg.tileSet = clonePreset('gd128');
    cfg.tileSet.preset = 'gd128';
    for (const fan of cfg.fans) fan.enabled = true;
    const { config, disabled } = autoDisableUnmetFans(cfg);
    const removed = new Set(disabled.map((d) => d.fanId));
    const bypass = config.scoring.cap.bypass!.fanIds!;
    for (const id of removed) expect(bypass).not.toContain(id);
    expect(bypass).toContain('fullFlush');
    expect(validateFanConfig(config).ok).toBe(true);
  });

  it('可用番型（清一色/九莲宝灯）保持启用', () => {
    const cfg = configForPreset('gd128');
    expect(cfg.fans.find((f) => f.id === 'fullFlush')!.enabled).toBe(true);
    expect(cfg.fans.find((f) => f.id === 'nineGates')!.enabled).toBe(true);
    expect(cfg.fans.find((f) => f.id === 'bigWinds')!.enabled).toBe(true);
  });
});
