import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, runMigrations, TaskRepository, EventRepository } from '../packages/db/src/index.js';
import { type TaskStatus } from '../packages/shared/src/index.js';
import { buildServer } from '../apps/orchestrator/src/server.js';
import { TaskStateService } from '../apps/orchestrator/src/services/task-state-service.js';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

describe('ORC-001: Task State Machine & Transitions', () => {
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let eventRepo: EventRepository;
  let taskStateService: TaskStateService;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    eventRepo = new EventRepository(db);
    taskStateService = new TaskStateService(db);
    app = await buildServer({ db });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  describe('Nghiệm thu 1: Chu trình hợp lệ TODO → READY → RUNNING → VERIFYING → DONE', () => {
    it('chuyển đổi tuần tự qua repository transitionStatus thành công', () => {
      const task = taskRepo.create({
        id: 'ORC-TASK-1',
        title: 'Linear Lifecycle Task',
        status: 'TODO',
      });
      expect(task.status).toBe('TODO');
      expect(task.attempts).toBe(0);

      // 1. TODO -> READY
      const s1 = taskRepo.transitionStatus('ORC-TASK-1', 'READY', { reason: 'Dependencies ready' });
      expect(s1.status).toBe('READY');

      // 2. READY -> RUNNING (tăng attempt lên 1)
      const s2 = taskRepo.transitionStatus('ORC-TASK-1', 'RUNNING', {
        reason: 'Worker started',
        incrementAttempt: true,
      });
      expect(s2.status).toBe('RUNNING');
      expect(s2.attempts).toBe(1);

      // 3. RUNNING -> VERIFYING
      const s3 = taskRepo.transitionStatus('ORC-TASK-1', 'VERIFYING', {
        reason: 'Worker finished code change, running test suite',
      });
      expect(s3.status).toBe('VERIFYING');

      // 4. VERIFYING -> DONE
      const s4 = taskRepo.transitionStatus('ORC-TASK-1', 'DONE', {
        reason: 'Acceptance tests passed with exit code 0',
      });
      expect(s4.status).toBe('DONE');
      expect(s4.attempts).toBe(1);

      // Xác minh trong DB
      const inDb = taskRepo.findById('ORC-TASK-1');
      expect(inDb?.status).toBe('DONE');
    });

    it('chuyển đổi tuần tự qua TaskStateService và ghi nhận event', () => {
      taskRepo.create({
        id: 'ORC-TASK-SVC',
        title: 'Service Managed Task',
        status: 'TODO',
      });

      // Tạo một run giả lập trong DB
      db.prepare(`
        INSERT INTO runs (id, task_id, attempt, status, started_at)
        VALUES ('run-orc-1', 'ORC-TASK-SVC', 1, 'RUNNING', datetime('now'))
      `).run();

      const r1 = taskStateService.markReady('ORC-TASK-SVC');
      expect(r1.status).toBe('READY');

      const r2 = taskStateService.markRunning('ORC-TASK-SVC', { runId: 'run-orc-1' });
      expect(r2.status).toBe('RUNNING');
      expect(r2.attempts).toBe(1);

      const r3 = taskStateService.markVerifying('ORC-TASK-SVC', { runId: 'run-orc-1' });
      expect(r3.status).toBe('VERIFYING');

      const r4 = taskStateService.markDone('ORC-TASK-SVC', { runId: 'run-orc-1' });
      expect(r4.status).toBe('DONE');

      // Kiểm tra events đã được lưu vào bảng events
      const events = eventRepo.findByRunId('run-orc-1');
      expect(events.length).toBeGreaterThanOrEqual(3);
      const transitionEvents = events.filter((e) => e.type === 'task_transition');
      expect(transitionEvents.length).toBe(3);
      expect((transitionEvents[0]?.payload as Record<string, unknown>).to).toBe('RUNNING');
      expect((transitionEvents[1]?.payload as Record<string, unknown>).to).toBe('VERIFYING');
      expect((transitionEvents[2]?.payload as Record<string, unknown>).to).toBe('DONE');
    });
  });

  describe('Nghiệm thu 2: Các nhánh phân nhánh (FAILED, BLOCKED, PAUSED, CANCELLED)', () => {
    it('Chu trình Thất bại & Thử lại: RUNNING → FAILED → READY → RUNNING → VERIFYING → DONE', () => {
      taskRepo.create({ id: 'TASK-RETRY', title: 'Retry Task', status: 'READY' });

      // Lần 1: RUNNING -> FAILED
      taskStateService.markRunning('TASK-RETRY', { incrementAttempt: true });
      expect(taskStateService.getStatus('TASK-RETRY')).toBe('RUNNING');

      taskStateService.markFailed('TASK-RETRY', { reason: 'Mock error: compile failure' });
      expect(taskStateService.getStatus('TASK-RETRY')).toBe('FAILED');

      // Scheduler retry: FAILED -> READY
      taskStateService.markReady('TASK-RETRY', 'Retrying attempt 2');
      expect(taskStateService.getStatus('TASK-RETRY')).toBe('READY');

      // Lần 2: RUNNING -> VERIFYING -> DONE
      taskStateService.markRunning('TASK-RETRY', { incrementAttempt: true });
      expect(taskRepo.findById('TASK-RETRY')?.attempts).toBe(2);

      taskStateService.markVerifying('TASK-RETRY');
      taskStateService.markDone('TASK-RETRY');
      expect(taskStateService.getStatus('TASK-RETRY')).toBe('DONE');
    });

    it('Chu trình Tạm dừng & Tiếp tục: RUNNING → PAUSED → READY', () => {
      taskRepo.create({ id: 'TASK-PAUSE', title: 'Pause Task', status: 'READY' });
      taskStateService.markRunning('TASK-PAUSE');

      taskStateService.pause('TASK-PAUSE', 'Paused by operator');
      expect(taskStateService.getStatus('TASK-PAUSE')).toBe('PAUSED');

      taskStateService.resume('TASK-PAUSE', 'Resumed to queue');
      expect(taskStateService.getStatus('TASK-PAUSE')).toBe('READY');
    });

    it('Chu trình Bị chặn & Gỡ chặn: TODO → BLOCKED → READY', () => {
      taskRepo.create({ id: 'TASK-BLOCK', title: 'Blocked Task', status: 'TODO' });

      taskStateService.markBlocked('TASK-BLOCK', 'Missing external DB credential');
      expect(taskStateService.getStatus('TASK-BLOCK')).toBe('BLOCKED');

      taskStateService.markReady('TASK-BLOCK', 'Credential provided');
      expect(taskStateService.getStatus('TASK-BLOCK')).toBe('READY');
    });

    it('Chu trình Hủy tác vụ: RUNNING → CANCELLED & CANCELLED → TODO (Reopen)', () => {
      taskRepo.create({ id: 'TASK-CANCEL', title: 'Cancel Task', status: 'READY' });
      taskStateService.markRunning('TASK-CANCEL');

      taskStateService.cancel('TASK-CANCEL', 'Task stopped by user');
      expect(taskStateService.getStatus('TASK-CANCEL')).toBe('CANCELLED');

      // Mở lại task bị hủy
      taskStateService.transition('TASK-CANCEL', 'TODO', { reason: 'Reopened by manager' });
      expect(taskStateService.getStatus('TASK-CANCEL')).toBe('TODO');
    });
  });

  describe('Nghiệm thu 3: BẮT BUỘC — Chuyển trạng thái trái phép → throw ILLEGAL_STATE_TRANSITION', () => {
    beforeEach(() => {
      taskRepo.create({ id: 'T-VALIDATE', title: 'Validation Task', status: 'TODO' });
    });

    it('Ném lỗi khi chuyển TODO trực tiếp sang RUNNING, VERIFYING, hoặc DONE', () => {
      // TODO -> RUNNING
      expect(() => taskRepo.transitionStatus('T-VALIDATE', 'RUNNING')).toThrowError(
        expect.objectContaining({
          code: 'ILLEGAL_STATE_TRANSITION',
          message: expect.stringContaining("cannot transition from 'TODO' to 'RUNNING'"),
        }),
      );

      // TODO -> VERIFYING
      expect(() => taskRepo.transitionStatus('T-VALIDATE', 'VERIFYING')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );

      // TODO -> DONE
      expect(() => taskRepo.transitionStatus('T-VALIDATE', 'DONE')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );

      // Task trong DB vẫn giữ nguyên trạng thái TODO
      expect(taskRepo.findById('T-VALIDATE')?.status).toBe('TODO');
    });

    it('Ném lỗi khi chuyển READY trực tiếp sang VERIFYING hoặc DONE', () => {
      taskRepo.transitionStatus('T-VALIDATE', 'READY');

      expect(() => taskRepo.transitionStatus('T-VALIDATE', 'VERIFYING')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );

      expect(() => taskRepo.transitionStatus('T-VALIDATE', 'DONE')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );
    });

    it('Ném lỗi khi RUNNING nhảy cóc sang DONE mà không qua VERIFYING', () => {
      taskRepo.transitionStatus('T-VALIDATE', 'READY');
      taskRepo.transitionStatus('T-VALIDATE', 'RUNNING');

      expect(() => taskRepo.transitionStatus('T-VALIDATE', 'DONE')).toThrowError(
        expect.objectContaining({
          code: 'ILLEGAL_STATE_TRANSITION',
          message: expect.stringContaining("cannot transition from 'RUNNING' to 'DONE'"),
        }),
      );
    });

    it('Ném lỗi khi RUNNING hoặc VERIFYING nhảy ngược về TODO / READY trực tiếp', () => {
      taskRepo.transitionStatus('T-VALIDATE', 'READY');
      taskRepo.transitionStatus('T-VALIDATE', 'RUNNING');

      expect(() => taskRepo.transitionStatus('T-VALIDATE', 'TODO')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );
      expect(() => taskRepo.transitionStatus('T-VALIDATE', 'READY')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );

      taskRepo.transitionStatus('T-VALIDATE', 'VERIFYING');

      expect(() => taskRepo.transitionStatus('T-VALIDATE', 'TODO')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );
      expect(() => taskRepo.transitionStatus('T-VALIDATE', 'READY')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );
      expect(() => taskRepo.transitionStatus('T-VALIDATE', 'RUNNING')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );
    });

    it('Ném lỗi khi cố chuyển trạng thái từ DONE (DONE là terminal)', () => {
      taskRepo.transitionStatus('T-VALIDATE', 'READY');
      taskRepo.transitionStatus('T-VALIDATE', 'RUNNING');
      taskRepo.transitionStatus('T-VALIDATE', 'VERIFYING');
      taskRepo.transitionStatus('T-VALIDATE', 'DONE');

      const allStatuses: TaskStatus[] = [
        'TODO',
        'READY',
        'RUNNING',
        'VERIFYING',
        'DONE',
        'FAILED',
        'BLOCKED',
        'PAUSED',
        'CANCELLED',
      ];

      for (const target of allStatuses) {
        expect(() => taskRepo.transitionStatus('T-VALIDATE', target)).toThrowError(
          expect.objectContaining({
            code: 'ILLEGAL_STATE_TRANSITION',
            message: expect.stringContaining("cannot transition from 'DONE' to"),
          }),
        );
      }
    });

    it('Ném lỗi khi FAILED, BLOCKED, CANCELLED nhảy trực tiếp sang RUNNING hoặc DONE', () => {
      // FAILED
      taskRepo.transitionStatus('T-VALIDATE', 'READY');
      taskRepo.transitionStatus('T-VALIDATE', 'RUNNING');
      taskRepo.transitionStatus('T-VALIDATE', 'FAILED');

      expect(() => taskRepo.transitionStatus('T-VALIDATE', 'RUNNING')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );
      expect(() => taskRepo.transitionStatus('T-VALIDATE', 'VERIFYING')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );
      expect(() => taskRepo.transitionStatus('T-VALIDATE', 'DONE')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );

      // CANCELLED
      taskRepo.transitionStatus('T-VALIDATE', 'CANCELLED');
      expect(() => taskRepo.transitionStatus('T-VALIDATE', 'RUNNING')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );
      expect(() => taskRepo.transitionStatus('T-VALIDATE', 'DONE')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );
    });

    it('TaskStateService.resume() ném lỗi nếu task hiện tại không phải là PAUSED', () => {
      expect(() => taskStateService.resume('T-VALIDATE')).toThrowError(
        expect.objectContaining({
          code: 'ILLEGAL_STATE_TRANSITION',
          message: expect.stringContaining("current status is 'TODO', not 'PAUSED'"),
        }),
      );
    });
  });

  describe('Nghiệm thu 4: REST API POST /tasks/:id/transition & GET /tasks/:id/allowed-transitions', () => {
    beforeEach(() => {
      taskRepo.create({ id: 'API-TASK', title: 'API Task', status: 'TODO' });
    });

    it('POST /tasks/:id/transition thực hiện chuyển đổi hợp lệ và trả về 200', async () => {
      const res1 = await app.inject({
        method: 'POST',
        url: '/tasks/API-TASK/transition',
        payload: {
          status: 'READY',
          reason: 'Set ready via API',
        },
      });

      expect(res1.statusCode).toBe(200);
      const json1 = res1.json();
      expect(json1.data.status).toBe('READY');

      const res2 = await app.inject({
        method: 'POST',
        url: '/api/tasks/API-TASK/transition',
        payload: {
          status: 'RUNNING',
          incrementAttempt: true,
        },
      });

      expect(res2.statusCode).toBe(200);
      const json2 = res2.json();
      expect(json2.data.status).toBe('RUNNING');
      expect(json2.data.attempts).toBe(1);
    });

    it('POST /tasks/:id/transition từ chối chuyển đổi trái phép và trả về 400 ILLEGAL_STATE_TRANSITION', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/tasks/API-TASK/transition',
        payload: {
          status: 'DONE',
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe('ILLEGAL_STATE_TRANSITION');
      expect(json.error.message).toContain("cannot transition from 'TODO' to 'DONE'");

      // Đảm bảo trạng thái trong DB không thay đổi
      expect(taskRepo.findById('API-TASK')?.status).toBe('TODO');
    });

    it('POST /tasks/:id/transition trả về 404 khi task không tồn tại', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/tasks/NON-EXISTENT/transition',
        payload: {
          status: 'READY',
        },
      });

      expect(res.statusCode).toBe(404);
      const json = res.json();
      expect(json.error.code).toBe('TASK_NOT_FOUND');
    });

    it('GET /tasks/:id/allowed-transitions trả về danh sách trạng thái hợp lệ kế tiếp', async () => {
      const res1 = await app.inject({
        method: 'GET',
        url: '/tasks/API-TASK/allowed-transitions',
      });

      expect(res1.statusCode).toBe(200);
      const json1 = res1.json();
      expect(json1.data.currentStatus).toBe('TODO');
      expect(json1.data.allowedTransitions).toEqual(['READY', 'BLOCKED', 'CANCELLED']);

      // Chuyển sang READY
      taskRepo.transitionStatus('API-TASK', 'READY');

      const res2 = await app.inject({
        method: 'GET',
        url: '/api/tasks/API-TASK/allowed-transitions',
      });

      expect(res2.statusCode).toBe(200);
      const json2 = res2.json();
      expect(json2.data.currentStatus).toBe('READY');
      expect(json2.data.allowedTransitions).toEqual(['RUNNING', 'PAUSED', 'BLOCKED', 'CANCELLED', 'TODO']);
    });
  });
});
