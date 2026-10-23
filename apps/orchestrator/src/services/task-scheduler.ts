import type Database from 'better-sqlite3';
import { TaskRepository, AgentLockRepository, RunRepository, CheckpointRepository } from '@ai-orchestrator/db';
import {
  type TaskWithDependencies,
  type AgentLock,
  type SchedulerStatus,
  type ScheduleNextOptions,
  type ScheduleStepResult,
  RetryPolicy,
  type RetryPolicyInput,
  logger,
} from '@ai-orchestrator/shared';
import { TaskStateService } from './task-state-service.js';
import type { RunService } from './run-service.js';

export const DEFAULT_AGENT_LOCK_ID = 'default_agent';

export interface AcquireTaskOptions {
  workerType?: string;
  featureId?: string;
  planId?: string;
  phase?: string;
  lockId?: string;
}

export interface AcquireTaskResult {
  acquired: boolean;
  task?: TaskWithDependencies;
  lock?: AgentLock;
  reason?: 'LOCK_HELD' | 'NO_READY_TASKS' | 'CONCURRENCY_LIMIT_EXCEEDED' | 'ACTIVE_RUN_EXISTS';
  activeTaskId?: string;
}

export interface TaskSchedulerOptions {
  db: Database.Database;
  runService: RunService;
  lockId?: string;
  autoVerify?: boolean;
  retryPolicy?: RetryPolicy | RetryPolicyInput;
  autoRetry?: boolean;
}

export class TaskScheduler {
  private readonly db: Database.Database;
  private readonly taskRepo: TaskRepository;
  private readonly lockRepo: AgentLockRepository;
  private readonly runRepo: RunRepository;
  private readonly checkpointRepo: CheckpointRepository;
  private readonly stateService: TaskStateService;
  private readonly runService: RunService;
  private readonly lockId: string;
  private readonly autoVerifyDefault: boolean;
  private readonly retryPolicy: RetryPolicy;
  private readonly autoRetryDefault: boolean;

  private _isRunning = false;
  private _isPaused = false;
  private _isStopped = false;
  private _activeTaskId: string | null = null;
  private _activeRunId: string | null = null;

  constructor(options: TaskSchedulerOptions) {
    this.db = options.db;
    this.runService = options.runService;
    this.taskRepo = new TaskRepository(this.db);
    this.lockRepo = new AgentLockRepository(this.db);
    this.runRepo = new RunRepository(this.db);
    this.checkpointRepo = new CheckpointRepository(this.db);
    this.stateService = new TaskStateService(this.db);
    this.lockId = options.lockId ?? DEFAULT_AGENT_LOCK_ID;
    this.autoVerifyDefault = options.autoVerify ?? true;
    this.retryPolicy =
      options.retryPolicy instanceof RetryPolicy
        ? options.retryPolicy
        : new RetryPolicy(options.retryPolicy);
    this.autoRetryDefault = options.autoRetry ?? true;
  }

  get retry(): RetryPolicy {
    return this.retryPolicy;
  }

  get isRunning(): boolean {
    return this._isRunning || Boolean(this._activeTaskId);
  }

  get isPaused(): boolean {
    return this._isPaused;
  }

  get activeTaskId(): string | null {
    return this._activeTaskId;
  }

  get activeRunId(): string | null {
    return this._activeRunId;
  }

