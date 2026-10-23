import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  TaskRepository,
  RunRepository,
  EventRepository,
  AgentLockRepository,
  CheckpointRepository,
  RecoveryAuditRepository,
} from '@ai-orchestrator/db';
import {
  type TaskWithDependencies,
  type RecoveryResult,
  type RecoveryOptions,
  type RecoveryStatus,
  type RecoveredTaskItem,
  type CleanedRunItem,
  RecoveryOptionsSchema,
  RetryPolicy,
  logger,
} from '@ai-orchestrator/shared';
import { TaskStateService } from './task-state-service.js';
import type { ResourceQuotaManager } from './resource-quota-manager.js';

export interface RecoveryServiceOptions {
  db: Database.Database;
  taskRepo?: TaskRepository;
  runRepo?: RunRepository;
  lockRepo?: AgentLockRepository;
  eventRepo?: EventRepository;
  checkpointRepo?: CheckpointRepository;
  auditRepo?: RecoveryAuditRepository;
  stateService?: TaskStateService;
  retryPolicy?: RetryPolicy;
  resourceQuotaManager?: ResourceQuotaManager;
}

/**
 * Service phục hồi hệ thống sau crash / restart (OPS-003).
 *
 * Chức năng cốt lõi:
 * 1. Phát hiện các task đang ở trạng thái RUNNING (hoặc VERIFYING) bị ngắt giữa chừng do hệ thống tắt đột ngột.
 * 2. Kiểm tra điều kiện: attempts vs max_attempts.
 *    - Nếu attempts < max_attempts và autoRequeue: chuyển task sang FAILED rồi sang READY (requeue).
 *    - Nếu attempts >= max_attempts: chuyển task sang FAILED (fail dứt điểm, chống vòng lặp vô hạn).
 * 3. Dọn dẹp run bị treo: cập nhật status ERROR, ghi nhận finished_at, checkpoint và event gián đoạn.
 *    Bảo toàn toàn bộ lịch sử chạy ("Không mất lịch sử").
 * 4. Giải phóng agent lock và slot tài nguyên, bảo đảm khi scheduler khởi động lại sẽ không xảy ra deadlock
 *    hay thực thi song song trùng lặp ("Không chạy trùng").
 */
export class RecoveryService {
  private readonly db: Database.Database;
  private readonly taskRepo: TaskRepository;
  private readonly runRepo: RunRepository;
  private readonly lockRepo: AgentLockRepository;
  private readonly eventRepo: EventRepository;
  private readonly checkpointRepo: CheckpointRepository;
  private readonly auditRepo: RecoveryAuditRepository;
  private readonly stateService: TaskStateService;
  private readonly retryPolicy: RetryPolicy;
  private readonly resourceQuotaManager?: ResourceQuotaManager;

  constructor(options: RecoveryServiceOptions) {
    this.db = options.db;
    this.taskRepo = options.taskRepo ?? new TaskRepository(this.db);
    this.runRepo = options.runRepo ?? new RunRepository(this.db);
    this.lockRepo = options.lockRepo ?? new AgentLockRepository(this.db);
    this.eventRepo = options.eventRepo ?? new EventRepository(this.db);
    this.checkpointRepo = options.checkpointRepo ?? new CheckpointRepository(this.db);
    this.auditRepo = options.auditRepo ?? new RecoveryAuditRepository(this.db);
    this.stateService = options.stateService ?? new TaskStateService(this.db);
    this.retryPolicy = options.retryPolicy ?? new RetryPolicy();
    this.resourceQuotaManager = options.resourceQuotaManager;
  }

