import { describe, expect, it, vi } from 'vitest';
import { autoDisableUnmetFans, clonePreset, defaultFanConfig, FAN_CONFIG_VERSION, resolveFanConfig } from '@quejie/fan-config';
import { PROTOCOL_VERSION } from '@quejie/protocol';

describe('P1 冒烟', () => {
  it('配置与协议包可导入', () => {
    expect(FAN_CONFIG_VERSION).toBe('1.1.0');
    expect(PROTOCOL_VERSION).toBe('1');
  });

  it('没有 structuredClone 时仍可独立复制和解析开局配置', () => {
    const expected = resolveFanConfig(defaultFanConfig());
    vi.stubGlobal('structuredClone', undefined);
    try {
      const config = defaultFanConfig();
      expect(resolveFanConfig(config)).toStrictEqual(expected);
      const copied = autoDisableUnmetFans(config).config;
      copied.tileSet.suits.character.copies = 1;
      copied.fans[0]!.value = 2;
      expect(config.tileSet.suits.character.copies).toBe(clonePreset('gd128').suits.character.copies);
      expect(config.fans[0]!.value).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
