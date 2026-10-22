import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  RunRepository,
  TaskRepository,
  EventRepository,
  AgentLockRepository,
} from '@ai-orchestrator/db';
import {
  AppError,
  type Run,
  type EventRecord,
  type EventFilter,
  type CreateRunApiInput,
  type StopRunApiInput,
  type RunFilter,
  type Env,
} from '@ai-orchestrator/shared';
import {
  ExecutionManager,
  defaultExecutionManager,
  type ManagedExecution,
} from '../adapters/execution-manager.js';
import type { RepositoryRegistry } from '../adapters/repository-registry.js';
import { getOrchestratorConfig } from '../config.js';

export interface RunServiceOptions {
  db: Database.Database;
  executionManager?: ExecutionManager;
  repositoryRegistry?: RepositoryRegistry;
  config?: Partial<Env>;
}

export interface ManagedRunInfo extends Run {
  isRunning: boolean;
}

export class RunService {
  private readonly db: Database.Database;
  private readonly taskRepo: TaskRepository;
  private readonly runRepo: RunRepository;
  private readonly eventRepo: EventRepository;
  private readonly lockRepo: AgentLockRepository;
  private readonly executionManager: ExecutionManager;
  private readonly repositoryRegistry?: RepositoryRegistry;
  private readonly config: Partial<Env>;

  constructor(options: RunServiceOptions) {
    this.db = options.db;
    this.taskRepo = new TaskRepository(this.db);
    this.runRepo = new RunRepository(this.db);
    this.eventRepo = new EventRepository(this.db);
    this.lockRepo = new AgentLockRepository(this.db);
    this.executionManager = options.executionManager ?? defaultExecutionManager;
    this.repositoryRegistry = options.repositoryRegistry;

    let config: Partial<Env> = options.config ?? {};
    if (!options.config) {
      try {
        config = getOrchestratorConfig();
      } catch {
        config = {
          AGY_BIN: process.env['AGY_BIN'] || 'agy',
          AGY_ARGS: process.env['AGY_ARGS'],
        };
      }
    }
    this.config = config;
  }

  getExecutionManager(): ExecutionManager {
    return this.executionManager;
  }

  getManagedExecution(runId: string): ManagedExecution | undefined {
    return this.executionManager.get(runId);
  }

