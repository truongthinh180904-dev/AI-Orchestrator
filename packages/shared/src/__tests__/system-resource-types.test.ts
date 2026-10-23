import { describe, expect, it } from 'vitest';
import {
  SystemResourceThresholdsSchema,
  ResourceRejectReasonSchema,
} from '../resources/index.js';

describe('SystemResourceTypes Schema & Validation', () => {
  it('cung cấp giá trị mặc định chuẩn xác và an toàn', () => {
    const defaults = SystemResourceThresholdsSchema.parse({});

    expect(defaults.cpu_warning_percent).toBe(80);
    expect(defaults.cpu_critical_percent).toBe(90);
    expect(defaults.memory_warning_percent).toBe(85);
    expect(defaults.memory_critical_percent).toBe(92);
    expect(defaults.min_free_memory_bytes).toBe(256 * 1024 * 1024);
    expect(defaults.disk_warning_percent).toBe(85);
    expect(defaults.disk_critical_percent).toBe(90);
    expect(defaults.min_free_disk_bytes).toBe(1024 * 1024 * 1024);
    expect(defaults.disk_path).toBe('.');
    expect(defaults.enabled).toBe(true);
  });

  it('xác thực giới hạn hợp lệ của phần trăm (1% - 100%)', () => {
    expect(() =>
      SystemResourceThresholdsSchema.parse({ cpu_warning_percent: 0 }),
    ).toThrow();

    expect(() =>
      SystemResourceThresholdsSchema.parse({ cpu_critical_percent: 105 }),
    ).toThrow();

    const valid = SystemResourceThresholdsSchema.parse({
      cpu_warning_percent: 75,
      cpu_critical_percent: 88,
      disk_warning_percent: 70,
      disk_critical_percent: 85,
    });
    expect(valid.cpu_warning_percent).toBe(75);
    expect(valid.cpu_critical_percent).toBe(88);
  });

  it('ResourceRejectReasonSchema bao gồm SYSTEM_RESOURCE_EXCEEDED', () => {
    const parsed = ResourceRejectReasonSchema.parse('SYSTEM_RESOURCE_EXCEEDED');
    expect(parsed).toBe('SYSTEM_RESOURCE_EXCEEDED');
  });
});