  /**
   * Atomically acquires the next ready task and secures the 1-agent lock
   * inside an SQLite immediate transaction.
   * If any task or run is active, or if lock is held, returns acquired: false.
   */
  acquireNextTask(options?: AcquireTaskOptions): AcquireTaskResult {
    const lockId = options?.lockId ?? this.lockId;

    const acquireTx = this.db.transaction(() => {
      // 1. Check if agent lock is already held
      const currentLock = this.lockRepo.getCurrentLock(lockId);
      if (currentLock) {
        const lockedTask = this.taskRepo.findById(currentLock.task_id);
        if (lockedTask && (lockedTask.status === 'RUNNING' || lockedTask.status === 'VERIFYING')) {
          return {
            acquired: false,
            reason: 'LOCK_HELD' as const,
            activeTaskId: currentLock.task_id,
          };
        }
        // Stale lock: previous process finished without releasing
        this.lockRepo.release(lockId);
      }

      // 2. Check if any task in database is in active execution
      const runningTasks = this.taskRepo.findAll({ status: 'RUNNING' });
      const verifyingTasks = this.taskRepo.findAll({ status: 'VERIFYING' });
      if (runningTasks.length > 0 || verifyingTasks.length > 0) {
        const active = runningTasks[0] ?? verifyingTasks[0];
        return {
          acquired: false,
          reason: 'CONCURRENCY_LIMIT_EXCEEDED' as const,
          activeTaskId: active?.id,
        };
      }

      // 3. Check if any run in database has status RUNNING
      const activeRuns = this.runRepo.findAll({ status: 'RUNNING' });
      if (activeRuns.length > 0) {
        return {
          acquired: false,
          reason: 'ACTIVE_RUN_EXISTS' as const,
          activeTaskId: activeRuns[0]?.task_id,
        };
      }

      // 4. Resolve candidate ready tasks (dependencies fully satisfied)
      const candidateStatuses: ['READY', 'TODO'] = ['READY', 'TODO'];
      const readyTasks = this.taskRepo.findReadyTasks(
        {
          feature_id: options?.featureId,
          plan_id: options?.planId,
          phase: options?.phase,
        },
        {
          candidateStatuses,
          limit: 1,
        },
      );

      const candidate = readyTasks[0];
      if (!candidate) {
        return {
          acquired: false,
          reason: 'NO_READY_TASKS' as const,
        };
      }

      // 5. Atomically transition task to RUNNING and increment attempt
      let runningTask: TaskWithDependencies;
      if (candidate.status === 'TODO') {
        // First transition to READY, then RUNNING
        this.taskRepo.transitionStatus(candidate.id, 'READY', {
          reason: 'Dependencies satisfied before scheduler run',
        });
        runningTask = this.taskRepo.transitionStatus(candidate.id, 'RUNNING', {
          incrementAttempt: true,
          reason: 'Scheduler acquired task for execution',
        });
      } else {
        runningTask = this.taskRepo.transitionStatus(candidate.id, 'RUNNING', {
          incrementAttempt: true,
          reason: 'Scheduler acquired task for execution',
        });
      }

      // 6. Atomically insert lock into agent_locks
      const lock = this.lockRepo.acquire({
        id: lockId,
        task_id: runningTask.id,
        owner_pid: process.pid,
      });

      return {
        acquired: true,
        task: runningTask,
        lock,
      };
    });

    return acquireTx.immediate();
  }

