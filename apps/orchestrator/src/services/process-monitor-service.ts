import type Database from 'better-sqlite3';
import {
  AppError,
  evaluateProcessLiveness,
  isProcessAlive,
  type ProcessLivenessState,
  type ProcessScanOptions,
  type ProcessScanSummary,
  type ProcessStateInspection,
  type Run,
  logger,
} from '@ai-orchestrator/shared';
import {
  AgentLockRepository,
  CheckpointRepository,
  EventRepository,
  RunRepository,
  TaskRepository,
} from '@ai-orchestrator/db';
import { ExecutionManager, defaultExecutionManager } from '../adapters/execution-manager.js';
import { TaskStateService } from './task-state-service.js';
import type { ResourceQuotaManager } from './resource-quota-manager.js';

export interface ProcessMonitorServiceOptions {
  db: Database.Database;
  runRepo?: RunRepository;
  taskRepo?: TaskRepository;
  lockRepo?: AgentLockRepository;
  checkpointRepo?: CheckpointRepository;
  eventRepo?: EventRepository;
  executionManager?: ExecutionManager;
  stateService?: TaskStateService;
  resourceQuotaManager?: ResourceQuotaManager;
  defaultHeartbeatTimeoutMs?: number;
}

export class ProcessMonitorService {
  private readonly db: Database.Database;
  private readonly runRepo: RunRepository;
  private readonly taskRepo: TaskRepository;
  private readonly lockRepo: AgentLockRepository;
  private readonly checkpointRepo: CheckpointRepository;
  private readonly eventRepo: EventRepository;
  private readonly executionManager: ExecutionManager;
  private readonly stateService: TaskStateService;
  private readonly resourceQuotaManager?: ResourceQuotaManager;
  private readonly defaultHeartbeatTimeoutMs: number;

  private _watchdogTimer: NodeJS.Timeout | null = null;
  private _isWatchdogScanning = false;

  constructor(options: ProcessMonitorServiceOptions) {
    this.db = options.db;
    this.runRepo = options.runRepo ?? new RunRepository(this.db);
    this.taskRepo = options.taskRepo ?? new TaskRepository(this.db);
    this.lockRepo = options.lockRepo ?? new AgentLockRepository(this.db);
    this.checkpointRepo = options.checkpointRepo ?? new CheckpointRepository(this.db);
    this.eventRepo = options.eventRepo ?? new EventRepository(this.db);
    this.executionManager = options.executionManager ?? defaultExecutionManager;
    this.stateService = options.stateService ?? new TaskStateService(this.db);
    this.resourceQuotaManager = options.resourceQuotaManager;
    this.defaultHeartbeatTimeoutMs = options.defaultHeartbeatTimeoutMs ?? 30_000;
  }

  /**
   * Checks whether an OS PID is alive.
   */
  checkPid(pid: number): { pid: number; isAlive: boolean } {
    return {
      pid,
      isAlive: isProcessAlive(pid),
    };
  }

  /**
   * Inspects a specific run by ID and returns its diagnostic liveness state.
   * Strictly distinguishes between:
   * - FINISHED (Xong): clean exit with finished_at or terminal status
   * - DEAD (Chết): marked active in DB but PID is missing from OS
   * - ALIVE: active in OS with fresh heartbeat
   * - UNRESPONSIVE: active in OS but heartbeat timed out
   */
  inspectRun(
    runId: string,
    options?: { heartbeatTimeoutMs?: number; now?: number },
  ): ProcessStateInspection {
    const run = this.runRepo.getById(runId);
    if (!run) {
      throw new AppError('RUN_NOT_FOUND', `Run with id '${runId}' not found`, { runId });
    }

    const heartbeatTimeoutMs = options?.heartbeatTimeoutMs ?? this.defaultHeartbeatTimeoutMs;
    const managed = this.executionManager.get(runId);

    // If managed in memory, merge freshest heartbeat and pid if DB is slightly behind
    const effectiveRun = {
      ...run,
      pid: managed?.handle.pid ?? run.pid,
      last_heartbeat_at:
        managed?.lastHeartbeatAt?.toISOString() ?? run.last_heartbeat_at ?? null,
    };

    return evaluateProcessLiveness({
      run: effectiveRun,
      isHandleRunning: managed?.isRunning(),
      heartbeatTimeoutMs,
      now: options?.now,
    });
  }

