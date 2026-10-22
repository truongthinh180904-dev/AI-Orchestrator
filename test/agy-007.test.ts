import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  RunRepository,
  EventRepository,
} from '../packages/db/src/index.js';
import {
  buildServer,
  createExecutionManager,
  RepositoryRegistry,
  type ExecutionManager,
} from '../apps/orchestrator/src/index.js';
import type Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mockCliPath = path.resolve(__dirname, '../fixtures/mock-agy-cli.cjs');

describe('AGY-007 Acceptance Tests: Worker execution API: POST /runs, GET /runs/:id, GET /runs/:id/stream (SSE), POST /runs/:id/stop — Chạy thử qua API với CLI giả', () => {
  let db: Database.Database;
  let server: FastifyInstance;
  let executionManager: ExecutionManager;
  let repositoryRegistry: RepositoryRegistry;
  let taskRepo: TaskRepository;
  let runRepo: RunRepository;
  let eventRepo: EventRepository;
  let testRepoDir: string;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);

    testRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-007-repo-'));
    repositoryRegistry = new RepositoryRegistry();
    repositoryRegistry.register(testRepoDir, {
      id: 'repo-test',
      name: 'Test Repository',
    });

    executionManager = createExecutionManager({ repositoryRegistry });
    taskRepo = new TaskRepository(db);
    runRepo = new RunRepository(db);
    eventRepo = new EventRepository(db);

    // Seed sample task
    taskRepo.create({
      id: 'TASK-AGY-007',
      title: 'Xây dựng Worker Execution API',
      description: 'Hiện thực các route /runs, /runs/:id, /runs/:id/stream, /runs/:id/stop',
      repository: testRepoDir,
      timeout_minutes: 5,
    });

    server = await buildServer({
      db,
      executionManager,
      repositoryRegistry,
      logger: false,
    });
    await server.ready();
  });

  afterEach(async () => {
    await executionManager.stopAll();
    await server.close();
    db.close();
    try {
      fs.rmSync(testRepoDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  // ==========================================
  // Tiêu chí 1: POST /runs — Khởi chạy run qua API
  // ==========================================
  describe('Tiêu chí 1: POST /runs — Khởi chạy tiến trình worker qua API', () => {
    it('1.1: Khởi chạy run thành công với mock CLI qua API: trả về 201, run ID, status RUNNING, pid hợp lệ, lưu vào DB', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-007',
          command: {
            exe: 'node',
            args: [mockCliPath, 'success'],
            cwd: testRepoDir,
          },
        },
      });

      expect(res.statusCode).toBe(201);
      const json = res.json();
      expect(json.data).toBeDefined();
      expect(json.data.id).toBeTypeOf('string');
      expect(json.data.task_id).toBe('TASK-AGY-007');
      expect(json.data.status).toBe('RUNNING');
      expect(json.data.attempt).toBe(1);
      expect(json.data.pid).toBeTypeOf('number');

      const runId = json.data.id;

      // Kiểm tra trong SQLite DB bảng runs
      const dbRun = runRepo.getById(runId);
      expect(dbRun).toBeDefined();
      expect(dbRun?.task_id).toBe('TASK-AGY-007');
      expect(dbRun?.status).toBe('RUNNING');

      // Chờ tiến trình kết thúc
      const managed = executionManager.get(runId);
      expect(managed).toBeDefined();
      await managed?.waitForCompletion();

      // Kiểm tra event process_start và result đã được lưu vào bảng events
      const events = eventRepo.findByRunId(runId);
      expect(events.length).toBeGreaterThan(0);
      expect(events.some((e) => e.type === 'process_start')).toBe(true);
      expect(events.some((e) => e.type === 'result')).toBe(true);
    });

    it('1.2: Từ chối khởi chạy run khi taskId không tồn tại với lỗi 404 TASK_NOT_FOUND', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-NON-EXISTENT',
          command: {
            exe: 'node',
            args: [mockCliPath, 'success'],
            cwd: testRepoDir,
          },
        },
      });

      expect(res.statusCode).toBe(404);
      const json = res.json();
      expect(json.error).toBeDefined();
      expect(json.error.code).toBe('TASK_NOT_FOUND');
    });

    it('1.3: Từ chối khi request payload không hợp lệ (thiếu taskId) với lỗi 400 VALIDATION_ERROR', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          // Thiếu taskId
          command: {
            exe: 'node',
          },
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('1.4: Tự động tăng attempt cho các lần chạy tiếp theo của cùng một task', async () => {
      // Run 1
      const res1 = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-007',
          command: {
            exe: 'node',
            args: [mockCliPath, 'success'],
            cwd: testRepoDir,
          },
        },
      });
      expect(res1.statusCode).toBe(201);
      expect(res1.json().data.attempt).toBe(1);
      await executionManager.get(res1.json().data.id)?.waitForCompletion();

      // Run 2
      const res2 = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-007',
          command: {
            exe: 'node',
            args: [mockCliPath, 'success'],
            cwd: testRepoDir,
          },
        },
      });
      expect(res2.statusCode).toBe(201);
      expect(res2.json().data.attempt).toBe(2);
      await executionManager.get(res2.json().data.id)?.waitForCompletion();

      // Kiểm tra cả 2 runs trong DB
      const taskRuns = runRepo.findByTaskId('TASK-AGY-007');
      expect(taskRuns.length).toBe(2);
      expect(taskRuns[0]?.attempt).toBe(1);
      expect(taskRuns[1]?.attempt).toBe(2);
    });

    it('1.5: Từ chối khi cwd không thuộc repo đã đăng ký với lỗi 400 UNREGISTERED_REPOSITORY', async () => {
      const outsideDir = os.tmpdir();
      const res = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-007',
          command: {
            exe: 'node',
            args: [mockCliPath, 'success'],
            cwd: outsideDir,
          },
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('UNREGISTERED_REPOSITORY');
    });
  });

  // ==========================================
  // Tiêu chí 2: GET /runs/:id và GET /runs
  // ==========================================
  describe('Tiêu chí 2: GET /runs/:id và GET /runs — Truy vấn trạng thái lần chạy', () => {
    it('2.1: Lấy chi tiết run thành công qua GET /runs/:id: trả về 200, status, isRunning: false khi hoàn tất', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-007',
          command: {
            exe: 'node',
            args: [mockCliPath, 'success'],
            cwd: testRepoDir,
          },
        },
      });
      const runId = postRes.json().data.id;
      await executionManager.get(runId)?.waitForCompletion();

      const getRes = await server.inject({
        method: 'GET',
        url: `/runs/${runId}`,
      });

      expect(getRes.statusCode).toBe(200);
      const data = getRes.json().data;
      expect(data.id).toBe(runId);
      expect(data.task_id).toBe('TASK-AGY-007');
      expect(data.status).toBe('SUCCESS');
      expect(data.exit_code).toBe(0);
      expect(data.isRunning).toBe(false);
      expect(data.started_at).toBeTypeOf('string');
      expect(data.finished_at).toBeTypeOf('string');
    });

    it('2.2: Trả về lỗi 404 RUN_NOT_FOUND khi id không tồn tại trong DB', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/runs/run-does-not-exist-123',
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('RUN_NOT_FOUND');
    });

    it('2.3: GET /runs liệt kê danh sách các run và hỗ trợ lọc theo taskId', async () => {
      // Tạo thêm một task khác
      taskRepo.create({
        id: 'TASK-AGY-OTHER',
        title: 'Task phụ',
        repository: testRepoDir,
      });

      const res1 = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-007',
          command: { exe: 'node', args: [mockCliPath, 'success'], cwd: testRepoDir },
        },
      });
      await executionManager.get(res1.json().data.id)?.waitForCompletion();

      const res2 = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-OTHER',
          command: { exe: 'node', args: [mockCliPath, 'success'], cwd: testRepoDir },
        },
      });
      await executionManager.get(res2.json().data.id)?.waitForCompletion();

      // Liệt kê tất cả
      const listAll = await server.inject({ method: 'GET', url: '/runs' });
      expect(listAll.statusCode).toBe(200);
      expect(listAll.json().data.length).toBe(2);

      // Lọc theo taskId
      const listFiltered = await server.inject({
        method: 'GET',
        url: '/runs?taskId=TASK-AGY-007',
      });
      expect(listFiltered.statusCode).toBe(200);
      expect(listFiltered.json().data.length).toBe(1);
      expect(listFiltered.json().data[0].task_id).toBe('TASK-AGY-007');
    });
  });

  // ==========================================
  // Tiêu chí 3: GET /runs/:id/stream — SSE Realtime Events
  // ==========================================
  describe('Tiêu chí 3: GET /runs/:id/stream (SSE) — Stream sự kiện thời gian thực', () => {
    it('3.1: Nhận header text/event-stream và stream các events từ mock CLI theo chuẩn SSE', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-007',
          command: {
            exe: 'node',
            args: [mockCliPath, 'success'],
            cwd: testRepoDir,
          },
        },
      });
      const runId = postRes.json().data.id;
      const managed = executionManager.get(runId);
      await managed?.waitForCompletion();

      const sseRes = await server.inject({
        method: 'GET',
        url: `/runs/${runId}/stream`,
      });

      expect(sseRes.statusCode).toBe(200);
      expect(sseRes.headers['content-type']).toContain('text/event-stream');
      expect(sseRes.payload).toContain('id:');
      expect(sseRes.payload).toContain('event: process_start');
      expect(sseRes.payload).toContain('event: result');
      expect(sseRes.payload).toContain('event: done');
    });

    it('3.2: Khách hàng kết nối sau khi run đã hoàn tất vẫn nhận được toàn bộ lịch sử event từ DB kèm event done', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-007',
          command: {
            exe: 'node',
            args: [mockCliPath, 'success'],
            cwd: testRepoDir,
          },
        },
      });
      const runId = postRes.json().data.id;
      await executionManager.get(runId)?.waitForCompletion();

      // Kết nối muộn khi process đã dừng hẳn
      const sseRes = await server.inject({
        method: 'GET',
        url: `/runs/${runId}/stream`,
      });

      expect(sseRes.statusCode).toBe(200);
      expect(sseRes.payload).toContain('event: process_start');
      expect(sseRes.payload).toContain('event: result');
      expect(sseRes.payload).toContain('event: done');
    });

    it('3.3: Hỗ trợ query after_seq hoặc header Last-Event-ID để chỉ lấy các event phát sinh sau đó', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-007',
          command: {
            exe: 'node',
            args: [mockCliPath, 'success'],
            cwd: testRepoDir,
          },
        },
      });
      const runId = postRes.json().data.id;
      await executionManager.get(runId)?.waitForCompletion();

      // Giả sử client đã có event seq 1 và seq 2, chỉ muốn nhận từ seq 3 trở đi
      const sseRes = await server.inject({
        method: 'GET',
        url: `/runs/${runId}/stream?after_seq=2`,
      });

      expect(sseRes.statusCode).toBe(200);
      expect(sseRes.payload).not.toContain('id: 1\n');
      expect(sseRes.payload).not.toContain('id: 2\n');
      expect(sseRes.payload).toContain('id: 3\n');
    });

    it('3.4: Trả về 404 RUN_NOT_FOUND khi truy cập stream của run không tồn tại', async () => {
      const sseRes = await server.inject({
        method: 'GET',
        url: '/runs/non-existent-run/stream',
      });

      expect(sseRes.statusCode).toBe(404);
      expect(sseRes.json().error.code).toBe('RUN_NOT_FOUND');
    });
  });

  // ==========================================
  // Tiêu chí 4: POST /runs/:id/stop — Dừng tiến trình
  // ==========================================
  describe('Tiêu chí 4: POST /runs/:id/stop — Dừng tiến trình worker theo yêu cầu', () => {
    it('4.1: Dừng tiến trình đang chạy thành công: mock CLI bị dừng, trạng thái chuyển thành CANCELLED', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-007',
          command: {
            exe: 'node',
            args: [mockCliPath, 'hang'],
            cwd: testRepoDir,
          },
        },
      });
      const runId = postRes.json().data.id;

      // Xác nhận đang chạy
      expect(executionManager.isRunning(runId)).toBe(true);

      const stopRes = await server.inject({
        method: 'POST',
        url: `/runs/${runId}/stop`,
        payload: {
          reason: 'Người dùng nhấn dừng trên dashboard',
        },
      });

      expect(stopRes.statusCode).toBe(200);
      const json = stopRes.json();
      expect(json.data.stopped).toBe(true);
      expect(json.data.status).toBe('CANCELLED');

      // Xác nhận DB cũng được cập nhật thành CANCELLED
      const dbRun = runRepo.getById(runId);
      expect(dbRun?.status).toBe('CANCELLED');
      expect(dbRun?.finished_at).toBeTruthy();
    });

    it('4.2: Dừng an toàn khi run đã hoàn tất trước đó: trả về stopped: false mà không throw lỗi', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-007',
          command: {
            exe: 'node',
            args: [mockCliPath, 'success'],
            cwd: testRepoDir,
          },
        },
      });
      const runId = postRes.json().data.id;
      await executionManager.get(runId)?.waitForCompletion();

      // Thử stop khi đã xong
      const stopRes = await server.inject({
        method: 'POST',
        url: `/runs/${runId}/stop`,
      });

      expect(stopRes.statusCode).toBe(200);
      expect(stopRes.json().data.stopped).toBe(false);
      expect(stopRes.json().data.status).toBe('SUCCESS');
    });

    it('4.3: Trả về 404 RUN_NOT_FOUND khi stop một run không tồn tại', async () => {
      const stopRes = await server.inject({
        method: 'POST',
        url: '/runs/non-existent-run/stop',
      });

      expect(stopRes.statusCode).toBe(404);
      expect(stopRes.json().error.code).toBe('RUN_NOT_FOUND');
    });
  });

  // ==========================================
  // Tiêu chí 5: Chạy thử toàn diện với CLI giả (Mock CLI End-to-End)
  // ==========================================
  describe('Tiêu chí 5: Kiểm thử toàn diện các kịch bản kết thúc với CLI giả', () => {
    it('5.1: CLI giả kịch bản SUCCESS: thoát 0, result SUCCESS, DB cập nhật status SUCCESS', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-007',
          command: {
            exe: 'node',
            args: [mockCliPath, 'success'],
            cwd: testRepoDir,
          },
        },
      });

      const runId = res.json().data.id;
      const managed = executionManager.get(runId);
      const completion = await managed?.waitForCompletion();

      expect(completion && 'status' in completion && completion.status).toBe('SUCCESS');
      const dbRun = runRepo.getById(runId);
      expect(dbRun?.status).toBe('SUCCESS');
      expect(dbRun?.exit_code).toBe(0);
    });

    it('5.2: CLI giả kịch bản ERROR: thoát 1, result ERROR, DB cập nhật status ERROR', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-007',
          command: {
            exe: 'node',
            args: [mockCliPath, 'error'],
            cwd: testRepoDir,
          },
        },
      });

      const runId = res.json().data.id;
      const managed = executionManager.get(runId);
      const completion = await managed?.waitForCompletion();

      expect(completion && 'status' in completion && completion.status).toBe('ERROR');
      const dbRun = runRepo.getById(runId);
      expect(dbRun?.status).toBe('ERROR');
      expect(dbRun?.exit_code).toBe(1);
    });

    it('5.3: CLI giả kịch bản TIMEOUT: treo vô hạn, bị timeoutMs ngắt đúng hạn, DB cập nhật TIMEOUT', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-007',
          timeoutMs: 120,
          gracePeriodMs: 60,
          command: {
            exe: 'node',
            args: [mockCliPath, 'hang'],
            cwd: testRepoDir,
          },
        },
      });

      const runId = res.json().data.id;
      const managed = executionManager.get(runId);

      const startTime = Date.now();
      const completion = await managed?.waitForCompletion();
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeGreaterThanOrEqual(100);
      expect(completion && 'status' in completion && completion.status).toBe('TIMEOUT');
      const dbRun = runRepo.getById(runId);
      expect(dbRun?.status).toBe('TIMEOUT');
    });
  });
});
