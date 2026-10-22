import type Database from 'better-sqlite3';
import {
  TaskRepository,
  EventRepository,
} from '@ai-orchestrator/db';
import {
  AppError,
  type TaskWithDependencies,
  type TaskStatus,
  assertValidTaskTransition,
  isValidTaskTransition,
  getAllowedTaskTransitions,
  logger as defaultLogger,
  type Logger,
} from '@ai-orchestrator/shared';

export interface TransitionTaskOptions {
  reason?: string;
  runId?: string;
  incrementAttempt?: boolean;
  force?: boolean;
  meta?: Record<string, unknown>;
}

export class TaskStateService {
  private readonly taskRepo: TaskRepository;
  private readonly eventRepo: EventRepository;
  private readonly logger: Logger;

  constructor(
    private readonly db: Database.Database,
    options?: { logger?: Logger },
  ) {
    this.taskRepo = new TaskRepository(db);
    this.eventRepo = new EventRepository(db);
    this.logger = options?.logger ?? defaultLogger;
  }

  /**
   * Lấy trạng thái hiện tại của task.
   */
  getStatus(taskId: string): TaskStatus {
    const task = this.taskRepo.findById(taskId);
    if (!task) {
      throw new AppError('TASK_NOT_FOUND', `Task with id '${taskId}' not found`, { taskId });
    }
    return task.status;
  }

  /**
   * Kiểm tra khả năng chuyển đổi trạng thái của một task trong DB.
   */
  canTransition(taskId: string, targetStatus: TaskStatus): boolean {
    const current = this.getStatus(taskId);
    return isValidTaskTransition(current, targetStatus);
  }

  /**
   * Lấy danh sách các trạng thái hợp lệ kế tiếp cho task.
   */
  getAllowedTransitions(taskId: string): readonly TaskStatus[] {
    const current = this.getStatus(taskId);
    return getAllowedTaskTransitions(current);
  }

  /**
   * Chuyển đổi trạng thái task tuân thủ nghiêm ngặt State Machine (ORC-001).
   * Bất kỳ chuyển đổi trái phép nào đều ném AppError('ILLEGAL_STATE_TRANSITION', ...).
   */
  transition(
    taskId: string,
    targetStatus: TaskStatus,
    options?: TransitionTaskOptions,
  ): TaskWithDependencies {
    const existing = this.taskRepo.findById(taskId);
    if (!existing) {
      throw new AppError('TASK_NOT_FOUND', `Task with id '${taskId}' not found`, { taskId });
    }

    const from = existing.status;

    // Kiểm tra tính hợp lệ của chuyển đổi
    if (!options?.force) {
      assertValidTaskTransition(from, targetStatus, {
        taskId,
        reason: options?.reason,
      });
    }

    // Thực hiện chuyển đổi trong repository
    const updated = this.taskRepo.transitionStatus(taskId, targetStatus, {
      incrementAttempt: options?.incrementAttempt,
      force: options?.force,
      reason: options?.reason,
    });

    // Ghi event vào bảng events nếu có runId hoặc ghi audit log
    if (options?.runId) {
      try {
        this.eventRepo.create({
          run_id: options.runId,
          type: 'task_transition',
          payload: {
            taskId,
            from,
            to: targetStatus,
            reason: options?.reason,
            meta: options?.meta,
          },
        });
      } catch (err) {
        this.logger.warn('Failed to record task_transition event in events table', {
          taskId,
          runId: options.runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.logger.info(`Task '${taskId}' transitioned from ${from} to ${targetStatus}`, {
      taskId,
      from,
      to: targetStatus,
      reason: options?.reason,
      attempts: updated.attempts,
    });

    return updated;
  }

  markReady(taskId: string, reason?: string): TaskWithDependencies {
    return this.transition(taskId, 'READY', { reason: reason ?? 'All dependencies satisfied' });
  }

  markRunning(
    taskId: string,
    options?: { reason?: string; incrementAttempt?: boolean; runId?: string },
  ): TaskWithDependencies {
    return this.transition(taskId, 'RUNNING', {
      reason: options?.reason ?? 'Worker execution started',
      incrementAttempt: options?.incrementAttempt ?? true,
      runId: options?.runId,
    });
  }

  markVerifying(
    taskId: string,
    options?: { reason?: string; runId?: string },
  ): TaskWithDependencies {
    return this.transition(taskId, 'VERIFYING', {
      reason: options?.reason ?? 'Execution completed, starting verification',
      runId: options?.runId,
    });
  }

  markDone(
    taskId: string,
    options?: { reason?: string; runId?: string },
  ): TaskWithDependencies {
    return this.transition(taskId, 'DONE', {
      reason: options?.reason ?? 'Acceptance criteria and tests passed',
      runId: options?.runId,
    });
  }

  markFailed(
    taskId: string,
    options?: { reason?: string; runId?: string },
  ): TaskWithDependencies {
    return this.transition(taskId, 'FAILED', {
      reason: options?.reason ?? 'Execution or verification failed',
      runId: options?.runId,
    });
  }

  markBlocked(taskId: string, reason?: string): TaskWithDependencies {
    return this.transition(taskId, 'BLOCKED', {
      reason: reason ?? 'Task dependencies or resources blocked',
    });
  }

  pause(taskId: string, reason?: string): TaskWithDependencies {
    return this.transition(taskId, 'PAUSED', {
      reason: reason ?? 'Task paused by operator',
    });
  }

  resume(taskId: string, reason?: string): TaskWithDependencies {
    const current = this.getStatus(taskId);
    if (current !== 'PAUSED') {
      throw new AppError('ILLEGAL_STATE_TRANSITION', `Cannot resume task '${taskId}': current status is '${current}', not 'PAUSED'`, {
        taskId,
        currentStatus: current,
      });
    }
    // Mặc định resume đưa về READY để scheduler điều phối an toàn
    return this.transition(taskId, 'READY', {
      reason: reason ?? 'Task resumed from pause',
    });
  }

  cancel(
    taskId: string,
    reasonOrOptions?: string | { reason?: string; runId?: string },
  ): TaskWithDependencies {
    const opts =
      typeof reasonOrOptions === 'string' ? { reason: reasonOrOptions } : reasonOrOptions;
    return this.transition(taskId, 'CANCELLED', {
      reason: opts?.reason ?? 'Task cancelled',
      runId: opts?.runId,
    });
  }
}