  /**
   * Executes a single step: acquires the next ready task, executes the worker,
   * supervises lifecycle to completion, updates task state machine, and releases lock.
   */
  async step(options?: ScheduleNextOptions): Promise<ScheduleStepResult> {
    if (this._isPaused) {
      return {
        executed: false,
        reason: 'SCHEDULER_PAUSED',
      };
    }

    const acquireResult = this.acquireNextTask({
      featureId: options?.featureId,
      planId: options?.planId,
      phase: options?.phase,
      workerType: options?.workerType,
      lockId: options?.lockId,
    });

    if (!acquireResult.acquired || !acquireResult.task) {
      return {
        executed: false,
        reason: acquireResult.reason,
        activeTaskId: acquireResult.activeTaskId,
      };
    }

    const task = acquireResult.task;
    this._activeTaskId = task.id;

    logger.info(`Scheduler executing task '${task.id}'`, {
      taskId: task.id,
      priority: task.priority,
      attempts: task.attempts,
    });

    try {
      // Start run via RunService
      const { run, execution } = await this.runService.startRun({
        taskId: task.id,
        timeoutMs: options?.timeoutMs,
        skipLockCheck: true, // Task lock already secured above
      });

      this._activeRunId = run.id;
      this.lockRepo.updateRunId(this.lockId, run.id);

      // Record start checkpoint
      try {
        this.checkpointRepo.create({
          task_id: task.id,
          run_id: run.id,
          attempt: run.attempt,
          step: 'run_started',
          status: 'IN_PROGRESS',
          data: { started_at: run.started_at, workerType: task.worker_type },
        });
      } catch {
        // Non-critical checkpoint failure
      }

      // Wait for process completion
      await execution.waitForCompletion();

      // Retrieve final run status from DB
      const finishedRun = this.runRepo.getById(run.id);
      const runStatus = finishedRun?.status ?? 'ERROR';

      // Update task state according to ORC-001 state machine
      if (runStatus === 'SUCCESS') {
        this.stateService.markVerifying(task.id, {
          reason: 'Process completed with exit code 0, verifying results',
          runId: run.id,
        });
        const autoVerify = options?.autoVerify ?? this.autoVerifyDefault;
        if (autoVerify) {
          this.stateService.markDone(task.id, {
            reason: 'Acceptance criteria and tests passed',
            runId: run.id,
          });
        }
        try {
          this.checkpointRepo.create({
            task_id: task.id,
            run_id: run.id,
            attempt: run.attempt,
            step: 'run_completed',
            status: 'COMPLETED',
            data: { exit_code: finishedRun?.exit_code, autoVerify },
          });
        } catch {
          // Non-critical
        }
      } else if (runStatus === 'CANCELLED') {
        this.stateService.cancel(task.id, {
          reason: 'Execution was cancelled or stopped',
          runId: run.id,
        });
        try {
          this.checkpointRepo.create({
            task_id: task.id,
            run_id: run.id,
            attempt: run.attempt,
            step: 'run_cancelled',
            status: 'FAILED',
            data: { reason: 'Execution was cancelled or stopped' },
          });
        } catch {
          // Non-critical
        }
        const finalTask = this.taskRepo.findById(task.id);
        return {
          executed: true,
          taskId: task.id,
          runId: run.id,
          status: finalTask?.status ?? runStatus,
        };
      } else {
        const failureReason =
          runStatus === 'TIMEOUT'
            ? 'Execution timed out'
            : `Process execution failed with status '${runStatus}'`;
        this.stateService.markFailed(task.id, {
          reason: failureReason,
          runId: run.id,
        });
        try {
          this.checkpointRepo.create({
            task_id: task.id,
            run_id: run.id,
            attempt: run.attempt,
            step: 'run_failed',
            status: 'FAILED',
            data: { failureReason, runStatus, exit_code: finishedRun?.exit_code },
          });
        } catch {
          // Non-critical
        }

        // ORC-004: Retry policy evaluation & backoff
        const failedTask = this.taskRepo.findById(task.id);
        const autoRetry = options?.autoRetry ?? this.autoRetryDefault;

        if (failedTask && autoRetry) {
          const decision = this.retryPolicy.evaluate(failedTask);
          if (decision.shouldRetry) {
            // Task has remaining attempts: queue for retry after backoff
            this.stateService.markReady(
              task.id,
              `Retry attempt ${failedTask.attempts + 1} of ${failedTask.max_attempts}: ${failureReason}. Backoff delay: ${decision.delayMs}ms`,
            );

            // Apply wait if requested
            if (options?.waitBackoff && decision.delayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, decision.delayMs));
            }

            return {
              executed: true,
              taskId: task.id,
              runId: run.id,
              status: 'RETRYING',
              retried: true,
              delayMs: decision.delayMs,
              nextRetryAt: decision.nextRetryAt,
              reason: `Task failed and queued for retry (${failedTask.attempts}/${failedTask.max_attempts})`,
            };
          } else {
            // Reached max_attempts: stays FAILED, halting retries (KHÔNG RETRY VÔ HẠN)
            logger.warn(
              `Task '${task.id}' reached max_attempts (${failedTask.attempts}/${failedTask.max_attempts}), halting retries`,
              {
                taskId: task.id,
                attempts: failedTask.attempts,
                maxAttempts: failedTask.max_attempts,
              },
            );

            return {
              executed: true,
              taskId: task.id,
              runId: run.id,
              status: 'FAILED',
              retried: false,
              reason: 'MAX_ATTEMPTS_EXCEEDED',
            };
          }
        }

        const finalTask = this.taskRepo.findById(task.id);
        return {
          executed: true,
          taskId: task.id,
          runId: run.id,
          status: finalTask?.status ?? runStatus,
          retried: false,
          reason: failureReason,
        };
      }

