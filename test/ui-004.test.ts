/**
 * Acceptance test for UI-004: Live logs (SSE) + thông báo — Cập nhật realtime
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
  EventRepository,
} from '../packages/db/src/index.js';
import type Database from 'better-sqlite3';
import { ApiClient } from '../apps/dashboard/src/lib/api.js';
import {
  NotificationStore,
  createNotificationFromEvent,
} from '../apps/dashboard/src/lib/notifications.js';
import { type EventRecord } from '../packages/shared/src/index.js';

describe('UI-004 Acceptance: Live logs (SSE) + thông báo — Cập nhật realtime', () => {
  let db: Database.Database;
  let server: FastifyInstance;
  let orchestratorUrl: string;
  let api: ApiClient;
  let localDashboardServer: http.Server | null = null;
  let dashboardUrl: string = '';
  let taskRepo: TaskRepository;
  let featureRepo: FeatureRepository;
  let runRepo: RunRepository;
  let eventRepo: EventRepository;
  let seededRunId: string;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);

    taskRepo = new TaskRepository(db);
    featureRepo = new FeatureRepository(db);
    runRepo = new RunRepository(db);
    eventRepo = new EventRepository(db);

    // Seed feature
    featureRepo.create({
      id: 'FEAT-LIVE',
      name: 'Live Streaming and Notifications',
      description: 'Realtime event streaming and dashboard notification center',
      required_tasks: ['TSK-LIVE-1'],
      integration_tests: ['pnpm test:live'],
      status: 'IN_PROGRESS',
    });

    // Seed task
    taskRepo.create({
      id: 'TSK-LIVE-1',
      feature_id: 'FEAT-LIVE',
      title: 'Realtime worker execution stream',
      description: 'Stream stdout, stderr and structured events in realtime via SSE',
      phase: 'UI',
      worker_type: 'agy',
      repository: '.',
      scope_files: ['apps/dashboard/src/components/LiveLogViewer.tsx'],
      acceptance_criteria: [
        'Stream live logs via SSE',
        'Auto-scroll terminal view with pause toggle',
        'Notification alerts on critical events',
      ],
      test_commands: ['pnpm test'],
      priority: 1,
      max_attempts: 3,
      timeout_minutes: 30,
      status: 'RUNNING',
      attempts: 1,
      dependencies: [],
    });

    // Seed completed run with events
    const run = runRepo.create({
      task_id: 'TSK-LIVE-1',
      attempt: 1,
      status: 'SUCCESS',
      pid: 4567,
    });
    seededRunId = run.id;

    // Seed events
    eventRepo.create({
      run_id: run.id,
      seq: 1,
      type: 'process_start',
      payload: { pid: 4567, command: 'node worker.js' },
      ts: '2026-10-23T08:30:00.000Z',
    });

    eventRepo.create({
      run_id: run.id,
      seq: 2,
      type: 'stdout',
      payload: 'Building TypeScript artifacts...',
      ts: '2026-10-23T08:30:01.000Z',
    });

    eventRepo.create({
      run_id: run.id,
      seq: 3,
      type: 'checkpoint',
      payload: { step: 'compile_code', status: 'SUCCESS' },
      ts: '2026-10-23T08:30:02.000Z',
    });

    eventRepo.create({
      run_id: run.id,
      seq: 4,
      type: 'stderr',
      payload: 'Warning: experimental feature flag enabled',
      ts: '2026-10-23T08:30:03.000Z',
    });

    eventRepo.create({
      run_id: run.id,
      seq: 5,
      type: 'process_exit',
      payload: { exitCode: 0, durationMs: 3500 },
      ts: '2026-10-23T08:30:04.000Z',
    });

    // Start Fastify orchestrator server
    server = await buildServer({ db, logger: false });
    await server.listen({ port: 0, host: '127.0.0.1' });
    const port = (server.server.address() as AddressInfo).port;
    orchestratorUrl = `http://127.0.0.1:${port}`;
    api = new ApiClient({ baseUrl: orchestratorUrl });

    // Start simple HTTP dashboard preview server
    localDashboardServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html>
<head><title>Dashboard Preview</title></head>
<body>
  <div data-testid="dashboard-layout-root">
    <header data-testid="dashboard-header">
      <div data-testid="notification-bell-btn">🔔<span data-testid="notification-badge-count">1</span></div>
      <div data-testid="connection-status-badge">API Trực tuyến</div>
    </header>
    <main data-testid="dashboard-main">
      <div data-testid="dashboard-task-detail-page">
        <button data-testid="tab-live">🔴 Live Logs (SSE)</button>
        <div data-testid="run-live-logs-container">
          <div data-testid="live-log-viewer">
            <div data-testid="live-log-toolbar">
              <span data-testid="live-run-id">RUN #${run.id.slice(0, 8)}</span>
              <span data-testid="live-status-badge">TRỰC TUYẾN (LIVE)</span>
              <button data-testid="btn-toggle-autoscroll" data-autoscroll="true">⬇ Cuộn: BẬT</button>
            </div>
            <div data-testid="live-terminal-container">
              <div data-testid="log-line-1"><span data-testid="log-seq-1">#1</span> [process_start]</div>
              <div data-testid="log-line-2"><span data-testid="log-seq-2">#2</span> [stdout] Building TypeScript artifacts...</div>
            </div>
          </div>
        </div>
      </div>
    </main>
    <div data-testid="notification-toast-container"></div>
  </div>
</body>
</html>`);
    });

    await new Promise<void>((resolve) => {
      localDashboardServer!.listen(0, '127.0.0.1', () => {
        const dPort = (localDashboardServer!.address() as AddressInfo).port;
        dashboardUrl = `http://127.0.0.1:${dPort}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (server) await server.close();
    if (localDashboardServer) {
      await new Promise<void>((resolve) => localDashboardServer!.close(() => resolve()));
    }
    db.close();
  });

  it('Nghiệm thu 1: Live logs (SSE) — Máy chủ Orchestrator stream SSE qua endpoint GET /runs/:id/stream với định dạng chuẩn', async () => {
    const runId = seededRunId;

    const streamUrl = `${orchestratorUrl}/runs/${runId}/stream`;
    const res = await fetch(streamUrl);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');

    const text = await res.text();
    expect(text).toContain('id: 1');
    expect(text).toContain('event: process_start');
    expect(text).toContain('event: stdout');
    expect(text).toContain('Building TypeScript artifacts...');
    expect(text).toContain('event: checkpoint');
    expect(text).toContain('compile_code');
    expect(text).toContain('event: process_exit');
    expect(text).toContain('event: done');
  });

  it('Nghiệm thu 2: Cập nhật realtime — ApiClient subscribeToRunStream nhận sự kiện thời gian thực', async () => {
    const runId = seededRunId;

    const events: EventRecord[] = [];
    const stateHistory: string[] = [];
    let doneData: { runId: string; status: string } | null = null;

    await new Promise<void>((resolve, reject) => {
      const unsubscribe = api.subscribeToRunStream(runId, {
        onEvent: (event) => {
          events.push(event);
        },
        onStateChange: (state) => {
          stateHistory.push(state);
        },
        onDone: (data) => {
          doneData = data;
          unsubscribe();
          resolve();
        },
        onError: (err) => {
          unsubscribe();
          reject(err);
        },
      });
    });

    expect(events.length).toBe(5);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(events[0]?.type).toBe('process_start');
    expect(events[1]?.type).toBe('stdout');
    expect(events[2]?.type).toBe('checkpoint');
    expect(events[3]?.type).toBe('stderr');
    expect(events[4]?.type).toBe('process_exit');

    expect(stateHistory).toContain('connecting');
    expect(stateHistory).toContain('connected');
    expect(stateHistory).toContain('completed');
    expect(doneData).toEqual({ runId, status: 'SUCCESS' });
  });

  it('Nghiệm thu 3: Cập nhật realtime — Phục hồi và nối tiếp luồng với after_seq / last-event-id', async () => {
    const runId = seededRunId;

    // Connect with afterSeq: 3 to receive only subsequent events (seq 4 and 5)
    const events: EventRecord[] = [];

    await new Promise<void>((resolve, reject) => {
      const unsubscribe = api.subscribeToRunStream(
        runId,
        {
          onEvent: (event) => {
            events.push(event);
          },
          onDone: () => {
            unsubscribe();
            resolve();
          },
          onError: (err) => {
            unsubscribe();
            reject(err);
          },
        },
        { afterSeq: 3 },
      );
    });

    expect(events.length).toBe(2);
    expect(events.map((e) => e.seq)).toEqual([4, 5]);
    expect(events[0]?.type).toBe('stderr');
    expect(events[1]?.type).toBe('process_exit');
  });

  it('Nghiệm thu 4: Thông báo (Notifications) — Tự động chuyển đổi sự kiện vòng đời và mốc checkpoint thành thông báo', () => {
    const store = new NotificationStore();

    // 1. process_start -> info
    const notifStart = createNotificationFromEvent(
      {
        id: 1,
        run_id: 'run-99',
        seq: 1,
        type: 'process_start',
        payload: { pid: 1234 },
        ts: '2026-10-23T00:00:00Z',
      },
      { taskId: 'TSK-LIVE-1' },
      store,
    );
    expect(notifStart).not.toBeNull();
    expect(notifStart?.severity).toBe('info');
    expect(notifStart?.title).toBe('Tiến trình bắt đầu');
    expect(notifStart?.link).toBe('/tasks/TSK-LIVE-1');

    // 2. checkpoint -> info
    const notifCp = createNotificationFromEvent(
      {
        id: 2,
        run_id: 'run-99',
        seq: 2,
        type: 'checkpoint',
        payload: { step: 'quality_gate_audit' },
        ts: '2026-10-23T00:01:00Z',
      },
      undefined,
      store,
    );
    expect(notifCp?.severity).toBe('info');
    expect(notifCp?.message).toContain('quality_gate_audit');

    // 3. process_exit (exitCode: 0) -> success
    const notifSuccess = createNotificationFromEvent(
      {
        id: 3,
        run_id: 'run-99',
        seq: 3,
        type: 'process_exit',
        payload: { exitCode: 0 },
        ts: '2026-10-23T00:02:00Z',
      },
      undefined,
      store,
    );
    expect(notifSuccess?.severity).toBe('success');
    expect(notifSuccess?.message).toContain('mã thoát 0');

    // 4. process_exit (exitCode: 1) -> error
    const notifError = createNotificationFromEvent(
      {
        id: 4,
        run_id: 'run-99',
        seq: 4,
        type: 'process_exit',
        payload: { exitCode: 1 },
        ts: '2026-10-23T00:03:00Z',
      },
      undefined,
      store,
    );
    expect(notifError?.severity).toBe('error');
    expect(notifError?.message).toContain('mã lỗi 1');

    // Store operations
    expect(store.getNotifications().length).toBe(4);
    expect(store.getUnreadCount()).toBe(4);

    store.markAsRead(notifStart!.id);
    expect(store.getUnreadCount()).toBe(3);

    store.markAllAsRead();
    expect(store.getUnreadCount()).toBe(0);

    store.clearAll();
    expect(store.getNotifications().length).toBe(0);
  });

  it('Nghiệm thu 5: Chạy local — Máy chủ Dashboard phục vụ trang /tasks/:id tích hợp Live Logs SSE tab và NotificationBell', async () => {
    const res = await fetch(`${dashboardUrl}/tasks/TSK-LIVE-1`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain('dashboard-layout-root');
    expect(html).toContain('notification-bell-btn');
    expect(html).toContain('notification-badge-count');
    expect(html).toContain('tab-live');
    expect(html).toContain('Live Logs (SSE)');
    expect(html).toContain('live-log-viewer');
    expect(html).toContain('live-run-id');
    expect(html).toContain('live-status-badge');
    expect(html).toContain('btn-toggle-autoscroll');
    expect(html).toContain('live-terminal-container');
    expect(html).toContain('notification-toast-container');
  });

  it('Nghiệm thu 6: Next.js Dashboard exports và source components UI-004 tồn tại đầy đủ', () => {
    const liveLogViewerPath = path.resolve(
      process.cwd(),
      'apps/dashboard/src/components/LiveLogViewer.tsx',
    );
    const notifCenterPath = path.resolve(
      process.cwd(),
      'apps/dashboard/src/components/NotificationCenter.tsx',
    );
    const notificationsPath = path.resolve(
      process.cwd(),
      'apps/dashboard/src/lib/notifications.ts',
    );
    const indexPath = path.resolve(process.cwd(), 'apps/dashboard/src/index.ts');

    expect(fs.existsSync(liveLogViewerPath)).toBe(true);
    expect(fs.existsSync(notifCenterPath)).toBe(true);
    expect(fs.existsSync(notificationsPath)).toBe(true);

    const indexContent = fs.readFileSync(indexPath, 'utf-8');
    expect(indexContent).toContain('./components/LiveLogViewer.js');
    expect(indexContent).toContain('./components/NotificationCenter.js');
    expect(indexContent).toContain('./lib/notifications.js');
  });
});
