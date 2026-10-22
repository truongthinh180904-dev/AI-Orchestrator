import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  AgentLockRepository,
  EventRepository,
  RunRepository,
} from '@ai-orchestrator/db';
import { RunService } from '../services/run-service.js';
import { TaskScheduler } from '../services/task-scheduler.js';
import { TaskStateService } from '../services/task-state-service.js';
import { buildServer } from '../server.js';
import { createExecutionManager, type ExecutionManager } from '../adapters/execution-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mockCliPath = path.resolve(__dirname, '../../../../fixtures/mock-agy-cli.cjs');

describe('Retry Policy & Scheduler Unit Tests (ORC-004: max_attempts, backoff, no infinite retry)', () => {
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let lockRepo: AgentLockRepository;
  let eventRepo: EventRepository;
  let runRepo: RunRepository;
  let executionManager: ExecutionManager;
  let runService: RunService;
  let stateService: TaskStateService;
  let scheduler: TaskScheduler;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    lockRepo = new AgentLockRepository(db);
    eventRepo = new EventRepository(db);
    runRepo = new RunRepository(db);
    stateService = new TaskStateService(db);
    executionManager = createExecutionManager();

    // Dùng mock CLI: khi có cờ --error thì exit 1
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
  });

  afterEach(async () => {
    await executionManager.stopAll();
    db.close();
  });

  describe('TaskStateService.retryTask & Chống Retry Vô Hạn', () => {
    it('cho phép retry khi attempts < max_attempts và đưa task FAILED về READY', () => {
      const task = taskRepo.create({
        id: 'T-RETRY-1',
        title: 'Task retryable',
        status: 'FAILED',
        max_attempts: 3,
        attempts: 1,
      });

      const res = stateService.retryTask(task.id, { reason: 'Manual retry attempt 2' });
      expect(res.retried).toBe(true);
      expect(res.decision.shouldRetry).toBe(true);
      expect(res.decision.attempt).toBe(1);
      expect(res.decision.maxAttempts).toBe(3);
      expect(res.task.status).toBe('READY');

      const inDb = taskRepo.findById(task.id);
      expect(inDb?.status).toBe('READY');
    });

    it('Nghiệm thu ROADMAP: Chặn tuyệt đối khi attempts >= max_attempts (ném AppError MAX_ATTEMPTS_EXCEEDED)', () => {
      const exhaustedTask = taskRepo.create({
        id: 'T-EXHAUSTED',
        title: 'Task exhausted all attempts',
        status: 'FAILED',
        max_attempts: 3,
        attempts: 3,
      });

      expect(() => {
        stateService.retryTask(exhaustedTask.id);
      }).toThrowError(
        expect.objectContaining({
          code: 'MAX_ATTEMPTS_EXCEEDED',
        }),
      );

      // Trạng thái task vẫn phải giữ nguyên là FAILED, không bị đổi thành READY
      const inDb = taskRepo.findById(exhaustedTask.id);
      expect(inDb?.status).toBe('FAILED');
    });

    it('cho phép force retry khi có cờ force: true', () => {
      const exhaustedTask = taskRepo.create({
        id: 'T-FORCE',
        title: 'Force retry task',
        status: 'FAILED',
        max_attempts: 2,
        attempts: 2,
      });

      const res = stateService.retryTask(exhaustedTask.id, {
        force: true,
        reason: 'Operator override',
      });
      expect(res.retried).toBe(true);
      expect(res.task.status).toBe('READY');
    });

    it('ghi log sự kiện task_retry vào bảng events khi có runId', () => {
      const task = taskRepo.create({
        id: 'T-EVENT',
        title: 'Task with audit event',
        status: 'FAILED',
        max_attempts: 3,
        attempts: 1,
      });

      // Tạo một run hợp lệ trong DB
      const run = runRepo.create({
        task_id: task.id,
        attempt: 1,
        status: 'ERROR',
        started_at: new Date().toISOString(),
      });

      stateService.retryTask(task.id, { runId: run.id, reason: 'Retry with audit' });

      const events = eventRepo.findByRunId(run.id);
      const retryEvent = events.find((e) => e.type === 'task_retry');
      expect(retryEvent).toBeDefined();
      expect(retryEvent?.payload).toEqual(
        expect.objectContaining({
          taskId: task.id,
          attempt: 1,
          maxAttempts: 3,
        }),
      );
    });

    it('resetAttempts đưa số lần thử về 0 để cho phép chạy lại chu kỳ mới', () => {
      const task = taskRepo.create({
        id: 'T-RESET',
        title: 'Task to be reset',
        status: 'FAILED',
        max_attempts: 3,
        attempts: 3,
      });

      const updated = stateService.resetAttempts(task.id, 0);
      expect(updated.attempts).toBe(0);

      const decision = scheduler.retry.evaluate(updated);
      expect(decision.shouldRetry).toBe(true);
    });
  });

  describe('TaskScheduler: Chu kỳ Retry tự động trong step()', () => {
    it('Nghiệm thu: Task lỗi lần lượt qua từng attempt và dừng hẳn khi chạm max_attempts (Không retry vô hạn)', async () => {
      taskRepo.create({
        id: 'TASK-FAILING',
        title: 'Task always fails',
        status: 'READY',
        max_attempts: 3,
        attempts: 0,
      });

      // Lần chạy 1 (Attempt 1)
      const step1 = await scheduler.step({ waitBackoff: false });
      expect(step1.executed).toBe(true);
      expect(step1.taskId).toBe('TASK-FAILING');
      expect(step1.retried).toBe(true);
      expect(step1.status).toBe('RETRYING');

      const taskAfter1 = taskRepo.findById('TASK-FAILING');
      expect(taskAfter1?.attempts).toBe(1);
      expect(taskAfter1?.status).toBe('READY'); // Tự động đưa về READY cho attempt 2

      // Lần chạy 2 (Attempt 2)
      const step2 = await scheduler.step({ waitBackoff: false });
      expect(step2.executed).toBe(true);
      expect(step2.retried).toBe(true);
      expect(step2.status).toBe('RETRYING');

      const taskAfter2 = taskRepo.findById('TASK-FAILING');
      expect(taskAfter2?.attempts).toBe(2);
      expect(taskAfter2?.status).toBe('READY'); // Tự động đưa về READY cho attempt 3

      // Lần chạy 3 (Attempt 3 - Chạm max_attempts = 3)
      const step3 = await scheduler.step({ waitBackoff: false });
      expect(step3.executed).toBe(true);
      expect(step3.retried).toBe(false);
      expect(step3.status).toBe('FAILED');
      expect(step3.reason).toBe('MAX_ATTEMPTS_EXCEEDED');

      const taskAfter3 = taskRepo.findById('TASK-FAILING');
      expect(taskAfter3?.attempts).toBe(3);
      expect(taskAfter3?.status).toBe('FAILED'); // Dừng hẳn tại FAILED, không retry nữa!

      // Lần chạy 4: Không còn task READY nào, scheduler trả về NO_READY_TASKS
      const step4 = await scheduler.step();
      expect(step4.executed).toBe(false);
      expect(step4.reason).toBe('NO_READY_TASKS');
    });

    it('tắt autoRetry qua options { autoRetry: false } thì task FAILED ngay không retry', async () => {
      taskRepo.create({
        id: 'TASK-NO-RETRY',
        title: 'Task without auto retry',
        status: 'READY',
        max_attempts: 3,
        attempts: 0,
      });

      const res = await scheduler.step({ autoRetry: false });
      expect(res.executed).toBe(true);
      expect(res.retried).toBe(false);
      expect(res.status).toBe('FAILED');

      const task = taskRepo.findById('TASK-NO-RETRY');
      expect(task?.attempts).toBe(1);
      expect(task?.status).toBe('FAILED');
    });
  });

  describe('TaskScheduler: runUntilEmpty() chạy retry tuần tự và kết thúc tất định', () => {
    it('Nghiệm thu: runUntilEmpty xử lý đúng N lần thử và dừng cleanly, không lặp vô hạn', async () => {
      taskRepo.create({
        id: 'TASK-LOOP-TEST',
        title: 'Task loop test',
        status: 'READY',
        max_attempts: 3,
        attempts: 0,
      });

      const startTime = Date.now();
      const results = await scheduler.runUntilEmpty({ waitBackoff: false });
      const duration = Date.now() - startTime;

      // Phải thực thi đúng 3 lần (attempt 1, attempt 2, attempt 3)
      expect(results.length).toBe(3);
      expect(results[0]?.status).toBe('RETRYING');
      expect(results[1]?.status).toBe('RETRYING');
      expect(results[2]?.status).toBe('FAILED');
      expect(results[2]?.reason).toBe('MAX_ATTEMPTS_EXCEEDED');

      const finalTask = taskRepo.findById('TASK-LOOP-TEST');
      expect(finalTask?.status).toBe('FAILED');
      expect(finalTask?.attempts).toBe(3);

      // Lock phải được giải phóng hoàn toàn
      expect(lockRepo.isLocked('default_agent')).toBe(false);
      expect(scheduler.isRunning).toBe(false);
      // Kết thúc nhanh chóng (không bị kẹt timer)
      expect(duration).toBeLessThan(5000);
    });
  });

  describe('REST API: POST /tasks/:id/retry', () => {
    it('trả về 200 và kết quả retry khi còn lượt thử', async () => {
      taskRepo.create({
        id: 'API-TASK-1',
        title: 'API retryable task',
        status: 'FAILED',
        max_attempts: 3,
        attempts: 1,
      });

      const server = await buildServer({ db, taskScheduler: scheduler, executionManager });

      try {
        const res = await server.inject({
          method: 'POST',
          url: '/tasks/API-TASK-1/retry',
          payload: { reason: 'Operator requested retry via API' },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.data.retried).toBe(true);
        expect(body.data.task.status).toBe('READY');
      } finally {
        await server.close();
      }
    });

    it('Nghiệm thu: Từ chối retry khi attempts >= max_attempts qua API', async () => {
      taskRepo.create({
        id: 'API-TASK-EXHAUSTED',
        title: 'API exhausted task',
        status: 'FAILED',
        max_attempts: 2,
        attempts: 2,
      });

      const server = await buildServer({ db, taskScheduler: scheduler, executionManager });

      try {
        const res = await server.inject({
          method: 'POST',
          url: '/tasks/API-TASK-EXHAUSTED/retry',
          payload: {},
        });

        expect(res.statusCode).toBe(400);
        const body = res.json();
        expect(body.error.code).toBe('MAX_ATTEMPTS_EXCEEDED');
      } finally {
        await server.close();
      }
    });
  });
});
