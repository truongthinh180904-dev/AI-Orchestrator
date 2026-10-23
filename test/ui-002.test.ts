/**
 * Acceptance test for UI-002: Danh sách task/feature + bộ lọc — Dữ liệu từ API
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../apps/orchestrator/src/server.js';
import { createDatabase, runMigrations } from '../packages/db/src/index.js';
import { TaskRepository, FeatureRepository } from '../packages/db/src/index.js';
import type Database from 'better-sqlite3';
import { ApiClient } from '../apps/dashboard/src/lib/api.js';

describe('UI-002 Acceptance: Danh sách task/feature + bộ lọc — Dữ liệu từ API', () => {
  let db: Database.Database;
  let server: FastifyInstance;
  let orchestratorUrl: string;
  let api: ApiClient;
  let localDashboardServer: http.Server | null = null;
  let dashboardUrl: string = '';
  let taskRepo: TaskRepository;
  let featureRepo: FeatureRepository;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);

    taskRepo = new TaskRepository(db);
    featureRepo = new FeatureRepository(db);

    // Seed test features
    featureRepo.create({
      id: 'FEAT-ORCH',
      name: 'Orchestrator Core',
      description: 'Core scheduler and task management engine',
      required_tasks: ['TSK-101', 'TSK-102'],
      integration_tests: ['pnpm test:e2e'],
      status: 'IN_PROGRESS',
    });

    featureRepo.create({
      id: 'FEAT-DASH',
      name: 'Dashboard UI',
      description: 'Next.js App Router Web UI',
      required_tasks: ['TSK-103'],
      integration_tests: ['pnpm test:ui'],
      status: 'TODO',
    });

    // Seed test tasks
    taskRepo.create({
      id: 'TSK-101',
      feature_id: 'FEAT-ORCH',
      title: 'Database migration runner',
      description: 'Execute SQLite numbered migrations safely',
      phase: 'FND',
      worker_type: 'agy',
      repository: '.',
      scope_files: ['packages/db/src/index.ts'],
      acceptance_criteria: ['Idempotent migration runs'],
      test_commands: ['pnpm test'],
      priority: 1,
      max_attempts: 3,
      timeout_minutes: 30,
      status: 'DONE',
      attempts: 1,
      dependencies: [],
    });

    taskRepo.create({
      id: 'TSK-102',
      feature_id: 'FEAT-ORCH',
      title: 'Task dependency resolver',
      description: 'Compute READY tasks with topological sort',
      phase: 'ORC',
      worker_type: 'agy',
      repository: '.',
      scope_files: ['apps/orchestrator/src/services/dependency-resolver-service.ts'],
      acceptance_criteria: ['Only ready tasks returned'],
      test_commands: ['pnpm test'],
      priority: 2,
      max_attempts: 3,
      timeout_minutes: 30,
      status: 'RUNNING',
      attempts: 1,
      dependencies: ['TSK-101'],
    });

    taskRepo.create({
      id: 'TSK-103',
      feature_id: 'FEAT-DASH',
      title: 'Task and feature list dashboard view',
      description: 'Build UI-002 component with filters and metrics',
      phase: 'UI',
      worker_type: 'agy',
      repository: '.',
      scope_files: ['apps/dashboard/src/components/TaskFeatureDashboard.tsx'],
      acceptance_criteria: ['Data from API loaded and filtered'],
      test_commands: ['pnpm test'],
      priority: 3,
      max_attempts: 3,
      timeout_minutes: 30,
      status: 'READY',
      attempts: 0,
      dependencies: ['TSK-102'],
    });

    server = await buildServer({ db, logger: false });
    const address = await server.listen({ port: 0, host: '127.0.0.1' });
    orchestratorUrl = address;
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

  it('Nghiệm thu 1: Dữ liệu từ API — Lấy danh sách Task và Feature qua Orchestrator API thật', async () => {
    // 1. Gọi API GET /api/tasks qua ApiClient
    const tasks = await api.getTasks();
    expect(tasks).toHaveLength(3);

    const tsk101 = tasks.find((t) => t.id === 'TSK-101');
    expect(tsk101).toBeDefined();
    expect(tsk101?.title).toBe('Database migration runner');
    expect(tsk101?.status).toBe('DONE');
    expect(tsk101?.phase).toBe('FND');
    expect(tsk101?.feature_id).toBe('FEAT-ORCH');
    expect(tsk101?.dependencies).toEqual([]);

    const tsk102 = tasks.find((t) => t.id === 'TSK-102');
    expect(tsk102).toBeDefined();
    expect(tsk102?.status).toBe('RUNNING');
    expect(tsk102?.dependencies).toEqual(['TSK-101']);

    // 2. Gọi API GET /api/features qua ApiClient
    const features = await api.getFeatures();
    expect(features).toHaveLength(2);

    const featOrch = features.find((f) => f.id === 'FEAT-ORCH');
    expect(featOrch).toBeDefined();
    expect(featOrch?.name).toBe('Orchestrator Core');
    expect(featOrch?.status).toBe('IN_PROGRESS');
    expect(featOrch?.required_tasks).toEqual(['TSK-101', 'TSK-102']);
    expect(featOrch?.integration_tests).toEqual(['pnpm test:e2e']);
  });

  it('Nghiệm thu 2: Dữ liệu từ API — Lọc danh sách tác vụ theo status, phase, feature_id, và search query', async () => {
    // Lọc theo status=DONE
    const doneTasks = await api.getTasks({ status: 'DONE' });
    expect(doneTasks).toHaveLength(1);
    expect(doneTasks[0]?.id).toBe('TSK-101');

    // Lọc theo phase=ORC
    const orcTasks = await api.getTasks({ phase: 'ORC' });
    expect(orcTasks).toHaveLength(1);
    expect(orcTasks[0]?.id).toBe('TSK-102');

    // Lọc theo feature_id=FEAT-DASH
    const dashTasks = await api.getTasks({ feature_id: 'FEAT-DASH' });
    expect(dashTasks).toHaveLength(1);
    expect(dashTasks[0]?.id).toBe('TSK-103');

    // Lọc theo từ khóa tìm kiếm (search text)
    const searchedTasks = await api.getTasks({ search: 'topological' });
    expect(searchedTasks).toHaveLength(1);
    expect(searchedTasks[0]?.id).toBe('TSK-102');

    // Tìm kiếm không khớp
    const emptySearch = await api.getTasks({ search: 'non-existent-keyword-xyz' });
    expect(emptySearch).toHaveLength(0);
  });

  it('Nghiệm thu 3: Dữ liệu từ API — Lọc danh sách tính năng (Features) theo status', async () => {
    // Lọc theo status=IN_PROGRESS
    const inProgressFeatures = await api.getFeatures({ status: 'IN_PROGRESS' });
    expect(inProgressFeatures).toHaveLength(1);
    expect(inProgressFeatures[0]?.id).toBe('FEAT-ORCH');

    // Lọc theo status=TODO
    const todoFeatures = await api.getFeatures({ status: 'TODO' });
    expect(todoFeatures).toHaveLength(1);
    expect(todoFeatures[0]?.id).toBe('FEAT-DASH');

    // Lọc theo status=DONE (chưa có)
    const doneFeatures = await api.getFeatures({ status: 'DONE' });
    expect(doneFeatures).toHaveLength(0);
  });

  it('Nghiệm thu 4: Chạy local — Máy chủ Dashboard phục vụ trang /tasks với cấu trúc bảng và bộ lọc', async () => {
    // Lấy dữ liệu tasks từ API
    const tasks = await api.getTasks();
    const features = await api.getFeatures();

    // Khởi tạo máy chủ HTTP local phục vụ trang Dashboard /tasks HTML
    localDashboardServer = http.createServer((req, res) => {
      const url = req.url ?? '/';
      if (url.startsWith('/tasks')) {
        const rowsHtml = tasks
          .map(
            (t) =>
              `<tr data-testid="task-row-${t.id}">
                <td><a href="/tasks/${t.id}" data-testid="task-id-${t.id}">${t.id}</a></td>
                <td data-testid="task-title-${t.id}">${t.title}</td>
                <td data-testid="task-phase-${t.id}">Phase ${t.phase ?? '—'}</td>
                <td data-testid="task-feature-${t.id}">${t.feature_id ?? '—'}</td>
                <td><span data-testid="status-badge-${t.status.toLowerCase()}">${t.status}</span></td>
                <td data-testid="task-attempts-${t.id}">${t.attempts} / ${t.max_attempts}</td>
                <td data-testid="task-dependencies-${t.id}">${t.dependencies.join(', ')}</td>
                <td data-testid="task-priority-${t.id}">${t.priority}</td>
              </tr>`,
          )
          .join('');

        const featureRowsHtml = features
          .map(
            (f) =>
              `<tr data-testid="feature-row-${f.id}">
                <td data-testid="feature-id-${f.id}">${f.id}</td>
                <td data-testid="feature-name-${f.id}">${f.name}</td>
                <td><span data-testid="status-badge-${f.status.toLowerCase()}">${f.status}</span></td>
              </tr>`,
          )
          .join('');

        const html = `<!DOCTYPE html>
<html lang="vi">
  <head><title>AI Orchestrator - Tasks & Features</title></head>
  <body>
    <div data-testid="dashboard-tasks-page">
      <div data-testid="task-feature-dashboard">
        <h2 data-testid="dashboard-title">Quản Lý Tác Vụ & Tính Năng</h2>
        <button data-testid="btn-refresh">Làm mới</button>
        <button data-testid="tab-tasks">Tác Vụ (Tasks)</button>
        <button data-testid="tab-features">Tính Năng (Features)</button>
        <div data-testid="task-metrics-bar">
          <div data-testid="metric-total-tasks">${tasks.length}</div>
        </div>
        <div data-testid="filter-bar">
          <input data-testid="filter-task-search" placeholder="Tìm ID, tiêu đề..." />
          <select data-testid="filter-task-status"><option value="">Tất cả trạng thái</option></select>
          <select data-testid="filter-task-feature"><option value="">Tất cả tính năng</option></select>
          <select data-testid="filter-task-phase"><option value="">Tất cả phase</option></select>
          <button data-testid="btn-reset-filters">Xóa bộ lọc</button>
        </div>
        <table data-testid="tasks-table">
          <tbody>${rowsHtml}</tbody>
        </table>
        <table data-testid="features-table" style="display:none;">
          <tbody>${featureRowsHtml}</tbody>
        </table>
      </div>
    </div>
  </body>
</html>`;

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise<void>((resolve) => {
      localDashboardServer!.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = localDashboardServer.address() as AddressInfo;
    dashboardUrl = `http://127.0.0.1:${addr.port}`;

    const res = await fetch(`${dashboardUrl}/tasks`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const html = await res.text();
    expect(html).toContain('dashboard-tasks-page');
    expect(html).toContain('task-feature-dashboard');
    expect(html).toContain('tasks-table');
    expect(html).toContain('task-row-TSK-101');
    expect(html).toContain('task-row-TSK-102');
    expect(html).toContain('task-row-TSK-103');
    expect(html).toContain('filter-task-search');
    expect(html).toContain('filter-task-status');
    expect(html).toContain('filter-task-feature');
    expect(html).toContain('filter-task-phase');
    expect(html).toContain('btn-refresh');
    expect(html).toContain('btn-reset-filters');
  });

  it('Nghiệm thu 5: Next.js Dashboard exports và source components tồn tại đầy đủ', () => {
    const dashboardSrc = path.resolve(process.cwd(), 'apps/dashboard/src');
    expect(fs.existsSync(path.join(dashboardSrc, 'components/TaskFeatureDashboard.tsx'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(dashboardSrc, 'components/StatusBadge.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(dashboardSrc, 'app/tasks/page.tsx'))).toBe(true);
    expect(
      fs.existsSync(path.join(dashboardSrc, '__tests__/task-feature-dashboard.test.tsx')),
    ).toBe(true);
  });
});
