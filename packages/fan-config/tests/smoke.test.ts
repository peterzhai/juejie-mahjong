import { describe, expect, it } from 'vitest';
import { FAN_CONFIG_VERSION } from '@quejie/fan-config';
import { PROTOCOL_VERSION } from '@quejie/protocol';

describe('P1 冒烟', () => {
  it('配置与协议包可导入', () => {
    expect(FAN_CONFIG_VERSION).toBe('1.1.0');
    expect(PROTOCOL_VERSION).toBe('1');
  });
});
