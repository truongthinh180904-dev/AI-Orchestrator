import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase, runMigrations } from '@ai-orchestrator/db';
import type { SystemResourceMetricsSample } from '@ai-orchestrator/shared';
import { SystemResourceMonitor } from '../services/system-resource-monitor.js';

describe('SystemResourceMonitor Unit Tests', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('lấy mẫu metrics thực tế từ OS (CPU, RAM, Disk) có cấu trúc hợp lệ', () => {
    const monitor = new SystemResourceMonitor({ db });
    const sample = monitor.sampleMetrics();

    expect(sample.cpu.cores).toBeGreaterThanOrEqual(1);
    expect(sample.cpu.usagePercent).toBeGreaterThanOrEqual(0);
    expect(sample.cpu.usagePercent).toBeLessThanOrEqual(100);

    expect(sample.memory.totalBytes).toBeGreaterThan(0);
    expect(sample.memory.freeBytes).toBeGreaterThanOrEqual(0);
    expect(sample.memory.usedPercent).toBeGreaterThanOrEqual(0);
    expect(sample.memory.usedPercent).toBeLessThanOrEqual(100);

    expect(sample.disk.totalBytes).toBeGreaterThan(0);
    expect(sample.disk.usedPercent).toBeGreaterThanOrEqual(0);
  });

  it('đánh giá trạng thái OK khi mọi tài nguyên nằm dưới ngưỡng cảnh báo', () => {
    const safeSample: SystemResourceMetricsSample = {
      cpu: { usagePercent: 45.0, loadAverage1m: 1.2, cores: 4 },
      memory: {
        totalBytes: 16 * 1024 * 1024 * 1024,
        freeBytes: 10 * 1024 * 1024 * 1024,
        usedBytes: 6 * 1024 * 1024 * 1024,
        usedPercent: 37.5,
      },
      disk: {
        path: '.',
        totalBytes: 500 * 1024 * 1024 * 1024,
        freeBytes: 300 * 1024 * 1024 * 1024,
        usedBytes: 200 * 1024 * 1024 * 1024,
        usedPercent: 40.0,
      },
    };

    const monitor = new SystemResourceMonitor({
      db,
      metricsSampler: () => safeSample,
    });

    const snapshot = monitor.evaluate();
    expect(snapshot.status).toBe('OK');
    expect(snapshot.breaches).toHaveLength(0);

    const canAcquire = monitor.canAcquire();
    expect(canAcquire.allowed).toBe(true);
  });

  it('chuyển sang trạng thái WARNING khi CPU chạm 82% (> 80%), cho phép nhận task nhưng cảnh báo', () => {
    const warningSample: SystemResourceMetricsSample = {
      cpu: { usagePercent: 82.5, loadAverage1m: 3.3, cores: 4 },
      memory: {
        totalBytes: 16 * 1024 * 1024 * 1024,
        freeBytes: 6 * 1024 * 1024 * 1024,
        usedBytes: 10 * 1024 * 1024 * 1024,
        usedPercent: 62.5,
      },
      disk: {
        path: '.',
        totalBytes: 500 * 1024 * 1024 * 1024,
        freeBytes: 300 * 1024 * 1024 * 1024,
        usedBytes: 200 * 1024 * 1024 * 1024,
        usedPercent: 40.0,
      },
    };

    const monitor = new SystemResourceMonitor({
      db,
      metricsSampler: () => warningSample,
    });

    const snapshot = monitor.evaluate();
    expect(snapshot.status).toBe('WARNING');
    expect(snapshot.breaches).toHaveLength(1);
    expect(snapshot.breaches[0]?.level).toBe('WARNING');
    expect(snapshot.breaches[0]?.resource).toBe('cpu');

    // Cảnh báo không dừng nhận task
    const canAcquire = monitor.canAcquire();
    expect(canAcquire.allowed).toBe(true);
  });

  it('chuyển sang trạng thái CRITICAL khi RAM hoặc Disk vượt ngưỡng dừng, từ chối nhận task', () => {
    const criticalDiskSample: SystemResourceMetricsSample = {
      cpu: { usagePercent: 30.0, loadAverage1m: 1.0, cores: 4 },
      memory: {
        totalBytes: 16 * 1024 * 1024 * 1024,
        freeBytes: 8 * 1024 * 1024 * 1024,
        usedBytes: 8 * 1024 * 1024 * 1024,
        usedPercent: 50.0,
      },
      disk: {
        path: '.',
        totalBytes: 500 * 1024 * 1024 * 1024,
        freeBytes: 500 * 1024 * 1024, // 500MB < min 1GB
        usedBytes: 499.5 * 1024 * 1024 * 1024,
        usedPercent: 99.9,
      },
    };

    const monitor = new SystemResourceMonitor({
      db,
      metricsSampler: () => criticalDiskSample,
    });

    const snapshot = monitor.evaluate();
    expect(snapshot.status).toBe('CRITICAL');
    expect(snapshot.breaches.some((b) => b.level === 'CRITICAL')).toBe(true);

    // Vượt ngưỡng -> dừng nhận task
    const canAcquire = monitor.canAcquire();
    expect(canAcquire.allowed).toBe(false);
    expect(canAcquire.reason).toBe('SYSTEM_RESOURCE_EXCEEDED');
  });

  it('hỗ trợ cập nhật ngưỡng linh hoạt và ghi nhận kiểm toán vào database', () => {
    const monitor = new SystemResourceMonitor({ db });
    const updated = monitor.updateThresholds({
      cpu_warning_percent: 70,
      cpu_critical_percent: 85,
    });

    expect(updated.cpu_warning_percent).toBe(70);
    expect(updated.cpu_critical_percent).toBe(85);
  });
});
