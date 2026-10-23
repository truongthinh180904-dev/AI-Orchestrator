import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import type Database from 'better-sqlite3';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  RunRepository,
  EventRepository,
  CheckpointRepository,
  AgentLockRepository,
} from '../packages/db/src/index.js';
import {
  isProcessAlive,
  ProcessStateInspectionSchema,
  type TaskStatus,
} from '../packages/shared/src/index.js';
import { buildServer } from '../apps/orchestrator/src/server.js';
import { ProcessMonitorService } from '../apps/orchestrator/src/services/process-monitor-service.js';
import { TaskScheduler } from '../apps/orchestrator/src/services/task-scheduler.js';
import { RunService } from '../apps/orchestrator/src/services/run-service.js';
import { ExecutionManager } from '../apps/orchestrator/src/adapters/execution-manager.js';

describe('OPS-004: Kiểm tra process còn sống (PID + heartbeat) — Phân biệt chết vs xong', () => {
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let runRepo: RunRepository;
  let eventRepo: EventRepository;
  let checkpointRepo: CheckpointRepository;
  let lockRepo: AgentLockRepository;
  let executionManager: ExecutionManager;
  let runService: RunService;
  let monitorService: ProcessMonitorService;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    runRepo = new RunRepository(db);
    eventRepo = new EventRepository(db);
    checkpointRepo = new CheckpointRepository(db);
    lockRepo = new AgentLockRepository(db);
    executionManager = new ExecutionManager();

    runService = new RunService({
      db,
      executionManager,
    });

    monitorService = new ProcessMonitorService({
      db,
      executionManager,
      defaultHeartbeatTimeoutMs: 10_000,
    });

    db.prepare(
      "INSERT INTO features (id, name, created_at, updated_at) VALUES ('FEAT-OPS4', 'Process Liveness Feature', datetime('now'), datetime('now'))",
    ).run();
  });

  afterEach(() => {
    monitorService.stopWatchdog();
    executionManager.clearAll();
    db.close();
  });

  function createTestTask(
    id: string,
    options?: { status?: TaskStatus; attempts?: number; max_attempts?: number },
  ) {
    return taskRepo.create({
      id,
      feature_id: 'FEAT-OPS4',
      title: `Task ${id}`,
      status: options?.status ?? 'READY',
      attempts: options?.attempts ?? 0,
      max_attempts: options?.max_attempts ?? 3,
      priority: 10,
    });
  }

  describe('1. Kiểm tra Process còn sống qua PID (isProcessAlive)', () => {
    it('Nghiệm thu: PID của tiến trình Node hiện tại trả về true (còn sống)', () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it('Nghiệm thu: PID của tiến trình con thực tế trả về true khi đang chạy và false sau khi thoát', async () => {
      // Spawn một tiến trình con thực tế ngắn hạn
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400)']);
      expect(child.pid).toBeDefined();
      const pid = child.pid!;

      // Trong khi child đang chạy: isProcessAlive phải là true
      expect(isProcessAlive(pid)).toBe(true);

      // Chờ tiến trình con kết thúc
      await new Promise<void>((resolve) => {
        child.on('close', () => resolve());
      });

      // Sau khi tiến trình con đã đóng: isProcessAlive phải là false
      expect(isProcessAlive(pid)).toBe(false);
    });

    it('Nghiệm thu: PID không hợp lệ (null, undefined, 0, số âm, PID không tồn tại) trả về false', () => {
      expect(isProcessAlive(null)).toBe(false);
      expect(isProcessAlive(undefined)).toBe(false);
      expect(isProcessAlive(0)).toBe(false);
      expect(isProcessAlive(-1)).toBe(false);
      expect(isProcessAlive(99999999)).toBe(false);
    });
  });

  describe('2. Phân biệt "Chết" vs "Xong" (Distinguish Dead vs Finished)', () => {
    it('Nghiệm thu: Phân biệt "Xong" (FINISHED) — Tiến trình đã hoàn thành, có finished_at và status SUCCESS dù PID không còn trong OS', () => {
      const task = createTestTask('TASK-FINISHED-1', { status: 'DONE', attempts: 1 });
      const run = runRepo.create({
        id: 'run-finished-1',
        task_id: task.id,
        attempt: 1,
        status: 'SUCCESS',
        exit_code: 0,
        pid: 88888, // Giả lập PID cũ đã biến mất
        started_at: '2026-10-23T10:00:00.000Z',
        finished_at: '2026-10-23T10:05:00.000Z',
      });

      const inspection = monitorService.inspectRun(run.id);

      expect(inspection.state).toBe('FINISHED');
      expect(inspection.isFinished).toBe(true);
      expect(inspection.isAlive).toBe(false);
      expect(inspection.isCrashed).toBe(false);
      expect(inspection.isUnresponsive).toBe(false);
      expect(inspection.diagnosis).toContain('finished execution with status SUCCESS (exitCode: 0)');
      expect(ProcessStateInspectionSchema.parse(inspection)).toBeDefined();
    });

    it('Nghiệm thu: Phân biệt "Chết" (DEAD) — Run status RUNNING nhưng PID không còn tồn tại trong OS (chết bất thường)', () => {
      const task = createTestTask('TASK-DEAD-1', { status: 'RUNNING', attempts: 1 });
      const deadPid = 9999998; // PID không tồn tại trong OS
      const run = runRepo.create({
        id: 'run-dead-1',
        task_id: task.id,
        attempt: 1,
        status: 'RUNNING',
        pid: deadPid,
        started_at: '2026-10-23T10:00:00.000Z',
        finished_at: null,
      });

      const inspection = monitorService.inspectRun(run.id);

      expect(inspection.state).toBe('DEAD');
      expect(inspection.isFinished).toBe(false);
      expect(inspection.isAlive).toBe(false);
      expect(inspection.isCrashed).toBe(true);
      expect(inspection.isUnresponsive).toBe(false);
      expect(inspection.diagnosis).toContain(`Process PID ${deadPid} is dead/crashed unexpectedly`);
      expect(inspection.diagnosis).toContain('PID disappeared from OS without clean finish');
      expect(ProcessStateInspectionSchema.parse(inspection)).toBeDefined();
    });

    it('Nghiệm thu: "Còn sống" (ALIVE) — Run status RUNNING, PID còn trong OS và Heartbeat tươi mới', () => {
      const task = createTestTask('TASK-ALIVE-1', { status: 'RUNNING', attempts: 1 });
      const livePid = process.pid; // Dùng current process làm process còn sống
      const now = Date.now();
      const recentHeartbeat = new Date(now - 2000).toISOString(); // 2 giây trước

      const run = runRepo.create({
        id: 'run-alive-1',
        task_id: task.id,
        attempt: 1,
        status: 'RUNNING',
        pid: livePid,
        started_at: new Date(now - 60000).toISOString(),
        last_heartbeat_at: recentHeartbeat,
      });

      const inspection = monitorService.inspectRun(run.id, {
        heartbeatTimeoutMs: 10_000, // Ngưỡng 10 giây
        now,
      });

      expect(inspection.state).toBe('ALIVE');
      expect(inspection.isAlive).toBe(true);
      expect(inspection.isHeartbeatFresh).toBe(true);
      expect(inspection.isFinished).toBe(false);
      expect(inspection.isCrashed).toBe(false);
      expect(inspection.isUnresponsive).toBe(false);
      expect(inspection.diagnosis).toContain('alive and actively running');
    });

    it('Nghiệm thu: "Treo" (UNRESPONSIVE) — Run status RUNNING, PID còn trong OS nhưng Heartbeat đã hết hạn', () => {
      const task = createTestTask('TASK-HUNG-1', { status: 'RUNNING', attempts: 1 });
      const livePid = process.pid;
      const now = Date.now();
      const staleHeartbeat = new Date(now - 45_000).toISOString(); // 45 giây trước

      const run = runRepo.create({
        id: 'run-hung-1',
        task_id: task.id,
        attempt: 1,
        status: 'RUNNING',
        pid: livePid,
        started_at: new Date(now - 60000).toISOString(),
        last_heartbeat_at: staleHeartbeat,
      });

      const inspection = monitorService.inspectRun(run.id, {
        heartbeatTimeoutMs: 15_000, // Ngưỡng 15 giây < 45 giây
        now,
      });

      expect(inspection.state).toBe('UNRESPONSIVE');
      expect(inspection.isAlive).toBe(true);
      expect(inspection.isHeartbeatFresh).toBe(false);
      expect(inspection.isUnresponsive).toBe(true);
      expect(inspection.isFinished).toBe(false);
      expect(inspection.isCrashed).toBe(false);
      expect(inspection.diagnosis).toContain('alive in OS but unresponsive');
    });
  });

  describe('3. Ghi nhận và Cập nhật Heartbeat (Heartbeat Tracking)', () => {
    it('Nghiệm thu: recordHeartbeat cập nhật timestamp trong SQLite và phát sinh event heartbeat', () => {
      const task = createTestTask('TASK-HB-1', { status: 'RUNNING', attempts: 1 });
      const run = runRepo.create({
        id: 'run-hb-1',
        task_id: task.id,
        attempt: 1,
        status: 'RUNNING',
        pid: process.pid,
      });

      expect(run.last_heartbeat_at).toBeNull();

      const hbTime = '2026-10-23T12:30:00.000Z';
      const result = monitorService.recordHeartbeat(run.id, hbTime);

      expect(result.success).toBe(true);
      expect(result.lastHeartbeatAt).toBe(hbTime);

      // Kiểm tra DB được cập nhật
      const updatedRun = runRepo.getById(run.id);
      expect(updatedRun?.last_heartbeat_at).toBe(hbTime);

      // Kiểm tra event heartbeat được ghi nhận trong bảng events
      const events = eventRepo.findByRunId(run.id);
      expect(events.length).toBeGreaterThan(0);
      const hbEvent = events.find((e) => e.type === 'heartbeat');
      expect(hbEvent).toBeDefined();
    });
  });

  describe('4. Tự động Quét và Reconcile Tiến Trình Chết (Auto-Reconcile Crashed Runs)', () => {
    it('Nghiệm thu: scanActiveRuns phát hiện phân loại chính xác các trạng thái và reconcile tiến trình chết', () => {
      const taskDead = createTestTask('TASK-SCAN-DEAD', {
        status: 'RUNNING',
        attempts: 1,
        max_attempts: 3,
      });
      const deadRun = runRepo.create({
        id: 'run-scan-dead',
        task_id: taskDead.id,
        attempt: 1,
        status: 'RUNNING',
        pid: 9999997, // PID chết
      });

      lockRepo.acquire({
        id: 'default_agent',
        task_id: taskDead.id,
        run_id: deadRun.id,
      });

      const taskAlive = createTestTask('TASK-SCAN-ALIVE', {
        status: 'RUNNING',
        attempts: 1,
      });
      runRepo.create({
        id: 'run-scan-alive',
        task_id: taskAlive.id,
        attempt: 1,
        status: 'RUNNING',
        pid: process.pid, // PID sống
        last_heartbeat_at: new Date().toISOString(),
      });

      // Quét với cờ autoReconcile: true
      const summary = monitorService.scanActiveRuns({
        autoReconcile: true,
        heartbeatTimeoutMs: 30_000,
      });

      expect(summary.totalScanned).toBe(2);
      expect(summary.aliveCount).toBe(1);
      expect(summary.deadCount).toBe(1);
      expect(summary.reconciledCount).toBe(1);

      // Kiểm tra run chết đã được chuyển sang ERROR
      const reconciledRun = runRepo.getById(deadRun.id);
      expect(reconciledRun?.status).toBe('ERROR');
      expect(reconciledRun?.exit_code).toBe(137);
      expect(reconciledRun?.finished_at).toBeTruthy();

      // Kiểm tra task được requeue sang READY (vì attempts 1 < max_attempts 3)
      const requeuedTask = taskRepo.findById(taskDead.id);
      expect(requeuedTask?.status).toBe('READY');

      // Kiểm tra lock đã được tự động giải phóng
      expect(lockRepo.isLocked('default_agent')).toBe(false);

      // Kiểm tra checkpoint và event process_crashed đã được tạo
      const checkpoints = checkpointRepo.findByRunId(deadRun.id);
      expect(checkpoints.some((c) => c.step === 'process_crashed')).toBe(true);

      const events = eventRepo.findByRunId(deadRun.id);
      expect(events.some((e) => e.type === 'process_crashed')).toBe(true);
    });

    it('Nghiệm thu: Task hết lượt thử (attempts >= max_attempts) khi process chết sẽ chuyển sang FAILED dứt điểm', () => {
      const taskFinal = createTestTask('TASK-FINAL-DEAD', {
        status: 'RUNNING',
        attempts: 3,
        max_attempts: 3, // Hết lượt thử!
      });
      const deadRun = runRepo.create({
        id: 'run-final-dead',
        task_id: taskFinal.id,
        attempt: 3,
        status: 'RUNNING',
        pid: 9999996,
      });

      const reconcileResult = monitorService.reconcileCrashedRun(deadRun.id);
      expect(reconcileResult.reconciled).toBe(true);

      const failedTask = taskRepo.findById(taskFinal.id);
      expect(failedTask?.status).toBe('FAILED');
    });
  });

  describe('5. Tích hợp TaskScheduler & Background Watchdog', () => {
    it('Nghiệm thu: TaskScheduler tích hợp processMonitor cho phép theo dõi tiến trình', () => {
      const scheduler = new TaskScheduler({
        db,
        runService,
      });

      expect(scheduler.processMonitor).toBeDefined();
      expect(scheduler.processMonitor).toBeInstanceOf(ProcessMonitorService);

      const pidCheck = scheduler.processMonitor.checkPid(process.pid);
      expect(pidCheck.isAlive).toBe(true);
    });

    it('Nghiệm thu: Watchdog định kỳ có thể bắt đầu và dừng an toàn', () => {
      expect(monitorService.isWatchdogRunning()).toBe(false);
      monitorService.startWatchdog(100);
      expect(monitorService.isWatchdogRunning()).toBe(true);
      monitorService.stopWatchdog();
      expect(monitorService.isWatchdogRunning()).toBe(false);
    });
  });

  describe('6. REST API Endpoints Liveness & Heartbeat', () => {
    it('Nghiệm thu: GET /runs/:id/liveness, POST /runs/:id/heartbeat, GET /system/processes/liveness', async () => {
      const server = await buildServer({
        db,
        runService,
      });

      try {
        const task = createTestTask('TASK-API-1', { status: 'RUNNING', attempts: 1 });
        const run = runRepo.create({
          id: 'run-api-1',
          task_id: task.id,
          attempt: 1,
          status: 'RUNNING',
          pid: process.pid,
        });

        // 1. GET /runs/:id/liveness
        const livenessRes = await server.inject({
          method: 'GET',
          url: `/runs/${run.id}/liveness`,
        });
        expect(livenessRes.statusCode).toBe(200);
        const livenessBody = livenessRes.json<{ data: { state: string; isAlive: boolean } }>();
        expect(livenessBody.data.state).toBe('ALIVE');
        expect(livenessBody.data.isAlive).toBe(true);

        // 2. POST /runs/:id/heartbeat
        const hbTime = new Date().toISOString();
        const hbRes = await server.inject({
          method: 'POST',
          url: `/runs/${run.id}/heartbeat`,
          payload: { timestamp: hbTime },
        });
        expect(hbRes.statusCode).toBe(200);
        const hbBody = hbRes.json<{ data: { success: boolean; lastHeartbeatAt: string } }>();
        expect(hbBody.data.success).toBe(true);
        expect(hbBody.data.lastHeartbeatAt).toBe(hbTime);

        // 3. GET /system/processes/liveness
        const scanRes = await server.inject({
          method: 'GET',
          url: '/system/processes/liveness',
        });
        expect(scanRes.statusCode).toBe(200);
        const scanBody = scanRes.json<{ data: { totalScanned: number; aliveCount: number } }>();
        expect(scanBody.data.totalScanned).toBeGreaterThanOrEqual(1);
        expect(scanBody.data.aliveCount).toBeGreaterThanOrEqual(1);

        // 4. POST /system/processes/reconcile
        const reconcileRes = await server.inject({
          method: 'POST',
          url: '/system/processes/reconcile',
        });
        expect(reconcileRes.statusCode).toBe(200);
      } finally {
        await server.close();
      }
    });
  });
});
