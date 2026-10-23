import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  RunRepository,
  EventRepository,
  CheckpointRepository,
  AgentLockRepository,
  RecoveryAuditRepository,
} from '../packages/db/src/index.js';
import type { TaskStatus } from '../packages/shared/src/index.js';
import { buildServer } from '../apps/orchestrator/src/server.js';
import { RecoveryService } from '../apps/orchestrator/src/services/recovery-service.js';
import { TaskScheduler } from '../apps/orchestrator/src/services/task-scheduler.js';
import { RunService } from '../apps/orchestrator/src/services/run-service.js';
import { TaskHistoryService } from '../apps/orchestrator/src/services/task-history-service.js';
import { ExecutionManager } from '../apps/orchestrator/src/adapters/execution-manager.js';

describe('OPS-003: Phục hồi sau restart (task RUNNING → kiểm tra → requeue/fail)', () => {
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let runRepo: RunRepository;
  let eventRepo: EventRepository;
  let checkpointRepo: CheckpointRepository;
  let lockRepo: AgentLockRepository;
  let auditRepo: RecoveryAuditRepository;
  let historyService: TaskHistoryService;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    runRepo = new RunRepository(db);
    eventRepo = new EventRepository(db);
    checkpointRepo = new CheckpointRepository(db);
    lockRepo = new AgentLockRepository(db);
    auditRepo = new RecoveryAuditRepository(db);
    historyService = new TaskHistoryService({ db });

    db.prepare(
      "INSERT INTO features (id, name, created_at, updated_at) VALUES ('FEAT-OPS3', 'Crash Recovery Feature', datetime('now'), datetime('now'))",
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  function createTestTask(
    id: string,
    options?: { status?: TaskStatus; attempts?: number; max_attempts?: number },
  ) {
    return taskRepo.create({
      id,
      feature_id: 'FEAT-OPS3',
      title: `Task ${id}`,
      status: options?.status ?? 'READY',
      attempts: options?.attempts ?? 0,
      max_attempts: options?.max_attempts ?? 3,
      priority: 10,
    });
  }

  describe('1. Task RUNNING → Kiểm tra → Requeue (attempts < max_attempts)', () => {
    it('Nghiệm thu: Task RUNNING với attempts < max_attempts được kiểm tra và chuyển sang READY (requeue)', () => {
      const task = createTestTask('TASK-REQUEUE-1', {
        status: 'RUNNING',
        attempts: 1,
        max_attempts: 3,
      });

      const run = runRepo.create({
        id: 'run-requeue-1',
        task_id: task.id,
        attempt: 1,
        status: 'RUNNING',
        started_at: new Date('2026-10-23T10:00:00Z').toISOString(),
      });

      lockRepo.acquire({
        id: 'default_agent',
        task_id: task.id,
        run_id: run.id,
      });

      const recoveryService = new RecoveryService({ db });

      // Trước khi recovery: kiểm tra trạng thái
      const checkBefore = recoveryService.checkInterrupted();
      expect(checkBefore.needsRecovery).toBe(true);
      expect(checkBefore.runningTasksCount).toBe(1);
      expect(checkBefore.activeRunsCount).toBe(1);
      expect(checkBefore.heldLocksCount).toBe(1);

      // Thực hiện phục hồi
      const result = recoveryService.recover({ trigger: 'crash_simulation' });

      expect(result.recoveredTasks.length).toBe(1);
      const recovered = result.recoveredTasks[0]!;
      expect(recovered.taskId).toBe(task.id);
      expect(recovered.previousStatus).toBe('RUNNING');
      expect(recovered.newStatus).toBe('READY');
      expect(recovered.action).toBe('REQUEUED');
      expect(recovered.attempts).toBe(1);
      expect(recovered.maxAttempts).toBe(3);

      // Task trong DB đã ở trạng thái READY
      const updatedTask = taskRepo.findById(task.id);
      expect(updatedTask?.status).toBe('READY');
      expect(updatedTask?.attempts).toBe(1);

      // Run cũ được cập nhật thành ERROR, không còn RUNNING
      const updatedRun = runRepo.getById(run.id);
      expect(updatedRun?.status).toBe('ERROR');
      expect(updatedRun?.finished_at).toBeTruthy();
      expect(updatedRun?.exit_code).toBe(1);

      // Lock đã được giải phóng
      expect(lockRepo.isLocked('default_agent')).toBe(false);

      // Sau khi recovery: không còn task/run bị treo
      const checkAfter = recoveryService.checkInterrupted();
      expect(checkAfter.needsRecovery).toBe(false);
      expect(checkAfter.runningTasksCount).toBe(0);
      expect(checkAfter.activeRunsCount).toBe(0);
      expect(checkAfter.heldLocksCount).toBe(0);
    });

    it('Nghiệm thu: Task VERIFYING bị ngắt cũng được phục hồi và requeue sang READY', () => {
      const task = createTestTask('TASK-VERIFY-1', {
        status: 'VERIFYING',
        attempts: 1,
        max_attempts: 3,
      });

      const recoveryService = new RecoveryService({ db });
      const result = recoveryService.recover({ trigger: 'power_outage' });

      expect(result.recoveredTasks.length).toBe(1);
      expect(result.recoveredTasks[0]?.action).toBe('REQUEUED');
      expect(result.recoveredTasks[0]?.newStatus).toBe('READY');

      const updated = taskRepo.findById(task.id);
      expect(updated?.status).toBe('READY');
    });
  });

  describe('2. Task RUNNING → Kiểm tra → Fail (attempts >= max_attempts)', () => {
    it('Nghiệm thu: Task RUNNING với attempts >= max_attempts được kiểm tra và chuyển sang FAILED', () => {
      const task = createTestTask('TASK-EXHAUSTED-1', {
        status: 'RUNNING',
        attempts: 3,
        max_attempts: 3,
      });

      const run = runRepo.create({
        id: 'run-exhausted-1',
        task_id: task.id,
        attempt: 3,
        status: 'RUNNING',
      });

      const recoveryService = new RecoveryService({ db });
      const result = recoveryService.recover();

      expect(result.recoveredTasks.length).toBe(1);
      const recovered = result.recoveredTasks[0]!;
      expect(recovered.taskId).toBe(task.id);
      expect(recovered.previousStatus).toBe('RUNNING');
      expect(recovered.newStatus).toBe('FAILED');
      expect(recovered.action).toBe('FAILED');
      expect(recovered.reason).toContain('maximum attempts reached (3/3)');

      const updatedTask = taskRepo.findById(task.id);
      expect(updatedTask?.status).toBe('FAILED');

      const updatedRun = runRepo.getById(run.id);
      expect(updatedRun?.status).toBe('ERROR');
    });

    it('Nghiệm thu: Tùy chọn forceFailAll = true ép mọi task bị ngắt thành FAILED', () => {
      const task = createTestTask('TASK-FORCE-FAIL', {
        status: 'RUNNING',
        attempts: 1,
        max_attempts: 5,
      });

      const recoveryService = new RecoveryService({ db });
      const result = recoveryService.recover({ forceFailAll: true });

      expect(result.recoveredTasks[0]?.action).toBe('FAILED');
      expect(result.recoveredTasks[0]?.newStatus).toBe('FAILED');

      const updated = taskRepo.findById(task.id);
      expect(updated?.status).toBe('FAILED');
    });
  });

  describe('3. Nghiệm thu: Không mất lịch sử (ORC-005 integration)', () => {
    it('Bảo toàn 100% bản ghi run cũ, checkpoint và event trước và sau khi phục hồi', async () => {
      const task = createTestTask('TASK-HIST-1', {
        status: 'RUNNING',
        attempts: 1,
        max_attempts: 3,
      });

      const run1 = runRepo.create({
        id: 'run-hist-attempt-1',
        task_id: task.id,
        attempt: 1,
        status: 'RUNNING',
        started_at: new Date('2026-10-23T08:00:00Z').toISOString(),
      });

      // Ghi nhận event và checkpoint trước khi crash
      eventRepo.create({
        run_id: run1.id,
        type: 'stdout',
        payload: { text: 'Compiling module A...' },
      });
      checkpointRepo.create({
        task_id: task.id,
        run_id: run1.id,
        attempt: 1,
        step: 'build_step',
        status: 'COMPLETED',
        data: { module: 'A' },
      });

      // Crash & Phục hồi
      const recoveryService = new RecoveryService({ db });
      recoveryService.recover({ trigger: 'unexpected_shutdown' });

      // Run 1 vẫn tồn tại nguyên vẹn, không bị xóa
      const checkRun1 = runRepo.getById(run1.id);
      expect(checkRun1).not.toBeNull();
      expect(checkRun1?.id).toBe(run1.id);
      expect(checkRun1?.attempt).toBe(1);
      expect(checkRun1?.status).toBe('ERROR');

      // Sự kiện gián đoạn và checkpoint phục hồi được bổ sung
      const eventsRun1 = eventRepo.findByRunId(run1.id);
      expect(eventsRun1.some((e) => e.type === 'run_interrupted')).toBe(true);
      expect(eventsRun1.some((e) => e.type === 'stdout')).toBe(true);

      const checkpointsRun1 = checkpointRepo.findByRunId(run1.id);
      expect(checkpointsRun1.some((c) => c.step === 'recovery_interrupted')).toBe(true);
      expect(checkpointsRun1.some((c) => c.step === 'build_step')).toBe(true);

      // Tra cứu sâu lịch sử qua TaskHistoryService (ORC-005)
      const run1Detail = historyService.getRunDetail(run1.id);
      expect(run1Detail.run.id).toBe(run1.id);
      expect(run1Detail.result.outcome).toBe('ERROR');
      expect(run1Detail.result.success).toBe(false);
      expect(run1Detail.checkpoints.length).toBeGreaterThanOrEqual(2);
      expect(run1Detail.events.length).toBeGreaterThanOrEqual(2);

      // Giả lập lần chạy tiếp theo (Attempt 2) sau khi task đã requeue về READY
      const updatedTask = taskRepo.findById(task.id)!;
      expect(updatedTask.status).toBe('READY');

      const run2 = runRepo.create({
        id: 'run-hist-attempt-2',
        task_id: task.id,
        attempt: 2,
        status: 'SUCCESS',
        started_at: new Date('2026-10-23T08:05:00Z').toISOString(),
        finished_at: new Date('2026-10-23T08:06:00Z').toISOString(),
        exit_code: 0,
      });
      taskRepo.update(task.id, { status: 'DONE', attempts: 2 });

      // Kiểm tra lịch sử đa attempt: Cả Attempt 1 (gián đoạn) và Attempt 2 (thành công) đều hiển thị tuần tự
      const fullHistory = historyService.getTaskRunHistory(task.id);
      expect(fullHistory.taskId).toBe(task.id);
      expect(fullHistory.history.length).toBe(2);

      const histItem1 = fullHistory.history[0]!;
      expect(histItem1.attempt).toBe(1);
      expect(histItem1.run.id).toBe(run1.id);
      expect(histItem1.result.outcome).toBe('ERROR');

      const histItem2 = fullHistory.history[1]!;
      expect(histItem2.attempt).toBe(2);
      expect(histItem2.run.id).toBe(run2.id);
      expect(histItem2.result.outcome).toBe('SUCCESS');
      expect(histItem2.result.success).toBe(true);
    });
  });

  describe('4. Nghiệm thu: Không chạy trùng (Deadlock prevention & concurrency protection)', () => {
    it('Giải phóng Agent Lock và ngăn chặn trạng thái chạy trùng khi scheduler hoạt động tiếp', async () => {
      const task = createTestTask('TASK-NOCONCURRENT-1', {
        status: 'RUNNING',
        attempts: 1,
        max_attempts: 3,
      });

      const run = runRepo.create({
        id: 'run-noconcurrent-1',
        task_id: task.id,
        attempt: 1,
        status: 'RUNNING',
      });

      // Giả lập lock bị chiếm bởi session trước
      lockRepo.acquire({
        id: 'default_agent',
        task_id: task.id,
        run_id: run.id,
      });

      const executionManager = new ExecutionManager();
      const runService = new RunService({
        db,
        executionManager,
      });

      const scheduler = new TaskScheduler({
        db,
        runService,
      });

      // Khi chưa recovery: scheduler thử acquire task sẽ bị chặn do LOCK_HELD hoặc CONCURRENCY_LIMIT_EXCEEDED
      const tryAcquireBefore = scheduler.acquireNextTask();
      expect(tryAcquireBefore.acquired).toBe(false);
      expect(['LOCK_HELD', 'CONCURRENCY_LIMIT_EXCEEDED', 'ACTIVE_RUN_EXISTS']).toContain(
        tryAcquireBefore.reason,
      );

      // Kích hoạt phục hồi qua scheduler.recover()
      const recoveryResult = scheduler.recover();
      expect(recoveryResult.releasedLocks).toBe(1);
      expect(recoveryResult.recoveredTasks[0]?.newStatus).toBe('READY');

      // Sau khi recovery: lock đã giải phóng và không còn task nào ở RUNNING
      expect(lockRepo.isLocked('default_agent')).toBe(false);
      expect(db.prepare("SELECT COUNT(*) as count FROM runs WHERE status = 'RUNNING'").get()).toEqual({
        count: 0,
      });

      // Bây giờ scheduler acquireNextTask() thành công điều phối task, bảo đảm chạy đơn tiến trình
      const acquireAfter = scheduler.acquireNextTask();
      expect(acquireAfter.acquired).toBe(true);
      expect(acquireAfter.task?.id).toBe(task.id);
      expect(acquireAfter.task?.status).toBe('RUNNING');
      expect(acquireAfter.task?.attempts).toBe(2); // Attempt 2 được tăng lên an toàn
      expect(lockRepo.isLocked('default_agent')).toBe(true);

      // Kiểm tra: Không thể acquire thêm task thứ hai (Tối đa 1 coding process tại một thời điểm)
      const tryAcquireSecond = scheduler.acquireNextTask();
      expect(tryAcquireSecond.acquired).toBe(false);
      expect(['LOCK_HELD', 'CONCURRENCY_LIMIT_EXCEEDED']).toContain(tryAcquireSecond.reason);
    });
  });

  describe('5. Tự động phục hồi khi Server khởi động (autoRecoverOnStartup)', () => {
    it('buildServer tự động phát hiện và dọn dẹp các task/run treo từ phiên trước', async () => {
      const task1 = createTestTask('TASK-STARTUP-1', {
        status: 'RUNNING',
        attempts: 1,
        max_attempts: 3,
      });
      runRepo.create({
        id: 'run-startup-1',
        task_id: task1.id,
        attempt: 1,
        status: 'RUNNING',
      });
      lockRepo.acquire({
        id: 'default_agent',
        task_id: task1.id,
      });

      // Khởi động server (mặc định autoRecover = true)
      const server = await buildServer({ db, autoRecover: true });

      try {
        // Kiểm tra task1 đã tự động chuyển sang READY
        const checkedTask = taskRepo.findById(task1.id);
        expect(checkedTask?.status).toBe('READY');

        // Lock đã tự động giải phóng
        expect(lockRepo.isLocked('default_agent')).toBe(false);

        // Lịch sử audit đã ghi nhận sự kiện phục hồi server_startup
        const audits = auditRepo.findAll({ trigger: 'server_startup' });
        expect(audits.length).toBeGreaterThanOrEqual(1);
        expect(audits[0]?.recovered_tasks_count).toBe(1);
        expect(audits[0]?.cleaned_runs_count).toBe(1);
      } finally {
        await server.close();
      }
    });
  });

  describe('6. REST API Endpoints điều khiển Recovery', () => {
    it('POST /scheduler/recover & GET /scheduler/recovery/status hoạt động chuẩn xác', async () => {
      const task = createTestTask('TASK-API-REC', {
        status: 'RUNNING',
        attempts: 1,
        max_attempts: 3,
      });
      runRepo.create({
        id: 'run-api-rec',
        task_id: task.id,
        attempt: 1,
        status: 'RUNNING',
      });

      const server = await buildServer({ db, autoRecover: false });

      try {
        // 1. Kiểm tra status gián đoạn qua GET /scheduler/recovery/status
        const statusRes = await server.inject({
          method: 'GET',
          url: '/scheduler/recovery/status',
        });
        expect(statusRes.statusCode).toBe(200);
        const statusData = JSON.parse(statusRes.body).data;
        expect(statusData.needsRecovery).toBe(true);
        expect(statusData.runningTasksCount).toBe(1);

        // 2. Kích hoạt phục hồi qua POST /scheduler/recover
        const recoverRes = await server.inject({
          method: 'POST',
          url: '/scheduler/recover',
          payload: {
            trigger: 'api_manual_trigger',
            autoRequeue: true,
          },
        });
        expect(recoverRes.statusCode).toBe(200);
        const recoverData = JSON.parse(recoverRes.body).data;
        expect(recoverData.trigger).toBe('api_manual_trigger');
        expect(recoverData.recoveredTasks.length).toBe(1);
        expect(recoverData.recoveredTasks[0].action).toBe('REQUEUED');
        expect(recoverData.recoveredTasks[0].newStatus).toBe('READY');

        // 3. Kiểm tra lại status sau phục hồi qua GET /system/recovery
        const statusResAfter = await server.inject({
          method: 'GET',
          url: '/system/recovery',
        });
        expect(statusResAfter.statusCode).toBe(200);
        const statusAfter = JSON.parse(statusResAfter.body).data;
        expect(statusAfter.needsRecovery).toBe(false);
      } finally {
        await server.close();
      }
    });
  });
});
