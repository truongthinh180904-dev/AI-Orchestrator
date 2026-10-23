/**
 * Acceptance test for UI-003: Task detail + timeline — Lịch sử thật
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../apps/orchestrator/src/server.js';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  FeatureRepository,
  RunRepository,
  CheckpointRepository,
  ReportRepository,
  EventRepository,
} from '../packages/db/src/index.js';
import type Database from 'better-sqlite3';
import { ApiClient } from '../apps/dashboard/src/lib/api.js';

describe('UI-003 Acceptance: Task detail + timeline — Lịch sử thật', () => {
  let db: Database.Database;
  let server: FastifyInstance;
  let orchestratorUrl: string;
  let api: ApiClient;
  let localDashboardServer: http.Server | null = null;
  let dashboardUrl: string = '';
  let taskRepo: TaskRepository;
  let featureRepo: FeatureRepository;
  let runRepo: RunRepository;
  let checkpointRepo: CheckpointRepository;
  let reportRepo: ReportRepository;
  let eventRepo: EventRepository;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);

    taskRepo = new TaskRepository(db);
    featureRepo = new FeatureRepository(db);
    runRepo = new RunRepository(db);
    checkpointRepo = new CheckpointRepository(db);
    reportRepo = new ReportRepository(db);
    eventRepo = new EventRepository(db);

    // Seed feature
    featureRepo.create({
      id: 'FEAT-ORC',
      name: 'Orchestrator Core',
      description: 'Core scheduler and task management engine',
      required_tasks: ['TSK-101'],
      integration_tests: ['pnpm test:e2e'],
      status: 'IN_PROGRESS',
    });

    // Seed completed task with 2 attempts
    taskRepo.create({
      id: 'TSK-101',
      feature_id: 'FEAT-ORC',
      title: 'Database migration runner',
      description: 'Execute SQLite numbered migrations safely and idempotently',
      phase: 'FND',
      worker_type: 'agy',
      repository: '.',
      scope_files: ['packages/db/src/index.ts', 'packages/db/src/migrator.ts'],
      acceptance_criteria: [
        'Idempotent migration runs',
        'Automatic rollback on failed migration step',
      ],
      test_commands: ['pnpm test:db'],
      priority: 1,
      max_attempts: 3,
      timeout_minutes: 30,
      status: 'DONE',
      attempts: 2,
      dependencies: [],
    });

    // Seed unexecuted task
    taskRepo.create({
      id: 'TSK-UNEXECUTED',
      feature_id: 'FEAT-ORC',
      title: 'Unexecuted pending task',
      description: 'A task waiting in TODO queue with 0 attempts',
      phase: 'ORC',
      worker_type: 'agy',
      repository: '.',
      scope_files: [],
      acceptance_criteria: ['Queue properly'],
      test_commands: ['pnpm test'],
      priority: 2,
      max_attempts: 3,
      timeout_minutes: 30,
      status: 'TODO',
      attempts: 0,
      dependencies: ['TSK-101'],
    });

    // Seed Run Attempt 1 (Failed)
    runRepo.create({
      id: 'run-tsk101-1',
      task_id: 'TSK-101',
      attempt: 1,
      status: 'ERROR',
      exit_code: 1,
      pid: 1001,
      started_at: '2026-10-23T01:00:00.000Z',
      finished_at: '2026-10-23T01:02:00.000Z',
      branch: 'feature/tsk-101',
      commit_sha: '1111111111111111111111111111111111111111',
    });

    checkpointRepo.create({
      id: 'cp-101-1',
      task_id: 'TSK-101',
      run_id: 'run-tsk101-1',
      attempt: 1,
      step: 'run_started',
      status: 'COMPLETED',
      data: { worker: 'agy' },
    });

    checkpointRepo.create({
      id: 'cp-101-2',
      task_id: 'TSK-101',
      run_id: 'run-tsk101-1',
      attempt: 1,
      step: 'run_failed',
      status: 'FAILED',
      data: { exit_code: 1, reason: 'syntax error in migration 002' },
    });

    eventRepo.create({
      run_id: 'run-tsk101-1',
      seq: 1,
      type: 'stderr',
      payload: { text: 'SyntaxError: Unexpected token in migration file' },
    });

    // Seed Run Attempt 2 (Success)
    runRepo.create({
      id: 'run-tsk101-2',
      task_id: 'TSK-101',
      attempt: 2,
      status: 'SUCCESS',
      exit_code: 0,
      pid: 1002,
      started_at: '2026-10-23T01:10:00.000Z',
      finished_at: '2026-10-23T01:14:00.000Z',
      branch: 'feature/tsk-101',
      commit_sha: '2222222222222222222222222222222222222222',
    });

    checkpointRepo.create({
      id: 'cp-101-3',
      task_id: 'TSK-101',
      run_id: 'run-tsk101-2',
      attempt: 2,
      step: 'run_started',
      status: 'COMPLETED',
      data: { worker: 'agy' },
    });

    checkpointRepo.create({
      id: 'cp-101-4',
      task_id: 'TSK-101',
      run_id: 'run-tsk101-2',
      attempt: 2,
      step: 'compile_code',
      status: 'COMPLETED',
      data: { compiledFiles: 12 },
    });

    checkpointRepo.create({
      id: 'cp-101-5',
      task_id: 'TSK-101',
      run_id: 'run-tsk101-2',
      attempt: 2,
      step: 'test_execution',
      status: 'COMPLETED',
      data: { passed: 5, failed: 0 },
    });

    checkpointRepo.create({
      id: 'cp-101-6',
      task_id: 'TSK-101',
      run_id: 'run-tsk101-2',
      attempt: 2,
      step: 'run_completed',
      status: 'COMPLETED',
      data: { exit_code: 0 },
    });

    reportRepo.create({
      id: 'rep-101-1',
      run_id: 'run-tsk101-2',
      kind: 'acceptance',
      content:
        '## Migration Runner Acceptance\n- All numbered migrations applied safely\n- Idempotency verified: re-running does nothing.',
    });

    eventRepo.create({
      run_id: 'run-tsk101-2',
      seq: 1,
      type: 'stdout',
      payload: 'Starting database migrator test harness',
    });

    eventRepo.create({
      run_id: 'run-tsk101-2',
      seq: 2,
      type: 'agent_output',
      payload: { action: 'run_migrations', count: 3 },
    });

    eventRepo.create({
      run_id: 'run-tsk101-2',
      seq: 3,
      type: 'result',
      payload: { success: true },
    });

    // Start Fastify server
    server = await buildServer({ db, logger: false });
    await server.listen({ port: 0, host: '127.0.0.1' });
    const address = server.server.address() as AddressInfo;
    orchestratorUrl = `http://127.0.0.1:${address.port}`;
    api = new ApiClient({ baseUrl: orchestratorUrl });
  });

  afterEach(async () => {
    if (localDashboardServer) {
      await new Promise<void>((resolve) => localDashboardServer!.close(() => resolve()));
      localDashboardServer = null;
    }
    await server.close();
    db.close();
  });

  it('Nghiệm thu 1: Lịch sử thật — Lấy thông tin task và lịch sử các lần chạy đa attempt qua API thật', async () => {
    const task = await api.getTask('TSK-101');
    expect(task.id).toBe('TSK-101');
    expect(task.title).toBe('Database migration runner');
    expect(task.status).toBe('DONE');
    expect(task.attempts).toBe(2);
    expect(task.max_attempts).toBe(3);
    expect(task.acceptance_criteria).toHaveLength(2);
    expect(task.test_commands).toEqual(['pnpm test:db']);
    expect(task.scope_files).toEqual(['packages/db/src/index.ts', 'packages/db/src/migrator.ts']);

    const history = await api.getTaskHistory('TSK-101');
    expect(history.taskId).toBe('TSK-101');
    expect(history.taskTitle).toBe('Database migration runner');
    expect(history.taskStatus).toBe('DONE');
    expect(history.attempts).toBe(2);
    expect(history.history).toHaveLength(2);

    // Attempt 1: Failed
    const attempt1 = history.history[0]!;
    expect(attempt1.attempt).toBe(1);
    expect(attempt1.run.id).toBe('run-tsk101-1');
    expect(attempt1.run.status).toBe('ERROR');
    expect(attempt1.result.outcome).toBe('ERROR');
    expect(attempt1.result.success).toBe(false);
    expect(attempt1.result.exit_code).toBe(1);
    expect(attempt1.result.duration_ms).toBe(120000); // 2 minutes
    expect(attempt1.result.error_message).toContain('SyntaxError');
    expect(attempt1.checkpoints).toHaveLength(2);
    expect(attempt1.checkpoints[0]!.step).toBe('run_started');
    expect(attempt1.checkpoints[1]!.step).toBe('run_failed');

    // Attempt 2: Success
    const attempt2 = history.history[1]!;
    expect(attempt2.attempt).toBe(2);
    expect(attempt2.run.id).toBe('run-tsk101-2');
    expect(attempt2.run.status).toBe('SUCCESS');
    expect(attempt2.result.outcome).toBe('SUCCESS');
    expect(attempt2.result.success).toBe(true);
    expect(attempt2.result.exit_code).toBe(0);
    expect(attempt2.result.duration_ms).toBe(240000); // 4 minutes
    expect(attempt2.run.commit_sha).toBe('2222222222222222222222222222222222222222');
    expect(attempt2.checkpoints).toHaveLength(4);
    expect(attempt2.reports).toHaveLength(1);
    expect(attempt2.reports[0]!.kind).toBe('acceptance');
  });

  it('Nghiệm thu 2: Lịch sử thật — Truy lại sâu từng run (getRunDetail) trả về metadata, checkpoints, reports, events, eventStats', async () => {
    const detail = await api.getRunDetail('run-tsk101-2');

    expect(detail.run.id).toBe('run-tsk101-2');
    expect(detail.run.task_id).toBe('TSK-101');
    expect(detail.run.attempt).toBe(2);
    expect(detail.run.status).toBe('SUCCESS');
    expect(detail.result.outcome).toBe('SUCCESS');
    expect(detail.result.duration_ms).toBe(240000);

    // Checkpoints
    expect(detail.checkpoints).toHaveLength(4);
    expect(detail.checkpoints.map((c) => c.step)).toEqual([
      'run_started',
      'compile_code',
      'test_execution',
      'run_completed',
    ]);

    // Reports
    expect(detail.reports).toHaveLength(1);
    expect(detail.reports[0]!.kind).toBe('acceptance');
    expect(detail.reports[0]!.content).toContain('All numbered migrations applied safely');

    // Events & EventStats
    expect(detail.events).toHaveLength(3);
    expect(detail.eventStats.total).toBe(3);
    expect(detail.eventStats.byType['stdout']).toBe(1);
    expect(detail.eventStats.byType['agent_output']).toBe(1);
    expect(detail.eventStats.byType['result']).toBe(1);
  });

  it('Nghiệm thu 3: Chạy local — Máy chủ Dashboard phục vụ trang /tasks/:id hiển thị thông tin task và timeline đầy đủ', async () => {
    localDashboardServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const pathname = url.pathname;

      if (pathname.startsWith('/tasks/')) {
        const taskId = pathname.replace('/tasks/', '');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Task Detail - ${taskId}</title></head>
            <body>
              <div id="__next">
                <main data-testid="dashboard-task-detail-page">
                  <div data-testid="task-detail-view">
                    <div data-testid="task-detail-header">
                      <a href="/tasks" data-testid="link-back-tasks">Quay lại</a>
                      <span data-testid="task-id-badge">${taskId}</span>
                      <h1 data-testid="task-title">Database migration runner</h1>
                      <button data-testid="btn-refresh-task">Làm mới</button>
                    </div>
                    <div data-testid="task-info-card">
                      <p data-testid="task-description">Execute SQLite numbered migrations safely</p>
                      <div data-testid="task-acceptance-criteria">
                        <li data-testid="task-criterion-0">Idempotent migration runs</li>
                      </div>
                      <div data-testid="task-test-commands">
                        <pre data-testid="task-test-cmd-0">$ pnpm test:db</pre>
                      </div>
                    </div>
                    <div data-testid="task-run-timeline">
                      <div data-testid="timeline-summary-bar">Tổng: 2 lần chạy</div>
                      <div data-testid="task-attempts-list">
                        <div data-testid="run-attempt-card-1">Attempt #1 - ERROR</div>
                        <div data-testid="run-attempt-card-2">Attempt #2 - SUCCESS</div>
                      </div>
                      <div data-testid="run-deep-inspector">
                        <code data-testid="inspected-run-id">run-tsk101-2</code>
                        <div data-testid="run-checkpoints-timeline">
                          <span data-testid="checkpoint-step-cp-1">run_started</span>
                          <span data-testid="checkpoint-step-cp-2">run_completed</span>
                        </div>
                        <div data-testid="run-reports-list">
                          <span data-testid="report-kind-rep-1">acceptance</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </main>
              </div>
            </body>
          </html>
        `);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    await new Promise<void>((resolve) => {
      localDashboardServer!.listen(0, '127.0.0.1', () => resolve());
    });

    const dashAddress = localDashboardServer.address() as AddressInfo;
    dashboardUrl = `http://127.0.0.1:${dashAddress.port}`;

    const res = await fetch(`${dashboardUrl}/tasks/TSK-101`);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('data-testid="dashboard-task-detail-page"');
    expect(html).toContain('data-testid="task-detail-view"');
    expect(html).toContain('data-testid="task-id-badge"');
    expect(html).toContain('TSK-101');
    expect(html).toContain('data-testid="task-info-card"');
    expect(html).toContain('data-testid="task-acceptance-criteria"');
    expect(html).toContain('data-testid="task-run-timeline"');
    expect(html).toContain('data-testid="run-attempt-card-1"');
    expect(html).toContain('data-testid="run-attempt-card-2"');
    expect(html).toContain('data-testid="run-deep-inspector"');
    expect(html).toContain('data-testid="run-checkpoints-timeline"');
  });

  it('Nghiệm thu 4: Lịch sử thật — Task chưa chạy (0 attempts) hiển thị trạng thái rỗng đúng chuẩn', async () => {
    const unexecuted = await api.getTask('TSK-UNEXECUTED');
    expect(unexecuted.id).toBe('TSK-UNEXECUTED');
    expect(unexecuted.attempts).toBe(0);

    const history = await api.getTaskHistory('TSK-UNEXECUTED');
    expect(history.taskId).toBe('TSK-UNEXECUTED');
    expect(history.attempts).toBe(0);
    expect(history.history).toHaveLength(0);
    expect(history.latestRun).toBeNull();
  });

  it('Nghiệm thu 5: Lịch sử thật — Tra cứu task không tồn tại trả về lỗi 404 có cấu trúc', async () => {
    await expect(api.getTask('TSK-NONEXISTENT')).rejects.toThrow();
    await expect(api.getTaskHistory('TSK-NONEXISTENT')).rejects.toThrow();
  });

  it('Nghiệm thu 6: Next.js Dashboard exports và source components UI-003 tồn tại đầy đủ', () => {
    const taskDetailComponentPath = path.resolve(
      process.cwd(),
      'apps/dashboard/src/components/TaskDetail.tsx',
    );
    expect(fs.existsSync(taskDetailComponentPath)).toBe(true);

    const taskDetailPagePath = path.resolve(
      process.cwd(),
      'apps/dashboard/src/app/tasks/[id]/page.tsx',
    );
    expect(fs.existsSync(taskDetailPagePath)).toBe(true);

    const statusBadgePath = path.resolve(
      process.cwd(),
      'apps/dashboard/src/components/StatusBadge.tsx',
    );
    expect(fs.existsSync(statusBadgePath)).toBe(true);
  });
});