  async startRun(input: CreateRunApiInput): Promise<{ run: Run; execution: ManagedExecution }> {
    if (!input.skipLockCheck) {
      const runningExecutions = this.executionManager.listRunning();
      if (runningExecutions.length > 0) {
        throw new AppError(
          'CONCURRENCY_LIMIT_EXCEEDED',
          `Cannot start run for task '${input.taskId}': another execution is currently active (${runningExecutions[0]?.runId})`,
          {
            activeRunId: runningExecutions[0]?.runId,
            taskId: input.taskId,
          },
        );
      }

      const activeLock = this.lockRepo.getCurrentLock('default_agent');
      if (activeLock && activeLock.task_id !== input.taskId) {
        const lockedTask = this.taskRepo.findById(activeLock.task_id);
        if (lockedTask && (lockedTask.status === 'RUNNING' || lockedTask.status === 'VERIFYING')) {
          throw new AppError(
            'AGENT_LOCK_HELD',
            `Agent lock is currently held by task '${activeLock.task_id}'`,
            {
              lockId: activeLock.id,
              activeTaskId: activeLock.task_id,
            },
          );
        }
      }
    }

    const task = this.taskRepo.findById(input.taskId);
    if (!task) {
      throw new AppError('TASK_NOT_FOUND', `Task with id '${input.taskId}' not found`, {
        taskId: input.taskId,
      });
    }

    // Determine attempt count
    const existingRuns = this.runRepo.findByTaskId(input.taskId);
    const attempt = existingRuns.length + 1;

    // Determine executable & arguments
    const exe = input.command?.exe ?? this.config.AGY_BIN ?? 'agy';
    let args: string[];
    if (input.command?.args) {
      args = input.command.args;
    } else {
      const prompt = task.description || task.title;
      args = this.config.AGY_ARGS ? [this.config.AGY_ARGS, '-p', prompt] : ['-p', prompt];
    }

    // Determine working directory
    let cwd = input.command?.cwd;
    if (!cwd) {
      if (task.repository && task.repository !== '.') {
        cwd = path.resolve(task.repository);
      } else {
        cwd = process.cwd();
      }
    } else {
      cwd = path.resolve(cwd);
    }

    // Check registry if provided
    if (this.repositoryRegistry) {
      this.repositoryRegistry.assertCwdValid(cwd);
    }

    // Determine timeout
    const timeoutMs =
      input.timeoutMs ??
      (task.timeout_minutes && task.timeout_minutes > 0
        ? task.timeout_minutes * 60 * 1000
        : undefined);

    // Create run record in DB
    const run = this.runRepo.create({
      task_id: task.id,
      attempt,
      status: 'RUNNING',
      branch: input.branch ?? null,
    });

    // Secure lock in agent_locks if not already held
    try {
      if (!this.lockRepo.isLocked('default_agent')) {
        this.lockRepo.acquire({
          id: 'default_agent',
          task_id: task.id,
          run_id: run.id,
          owner_pid: process.pid,
        });
      } else {
        this.lockRepo.updateRunId('default_agent', run.id);
      }
    } catch {
      // Lock may have already been acquired by TaskScheduler
    }

    // Update task status and attempt in DB
    try {
      this.taskRepo.update(task.id, {
        status: 'RUNNING',
        attempts: attempt,
      });
    } catch {
      // Non-critical if task status transition fails
    }

    // Spawn and supervise process
    const execution = this.executionManager.startRun({
      runId: run.id,
      taskId: task.id,
      command: {
        exe,
        args,
        cwd,
        env: input.command?.env,
        extraEnvWhitelist: input.command?.extraEnvWhitelist,
        detached: input.command?.detached,
      },
      timeoutMs,
      gracePeriodMs: input.gracePeriodMs,
      eventRepository: this.eventRepo,
      runRepository: this.runRepo,
      repositoryRegistry: this.repositoryRegistry,
      recordRawStdout: true,
      recordRawStderr: true,
      recordParsedEvents: true,
      recordLifecycle: true,
    });

    // Update pid in DB
    if (execution.handle.pid) {
      this.runRepo.update(run.id, { pid: execution.handle.pid });
    }

    execution.handle.on('close', () => {
      try {
        this.lockRepo.release('default_agent', task.id);
      } catch {
        // Ignore release errors
      }
    });

    const currentRun = this.runRepo.getById(run.id) ?? run;
    return { run: currentRun, execution };
  }

  getRun(id: string): ManagedRunInfo {
    const run = this.runRepo.getById(id);
    if (!run) {
      throw new AppError('RUN_NOT_FOUND', `Run with id '${id}' not found`, { runId: id });
    }

    const isRunning = this.executionManager.isRunning(id);
    const managed = this.executionManager.get(id);
    const pid = managed?.handle.pid ?? run.pid;

    return {
      ...run,
      pid,
      isRunning,
    };
  }

  listRuns(filter?: RunFilter): Run[] {
    return this.runRepo.findAll(filter);
  }

  async stopRun(
    id: string,
    options?: StopRunApiInput,
  ): Promise<{ stopped: boolean; run: Run; message?: string }> {
    const run = this.runRepo.getById(id);
    if (!run) {
      throw new AppError('RUN_NOT_FOUND', `Run with id '${id}' not found`, { runId: id });
    }

    const isRunning = this.executionManager.isRunning(id);
    if (!isRunning) {
      if (run.status === 'RUNNING') {
        const updated = this.runRepo.updateStatus(id, 'CANCELLED');
        return { stopped: true, run: updated, message: 'Orphan run marked as cancelled' };
      }
      return { stopped: false, run, message: 'Run is not currently running' };
    }

    const stopped = await this.executionManager.stop(id, options);
    this.lockRepo.release('default_agent', run.task_id);
    const updated = this.runRepo.getById(id) ?? run;
    return { stopped, run: updated };
  }

  getEvents(runId: string, filter?: EventFilter): EventRecord[] {
    const run = this.runRepo.getById(runId);
    if (!run) {
      throw new AppError('RUN_NOT_FOUND', `Run with id '${runId}' not found`, { runId });
    }
    return this.eventRepo.findByRunId(runId, filter);
  }
}
