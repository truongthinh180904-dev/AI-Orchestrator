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
  type ExecutionCompletionResult,
} from '../apps/orchestrator/src/index.js';
import type Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mockCliPath = path.resolve(__dirname, '../fixtures/mock-agy-cli.cjs');

describe('AGY-008 Acceptance Tests: Test CLI giả: lỗi, timeout, crash, output rác (script mock)', () => {
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

    testRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-008-repo-'));
    repositoryRegistry = new RepositoryRegistry();
    repositoryRegistry.register(testRepoDir, {
      id: 'repo-mock-test',
      name: 'Mock Test Repository',
    });

    executionManager = createExecutionManager({
      repositoryRegistry,
      defaultGracePeriodMs: 200,
    });
    taskRepo = new TaskRepository(db);
    runRepo = new RunRepository(db);
    eventRepo = new EventRepository(db);

    taskRepo.create({
      id: 'TASK-AGY-008',
      title: 'Kiểm thử Mock AGY CLI toàn diện',
      description: 'Kiểm thử các kịch bản lỗi, timeout, crash và output rác với script mock',
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
      // Ignore directory cleanup error
    }
  });

  // ==========================================
  // Tiêu chí 1: Test CLI giả — Tình huống Lỗi (Error)
  // ==========================================
  describe('Tiêu chí 1: Test CLI giả — Tình huống Lỗi (Error)', () => {
    it('1.1: CLI thoát với mã lỗi khác 0 (exit 1), ghi stderr và phát event result ERROR -> run phân giải thành ERROR', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-008',
          command: {
            exe: 'node',
            args: [mockCliPath, 'error'],
            cwd: testRepoDir,
          },
        },
      });

      expect(postRes.statusCode).toBe(201);
      const runId = postRes.json().data.id;
      const managed = executionManager.get(runId);
      const completion = (await managed?.waitForCompletion()) as ExecutionCompletionResult | undefined;

      expect(completion?.status).toBe('ERROR');
      expect(completion?.exitCode).toBe(1);

      // Kiểm tra API GET /runs/:id
      const getRes = await server.inject({
        method: 'GET',
        url: `/runs/${runId}`,
      });
      expect(getRes.statusCode).toBe(200);
      const data = getRes.json().data;
      expect(data.status).toBe('ERROR');
      expect(data.exit_code).toBe(1);
      expect(data.isRunning).toBe(false);

      // Kiểm tra DB events
      const events = eventRepo.findByRunId(runId);
      const stderrEvents = events.filter((e) => e.type === 'stderr');
      expect(stderrEvents.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(stderrEvents)).toContain('Fatal: compile error');

      const resultEvents = events.filter((e) => e.type === 'result');
      expect(resultEvents.length).toBe(1);
      expect((resultEvents[0]?.payload as { status?: string }).status).toBe('ERROR');
    });

    it('1.2: CLI thoát với mã lỗi khác 0 (exit 2) không có event result -> run vẫn phân giải thành ERROR', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-008',
          command: {
            exe: 'node',
            args: [mockCliPath, 'error_exit_2'],
            cwd: testRepoDir,
          },
        },
      });

      expect(postRes.statusCode).toBe(201);
      const runId = postRes.json().data.id;
      const managed = executionManager.get(runId);
      const completion = (await managed?.waitForCompletion()) as ExecutionCompletionResult | undefined;

      expect(completion?.status).toBe('ERROR');
      expect(completion?.exitCode).toBe(2);

      const dbRun = runRepo.getById(runId);
      expect(dbRun?.status).toBe('ERROR');
      expect(dbRun?.exit_code).toBe(2);

      const events = eventRepo.findByRunId(runId);
      const stderrEvents = events.filter((e) => e.type === 'stderr');
      expect(stderrEvents.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(stderrEvents)).toContain('Syntax error or fatal configuration error');
    });

    it('1.3: CLI thoát với mã 0 nhưng payload event result báo ERROR -> run phân giải chính xác thành ERROR', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-008',
          command: {
            exe: 'node',
            args: [mockCliPath, 'error_result_zero_exit'],
            cwd: testRepoDir,
          },
        },
      });

      expect(postRes.statusCode).toBe(201);
      const runId = postRes.json().data.id;
      const managed = executionManager.get(runId);
      const completion = (await managed?.waitForCompletion()) as ExecutionCompletionResult | undefined;

      expect(completion?.status).toBe('ERROR');
      expect(completion?.exitCode).toBe(0);

      const dbRun = runRepo.getById(runId);
      expect(dbRun?.status).toBe('ERROR');
      expect(dbRun?.exit_code).toBe(0);

      const events = eventRepo.findByRunId(runId);
      const resultEvents = events.filter((e) => e.type === 'result');
      expect(resultEvents.length).toBe(1);
      const resultPayload = resultEvents[0]?.payload as { status?: string; error?: string };
      expect(resultPayload.status).toBe('ERROR');
      expect(resultPayload.error).toBe('Quality checks failed');
    });

    it('1.4: Lỗi khởi chạy khi executable không tồn tại (ENOENT) -> xử lý an toàn không làm crash server', async () => {
      const nonExistentExe = path.join(testRepoDir, 'non-existent-binary-xyz');
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-008',
          command: {
            exe: nonExistentExe,
            args: ['some-arg'],
            cwd: testRepoDir,
          },
        },
      });

      expect(postRes.statusCode).toBe(201);
      const runId = postRes.json().data.id;
      const managed = executionManager.get(runId);

      // Chờ hoàn tất hoặc reject
      try {
        await managed?.waitForCompletion();
      } catch {
        // Expected reject on spawn error
      }
      await managed?.handle.waitForExit().catch(() => {});

      // Kiểm tra sự kiện process_error được ghi vào bảng events
      const events = eventRepo.findByRunId(runId);
      const errorEvents = events.filter((e) => e.type === 'process_error');
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(errorEvents)).toContain('ENOENT');

      // Server vẫn sống và phục vụ các request khác bình thường
      const pingRes = await server.inject({ method: 'GET', url: '/health' });
      expect(pingRes.statusCode).toBe(200);
    });

    it('1.5: Stream SSE của run bị lỗi (GET /runs/:id/stream) truyền đầy đủ sự kiện và kết thúc bằng event done', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-008',
          command: {
            exe: 'node',
            args: [mockCliPath, 'error'],
            cwd: testRepoDir,
          },
        },
      });

      const runId = postRes.json().data.id;
      await executionManager.get(runId)?.waitForCompletion();

      const sseRes = await server.inject({
        method: 'GET',
        url: `/runs/${runId}/stream`,
      });

      expect(sseRes.statusCode).toBe(200);
      expect(sseRes.payload).toContain('event: stderr');
      expect(sseRes.payload).toContain('Fatal: compile error');
      expect(sseRes.payload).toContain('event: result');
      expect(sseRes.payload).toContain('event: process_exit');
      expect(sseRes.payload).toContain('event: done');
    });
  });

  // ==========================================
  // Tiêu chí 2: Test CLI giả — Tình huống Timeout
  // ==========================================
  describe('Tiêu chí 2: Test CLI giả — Tình huống Timeout', () => {
    it('2.1: CLI chạy quá timeoutMs -> dừng bằng SIGTERM trong grace period, phân giải thành TIMEOUT', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-008',
          timeoutMs: 200,
          gracePeriodMs: 400,
          command: {
            exe: 'node',
            args: [mockCliPath, 'timeout'],
            cwd: testRepoDir,
          },
        },
      });

      expect(postRes.statusCode).toBe(201);
      const runId = postRes.json().data.id;
      const managed = executionManager.get(runId);
      const completion = (await managed?.waitForCompletion()) as ExecutionCompletionResult | undefined;

      expect(completion?.status).toBe('TIMEOUT');

      const dbRun = runRepo.getById(runId);
      expect(dbRun?.status).toBe('TIMEOUT');

      const events = eventRepo.findByRunId(runId);
      const timeoutEvents = events.filter((e) => e.type === 'process_timeout');
      expect(timeoutEvents.length).toBe(1);
      const timeoutPayload = timeoutEvents[0]?.payload as { timeoutMs?: number; durationMs?: number };
      expect(timeoutPayload.timeoutMs).toBe(200);
      expect(timeoutPayload.durationMs).toBeGreaterThanOrEqual(180);
    });

    it('2.2: CLI ương bướng (stubborn) phớt lờ SIGTERM -> bị ép dừng bằng SIGKILL sau grace period, status TIMEOUT', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-008',
          timeoutMs: 150,
          gracePeriodMs: 150,
          command: {
            exe: 'node',
            args: [mockCliPath, 'stubborn'],
            cwd: testRepoDir,
          },
        },
      });

      expect(postRes.statusCode).toBe(201);
      const runId = postRes.json().data.id;
      const managed = executionManager.get(runId);
      const completion = (await managed?.waitForCompletion()) as ExecutionCompletionResult | undefined;

      expect(completion?.status).toBe('TIMEOUT');

      const getRes = await server.inject({ method: 'GET', url: `/runs/${runId}` });
      expect(getRes.statusCode).toBe(200);
      const data = getRes.json().data;
      expect(data.status).toBe('TIMEOUT');
      expect(data.isRunning).toBe(false);

      const events = eventRepo.findByRunId(runId);
      const timeoutEvents = events.filter((e) => e.type === 'process_timeout');
      expect(timeoutEvents.length).toBe(1);
    });

    it('2.3: Kế thừa timeout từ task khi request không chỉ định timeoutMs riêng', async () => {
      taskRepo.create({
        id: 'TASK-TIMEOUT-INHERIT',
        title: 'Task kế thừa timeout',
        repository: testRepoDir,
        timeout_minutes: 1,
      });

      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-TIMEOUT-INHERIT',
          command: {
            exe: 'node',
            args: [mockCliPath, 'success'],
            cwd: testRepoDir,
          },
        },
      });

      expect(postRes.statusCode).toBe(201);
      const runId = postRes.json().data.id;
      const managed = executionManager.get(runId);
      expect(managed?.timeoutMs).toBe(60 * 1000);

      await managed?.waitForCompletion();
      const dbRun = runRepo.getById(runId);
      expect(dbRun?.status).toBe('SUCCESS');
    });

    it('2.4: Người dùng hủy thủ công bằng POST /runs/:id/stop khi CLI đang chạy -> status CANCELLED', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-008',
          command: {
            exe: 'node',
            args: [mockCliPath, 'hang'],
            cwd: testRepoDir,
          },
        },
      });

      expect(postRes.statusCode).toBe(201);
      const runId = postRes.json().data.id;

      // Đợi tiến trình khởi động
      await new Promise((resolve) => setTimeout(resolve, 50));

      const stopRes = await server.inject({
        method: 'POST',
        url: `/runs/${runId}/stop`,
        payload: {
          reason: 'Manual cancellation by operator',
          gracePeriodMs: 200,
        },
      });

      expect(stopRes.statusCode).toBe(200);
      expect(stopRes.json().data.status).toBe('CANCELLED');

      const managed = executionManager.get(runId);
      await managed?.waitForCompletion();

      const getRes = await server.inject({ method: 'GET', url: `/runs/${runId}` });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().data.status).toBe('CANCELLED');
      expect(getRes.json().data.isRunning).toBe(false);
    });

    it('2.5: SSE stream của run bị timeout đóng luồng sạch sẽ với event done', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-008',
          timeoutMs: 150,
          gracePeriodMs: 200,
          command: {
            exe: 'node',
            args: [mockCliPath, 'timeout'],
            cwd: testRepoDir,
          },
        },
      });

      const runId = postRes.json().data.id;
      await executionManager.get(runId)?.waitForCompletion();

      const sseRes = await server.inject({
        method: 'GET',
        url: `/runs/${runId}/stream`,
      });

      expect(sseRes.statusCode).toBe(200);
      expect(sseRes.payload).toContain('event: process_timeout');
      expect(sseRes.payload).toContain('event: done');
    });
  });

  // ==========================================
  // Tiêu chí 3: Test CLI giả — Tình huống Crash đột ngột
  // ==========================================
  describe('Tiêu chí 3: Test CLI giả — Tình huống Crash đột ngột', () => {
    it('3.1: CLI bị lỗi bộ nhớ / fatal crash với exit code 139 (SIGSEGV) -> ghi nhận exit 139 và status ERROR', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-008',
          command: {
            exe: 'node',
            args: [mockCliPath, 'crash_segfault'],
            cwd: testRepoDir,
          },
        },
      });

      expect(postRes.statusCode).toBe(201);
      const runId = postRes.json().data.id;
      const managed = executionManager.get(runId);
      const completion = (await managed?.waitForCompletion()) as ExecutionCompletionResult | undefined;

      expect(completion?.status).toBe('ERROR');
      expect(completion?.exitCode).toBe(139);

      const dbRun = runRepo.getById(runId);
      expect(dbRun?.status).toBe('ERROR');
      expect(dbRun?.exit_code).toBe(139);

      const events = eventRepo.findByRunId(runId);
      const stderrEvents = events.filter((e) => e.type === 'stderr');
      expect(stderrEvents.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(stderrEvents)).toContain('Segmentation fault');
    });

    it('3.2: CLI gặp ngoại lệ chưa bắt (uncaught exception runtime) -> stderr lưu stack trace, status ERROR', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-008',
          command: {
            exe: 'node',
            args: [mockCliPath, 'crash_uncaught'],
            cwd: testRepoDir,
          },
        },
      });

      expect(postRes.statusCode).toBe(201);
      const runId = postRes.json().data.id;
      const managed = executionManager.get(runId);
      const completion = (await managed?.waitForCompletion()) as ExecutionCompletionResult | undefined;

      expect(completion?.status).toBe('ERROR');
      expect(completion?.exitCode).toBe(1);

      const events = eventRepo.findByRunId(runId);
      const stderrEvents = events.filter((e) => e.type === 'stderr');
      expect(stderrEvents.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(stderrEvents)).toContain('Uncaught TypeError in worker runtime');
    });

    it('3.3: CLI tự kết liễu bằng SIGKILL đột ngột -> ghi nhận signal SIGKILL, status ERROR, không treo', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-008',
          command: {
            exe: 'node',
            args: [mockCliPath, 'crash_signal'],
            cwd: testRepoDir,
          },
        },
      });

      expect(postRes.statusCode).toBe(201);
      const runId = postRes.json().data.id;
      const managed = executionManager.get(runId);
      const completion = (await managed?.waitForCompletion()) as ExecutionCompletionResult | undefined;

      expect(completion?.status).toBe('ERROR');
      expect(completion?.signal).toBe('SIGKILL');

      const getRes = await server.inject({ method: 'GET', url: `/runs/${runId}` });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().data.isRunning).toBe(false);
      expect(getRes.json().data.status).toBe('ERROR');
    });

    it('3.4: Sau khi CLI crash, orchestrator không bị ảnh hưởng và thực thi trơn tru run tiếp theo', async () => {
      // 1. Chạy run crash
      const crashRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-008',
          command: { exe: 'node', args: [mockCliPath, 'crash_segfault'], cwd: testRepoDir },
        },
      });
      await executionManager.get(crashRes.json().data.id)?.waitForCompletion();

      // 2. Chạy run success ngay sau đó
      const successRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-008',
          command: { exe: 'node', args: [mockCliPath, 'success'], cwd: testRepoDir },
        },
      });

      expect(successRes.statusCode).toBe(201);
      const successRunId = successRes.json().data.id;
      const successCompletion = (await executionManager.get(successRunId)?.waitForCompletion()) as
        | ExecutionCompletionResult
        | undefined;

      expect(successCompletion?.status).toBe('SUCCESS');
      expect(successCompletion?.exitCode).toBe(0);

      const dbRun = runRepo.getById(successRunId);
      expect(dbRun?.status).toBe('SUCCESS');
    });
  });

  // ==========================================
  // Tiêu chí 4: Test CLI giả — Tình huống Output rác (Garbage / Malformed Output)
  // ==========================================
  describe('Tiêu chí 4: Test CLI giả — Tình huống Output rác (Garbage / Malformed Output)', () => {
    it('4.1: CLI chỉ xuất plain text / không có event result (exit 0) -> phân giải thành INVALID_OUTPUT', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-008',
          command: {
            exe: 'node',
            args: [mockCliPath, 'no_result'],
            cwd: testRepoDir,
          },
        },
      });

      expect(postRes.statusCode).toBe(201);
      const runId = postRes.json().data.id;
      const managed = executionManager.get(runId);
      const completion = (await managed?.waitForCompletion()) as ExecutionCompletionResult | undefined;

      expect(completion?.status).toBe('INVALID_OUTPUT');
      expect(completion?.exitCode).toBe(0);

      const dbRun = runRepo.getById(runId);
      expect(dbRun?.status).toBe('INVALID_OUTPUT');

      // Vẫn lưu các dòng stdout plain text vào events
      const events = eventRepo.findByRunId(runId);
      const stdoutEvents = events.filter((e) => e.type === 'stdout');
      expect(stdoutEvents.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(stdoutEvents)).toContain('Plain text output without any result event');
    });

    it('4.2: CLI xuất event result nhưng payload vi phạm schema Zod -> phân giải thành INVALID_OUTPUT', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-008',
          command: {
            exe: 'node',
            args: [mockCliPath, 'invalid_result_schema'],
            cwd: testRepoDir,
          },
        },
      });

      expect(postRes.statusCode).toBe(201);
      const runId = postRes.json().data.id;
      const managed = executionManager.get(runId);
      const completion = (await managed?.waitForCompletion()) as ExecutionCompletionResult | undefined;

      expect(completion?.status).toBe('INVALID_OUTPUT');
      expect(completion?.resolution.reason).toContain('result event payload was invalid');

      const dbRun = runRepo.getById(runId);
      expect(dbRun?.status).toBe('INVALID_OUTPUT');
    });

    it('4.3: CLI xuất luồng NDJSON lẫn các dòng JSON hỏng và rác -> lưu parse_error, không crash, hoàn thành SUCCESS', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-008',
          command: {
            exe: 'node',
            args: [mockCliPath, 'garbage_stream'],
            cwd: testRepoDir,
          },
        },
      });

      expect(postRes.statusCode).toBe(201);
      const runId = postRes.json().data.id;
      const managed = executionManager.get(runId);
      const completion = (await managed?.waitForCompletion()) as ExecutionCompletionResult | undefined;

      expect(completion?.status).toBe('SUCCESS');
      expect(completion?.exitCode).toBe(0);

      const events = eventRepo.findByRunId(runId);

      // Kiểm tra có event parse_error ghi lại các dòng JSON hỏng
      const parseErrors = events.filter((e) => e.type === 'parse_error');
      expect(parseErrors.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(parseErrors)).toContain('corrupted_json');

      // Kiểm tra các event hợp lệ vẫn được phân tích đầy đủ
      const statusEvents = events.filter((e) => e.type === 'status');
      expect(statusEvents.length).toBe(1);

      const stdoutEvents = events.filter((e) => e.type === 'stdout');
      expect(stdoutEvents.length).toBeGreaterThanOrEqual(1);

      const resultEvents = events.filter((e) => e.type === 'result');
      expect(resultEvents.length).toBe(1);
      expect((resultEvents[0]?.payload as { status?: string }).status).toBe('SUCCESS');
    });

    it('4.4: CLI xuất dòng rác xen kẽ và kết thúc bằng mã lỗi 1 -> lưu parse_error và phân giải ERROR', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-008',
          command: {
            exe: 'node',
            args: [mockCliPath, 'garbage_stream_error'],
            cwd: testRepoDir,
          },
        },
      });

      expect(postRes.statusCode).toBe(201);
      const runId = postRes.json().data.id;
      const managed = executionManager.get(runId);
      const completion = (await managed?.waitForCompletion()) as ExecutionCompletionResult | undefined;

      expect(completion?.status).toBe('ERROR');
      expect(completion?.exitCode).toBe(1);

      const events = eventRepo.findByRunId(runId);
      const parseErrors = events.filter((e) => e.type === 'parse_error');
      expect(parseErrors.length).toBeGreaterThanOrEqual(1);

      const dbRun = runRepo.getById(runId);
      expect(dbRun?.status).toBe('ERROR');
    });

    it('4.5: CLI xuất dòng rác xen kẽ và thoát exit 0 không có result -> lưu parse_error và phân giải INVALID_OUTPUT', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-008',
          command: {
            exe: 'node',
            args: [mockCliPath, 'garbage_stream_no_result'],
            cwd: testRepoDir,
          },
        },
      });

      expect(postRes.statusCode).toBe(201);
      const runId = postRes.json().data.id;
      const managed = executionManager.get(runId);
      const completion = (await managed?.waitForCompletion()) as ExecutionCompletionResult | undefined;

      expect(completion?.status).toBe('INVALID_OUTPUT');
      expect(completion?.exitCode).toBe(0);

      const events = eventRepo.findByRunId(runId);
      const parseErrors = events.filter((e) => e.type === 'parse_error');
      expect(parseErrors.length).toBeGreaterThanOrEqual(1);
    });

    it('4.6: CLI xuất dòng cực dài (huge line 200KB+) -> buffer xử lý an toàn không tràn và hoàn thành SUCCESS', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-008',
          command: {
            exe: 'node',
            args: [mockCliPath, 'huge_line'],
            cwd: testRepoDir,
          },
        },
      });

      expect(postRes.statusCode).toBe(201);
      const runId = postRes.json().data.id;
      const managed = executionManager.get(runId);
      const completion = (await managed?.waitForCompletion()) as ExecutionCompletionResult | undefined;

      expect(completion?.status).toBe('SUCCESS');
      expect(completion?.exitCode).toBe(0);

      const events = eventRepo.findByRunId(runId);
      const stdoutEvents = events.filter((e) => e.type === 'stdout');
      expect(stdoutEvents.length).toBeGreaterThanOrEqual(1);
      const hugeLine = JSON.stringify(stdoutEvents);
      expect(hugeLine.length).toBeGreaterThan(150000);
    });

    it('4.7: CLI không xuất bất kỳ dòng nào (empty output) rồi thoát exit 0 -> phân giải thành INVALID_OUTPUT', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-AGY-008',
          command: {
            exe: 'node',
            args: [mockCliPath, 'empty'],
            cwd: testRepoDir,
          },
        },
      });

      expect(postRes.statusCode).toBe(201);
      const runId = postRes.json().data.id;
      const managed = executionManager.get(runId);
      const completion = (await managed?.waitForCompletion()) as ExecutionCompletionResult | undefined;

      expect(completion?.status).toBe('INVALID_OUTPUT');
      expect(completion?.exitCode).toBe(0);

      const dbRun = runRepo.getById(runId);
      expect(dbRun?.status).toBe('INVALID_OUTPUT');
    });
  });
});
