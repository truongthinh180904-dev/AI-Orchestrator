import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../connection.js';
import { runMigrations } from '../migrator.js';
import { SystemResourceRepository } from '../repositories/system-resource-repository.js';

describe('SystemResourceRepository (Migration 017 & Persistence)', () => {
  let db: Database.Database;
  let repo: SystemResourceRepository;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repo = new SystemResourceRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('lưu vết sự kiện tài nguyên hệ thống và truy vấn theo ID / mới nhất', () => {
    const created = repo.create({
      event_type: 'RESOURCE_CRITICAL',
      status: 'CRITICAL',
      cpu_percent: 94.5,
      memory_percent: 88.2,
      memory_free_bytes: 1024 * 1024 * 500,
      memory_total_bytes: 1024 * 1024 * 4096,
      disk_percent: 91.0,
      disk_free_bytes: 1024 * 1024 * 512,
      disk_total_bytes: 1024 * 1024 * 1024 * 50,
      breaches: [
        {
          resource: 'cpu',
          level: 'CRITICAL',
          metric: 'usagePercent',
          current: 94.5,
          threshold: 90.0,
          unit: '%',
          message: 'CPU usage (94.5%) exceeded critical threshold (90%)',
        },
      ],
      details: { trigger: 'test_load' },
    });

    expect(created.id).toBeDefined();
    expect(created.status).toBe('CRITICAL');
    expect(created.cpu_percent).toBe(94.5);
    expect(created.breaches).toHaveLength(1);

    const found = repo.findById(created.id);
    expect(found).not.toBeNull();
    expect(found?.cpu_percent).toBe(94.5);
    expect(found?.breaches[0]?.metric).toBe('usagePercent');

    const latest = repo.findLatest();
    expect(latest?.id).toBe(created.id);
  });

  it('lọc danh sách sự kiện theo status và event_type', () => {
    repo.create({
      event_type: 'RESOURCE_WARNING',
      status: 'WARNING',
      cpu_percent: 82.0,
      memory_percent: 70.0,
      memory_free_bytes: 1000,
      memory_total_bytes: 5000,
      disk_percent: 60.0,
      disk_free_bytes: 2000,
      disk_total_bytes: 5000,
      created_at: '2026-10-23T10:00:00.000Z',
    });

    repo.create({
      event_type: 'RESOURCE_CRITICAL',
      status: 'CRITICAL',
      cpu_percent: 95.0,
      memory_percent: 96.0,
      memory_free_bytes: 50,
      memory_total_bytes: 5000,
      disk_percent: 60.0,
      disk_free_bytes: 2000,
      disk_total_bytes: 5000,
      created_at: '2026-10-23T10:01:00.000Z',
    });

    repo.create({
      event_type: 'RESOURCE_RECOVERED',
      status: 'OK',
      cpu_percent: 30.0,
      memory_percent: 40.0,
      memory_free_bytes: 3000,
      memory_total_bytes: 5000,
      disk_percent: 60.0,
      disk_free_bytes: 2000,
      disk_total_bytes: 5000,
      created_at: '2026-10-23T10:02:00.000Z',
    });

    const criticalEvents = repo.findAll({ status: 'CRITICAL' });
    expect(criticalEvents).toHaveLength(1);
    expect(criticalEvents[0]?.cpu_percent).toBe(95.0);

    const warningEvents = repo.findAll({ status: 'WARNING' });
    expect(warningEvents).toHaveLength(1);

    const allEvents = repo.findAll({ limit: 10 });
    expect(allEvents).toHaveLength(3);
    expect(repo.count()).toBe(3);
  });
});