  /**
   * Records / touches a heartbeat for an active run.
   */
  recordHeartbeat(
    runId: string,
    timestamp?: string | Date,
  ): { success: boolean; lastHeartbeatAt: string } {
    const run = this.runRepo.getById(runId);
    if (!run) {
      throw new AppError('RUN_NOT_FOUND', `Run with id '${runId}' not found`, { runId });
    }

    const dateObj =
      timestamp instanceof Date
        ? timestamp
        : typeof timestamp === 'string'
          ? new Date(timestamp)
          : new Date();
    const isoString = dateObj.toISOString();

    // 1. Update in-memory execution manager if present
    this.executionManager.recordHeartbeat(runId, dateObj);

    // 2. Persist in database
    this.runRepo.updateHeartbeat(runId, isoString);

    // 3. Record event in SQLite events table
    try {
      const nextSeq = this.eventRepo.getNextSeq(runId);
      this.eventRepo.create({
        run_id: runId,
        seq: nextSeq,
        type: 'heartbeat',
        payload: {
          timestamp: isoString,
          pid: run.pid,
        },
      });
    } catch {
      // Non-critical event record failure
    }

    return {
      success: true,
      lastHeartbeatAt: isoString,
    };
  }

  /**
   * Scans all active runs and reports diagnostics.
   * Optionally reconciles dead runs and terminates unresponsive runs.
   */
  scanActiveRuns(options?: ProcessScanOptions): ProcessScanSummary {
    const heartbeatTimeoutMs = options?.heartbeatTimeoutMs ?? this.defaultHeartbeatTimeoutMs;
    const autoReconcile = options?.autoReconcile ?? false;
    const autoTerminateUnresponsive = options?.autoTerminateUnresponsive ?? false;
    const scannedAt = new Date().toISOString();

    // 1. Gather all runs that are currently marked RUNNING or PENDING in DB
    const activeDbRuns = this.runRepo.findAll({ status: 'RUNNING' });
    const pendingDbRuns = this.runRepo.findAll({ status: 'PENDING' });

    // Deduplicate by runId
    const runMap = new Map<string, Run>();
    for (const r of [...activeDbRuns, ...pendingDbRuns]) {
      runMap.set(r.id, r);
    }

    // Also include any active runs currently in memory from ExecutionManager
    for (const execution of this.executionManager.listRunning()) {
      if (!runMap.has(execution.runId)) {
        const r = this.runRepo.getById(execution.runId);
        if (r) {
          runMap.set(r.id, r);
        }
      }
    }

    const inspections: ProcessStateInspection[] = [];
    let aliveCount = 0;
    let unresponsiveCount = 0;
    let deadCount = 0;
    let finishedCount = 0;
    let reconciledCount = 0;

    for (const run of runMap.values()) {
      const inspection = this.inspectRun(run.id, { heartbeatTimeoutMs });
      inspections.push(inspection);

      switch (inspection.state) {
        case 'ALIVE':
          aliveCount++;
          break;
        case 'UNRESPONSIVE':
          unresponsiveCount++;
          if (autoTerminateUnresponsive) {
            void this.executionManager
              .stop(run.id, {
                reason: `Process unresponsive (heartbeat timed out after ${heartbeatTimeoutMs}ms)`,
              })
              .catch((err: unknown) => {
                logger.warn(`Failed to stop unresponsive run ${run.id}`, { error: err });
              });
          }
          break;
        case 'DEAD':
          deadCount++;
          if (autoReconcile) {
            try {
              const reconcileResult = this.reconcileCrashedRun(run.id, {
                reason: inspection.diagnosis,
              });
              if (reconcileResult.reconciled) {
                reconciledCount++;
              }
            } catch (err) {
              logger.error(`Failed to reconcile dead run ${run.id}`, { error: err });
            }
          }
          break;
        case 'FINISHED':
          finishedCount++;
          break;
        default:
          break;
      }
    }

    return {
      scannedAt,
      totalScanned: inspections.length,
      aliveCount,
      unresponsiveCount,
      deadCount,
      finishedCount,
      reconciledCount,
      inspections,
    };
  }

