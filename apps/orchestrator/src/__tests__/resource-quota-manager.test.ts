import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase, runMigrations } from '@ai-orchestrator/db';
import { ResourceQuotaManager } from '../services/resource-quota-manager.js';

describe('ResourceQuotaManager Unit Tests (OPS-001)', () => {
  let db: Database.Database;
  let simulatedTime: number;
  const mockClock = () => simulatedTime;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    simulatedTime = 1_700_000_000_000;
  });

  afterEach(() => {
    db.close();
  });

  describe('Giới hạn Concurrency (Mặc định: 1 coding process)', () => {
    it('cho phép acquire slot đầu tiên và chặn slot thứ hai khi đạt max_concurrency = 1', () => {
      const manager = new ResourceQuotaManager({
        db,
        clock: mockClock,
        config: { max_concurrency: 1 },
      });

      const canFirst = manager.canAcquire({ taskId: 'TSK-1' });
      expect(canFirst.allowed).toBe(true);

      const lease1 = manager.acquireSlot('TSK-1', 'run-1');
      expect(lease1.acquired).toBe(true);
      expect(manager.activeConcurrency).toBe(1);

      // Thử acquire slot thứ hai với task khác
      const canSecond = manager.canAcquire({ taskId: 'TSK-2' });
      expect(canSecond.allowed).toBe(false);
      expect(canSecond.reason).toBe('CONCURRENCY_LIMIT_REACHED');
      expect(canSecond.activeTaskId).toBe('TSK-1');

      expect(() => manager.acquireSlot('TSK-2', 'run-2')).toThrowError(/reached maximum limit/);

      // Giải phóng TSK-1 -> slot trở lại khả dụng
      manager.releaseSlot('TSK-1', 'run-1');
      expect(manager.activeConcurrency).toBe(0);

      const canAfterRelease = manager.canAcquire({ taskId: 'TSK-2' });
      expect(canAfterRelease.allowed).toBe(true);

      const lease2 = manager.acquireSlot('TSK-2', 'run-2');
      expect(lease2.acquired).toBe(true);
    });

    it('cho phép cấu hình max_concurrency cao hơn nếu muốn', () => {
      const manager = new ResourceQuotaManager({
        db,
        clock: mockClock,
        config: { max_concurrency: 2 },
      });

      manager.acquireSlot('TSK-1');
      manager.acquireSlot('TSK-2');
      expect(manager.activeConcurrency).toBe(2);

      const canThird = manager.canAcquire({ taskId: 'TSK-3' });
      expect(canThird.allowed).toBe(false);
      expect(canThird.reason).toBe('CONCURRENCY_LIMIT_REACHED');
    });
  });

  describe('Giới hạn Cooldown giữa các lần chạy (Inter-run Cooldown)', () => {
    it('áp dụng cooldown sau khi release slot và tự động hết hạn sau thời gian cấu hình', () => {
      const manager = new ResourceQuotaManager({
        db,
        clock: mockClock,
        config: { max_concurrency: 1, cooldown_ms: 10_000 },
      });

      manager.acquireSlot('TSK-1');
      manager.releaseSlot('TSK-1');

      // Trong vòng 10s cooldown
      simulatedTime += 3_000;
      const canDuringCooldown = manager.canAcquire({ taskId: 'TSK-2' });
      expect(canDuringCooldown.allowed).toBe(false);
      expect(canDuringCooldown.reason).toBe('COOLDOWN_ACTIVE');
      expect(canDuringCooldown.retryAfterMs).toBe(7_000);

      const status = manager.getStatus();
      expect(status.isThrottled).toBe(true);
      expect(status.cooldownRemainingMs).toBe(7_000);

      // Sau 10s cooldown
      simulatedTime += 8_000; // Tổng cộng 11s đã trôi qua
      const canAfterCooldown = manager.canAcquire({ taskId: 'TSK-2' });
      expect(canAfterCooldown.allowed).toBe(true);

      const lease = manager.acquireSlot('TSK-2');
      expect(lease.acquired).toBe(true);
    });
  });

  describe('Giới hạn Quota theo khung thời gian (Rolling Window Quota)', () => {
    it('chặn khi số run vượt trần max_runs_per_window và mở khóa khi window trôi qua', () => {
      const manager = new ResourceQuotaManager({
        db,
        clock: mockClock,
        config: {
          max_concurrency: 5,
          max_runs_per_window: 3,
          window_duration_ms: 60_000,
        },
      });

      manager.acquireSlot('TSK-1');
      manager.acquireSlot('TSK-2');
      manager.acquireSlot('TSK-3');

      const statusFull = manager.getStatus();
      expect(statusFull.windowRuns).toBe(3);
      expect(statusFull.windowRemainingQuota).toBe(0);

      // Run thứ 4 bị chặn
      const canFourth = manager.canAcquire({ taskId: 'TSK-4' });
      expect(canFourth.allowed).toBe(false);
      expect(canFourth.reason).toBe('WINDOW_QUOTA_EXCEEDED');

      // Thời gian trôi qua quá window_duration_ms (61s)
      simulatedTime += 61_000;

      const canAfterWindow = manager.canAcquire({ taskId: 'TSK-4' });
      expect(canAfterWindow.allowed).toBe(true);

      const statusAfter = manager.getStatus();
      expect(statusAfter.windowRuns).toBe(0);
      expect(statusAfter.windowRemainingQuota).toBe(3);
    });
  });

  describe('Xử lý Quota Hit, Exponential Backoff và Circuit Breaker', () => {
    it('áp dụng exponential backoff khi gặp quota hit (429/rate limit)', () => {
      const manager = new ResourceQuotaManager({
        db,
        clock: mockClock,
        config: {
          quota_backoff_ms: 10_000,
          quota_backoff_multiplier: 2,
          max_quota_backoff_ms: 60_000,
          max_consecutive_quota_hits: 4,
        },
      });

      // Lần 1: backoff = 10_000ms
      const hit1 = manager.recordQuotaHit({
        taskId: 'TSK-FAIL-1',
        error: new Error('429 Too Many Requests'),
      });
      expect(hit1.consecutiveHits).toBe(1);
      expect(hit1.backoffMs).toBe(10_000);
      expect(hit1.circuitBreakerTripped).toBe(false);

      const check1 = manager.canAcquire();
      expect(check1.allowed).toBe(false);
      expect(check1.reason).toBe('QUOTA_BACKOFF_ACTIVE');
      expect(check1.retryAfterMs).toBe(10_000);

      // Nhảy thời gian sau 10s: backoff hết hạn
      simulatedTime += 10_001;
      expect(manager.canAcquire().allowed).toBe(true);

      // Lần 2: backoff = 10_000 * 2 = 20_000ms
      const hit2 = manager.recordQuotaHit({
        taskId: 'TSK-FAIL-2',
        error: 'resource_exhausted',
      });
      expect(hit2.consecutiveHits).toBe(2);
      expect(hit2.backoffMs).toBe(20_000);

      // Thành công một task: tự động reset consecutiveHits về 0
      manager.recordSuccess('TSK-SUCCESS');
      const statusAfterSuccess = manager.getStatus();
      expect(statusAfterSuccess.consecutiveQuotaHits).toBe(0);
      expect(statusAfterSuccess.isThrottled).toBe(false);
    });

    it('kích hoạt Circuit Breaker khi số lần quota hits liên tiếp đạt max_consecutive_quota_hits', () => {
      const manager = new ResourceQuotaManager({
        db,
        clock: mockClock,
        config: {
          max_consecutive_quota_hits: 3,
          quota_backoff_ms: 1_000,
        },
      });

      manager.recordQuotaHit({ error: 'quota limit 1' });
      manager.recordQuotaHit({ error: 'quota limit 2' });
      const hit3 = manager.recordQuotaHit({ error: 'quota limit 3' });

      expect(hit3.consecutiveHits).toBe(3);
      expect(hit3.circuitBreakerTripped).toBe(true);
      expect(manager.isCircuitBreakerTripped).toBe(true);

      // Kể cả thời gian có trôi bao lâu, circuit breaker vẫn chặn
      simulatedTime += 10_000_000;
      const checkBlocked = manager.canAcquire();
      expect(checkBlocked.allowed).toBe(false);
      expect(checkBlocked.reason).toBe('CIRCUIT_BREAKER_TRIPPED');

      // Phục hồi bằng resetQuota()
      manager.resetQuota();
      expect(manager.isCircuitBreakerTripped).toBe(false);
      expect(manager.canAcquire().allowed).toBe(true);
    });
  });

  describe('Audit Logging vào QuotaEventRepository', () => {
    it('lưu vết đầy đủ các sự kiện quota, acquire, release, reset vào database SQLite', () => {
      db.prepare(
        "INSERT INTO features (id, name, created_at, updated_at) VALUES ('FEAT-TEST', 'Test Feature', datetime('now'), datetime('now'))",
      ).run();
      db.prepare(
        "INSERT INTO tasks (id, feature_id, title, created_at, updated_at) VALUES ('TSK-1', 'FEAT-TEST', 'Task 1', datetime('now'), datetime('now'))",
      ).run();
      db.prepare(
        "INSERT INTO tasks (id, feature_id, title, created_at, updated_at) VALUES ('TSK-2', 'FEAT-TEST', 'Task 2', datetime('now'), datetime('now'))",
      ).run();

      const manager = new ResourceQuotaManager({
        db,
        clock: mockClock,
        config: { max_concurrency: 1 },
      });

      manager.acquireSlot('TSK-1');
      manager.releaseSlot('TSK-1');
      manager.recordQuotaHit({ taskId: 'TSK-2', error: 'Rate limit 429' });
      manager.resetQuota();

      const events = manager.getEvents(10);
      expect(events.length).toBe(4);
      expect(events.map((e) => e.event_type)).toEqual([
        'QUOTA_RESET',
        'QUOTA_HIT',
        'SLOT_RELEASED',
        'SLOT_ACQUIRED',
      ]);
    });
  });
});
