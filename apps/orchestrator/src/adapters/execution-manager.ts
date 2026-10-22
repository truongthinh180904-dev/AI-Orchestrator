import { EventEmitter } from 'node:events';
import {
  type AgentCommandInput,
  type ProcessExitResult,
  type TerminateProcessOptions,
  STANDARD_EVENT_TYPES,
} from '@ai-orchestrator/shared';
import { processAdapter, ProcessAdapter, type ProcessHandle } from './process-adapter.js';
import {
  attachExecutionStream,
  type ExecutionStreamRecorder,
  type EventRecorderTarget,
  type RunRecorderTarget,
  type ExecutionCompletionResult,
} from './execution-stream.js';
import type { RepositoryRegistry } from './repository-registry.js';
import type { IsolatedWorktree } from './worktree-manager.js';

export interface StopRunOptions {
  gracePeriodMs?: number;
  signal?: NodeJS.Signals;
  forceSignal?: NodeJS.Signals;
  reason?: string;
}

export interface StartRunOptions {
  runId: string;
  taskId?: string;
  command: AgentCommandInput;
  worktree?: IsolatedWorktree;
  repositoryRegistry?: RepositoryRegistry;
  timeoutMs?: number;
  gracePeriodMs?: number;
  processAdapter?: ProcessAdapter;
  eventRepository?: EventRecorderTarget;
  runRepository?: RunRecorderTarget;
  recordRawStdout?: boolean;
  recordRawStderr?: boolean;
  recordParsedEvents?: boolean;
  recordLifecycle?: boolean;
  initialSeq?: number;
}

export interface RegisterRunOptions {
  runId: string;
  taskId?: string;
  handle: ProcessHandle;
  recorder?: ExecutionStreamRecorder;
  timeoutMs?: number;
  gracePeriodMs?: number;
  runRepository?: RunRecorderTarget;
  eventRepository?: EventRecorderTarget;
}

export interface ManagedExecution {
  readonly runId: string;
  readonly taskId?: string;
  readonly handle: ProcessHandle;
  readonly recorder?: ExecutionStreamRecorder;
  readonly startedAt: Date;
  readonly timeoutMs?: number;
  readonly gracePeriodMs: number;
  readonly isTimeout: boolean;
  readonly isCancelled: boolean;

  isRunning(): boolean;
  stop(options?: StopRunOptions): Promise<boolean>;
  waitForCompletion(): Promise<ExecutionCompletionResult | ProcessExitResult>;
}

export interface ExecutionManagerOptions {
  defaultGracePeriodMs?: number;
  defaultProcessAdapter?: ProcessAdapter;
  repositoryRegistry?: RepositoryRegistry;
}

export class ExecutionManager extends EventEmitter {
  private readonly _runs = new Map<string, ManagedExecution>();
  private readonly _defaultGracePeriodMs: number;
  private readonly _processAdapter: ProcessAdapter;
  private readonly _repositoryRegistry?: RepositoryRegistry;

  constructor(options: ExecutionManagerOptions = {}) {
    super();
    this._defaultGracePeriodMs = Math.max(0, options.defaultGracePeriodMs ?? 10_000);
    this._processAdapter = options.defaultProcessAdapter ?? processAdapter;
    this._repositoryRegistry = options.repositoryRegistry;
  }

  /**
   * Spawns a process, optionally attaches execution stream recording,
   * configures timeout watchdog, and registers the execution under runId.
   */
  startRun(options: StartRunOptions): ManagedExecution {
    const {
      runId,
      taskId,
      command,
      worktree,
      repositoryRegistry: customRegistry,
      timeoutMs,
      gracePeriodMs = this._defaultGracePeriodMs,
      processAdapter: customAdapter,
      eventRepository,
      runRepository,
      recordRawStdout,
      recordRawStderr,
      recordParsedEvents,
      recordLifecycle,
      initialSeq,
    } = options;

    // If worktree is provided and command.cwd was not specified or empty, use worktree path
    if (worktree && !command.cwd) {
      command.cwd = worktree.worktreePath;
    }

    // Verify cwd with repository registry if configured
    const registry = customRegistry ?? this._repositoryRegistry;
    if (registry) {
      registry.assertCwdValid(command.cwd);
    }

    const adapter = customAdapter ?? this._processAdapter;
    const handle = adapter.spawn(command);

    let recorder: ExecutionStreamRecorder | undefined;
    if (eventRepository) {
      recorder = attachExecutionStream({
        runId,
        handle,
        eventRepository,
        runRepository,
        recordRawStdout,
        recordRawStderr,
        recordParsedEvents,
        recordLifecycle,
        initialSeq,
      });
    }

    return this.register({
      runId,
      taskId,
      handle,
      recorder,
      timeoutMs,
      gracePeriodMs,
      runRepository,
      eventRepository,
    });
  }

