import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  EventRepository,
  RunRepository,
  CheckpointRepository,
  ReportRepository,
} from '../packages/db/src/index.js';
import {
  buildServer,
  RunService,
  TaskScheduler,
  TaskHistoryService,
  createExecutionManager,
  type ExecutionManager,
} from '../apps/orchestrator/src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mockCliPath = path.resolve(__dirname, '../fixtures/mock-agy-cli.cjs');

describe('ORC-005 Acceptance Tests: Checkpoint + lịch sử lần chạy (attempt, run, kết quả) — Truy lại từng run', () => {
  let db: Database.Database;
  let server: FastifyInstance;
  let taskRepo: TaskRepository;
  let eventRepo: EventRepository;
  let runRepo: RunRepository;
  let checkpointRepo: CheckpointRepository;
  let reportRepo: ReportRepository;
  let executionManager: ExecutionManager;
  let runService: RunService;
  let historyService: TaskHistoryService;
  let scheduler: TaskScheduler;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    eventRepo = new EventRepository(db);
    runRepo = new RunRepository(db);
    checkpointRepo = new CheckpointRepository(db);
    reportRepo = new ReportRepository(db);

    executionManager = createExecutionManager();
    runService = new RunService({
      db,
      executionManager,
      config: {
        AGY_BIN: 'node',
        AGY_ARGS: mockCliPath,
      },
    });
    historyService = new TaskHistoryService({ db });

    scheduler = new TaskScheduler({
      db,
      runService,
      autoVerify: true,
      autoRetry: false,
    });

    server = await buildServer({
      db,
      logger: false,
      executionManager,
      taskScheduler: scheduler,
      config: {
        AGY_BIN: 'node',
        AGY_ARGS: mockCliPath,
      },
    });
  });

  afterEach(async () => {
    await scheduler.stop(true);
    await executionManager.stopAll();
    await server.close();
    db.close();
  });

  describe('Tiêu chí 1: Truy lại từng run ("Truy lại từng run")', () => {
    it('1.1: GET /runs/:id/detail truy lại toàn bộ thông tin chi tiết của một run (metadata, task, kết quả, checkpoints, reports, events, eventStats)', async () => {
      taskRepo.create({
        id: 'TASK-INSPECT-1',
        title: 'Task to be inspected',
        description: 'Detailed description for task inspection',
        max_attempts: 3,
      });

      const run = runRepo.create({
        id: 'run-detailed-1',
        task_id: 'TASK-INSPECT-1',
        attempt: 1,
        status: 'SUCCESS',
        exit_code: 0,
        pid: 9999,
        started_at: '2026-10-23T04:00:00.000Z',
        finished_at: '2026-10-23T04:00:12.000Z',
        branch: 'dev',
        commit_sha: 'sha-abc1234',
      });

      // Tạo checkpoint
      checkpointRepo.create({
        id: 'cp-step-1',
        task_id: 'TASK-INSPECT-1',
        run_id: run.id,
        attempt: 1,
        step: 'setup_env',
        status: 'COMPLETED',
        data: { node_version: '20.18.0' },
      });

      // Tạo report
      reportRepo.create({
        id: 'rep-test-1',
        run_id: run.id,
        kind: 'test_report',
        content: '# Test Results: 15 passed, 0 failed',
      });

      // Tạo events
      eventRepo.create({ run_id: run.id, seq: 1, type: 'init', payload: { started: true } });
      eventRepo.create({ run_id: run.id, seq: 2, type: 'stdout', payload: { text: 'Starting test run...' } });
      eventRepo.create({ run_id: run.id, seq: 3, type: 'stdout', payload: { text: '15 tests passed' } });
      eventRepo.create({ run_id: run.id, seq: 4, type: 'result', payload: { status: 'SUCCESS' } });

      // Gọi API GET /runs/:id/detail
      const res = await server.inject({
        method: 'GET',
        url: `/runs/${run.id}/detail`,
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      const data = json.data;

      // 1. Run metadata
      expect(data.run.id).toBe('run-detailed-1');
      expect(data.run.task_id).toBe('TASK-INSPECT-1');
      expect(data.run.attempt).toBe(1);
      expect(data.run.status).toBe('SUCCESS');
      expect(data.run.exit_code).toBe(0);
      expect(data.run.pid).toBe(9999);
      expect(data.run.branch).toBe('dev');
      expect(data.run.commit_sha).toBe('sha-abc1234');

      // 2. Task info
      expect(data.task.id).toBe('TASK-INSPECT-1');
      expect(data.task.title).toBe('Task to be inspected');

      // 3. Kết quả (Result summary)
      expect(data.result.outcome).toBe('SUCCESS');
      expect(data.result.success).toBe(true);
      expect(data.result.exit_code).toBe(0);
      expect(data.result.duration_ms).toBe(12000);
      expect(data.result.checkpoint_count).toBe(1);
      expect(data.result.report_count).toBe(1);
      expect(data.result.event_count).toBe(4);

      // 4. Checkpoints
      expect(data.checkpoints).toHaveLength(1);
      expect(data.checkpoints[0].id).toBe('cp-step-1');
      expect(data.checkpoints[0].step).toBe('setup_env');
      expect(data.checkpoints[0].data).toEqual({ node_version: '20.18.0' });

      // 5. Reports
      expect(data.reports).toHaveLength(1);
      expect(data.reports[0].id).toBe('rep-test-1');
      expect(data.reports[0].kind).toBe('test_report');
      expect(data.reports[0].content).toBe('# Test Results: 15 passed, 0 failed');

      // 6. Events & Event stats
      expect(data.events).toHaveLength(4);
      expect(data.eventStats.total).toBe(4);
      expect(data.eventStats.byType).toEqual({
        init: 1,
        stdout: 2,
        result: 1,
      });
    });

    it('1.2: GET /runs/:id/detail trả về 404 khi truy lại run không tồn tại', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/runs/non-existent-run-999/detail',
      });

      expect(res.statusCode).toBe(404);
      const json = JSON.parse(res.payload);
      expect(json.error.code).toBe('RUN_NOT_FOUND');
    });
  });

  describe('Tiêu chí 2: Lịch sử lần chạy đa attempt (attempt, run, kết quả)', () => {
    it('2.1: GET /tasks/:id/history trả về lịch sử tuần tự từng attempt kèm kết quả và checkpoints', async () => {
      taskRepo.create({
        id: 'TASK-MULTI-ATTEMPT',
        title: 'Multi Attempt Task',
        max_attempts: 3,
        attempts: 2,
        status: 'DONE',
      });

      // Attempt 1: Failed
      const runAttempt1 = runRepo.create({
        id: 'run-att-1',
        task_id: 'TASK-MULTI-ATTEMPT',
        attempt: 1,
        status: 'ERROR',
        exit_code: 1,
        started_at: '2026-10-23T05:00:00.000Z',
        finished_at: '2026-10-23T05:00:08.000Z',
      });

      checkpointRepo.create({
        task_id: 'TASK-MULTI-ATTEMPT',
        run_id: runAttempt1.id,
        attempt: 1,
        step: 'test_execution',
        status: 'FAILED',
        data: { failure_count: 2 },
      });

      eventRepo.create({
        run_id: runAttempt1.id,
        seq: 1,
        type: 'stderr',
        payload: { text: 'AssertionError: expected true to be false' },
      });

      // Attempt 2: Success
      const runAttempt2 = runRepo.create({
        id: 'run-att-2',
        task_id: 'TASK-MULTI-ATTEMPT',
        attempt: 2,
        status: 'SUCCESS',
        exit_code: 0,
        started_at: '2026-10-23T05:05:00.000Z',
        finished_at: '2026-10-23T05:05:10.000Z',
      });

      checkpointRepo.create({
        task_id: 'TASK-MULTI-ATTEMPT',
        run_id: runAttempt2.id,
        attempt: 2,
        step: 'test_execution',
        status: 'COMPLETED',
        data: { failure_count: 0 },
      });

      reportRepo.create({
        run_id: runAttempt2.id,
        kind: 'pass_summary',
        content: 'All tests passed on attempt 2',
      });

      // Gọi API GET /tasks/:id/history
      const res = await server.inject({
        method: 'GET',
        url: '/tasks/TASK-MULTI-ATTEMPT/history',
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      const historyData = json.data;

      expect(historyData.taskId).toBe('TASK-MULTI-ATTEMPT');
      expect(historyData.attempts).toBe(2);
      expect(historyData.maxAttempts).toBe(3);
      expect(historyData.latestRun.id).toBe('run-att-2');
      expect(historyData.history).toHaveLength(2);

      // Attempt 1 record
      const att1 = historyData.history[0];
      expect(att1.attempt).toBe(1);
      expect(att1.run.id).toBe('run-att-1');
      expect(att1.result.outcome).toBe('ERROR');
      expect(att1.result.success).toBe(false);
      expect(att1.result.exit_code).toBe(1);
      expect(att1.result.duration_ms).toBe(8000);
      expect(att1.result.error_message).toBe('AssertionError: expected true to be false');
      expect(att1.checkpoints).toHaveLength(1);
      expect(att1.checkpoints[0].status).toBe('FAILED');

      // Attempt 2 record
      const att2 = historyData.history[1];
      expect(att2.attempt).toBe(2);
      expect(att2.run.id).toBe('run-att-2');
      expect(att2.result.outcome).toBe('SUCCESS');
      expect(att2.result.success).toBe(true);
      expect(att2.result.exit_code).toBe(0);
      expect(att2.result.duration_ms).toBe(10000);
      expect(att2.checkpoints).toHaveLength(1);
      expect(att2.checkpoints[0].status).toBe('COMPLETED');
      expect(att2.reports).toHaveLength(1);
      expect(att2.reports[0].kind).toBe('pass_summary');
    });

    it('2.2: GET /tasks/:id/history trả về 404 nếu task không tồn tại', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/tasks/UNKNOWN-TASK/history',
      });

      expect(res.statusCode).toBe(404);
      const json = JSON.parse(res.payload);
      expect(json.error.code).toBe('TASK_NOT_FOUND');
    });
  });

  describe('Tiêu chí 3: Quản lý Checkpoints qua REST API', () => {
    beforeEach(() => {
      taskRepo.create({
        id: 'TASK-CP-API',
        title: 'Task for checkpoint API tests',
      });
      runRepo.create({
        id: 'run-cp-api',
        task_id: 'TASK-CP-API',
        attempt: 1,
        status: 'RUNNING',
      });
    });

    it('3.1: POST /tasks/:id/checkpoints tạo checkpoint thành công', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/tasks/TASK-CP-API/checkpoints',
        payload: {
          step: 'compile_code',
          status: 'COMPLETED',
          data: { errors: 0, warnings: 1 },
          runId: 'run-cp-api',
        },
      });

      expect(res.statusCode).toBe(201);
      const json = JSON.parse(res.payload);
      expect(json.data.id).toBeDefined();
      expect(json.data.step).toBe('compile_code');
      expect(json.data.task_id).toBe('TASK-CP-API');
      expect(json.data.run_id).toBe('run-cp-api');
      expect(json.data.data).toEqual({ errors: 0, warnings: 1 });
    });

    it('3.2: GET /tasks/:id/checkpoints/latest trả về checkpoint gần nhất của task', async () => {
      checkpointRepo.create({
        id: 'cp-old',
        task_id: 'TASK-CP-API',
        run_id: 'run-cp-api',
        step: 'first_step',
        created_at: '2026-10-23T06:00:00.000Z',
      });
      checkpointRepo.create({
        id: 'cp-new',
        task_id: 'TASK-CP-API',
        run_id: 'run-cp-api',
        step: 'second_step',
        created_at: '2026-10-23T06:01:00.000Z',
      });

      const res = await server.inject({
        method: 'GET',
        url: '/tasks/TASK-CP-API/checkpoints/latest',
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.data.id).toBe('cp-new');
      expect(json.data.step).toBe('second_step');
    });

    it('3.3: POST /runs/:id/checkpoints và GET /runs/:id/checkpoints quản lý checkpoints theo run', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs/run-cp-api/checkpoints',
        payload: {
          step: 'run_specific_checkpoint',
          status: 'COMPLETED',
          data: { metric: 'speed', value: 100 },
        },
      });

      expect(postRes.statusCode).toBe(201);

      const getRes = await server.inject({
        method: 'GET',
        url: '/runs/run-cp-api/checkpoints',
      });

      expect(getRes.statusCode).toBe(200);
      const json = JSON.parse(getRes.payload);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].step).toBe('run_specific_checkpoint');
    });
  });

  describe('Tiêu chí 4: Quản lý Reports qua REST API', () => {
    it('4.1: POST /runs/:id/reports tạo report và GET /runs/:id/reports trả về danh sách reports của run', async () => {
      taskRepo.create({ id: 'TASK-REP', title: 'Task with report' });
      const run = runRepo.create({ id: 'run-rep-test', task_id: 'TASK-REP' });

      const postRes = await server.inject({
        method: 'POST',
        url: `/runs/${run.id}/reports`,
        payload: {
          kind: 'eslint_report',
          content: '0 errors, 0 warnings',
        },
      });

      expect(postRes.statusCode).toBe(201);
      const postJson = JSON.parse(postRes.payload);
      expect(postJson.data.kind).toBe('eslint_report');
      expect(postJson.data.content).toBe('0 errors, 0 warnings');

      const getRes = await server.inject({
        method: 'GET',
        url: `/runs/${run.id}/reports`,
      });

      expect(getRes.statusCode).toBe(200);
      const getJson = JSON.parse(getRes.payload);
      expect(getJson.data).toHaveLength(1);
      expect(getJson.data[0].kind).toBe('eslint_report');
    });
  });

  describe('Tiêu chí 5: Tự động ghi Checkpoint và cập nhật lịch sử khi Scheduler chạy', () => {
    it('5.1: TaskScheduler tự động tạo checkpoint khởi đầu và kết thúc, lưu đầy đủ lịch sử run', async () => {
      taskRepo.create({
        id: 'TASK-SCHED-AUDIT',
        title: 'Scheduler Audit Task',
        description: '-e "console.log(\'processing...\'); process.exit(0);"',
        status: 'READY',
        max_attempts: 2,
      });

      const stepResult = await scheduler.step();
      expect(stepResult.executed).toBe(true);
      expect(stepResult.status).toBe('DONE');

      // Checkpoints tự động được sinh
      const checkpoints = checkpointRepo.findByTaskId('TASK-SCHED-AUDIT');
      expect(checkpoints.length).toBeGreaterThanOrEqual(2);
      expect(checkpoints.map((c) => c.step)).toContain('run_started');
      expect(checkpoints.map((c) => c.step)).toContain('run_completed');

      // Truy lại run qua history API
      const history = historyService.getTaskRunHistory('TASK-SCHED-AUDIT');
      expect(history.attempts).toBe(1);
      expect(history.latestRun?.status).toBe('SUCCESS');
      expect(history.history[0]?.result.success).toBe(true);
      expect(history.history[0]?.checkpoints.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Tiêu chí 6: Ràng buộc Cascade Delete trong SQLite', () => {
    it('6.1: Xóa run sẽ tự động xóa các checkpoints và reports liên quan qua FK cascade', () => {
      taskRepo.create({ id: 'TASK-CASCADE', title: 'Cascade Task' });
      const run = runRepo.create({ id: 'run-cascade-1', task_id: 'TASK-CASCADE' });

      checkpointRepo.create({
        id: 'cp-cascade',
        task_id: 'TASK-CASCADE',
        run_id: run.id,
        step: 'test_step',
      });

      reportRepo.create({
        id: 'rep-cascade',
        run_id: run.id,
        kind: 'test_report',
        content: 'content',
      });

      expect(checkpointRepo.getById('cp-cascade')).not.toBeNull();
      expect(reportRepo.getById('rep-cascade')).not.toBeNull();

      // Xóa run
      runRepo.delete(run.id);

      // Checkpoints và Reports phải tự động bị xóa theo CASCADE
      expect(checkpointRepo.getById('cp-cascade')).toBeNull();
      expect(reportRepo.getById('rep-cascade')).toBeNull();
    });
  });
});
