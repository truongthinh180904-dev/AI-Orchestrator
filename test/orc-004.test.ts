import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  AgentLockRepository,
  EventRepository,
  RunRepository,
} from '../packages/db/src/index.js';
import { RetryPolicy } from '../packages/shared/src/index.js';
import {
  buildServer,
  RunService,
  TaskScheduler,
  TaskStateService,
  createExecutionManager,
  type ExecutionManager,
} from '../apps/orchestrator/src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mockCliPath = path.resolve(__dirname, '../fixtures/mock-agy-cli.cjs');

describe('ORC-004 Acceptance Tests: Retry policy (max_attempts, backoff) — Không retry vô hạn', () => {
  let db: Database.Database;
  let server: FastifyInstance;
  let taskRepo: TaskRepository;
  let lockRepo: AgentLockRepository;
  let eventRepo: EventRepository;
  let runRepo: RunRepository;
  let executionManager: ExecutionManager;
  let runService: RunService;
  let stateService: TaskStateService;
  let scheduler: TaskScheduler;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    lockRepo = new AgentLockRepository(db);
    eventRepo = new EventRepository(db);
    runRepo = new RunRepository(db);
    stateService = new TaskStateService(db);
    executionManager = createExecutionManager();

    // Mock CLI luôn thất bại (exit 1) khi có cờ --error
    runService = new RunService({
      db,
      executionManager,
      config: {
        AGY_BIN: 'node',
        AGY_ARGS: `${mockCliPath} --error`,
      },
    });

    scheduler = new TaskScheduler({
      db,
      runService,
      autoVerify: true,
      autoRetry: true,
      retryPolicy: {
        max_attempts: 3,
        strategy: 'exponential',
        initial_delay_ms: 10,
        max_delay_ms: 100,
        backoff_factor: 2,
        jitter: false,
      },
    });

    server = await buildServer({
      db,
      executionManager,
      taskScheduler: scheduler,
      logger: false,
    });
  });

  afterEach(async () => {
    await server.close();
    await executionManager.stopAll();
    db.close();
  });

  describe('Tiêu chí 1: Tiêu chuẩn nghiệm thu ROADMAP — Không retry vô hạn', () => {
    it('1.1: Task chạy lỗi liên tiếp dừng chính xác tại max_attempts và giữ nguyên FAILED, không retry vô tận', async () => {
      taskRepo.create({
        id: 'TASK-FAIL-LIMIT',
        title: 'Task that consistently fails',
        status: 'READY',
        max_attempts: 3,
        attempts: 0,
      });

      // Lần chạy 1
      const res1 = await scheduler.step({ waitBackoff: false });
      expect(res1.executed).toBe(true);
      expect(res1.retried).toBe(true);
      expect(res1.status).toBe('RETRYING');
      const t1 = taskRepo.findById('TASK-FAIL-LIMIT');
      expect(t1?.attempts).toBe(1);
      expect(t1?.status).toBe('READY');

      // Lần chạy 2
      const res2 = await scheduler.step({ waitBackoff: false });
      expect(res2.executed).toBe(true);
      expect(res2.retried).toBe(true);
      expect(res2.status).toBe('RETRYING');
      const t2 = taskRepo.findById('TASK-FAIL-LIMIT');
      expect(t2?.attempts).toBe(2);
      expect(t2?.status).toBe('READY');

      // Lần chạy 3 (Chạm mốc max_attempts = 3)
      const res3 = await scheduler.step({ waitBackoff: false });
      expect(res3.executed).toBe(true);
      expect(res3.retried).toBe(false);
      expect(res3.status).toBe('FAILED');
      expect(res3.reason).toBe('MAX_ATTEMPTS_EXCEEDED');

      const t3 = taskRepo.findById('TASK-FAIL-LIMIT');
      expect(t3?.attempts).toBe(3);
      expect(t3?.status).toBe('FAILED'); // Phải dừng tại FAILED!

      // Lần chạy 4: Không còn task READY nào được phép chạy, không rơi vào lặp vô tận
      const res4 = await scheduler.step({ waitBackoff: false });
      expect(res4.executed).toBe(false);
      expect(res4.reason).toBe('NO_READY_TASKS');
    });

    it('1.2: Vòng lặp tuần tự runUntilEmpty() dừng tất định khi hết attempts, không chạy lặp vô hạn', async () => {
      taskRepo.create({
        id: 'TASK-INFINITE-LOOP-GUARD',
        title: 'Infinite loop guard test',
        status: 'READY',
        max_attempts: 3,
        attempts: 0,
      });

      const startTime = Date.now();
      const results = await scheduler.runUntilEmpty({ waitBackoff: false });
      const duration = Date.now() - startTime;

      // Phải dừng đúng sau 3 lần thực thi
      expect(results.length).toBe(3);
      expect(results[0]?.status).toBe('RETRYING');
      expect(results[1]?.status).toBe('RETRYING');
      expect(results[2]?.status).toBe('FAILED');
      expect(results[2]?.reason).toBe('MAX_ATTEMPTS_EXCEEDED');

      const task = taskRepo.findById('TASK-INFINITE-LOOP-GUARD');
      expect(task?.status).toBe('FAILED');
      expect(task?.attempts).toBe(3);

      expect(scheduler.isRunning).toBe(false);
      expect(lockRepo.isLocked('default_agent')).toBe(false);
      expect(duration).toBeLessThan(3000); // Thoát ngay lập tức
    });

    it('1.3: Khi task đã chạm max_attempts, gọi retry qua State Service bị ném AppError MAX_ATTEMPTS_EXCEEDED', () => {
      taskRepo.create({
        id: 'TASK-REACHED-MAX',
        title: 'Task reached max attempts',
        status: 'FAILED',
        max_attempts: 3,
        attempts: 3,
      });

      expect(() => {
        stateService.retryTask('TASK-REACHED-MAX');
      }).toThrowError(
        expect.objectContaining({
          code: 'MAX_ATTEMPTS_EXCEEDED',
        }),
      );

      // Task vẫn giữ nguyên status FAILED
      const t = taskRepo.findById('TASK-REACHED-MAX');
      expect(t?.status).toBe('FAILED');
    });

    it('1.4: Tôn trọng cấu hình max_attempts riêng cho từng task (task max_attempts = 1 chỉ chạy đúng 1 lần)', async () => {
      taskRepo.create({
        id: 'TASK-ONE-ATTEMPT-ONLY',
        title: 'One attempt only task',
        status: 'READY',
        max_attempts: 1,
        attempts: 0,
      });

      const res = await scheduler.step({ waitBackoff: false });
      expect(res.executed).toBe(true);
      expect(res.retried).toBe(false);
      expect(res.status).toBe('FAILED');
      expect(res.reason).toBe('MAX_ATTEMPTS_EXCEEDED');

      const task = taskRepo.findById('TASK-ONE-ATTEMPT-ONLY');
      expect(task?.attempts).toBe(1);
      expect(task?.status).toBe('FAILED');
    });

    it('1.5: REST API POST /tasks/:id/retry từ chối khi attempts >= max_attempts với HTTP 400 và code MAX_ATTEMPTS_EXCEEDED', async () => {
      taskRepo.create({
        id: 'API-LIMIT-EXCEEDED',
        title: 'Exceeded task for API test',
        status: 'FAILED',
        max_attempts: 2,
        attempts: 2,
      });

      const response = await server.inject({
        method: 'POST',
        url: '/tasks/API-LIMIT-EXCEEDED/retry',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      const json = response.json();
      expect(json.error.code).toBe('MAX_ATTEMPTS_EXCEEDED');
      expect(json.error.message).toContain('max attempts reached (2/2)');
    });
  });

  describe('Tiêu chí 2: Chính sách Backoff và tính toán độ trễ (Backoff Delay Computation)', () => {
    it('2.1: Exponential Backoff tính toán đúng số ms theo từng lần thử và giới hạn trần max_delay_ms', () => {
      const policy = new RetryPolicy({
        strategy: 'exponential',
        initial_delay_ms: 1000,
        backoff_factor: 2,
        max_delay_ms: 5000,
        jitter: false,
      });

      // Attempt 1: 1000ms
      expect(policy.computeBackoffDelay(1)).toBe(1000);
      // Attempt 2: 2000ms
      expect(policy.computeBackoffDelay(2)).toBe(2000);
      // Attempt 3: 4000ms
      expect(policy.computeBackoffDelay(3)).toBe(4000);
      // Attempt 4: 8000ms -> capped at 5000ms
      expect(policy.computeBackoffDelay(4)).toBe(5000);
      // Attempt 10: 1000 * 2^9 = 512000ms -> capped at 5000ms
      expect(policy.computeBackoffDelay(10)).toBe(5000);
    });

    it('2.2: Linear Backoff tính toán độ trễ tuyến tính và capped tại max_delay_ms', () => {
      const policy = new RetryPolicy({
        strategy: 'linear',
        initial_delay_ms: 500,
        max_delay_ms: 1200,
        jitter: false,
      });

      expect(policy.computeBackoffDelay(1)).toBe(500);
      expect(policy.computeBackoffDelay(2)).toBe(1000);
      expect(policy.computeBackoffDelay(3)).toBe(1200); // capped at 1200
      expect(policy.computeBackoffDelay(4)).toBe(1200); // capped at 1200
    });

    it('2.3: Fixed Backoff giữ nguyên giá trị qua mọi lần thử', () => {
      const policy = new RetryPolicy({
        strategy: 'fixed',
        initial_delay_ms: 2000,
        jitter: false,
      });

      expect(policy.computeBackoffDelay(1)).toBe(2000);
      expect(policy.computeBackoffDelay(2)).toBe(2000);
      expect(policy.computeBackoffDelay(10)).toBe(2000);
    });

    it('2.4: Jitter tạo độ ngẫu nhiên an toàn trong khoảng [-jitter_ratio, +jitter_ratio]', () => {
      const policy = new RetryPolicy({
        strategy: 'fixed',
        initial_delay_ms: 1000,
        jitter: true,
        jitter_ratio: 0.1, // +/- 10% tức [900, 1100]
      });

      for (let i = 0; i < 30; i++) {
        const delay = policy.computeBackoffDelay(1);
        expect(delay).toBeGreaterThanOrEqual(900);
        expect(delay).toBeLessThanOrEqual(1100);
      }
    });
  });

  describe('Tiêu chí 3: Chuyển đổi State Machine & Ghi Nhận Lịch Sử Audit Events', () => {
    it('3.1: Task chuyển trạng thái hợp lệ FAILED -> READY và lưu bản ghi task_retry trong bảng events', () => {
      const task = taskRepo.create({
        id: 'TASK-AUDIT-TEST',
        title: 'Audit event task',
        status: 'FAILED',
        max_attempts: 3,
        attempts: 1,
      });

      const run = runRepo.create({
        task_id: task.id,
        attempt: 1,
        status: 'ERROR',
        started_at: new Date().toISOString(),
      });

      const res = stateService.retryTask(task.id, {
        runId: run.id,
        reason: 'Operator triggered retry for attempt 2',
      });

      expect(res.retried).toBe(true);
      expect(res.task.status).toBe('READY');

      const events = eventRepo.findByRunId(run.id);
      const retryEvent = events.find((e) => e.type === 'task_retry');
      expect(retryEvent).toBeDefined();
      expect(retryEvent?.payload).toEqual(
        expect.objectContaining({
          taskId: 'TASK-AUDIT-TEST',
          attempt: 1,
          maxAttempts: 3,
        }),
      );
    });

    it('3.2: Cho phép force retry và resetAttempts sau khi người vận hành can thiệp', () => {
      const task = taskRepo.create({
        id: 'TASK-RESET-TEST',
        title: 'Reset attempts task',
        status: 'FAILED',
        max_attempts: 2,
        attempts: 2,
      });

      // Task khi hết attempts thì evaluate trả về false
      const preDecision = scheduler.retry.evaluate(task);
      expect(preDecision.shouldRetry).toBe(false);

      // Force retry cho phép ghi đè
      const forceRes = stateService.retryTask(task.id, { force: true, reason: 'Admin override' });
      expect(forceRes.retried).toBe(true);
      expect(forceRes.task.status).toBe('READY');

      // Reset attempts về 0 trên một task FAILED khác
      const task2 = taskRepo.create({
        id: 'TASK-RESET-TEST-2',
        title: 'Reset attempts task 2',
        status: 'FAILED',
        max_attempts: 2,
        attempts: 2,
      });
      const resetTask2 = stateService.resetAttempts(task2.id, 0);
      expect(resetTask2.attempts).toBe(0);

      const decision2 = scheduler.retry.evaluate(resetTask2);
      expect(decision2.shouldRetry).toBe(true);
    });

    it('3.3: REST API POST /tasks/:id/retry thành công khi task còn lượt thử', async () => {
      taskRepo.create({
        id: 'API-TASK-SUCCESS',
        title: 'API retry success task',
        status: 'FAILED',
        max_attempts: 3,
        attempts: 1,
      });

      const response = await server.inject({
        method: 'POST',
        url: '/tasks/API-TASK-SUCCESS/retry',
        payload: { reason: 'API retry request' },
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.data.retried).toBe(true);
      expect(json.data.task.status).toBe('READY');
      expect(json.data.decision.shouldRetry).toBe(true);
    });
  });
});
