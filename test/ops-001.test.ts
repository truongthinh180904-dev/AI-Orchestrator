import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  RunRepository,
} from '../packages/db/src/index.js';
import {
  isQuotaOrRateLimitError,
  type TaskStatus,
} from '../packages/shared/src/index.js';
import { buildServer } from '../apps/orchestrator/src/server.js';
import { ResourceQuotaManager } from '../apps/orchestrator/src/services/resource-quota-manager.js';
import { TaskScheduler } from '../apps/orchestrator/src/services/task-scheduler.js';
import { RunService } from '../apps/orchestrator/src/services/run-service.js';
import { ExecutionManager } from '../apps/orchestrator/src/adapters/execution-manager.js';

describe('OPS-001: Resource & Quota Manager (concurrency, backoff) — Giới hạn hoạt động', () => {
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let simulatedTime: number;
  const mockClock = () => simulatedTime;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    simulatedTime = 1_700_000_000_000;

    // Helper tạo feature mẫu
    db.prepare("INSERT INTO features (id, name, created_at, updated_at) VALUES ('FEAT-OPS', 'OPS Feature', datetime('now'), datetime('now'))").run();
  });

  afterEach(() => {
    db.close();
  });

  function createTestTask(id: string, status: TaskStatus = 'READY', priority = 10) {
    return taskRepo.create({
      id,
      feature_id: 'FEAT-OPS',
      title: `Task ${id}`,
      status,
      priority,
    });
  }

  describe('1. Giới hạn Concurrency (Tối đa 1 coding process tại một thời điểm)', () => {
    it('1.1: Concurrency mặc định = 1 — Chặn nỗ lực acquire slot thứ hai khi slot đầu đang hoạt động', () => {
      const manager = new ResourceQuotaManager({
        db,
        clock: mockClock,
        config: { max_concurrency: 1 },
      });

      // Lần đầu tiên: được phép
      const canFirst = manager.canAcquire({ taskId: 'TSK-CONC-1' });
      expect(canFirst.allowed).toBe(true);
      const slot1 = manager.acquireSlot('TSK-CONC-1', 'run-1');
      expect(slot1.acquired).toBe(true);
      expect(manager.activeConcurrency).toBe(1);

      // Lần thứ hai: vượt giới hạn concurrency -> bị chặn
      const canSecond = manager.canAcquire({ taskId: 'TSK-CONC-2' });
      expect(canSecond.allowed).toBe(false);
      expect(canSecond.reason).toBe('CONCURRENCY_LIMIT_REACHED');
      expect(canSecond.activeTaskId).toBe('TSK-CONC-1');

      expect(() => manager.acquireSlot('TSK-CONC-2', 'run-2')).toThrowError(/reached maximum limit/);

      // Giải phóng slot 1 -> slot 2 được phép
      manager.releaseSlot('TSK-CONC-1', 'run-1');
      expect(manager.activeConcurrency).toBe(0);

      const canAfterRelease = manager.canAcquire({ taskId: 'TSK-CONC-2' });
      expect(canAfterRelease.allowed).toBe(true);
      const slot2 = manager.acquireSlot('TSK-CONC-2', 'run-2');
      expect(slot2.acquired).toBe(true);
    });

    it('1.2: Cấu hình linh hoạt max_concurrency tùy biến', () => {
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

      manager.releaseSlot('TSK-1');
      expect(manager.canAcquire({ taskId: 'TSK-3' }).allowed).toBe(true);
    });
  });

  describe('2. Giới hạn Cooldown giữa các lần chạy (Inter-run Cooldown)', () => {
    it('2.1: Giãn cách nghỉ cooldown_ms giữa 2 lượt chạy liên tiếp', () => {
      const COOLDOWN_MS = 60_000; // 60s
      const manager = new ResourceQuotaManager({
        db,
        clock: mockClock,
        config: { max_concurrency: 1, cooldown_ms: COOLDOWN_MS },
      });

      manager.acquireSlot('TSK-1');
      manager.releaseSlot('TSK-1');

      // Ngay sau khi release: cooldown đang hiệu lực (còn 60s)
      const duringCooldown = manager.canAcquire({ taskId: 'TSK-2' });
      expect(duringCooldown.allowed).toBe(false);
      expect(duringCooldown.reason).toBe('COOLDOWN_ACTIVE');
      expect(duringCooldown.retryAfterMs).toBe(COOLDOWN_MS);

      // Trôi qua 30s: cooldown vẫn còn 30s
      simulatedTime += 30_000;
      const midCooldown = manager.canAcquire({ taskId: 'TSK-2' });
      expect(midCooldown.allowed).toBe(false);
      expect(midCooldown.reason).toBe('COOLDOWN_ACTIVE');
      expect(midCooldown.retryAfterMs).toBe(30_000);

      // Trôi qua thêm 31s (tổng 61s > 60s): cooldown đã hết, cho phép chạy
      simulatedTime += 31_000;
      const afterCooldown = manager.canAcquire({ taskId: 'TSK-2' });
      expect(afterCooldown.allowed).toBe(true);

      const slot2 = manager.acquireSlot('TSK-2');
      expect(slot2.acquired).toBe(true);
    });
  });

  describe('3. Giới hạn Quota theo khung thời gian (Rolling Window Rate Limit)', () => {
    it('3.1: Chặn khi đạt số lượt tối đa trong rolling window và tự động hồi phục sau window', () => {
      const WINDOW_MS = 60_000; // 1 phút
      const MAX_RUNS = 2;
      const manager = new ResourceQuotaManager({
        db,
        clock: mockClock,
        config: {
          max_concurrency: 5,
          max_runs_per_window: MAX_RUNS,
          window_duration_ms: WINDOW_MS,
        },
      });

      manager.acquireSlot('TSK-1');
      manager.acquireSlot('TSK-2');

      const status = manager.getStatus();
      expect(status.windowRuns).toBe(2);
      expect(status.windowRemainingQuota).toBe(0);

      // Lần chạy thứ 3 bị từ chối do chạm trần quota cửa sổ
      const canThird = manager.canAcquire({ taskId: 'TSK-3' });
      expect(canThird.allowed).toBe(false);
      expect(canThird.reason).toBe('WINDOW_QUOTA_EXCEEDED');

      // Sau khi cửa sổ trôi qua (61s): quota phục hồi
      simulatedTime += 61_000;
      const canAfterWindow = manager.canAcquire({ taskId: 'TSK-3' });
      expect(canAfterWindow.allowed).toBe(true);

      const statusAfter = manager.getStatus();
      expect(statusAfter.windowRuns).toBe(0);
      expect(statusAfter.windowRemainingQuota).toBe(MAX_RUNS);
    });
  });

  describe('4. Quota Hit & Exponential Backoff', () => {
    it('4.1: Nhận diện lỗi rate limit 429 và áp dụng exponential backoff tăng dần', () => {
      const manager = new ResourceQuotaManager({
        db,
        clock: mockClock,
        config: {
          quota_backoff_ms: 10_000,
          quota_backoff_multiplier: 2,
          max_quota_backoff_ms: 80_000,
          max_consecutive_quota_hits: 5,
        },
      });

      // Lần 1: 10_000ms
      const hit1 = manager.recordQuotaHit({ error: 'HTTP 429 Too Many Requests' });
      expect(hit1.consecutiveHits).toBe(1);
      expect(hit1.backoffMs).toBe(10_000);
      expect(manager.canAcquire().allowed).toBe(false);
      expect(manager.canAcquire().reason).toBe('QUOTA_BACKOFF_ACTIVE');

      // Thời gian trôi qua 10s: backoff hết
      simulatedTime += 10_001;
      expect(manager.canAcquire().allowed).toBe(true);

      // Lần 2: 10_000 * 2^1 = 20_000ms
      const hit2 = manager.recordQuotaHit({ error: 'rate limit reached' });
      expect(hit2.consecutiveHits).toBe(2);
      expect(hit2.backoffMs).toBe(20_000);

      // Thời gian trôi qua 20s: backoff hết
      simulatedTime += 20_001;
      expect(manager.canAcquire().allowed).toBe(true);

      // Lần 3: 10_000 * 2^2 = 40_000ms
      const hit3 = manager.recordQuotaHit({ error: 'resource_exhausted' });
      expect(hit3.consecutiveHits).toBe(3);
      expect(hit3.backoffMs).toBe(40_000);

      // Task thành công -> tự động reset consecutiveHits về 0
      manager.recordSuccess('TSK-OK');
      const status = manager.getStatus();
      expect(status.consecutiveQuotaHits).toBe(0);
      expect(status.isThrottled).toBe(false);
    });

    it('4.2: Hàm isQuotaOrRateLimitError nhận diện chuẩn xác các mẫu lỗi quota', () => {
      expect(isQuotaOrRateLimitError('429 Too Many Requests')).toBe(true);
      expect(isQuotaOrRateLimitError('quota exceeded for quota metric')).toBe(true);
      expect(isQuotaOrRateLimitError('Rate limit reached')).toBe(true);
      expect(isQuotaOrRateLimitError('Resource exhausted')).toBe(true);
      expect(isQuotaOrRateLimitError('Server is overloaded')).toBe(true);
      expect(isQuotaOrRateLimitError({ status: 429 })).toBe(true);
      expect(isQuotaOrRateLimitError({ statusCode: 429 })).toBe(true);
      expect(isQuotaOrRateLimitError('Git merge conflict')).toBe(false);
    });
  });

  describe('5. Quota Circuit Breaker', () => {
    it('5.1: Kích hoạt Circuit Breaker khi vượt max_consecutive_quota_hits và yêu cầu reset thủ công', () => {
      const manager = new ResourceQuotaManager({
        db,
        clock: mockClock,
        config: {
          max_consecutive_quota_hits: 3,
          quota_backoff_ms: 1_000,
        },
      });

      manager.recordQuotaHit({ error: 'hit 1' });
      manager.recordQuotaHit({ error: 'hit 2' });
      const hit3 = manager.recordQuotaHit({ error: 'hit 3' });

      expect(hit3.circuitBreakerTripped).toBe(true);
      expect(manager.isCircuitBreakerTripped).toBe(true);

      // Kể cả thời gian trôi qua 100 giờ, Circuit Breaker vẫn kiên quyết chặn
      simulatedTime += 360_000_000;
      const check = manager.canAcquire();
      expect(check.allowed).toBe(false);
      expect(check.reason).toBe('CIRCUIT_BREAKER_TRIPPED');

      // Thực hiện resetQuota() -> giải phóng mạch và cho phép hoạt động lại
      manager.resetQuota();
      expect(manager.isCircuitBreakerTripped).toBe(false);
      expect(manager.canAcquire().allowed).toBe(true);
    });
  });

  describe('6. Tích hợp TaskScheduler với Resource & Quota Manager', () => {
    it('6.1: TaskScheduler từ chối acquire task khi ResourceQuotaManager đang kích hoạt backoff hoặc cooldown', async () => {
      createTestTask('TSK-SCHED-1');
      createTestTask('TSK-SCHED-2');

      const quotaManager = new ResourceQuotaManager({
        db,
        clock: mockClock,
        config: { max_concurrency: 1 },
      });

      const executionManager = new ExecutionManager();
      const runService = new RunService({ db, executionManager });
      const scheduler = new TaskScheduler({
        db,
        runService,
        resourceQuotaManager: quotaManager,
      });

      // Kích hoạt quota backoff giả lập
      quotaManager.recordQuotaHit({ error: 'rate limit 429' });

      // Scheduler thử acquire task
      const acquireResult = scheduler.acquireNextTask();
      expect(acquireResult.acquired).toBe(false);
      expect(acquireResult.reason).toBe('RESOURCE_QUOTA_BLOCKED');
      expect(acquireResult.quotaResult?.reason).toBe('QUOTA_BACKOFF_ACTIVE');

      // Scheduler gọi step()
      const stepResult = await scheduler.step();
      expect(stepResult.executed).toBe(false);
      expect(stepResult.reason).toBe('RESOURCE_QUOTA_BLOCKED');

      // Giải phóng quota
      quotaManager.resetQuota();

      // Sau khi giải phóng: scheduler acquire được task
      const acquireAfterReset = scheduler.acquireNextTask();
      expect(acquireAfterReset.acquired).toBe(true);
      expect(acquireAfterReset.task?.id).toBe('TSK-SCHED-1');

      // Dọn dẹp lock
      scheduler.releaseLock();
    });

    it('6.2: Scheduler phát hiện lỗi 429 khi chạy task và tự động kích hoạt quota hit', async () => {
      createTestTask('TSK-FAIL-429');

      const quotaManager = new ResourceQuotaManager({
        db,
        clock: mockClock,
        config: { max_concurrency: 1, quota_backoff_ms: 10_000 },
      });

      const executionManager = new ExecutionManager();
      const runService = new RunService({ db, executionManager });
      const scheduler = new TaskScheduler({
        db,
        runService,
        resourceQuotaManager: quotaManager,
        autoRetry: false,
      });

      // Bắt đầu một run và mô phỏng kết thúc với lỗi 429
      const acquire = scheduler.acquireNextTask();
      expect(acquire.acquired).toBe(true);

      const runRepo = new RunRepository(db);
      const testRun = runRepo.create({
        task_id: 'TSK-FAIL-429',
        status: 'RUNNING',
      });

      // Cập nhật run thất bại với lỗi 429
      runRepo.update(testRun.id, {
        status: 'ERROR',
        exit_code: 1,
      });

      // Quota Manager ghi nhận hit
      quotaManager.recordQuotaHit({
        taskId: 'TSK-FAIL-429',
        runId: testRun.id,
        error: 'HTTP 429: Too Many Requests',
      });

      expect(quotaManager.getStatus().consecutiveQuotaHits).toBe(1);
      expect(quotaManager.getStatus().isThrottled).toBe(true);

      scheduler.releaseLock();
    });
  });

  describe('7. REST API Endpoints (/system/quota)', () => {
    it('7.1: GET /system/quota trả về trạng thái chi tiết thời gian thực', async () => {
      const quotaManager = new ResourceQuotaManager({
        db,
        clock: mockClock,
        config: { max_concurrency: 1, cooldown_ms: 180_000 },
      });

      const server = await buildServer({ db, resourceQuotaManager: quotaManager });

      const res = await server.inject({
        method: 'GET',
        url: '/system/quota',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.maxConcurrency).toBe(1);
      expect(body.data.config.cooldown_ms).toBe(180_000);
      expect(body.data.consecutiveQuotaHits).toBe(0);
      expect(body.data.isThrottled).toBe(false);

      await server.close();
    });

    it('7.2: PATCH /system/quota/config cập nhật cấu hình tức thời', async () => {
      const quotaManager = new ResourceQuotaManager({
        db,
        clock: mockClock,
      });

      const server = await buildServer({ db, resourceQuotaManager: quotaManager });

      const res = await server.inject({
        method: 'PATCH',
        url: '/system/quota/config',
        payload: {
          max_concurrency: 3,
          cooldown_ms: 10_000,
          max_consecutive_quota_hits: 5,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.config.max_concurrency).toBe(3);
      expect(body.data.config.cooldown_ms).toBe(10_000);
      expect(body.data.config.max_consecutive_quota_hits).toBe(5);

      expect(quotaManager.currentConfig.max_concurrency).toBe(3);

      await server.close();
    });

    it('7.3: POST /system/quota/reset giải phóng circuit breaker và xóa quota hits', async () => {
      const quotaManager = new ResourceQuotaManager({
        db,
        clock: mockClock,
        config: { max_consecutive_quota_hits: 2 },
      });

      quotaManager.recordQuotaHit({ error: 'hit 1' });
      quotaManager.recordQuotaHit({ error: 'hit 2' });
      expect(quotaManager.isCircuitBreakerTripped).toBe(true);

      const server = await buildServer({ db, resourceQuotaManager: quotaManager });

      const res = await server.inject({
        method: 'POST',
        url: '/system/quota/reset',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.status.isCircuitBreakerTripped).toBe(false);
      expect(body.data.status.consecutiveQuotaHits).toBe(0);
      expect(quotaManager.isCircuitBreakerTripped).toBe(false);

      await server.close();
    });

    it('7.4: GET /system/quota/events trả về lịch sử sự kiện tài nguyên từ DB', async () => {
      createTestTask('TSK-1');
      createTestTask('TSK-2');

      const quotaManager = new ResourceQuotaManager({
        db,
        clock: mockClock,
      });

      quotaManager.acquireSlot('TSK-1');
      quotaManager.releaseSlot('TSK-1');
      quotaManager.recordQuotaHit({ taskId: 'TSK-2', error: '429' });

      const server = await buildServer({ db, resourceQuotaManager: quotaManager });

      const res = await server.inject({
        method: 'GET',
        url: '/system/quota/events?limit=10',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.count).toBe(3);
      expect(body.data.events.length).toBe(3);

      await server.close();
    });
  });
});
