import {
  autoDisableUnmetFans,
  clonePreset,
  defaultFanConfig,
  type FanConfig,
} from '@quejie/fan-config';

/**
 * 用指定预设替换默认配置的 tileSet：
 * - 自动禁用依赖不满足的番型（预设快捷填充流程）
 * - 非 wild 模式自动关闭 redCenterBonus（红中一致性，PRD 6.3 第 4 条）
 */
export function configForPreset(presetId: string): FanConfig {
  const cfg = defaultFanConfig();
  cfg.tileSet = clonePreset(presetId);
  cfg.tileSet.preset = presetId;
  if (cfg.tileSet.redCenterMode !== 'wild') {
    cfg.scoring.redCenterBonus.enabled = false;
  }
  // 预设应用语义：从番型表全量启用出发，按新牌集重新自动禁用
  for (const fan of cfg.fans) fan.enabled = true;
  return autoDisableUnmetFans(cfg).config;
}