      const finalTask = this.taskRepo.findById(task.id);
      return {
        executed: true,
        taskId: task.id,
        runId: run.id,
        status: finalTask?.status ?? runStatus,
      };
    } catch (error) {
      // Handle unexpected worker failure
      logger.error(`Scheduler execution failed for task '${task.id}'`, {
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });

      const errMessage = error instanceof Error ? error.message : 'Unexpected scheduler error';
      try {
        this.stateService.markFailed(task.id, {
          reason: errMessage,
          runId: this._activeRunId ?? undefined,
        });
      } catch {
        // Fallback status update
      }

      const failedTask = this.taskRepo.findById(task.id);
      const autoRetry = options?.autoRetry ?? this.autoRetryDefault;

      if (failedTask && autoRetry) {
        const decision = this.retryPolicy.evaluate(failedTask);
        if (decision.shouldRetry) {
          try {
            this.stateService.markReady(
              task.id,
              `Retry attempt ${failedTask.attempts + 1} of ${failedTask.max_attempts} after unexpected error: ${errMessage}`,
            );
            return {
              executed: true,
              taskId: task.id,
              runId: this._activeRunId ?? undefined,
              status: 'RETRYING',
              retried: true,
              delayMs: decision.delayMs,
              nextRetryAt: decision.nextRetryAt,
              reason: errMessage,
            };
          } catch {
            // Fallback
          }
        }
      }

      return {
        executed: true,
        taskId: task.id,
        runId: this._activeRunId ?? undefined,
        status: 'FAILED',
        retried: false,
        reason: errMessage,
      };
    } finally {
      // Release lock unconditionally
      this.lockRepo.release(this.lockId, task.id);
      this._activeTaskId = null;
      this._activeRunId = null;
    }
  }

  /**
   * Sequentially runs all ready tasks one after another until no more tasks
   * are ready or the scheduler is stopped/paused.
   */
  async runUntilEmpty(options?: ScheduleNextOptions): Promise<ScheduleStepResult[]> {
    const results: ScheduleStepResult[] = [];
    this._isRunning = true;
    this._isStopped = false;

    try {
      while (!this._isStopped && !this._isPaused) {
        const res = await this.step(options);
        if (!res.executed) {
          break;
        }
        results.push(res);
      }
    } finally {
      this._isRunning = false;
    }

    return results;
  }

  /**
   * Pauses the sequential scheduler loop.
   */
  pause(): void {
    this._isPaused = true;
    logger.info('Scheduler paused');
  }

  /**
   * Resumes the sequential scheduler loop.
   */
  resume(): void {
    this._isPaused = false;
    logger.info('Scheduler resumed');
  }

  /**
   * Stops the scheduler and optionally stops the active run.
   */
  async stop(cancelActive = true): Promise<void> {
    this._isStopped = true;
    this._isRunning = false;

    if (cancelActive && this._activeRunId) {
      try {
        await this.runService.stopRun(this._activeRunId, {
          reason: 'Scheduler stopped by operator',
        });
      } catch {
        // Ignore stop errors if process already exited
      }
    }

    logger.info('Scheduler stopped');
  }

  /**
   * Retrieves real-time status of the scheduler.
   */
  getStatus(): SchedulerStatus {
    const currentLock = this.lockRepo.getCurrentLock(this.lockId);
    const readyTasks = this.taskRepo.findReadyTasks(undefined, {
      candidateStatuses: ['READY', 'TODO'],
    });

    return {
      isRunning: this.isRunning,
      isPaused: this._isPaused,
      activeLock: currentLock,
      activeTaskId: this._activeTaskId ?? currentLock?.task_id ?? null,
      activeRunId: this._activeRunId ?? currentLock?.run_id ?? null,
      readyTasksCount: readyTasks.length,
    };
  }

  /**
   * Force releases lock if orphaned.
   */
  releaseLock(): void {
    this.lockRepo.forceRelease(this.lockId);
    this._activeTaskId = null;
    this._activeRunId = null;
    logger.info(`Scheduler lock '${this.lockId}' force-released`);
  }
}