  /**
   * Kiểm tra nhanh trạng thái gián đoạn mà không làm biến đổi dữ liệu (read-only check).
   */
  checkInterrupted(): RecoveryStatus {
    const runningTasks = this.taskRepo.findAll({ status: 'RUNNING' });
    const verifyingTasks = this.taskRepo.findAll({ status: 'VERIFYING' });
    const allInterruptedTasks = [...runningTasks, ...verifyingTasks];

    const activeRuns = this.runRepo.findAll({ status: 'RUNNING' });
    const pendingRuns = this.runRepo.findAll({ status: 'PENDING' });
    const allActiveRuns = [...activeRuns, ...pendingRuns];

    const heldLocks = this.lockRepo.findAll();

    const needsRecovery =
      allInterruptedTasks.length > 0 || allActiveRuns.length > 0 || heldLocks.length > 0;

    return {
      needsRecovery,
      runningTasksCount: allInterruptedTasks.length,
      activeRunsCount: allActiveRuns.length,
      heldLocksCount: heldLocks.length,
      runningTaskIds: allInterruptedTasks.map((t) => t.id),
      activeRunIds: allActiveRuns.map((r) => r.id),
      heldLockIds: heldLocks.map((l) => l.id),
    };
  }

  /**
   * Thực hiện phục hồi toàn diện sau restart / crash.
   * Toàn bộ tiến trình được bọc trong SQLite transaction đồng bộ, bảo đảm tính nguyên tử (atomicity).
   */
  recover(options?: RecoveryOptions): RecoveryResult {
    const opts = RecoveryOptionsSchema.parse(options ?? {});
    const recoveryId = crypto.randomUUID();
    const now = new Date().toISOString();

    const recoveryTx = this.db.transaction(() => {
      let releasedLocks = 0;

      // 1. Release Agent Lock(s)
      if (opts.releaseAllLocks) {
        const heldLocks = this.lockRepo.findAll();
        for (const lock of heldLocks) {
          this.lockRepo.forceRelease(lock.id);
          releasedLocks++;
        }
      } else {
        const released = this.lockRepo.release(opts.lockId);
        if (released) releasedLocks++;
      }

      // 2. Clean up dangling runs (RUNNING or PENDING)
      const cleanedRuns: CleanedRunItem[] = [];
      const danglingRuns = this.runRepo
        .findAll()
        .filter((r) => r.status === 'RUNNING' || r.status === 'PENDING');

      for (const run of danglingRuns) {
        const previousStatus = run.status;
        this.runRepo.updateStatus(run.id, 'ERROR', {
          exit_code: 1,
          finished_at: now,
        });

        // Record interruption event in events table
        try {
          this.eventRepo.create({
            run_id: run.id,
            type: 'run_interrupted',
            payload: {
              reason: 'Run interrupted by system restart/crash recovery',
              recoveryId,
              taskId: run.task_id,
              previousStatus,
              interrupted_at: now,
            },
          });
        } catch (err) {
          logger.warn(`Failed to record run_interrupted event for run '${run.id}'`, { error: err });
        }

        // Record checkpoint in checkpoints table
        try {
          this.checkpointRepo.create({
            task_id: run.task_id,
            run_id: run.id,
            attempt: run.attempt,
            step: 'recovery_interrupted',
            status: 'FAILED',
            data: {
              recoveryId,
              message: 'Execution interrupted by system restart',
              previousStatus,
              trigger: opts.trigger,
            },
          });
        } catch (err) {
          logger.warn(`Failed to record recovery checkpoint for run '${run.id}'`, { error: err });
        }

        cleanedRuns.push({
          runId: run.id,
          taskId: run.task_id,
          previousStatus,
          newStatus: 'ERROR',
          pid: run.pid,
          reason: 'Interrupted by server restart/crash',
        });
      }

      // 3. Scan and recover interrupted tasks (RUNNING or VERIFYING)
      const recoveredTasks: RecoveredTaskItem[] = [];
      const interruptedTasks: TaskWithDependencies[] = [
        ...this.taskRepo.findAll({ status: 'RUNNING' }),
        ...this.taskRepo.findAll({ status: 'VERIFYING' }),
      ];

      for (const task of interruptedTasks) {
        const previousStatus = task.status;
        const matchingRun = danglingRuns.find((r) => r.task_id === task.id);

        const canRequeue =
          opts.autoRequeue && !opts.forceFailAll && task.attempts < task.max_attempts;

        if (canRequeue) {
          // Requeue: RUNNING/VERIFYING -> FAILED -> READY
          this.stateService.transition(task.id, 'FAILED', {
            reason: `Interrupted by system restart (${opts.trigger})`,
            runId: matchingRun?.id,
          });

          const requeueReason = `Requeued for execution after restart recovery (attempt ${task.attempts + 1} of ${task.max_attempts})`;
          this.stateService.transition(task.id, 'READY', {
            reason: requeueReason,
            runId: matchingRun?.id,
          });

          // Checkpoint for task requeue
          try {
            this.checkpointRepo.create({
              task_id: task.id,
              run_id: matchingRun?.id ?? undefined,
              attempt: task.attempts,
              step: 'recovery_requeued',
              status: 'COMPLETED',
              data: {
                recoveryId,
                trigger: opts.trigger,
                attempts: task.attempts,
                maxAttempts: task.max_attempts,
                message: requeueReason,
              },
            });
          } catch (err) {
            logger.warn(`Failed to record recovery_requeued checkpoint for task '${task.id}'`, {
              error: err,
            });
          }

          recoveredTasks.push({
            taskId: task.id,
            previousStatus,
            newStatus: 'READY',
            action: 'REQUEUED',
            attempts: task.attempts,
            maxAttempts: task.max_attempts,
            runId: matchingRun?.id ?? null,
            reason: requeueReason,
          });
        } else {
          // Fail: transition to FAILED
          const failReason =
            task.attempts >= task.max_attempts
              ? `Interrupted by system restart; maximum attempts reached (${task.attempts}/${task.max_attempts})`
              : `Interrupted by system restart; marked FAILED by recovery policy`;

          this.stateService.transition(task.id, 'FAILED', {
            reason: failReason,
            runId: matchingRun?.id,
          });

          // Checkpoint for task failure
          try {
            this.checkpointRepo.create({
              task_id: task.id,
              run_id: matchingRun?.id ?? undefined,
              attempt: task.attempts,
              step: 'recovery_failed',
              status: 'FAILED',
              data: {
                recoveryId,
                trigger: opts.trigger,
                attempts: task.attempts,
                maxAttempts: task.max_attempts,
                message: failReason,
              },
            });
          } catch (err) {
            logger.warn(`Failed to record recovery_failed checkpoint for task '${task.id}'`, {
              error: err,
            });
          }

          recoveredTasks.push({
            taskId: task.id,
            previousStatus,
            newStatus: 'FAILED',
            action: 'FAILED',
            attempts: task.attempts,
            maxAttempts: task.max_attempts,
            runId: matchingRun?.id ?? null,
            reason: failReason,
          });
        }
      }

      // 4. Reset Resource Quota Manager slots if active and items were recovered
      if (
        this.resourceQuotaManager &&
        (recoveredTasks.length > 0 || cleanedRuns.length > 0 || releasedLocks > 0)
      ) {
        try {
          this.resourceQuotaManager.resetQuota();
        } catch (err) {
          logger.warn('Failed to reset resource quota manager during recovery', { error: err });
        }
      }

      // 5. Record audit entry
      if (opts.recordAudit) {
        try {
          this.auditRepo.create({
            id: recoveryId,
            trigger: opts.trigger,
            recovered_tasks_count: recoveredTasks.length,
            cleaned_runs_count: cleanedRuns.length,
            released_locks_count: releasedLocks,
            details: {
              recoveredTasks,
              cleanedRuns,
            },
            created_at: now,
          });
        } catch (err) {
          logger.warn('Failed to save recovery audit record', { error: err });
        }
      }

      return {
        recoveryId,
        trigger: opts.trigger,
        recoveredTasks,
        cleanedRuns,
        releasedLocks,
        timestamp: now,
      };
    });

    const result = recoveryTx.immediate();

    logger.info(`Restart recovery completed: ${result.recoveredTasks.length} task(s) processed`, {
      recoveryId: result.recoveryId,
      trigger: result.trigger,
      recoveredCount: result.recoveredTasks.length,
      cleanedRunsCount: result.cleanedRuns.length,
      releasedLocks: result.releasedLocks,
    });

    return result;
  }
}