  /**
   * Registers an already spawned ProcessHandle (and optional ExecutionStreamRecorder)
   * into the manager, attaching timeout supervision and stop handling.
   */
  register(options: RegisterRunOptions): ManagedExecution {
    const {
      runId,
      taskId,
      handle,
      recorder,
      timeoutMs,
      gracePeriodMs = this._defaultGracePeriodMs,
    } = options;

    const startedAt = handle.startedAt ?? new Date();
    let isTimeout = false;
    let isCancelled = false;
    let timeoutTimer: NodeJS.Timeout | null = null;

    if (timeoutMs !== undefined && timeoutMs > 0) {
      timeoutTimer = setTimeout(async () => {
        if (handle.isRunning() && !isCancelled && !isTimeout) {
          isTimeout = true;
          if (recorder) {
            recorder.markTimeout();
            try {
              recorder.recordEvent(STANDARD_EVENT_TYPES.PROCESS_TIMEOUT, {
                runId,
                timeoutMs,
                pid: handle.pid,
                durationMs: Date.now() - startedAt.getTime(),
              });
            } catch {
              // Ignore recorder errors during timeout
            }
          }
          this.emit('timeout', { runId, timeoutMs });
          await handle.terminate({
            gracePeriodMs,
            signal: 'SIGTERM',
            forceSignal: 'SIGKILL',
          });
        }
      }, timeoutMs);
      timeoutTimer.unref?.();
    }

    const clearTimers = (): void => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    };

    handle.on('close', (exitCode, signal) => {
      clearTimers();
      this.emit('finish', { runId, exitCode, signal });
    });

    handle.on('error', (err) => {
      clearTimers();
      if (this.listenerCount('error') > 0) {
        this.emit('error', { runId, error: err });
      }
    });

    const managedExecution: ManagedExecution = {
      runId,
      taskId,
      handle,
      recorder,
      startedAt,
      timeoutMs,
      gracePeriodMs,
      get isTimeout() {
        return isTimeout;
      },
      get isCancelled() {
        return isCancelled;
      },
      isRunning(): boolean {
        return handle.isRunning();
      },
      async stop(stopOptions?: StopRunOptions): Promise<boolean> {
        if (!handle.isRunning()) {
          return false;
        }

        if (isCancelled) {
          await handle.waitForExit();
          return true;
        }

        isCancelled = true;
        clearTimers();

        if (recorder) {
          recorder.markCancelled();
          try {
            recorder.recordEvent(STANDARD_EVENT_TYPES.PROCESS_STOPPED, {
              runId,
              reason: stopOptions?.reason ?? 'Manual stop requested',
              signal: stopOptions?.signal ?? 'SIGTERM',
            });
          } catch {
            // Ignore recorder errors during cancellation
          }
        }

        const effectiveGrace = stopOptions?.gracePeriodMs ?? gracePeriodMs;
        const terminateOpts: TerminateProcessOptions = {
          gracePeriodMs: effectiveGrace,
          signal: stopOptions?.signal ?? 'SIGTERM',
          forceSignal: stopOptions?.forceSignal ?? 'SIGKILL',
        };

        await handle.terminate(terminateOpts);
        return true;
      },
      waitForCompletion(): Promise<ExecutionCompletionResult | ProcessExitResult> {
        if (recorder) {
          return recorder.waitForCompletion();
        }
        return handle.waitForExit();
      },
    };

    this._runs.set(runId, managedExecution);
    this.emit('register', managedExecution);

    return managedExecution;
  }

  /**
   * Stops a running process identified by runId:
   * sends SIGTERM -> waits grace period -> sends SIGKILL if still running.
   * Returns true if a running process was stopped, false if not found or already stopped.
   */
  async stop(runId: string, options?: StopRunOptions): Promise<boolean> {
    const execution = this._runs.get(runId);
    if (!execution) {
      return false;
    }
    const stopped = await execution.stop(options);
    if (stopped) {
      this.emit('stop', { runId, reason: options?.reason });
    }
    return stopped;
  }

  get(runId: string): ManagedExecution | undefined {
    return this._runs.get(runId);
  }

  has(runId: string): boolean {
    return this._runs.has(runId);
  }

  isRunning(runId: string): boolean {
    const execution = this._runs.get(runId);
    return execution ? execution.isRunning() : false;
  }

  listRunning(): ManagedExecution[] {
    const result: ManagedExecution[] = [];
    for (const execution of this._runs.values()) {
      if (execution.isRunning()) {
        result.push(execution);
      }
    }
    return result;
  }

  listAll(): ManagedExecution[] {
    return Array.from(this._runs.values());
  }

  /**
   * Stops all active runs currently being managed.
   */
  async stopAll(options?: StopRunOptions): Promise<number> {
    const running = this.listRunning();
    let count = 0;
    await Promise.all(
      running.map(async (execution) => {
        const stopped = await execution.stop(options);
        if (stopped) count++;
      }),
    );
    return count;
  }

  /**
   * Clears finished runs from memory cache.
   */
  clear(): void {
    for (const [runId, execution] of this._runs.entries()) {
      if (!execution.isRunning()) {
        this._runs.delete(runId);
      }
    }
  }

  /**
   * Clears all runs unconditionally.
   */
  clearAll(): void {
    this._runs.clear();
  }
}

export function createExecutionManager(options?: ExecutionManagerOptions): ExecutionManager {
  return new ExecutionManager(options);
}

export const defaultExecutionManager = new ExecutionManager();
export const executionManager = defaultExecutionManager;

/**
 * Convenience function to stop a run via the default execution manager.
 * Initiates SIGTERM -> waits grace period -> escalates to SIGKILL.
 */
export async function stop(runId: string, options?: StopRunOptions): Promise<boolean> {
  return defaultExecutionManager.stop(runId, options);
}