  /**
   * Reconciles a crashed / dead run:
   * - Marks run as ERROR (with exit_code 137, finished_at = now)
   * - Records checkpoint 'process_crashed' and event 'process_crashed'
   * - Requeues task if attempts < max_attempts, else marks task FAILED
   * - Releases agent lock and cleans quota slot
   */
  reconcileCrashedRun(
    runId: string,
    options?: { reason?: string },
  ): { reconciled: boolean; run: Run; previousState: ProcessLivenessState } {
    const run = this.runRepo.getById(runId);
    if (!run) {
      throw new AppError('RUN_NOT_FOUND', `Run with id '${runId}' not found`, { runId });
    }

    // If run is already completed, nothing to reconcile
    if (run.finished_at || !['RUNNING', 'PENDING'].includes(run.status)) {
      return {
        reconciled: false,
        run,
        previousState: 'FINISHED',
      };
    }

    // Double check that the process PID is indeed not alive
    if (run.pid && isProcessAlive(run.pid)) {
      // Process is actually alive! Do not mark dead.
      return {
        reconciled: false,
        run,
        previousState: 'ALIVE',
      };
    }

    const now = new Date().toISOString();
    const reason =
      options?.reason ?? `Process PID ${run.pid ?? 'N/A'} crashed/died unexpectedly without clean termination`;

    const tx = this.db.transaction(() => {
      // 1. Update run record to ERROR
      const updatedRun = this.runRepo.update(run.id, {
        status: 'ERROR',
        exit_code: 137, // SIGKILL / crash exit code indicator
        finished_at: now,
      });

      // 2. Record crash event in events table
      try {
        const nextSeq = this.eventRepo.getNextSeq(run.id);
        this.eventRepo.create({
          run_id: run.id,
          seq: nextSeq,
          type: 'process_crashed',
          payload: {
            runId: run.id,
            taskId: run.task_id,
            pid: run.pid,
            reason,
            crashedAt: now,
          },
        });
      } catch (err) {
        logger.warn(`Failed to create crash event for run ${run.id}`, { error: err });
      }

      // 3. Record crash checkpoint
      try {
        this.checkpointRepo.create({
          task_id: run.task_id,
          run_id: run.id,
          attempt: run.attempt,
          step: 'process_crashed',
          status: 'FAILED',
          data: {
            pid: run.pid,
            reason,
            crashed_at: now,
          },
        });
      } catch (err) {
        logger.warn(`Failed to create crash checkpoint for run ${run.id}`, { error: err });
      }

      // 4. Update task state
      const task = this.taskRepo.findById(run.task_id);
      if (task) {
        const maxAttempts = task.max_attempts ?? 3;
        const currentAttempts = task.attempts ?? 1;

        if (currentAttempts < maxAttempts) {
          // Requeue task for another attempt
          this.stateService.markFailed(task.id, {
            reason: `Process crashed on attempt ${currentAttempts}: ${reason}`,
            runId: run.id,
          });
          this.stateService.markReady(
            task.id,
            `Requeued after process crash (${currentAttempts}/${maxAttempts} attempts used)`,
          );
          logger.info(`Task '${task.id}' requeued after worker process crash`, {
            taskId: task.id,
            attempts: currentAttempts,
            maxAttempts,
          });
        } else {
          // Exceeded max attempts: mark definitively FAILED
          this.stateService.markFailed(task.id, {
            reason: `Process crashed on final attempt ${currentAttempts}/${maxAttempts}: ${reason}`,
            runId: run.id,
          });
          logger.warn(`Task '${task.id}' marked FAILED after worker process crash (max attempts reached)`, {
            taskId: task.id,
            attempts: currentAttempts,
            maxAttempts,
          });
        }
      }

      // 5. Release held agent lock
      try {
        const activeLock = this.lockRepo.getCurrentLock('default_agent');
        if (activeLock && activeLock.task_id === run.task_id) {
          this.lockRepo.forceRelease('default_agent');
        }
      } catch (err) {
        logger.warn(`Failed to release lock after process crash for task ${run.task_id}`, { error: err });
      }

      // 6. Release resource quota slot if present
      if (this.resourceQuotaManager) {
        try {
          this.resourceQuotaManager.releaseSlot(run.task_id);
        } catch {
          // Ignore quota release error
        }
      }

      return updatedRun;
    });

    const finalRun = tx();

    return {
      reconciled: true,
      run: finalRun,
      previousState: 'DEAD',
    };
  }

  /**
   * Starts periodic watchdog background scanning.
   */
  startWatchdog(intervalMs = 5000, options?: ProcessScanOptions): void {
    if (this._watchdogTimer) {
      return;
    }

    this._watchdogTimer = setInterval(() => {
      if (this._isWatchdogScanning) {
        return;
      }
      this._isWatchdogScanning = true;
      try {
        this.scanActiveRuns(options);
      } catch (err) {
        logger.error('Error during periodic process monitor watchdog scan', { error: err });
      } finally {
        this._isWatchdogScanning = false;
      }
    }, intervalMs);

    this._watchdogTimer.unref?.();
  }

  /**
   * Stops periodic watchdog background scanning.
   */
  stopWatchdog(): void {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  /**
   * Checks whether the watchdog background loop is running.
   */
  isWatchdogRunning(): boolean {
    return this._watchdogTimer !== null;
  }
}
