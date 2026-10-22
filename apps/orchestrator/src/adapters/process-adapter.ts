import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { Readable } from 'node:stream';
import {
  AppError,
  AgentCommandSchema,
  buildProcessEnv,
  DEFAULT_ENV_WHITELIST,
  type AgentCommand,
  type AgentCommandInput,
  type ProcessExitResult,
  type TerminateProcessOptions,
} from '@ai-orchestrator/shared';
import type { RepositoryRegistry } from './repository-registry.js';

export interface ProcessHandle extends EventEmitter {
  readonly pid: number | undefined;
  readonly child: ChildProcess;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly command: AgentCommand;
  readonly startedAt: Date;

  isRunning(): boolean;
  getExitResult(): ProcessExitResult | null;
  waitForExit(): Promise<ProcessExitResult>;
  kill(signal?: NodeJS.Signals): boolean;
  terminate(options?: TerminateProcessOptions): Promise<ProcessExitResult>;
}

export class ProcessHandleImpl extends EventEmitter implements ProcessHandle {
  private _running = true;
  private _exitResult: ProcessExitResult | null = null;
  private _spawnError: Error | null = null;
  private readonly _exitPromise: Promise<ProcessExitResult>;
  public readonly startedAt: Date;

  constructor(
    public readonly child: ChildProcess,
    public readonly command: AgentCommand,
  ) {
    super();
    this.startedAt = new Date();
    const startTime = Date.now();

    this._exitPromise = new Promise<ProcessExitResult>((resolve, reject) => {
      this.child.on('error', (err) => {
        this._running = false;
        this._spawnError = err;
        if (this.listenerCount('error') > 0) {
          this.emit('error', err);
        }
        const appErr = new AppError(
          'PROCESS_EXECUTION_ERROR',
          `Process execution error for "${this.command.exe}": ${err.message}`,
          {
            command: this.command,
            originalError: err.message,
            code: (err as NodeJS.ErrnoException).code,
          },
        );
        reject(appErr);
      });

      this.child.on('exit', (code, signal) => {
        this.emit('exit', code, signal);
      });

      this.child.on('close', (exitCode, signal) => {
        this._running = false;
        const durationMs = Date.now() - startTime;
        const result: ProcessExitResult = {
          exitCode,
          signal,
          durationMs,
        };
        this._exitResult = result;
        this.emit('close', exitCode, signal, durationMs);
        if (!this._spawnError) {
          resolve(result);
        }
      });
    });

    // Suppress unhandled promise rejection warnings in case the caller awaits after rejection
    this._exitPromise.catch(() => {});

    // Forward stdout & stderr stream events
    if (this.child.stdout) {
      this.child.stdout.on('data', (chunk: Buffer) => {
        this.emit('stdout', chunk);
      });
    }

    if (this.child.stderr) {
      this.child.stderr.on('data', (chunk: Buffer) => {
        this.emit('stderr', chunk);
      });
    }
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get stdout(): Readable {
    if (!this.child.stdout) {
      throw new AppError('PROCESS_STREAM_ERROR', 'Process stdout is not available', {
        command: this.command,
      });
    }
    return this.child.stdout;
  }

  get stderr(): Readable {
    if (!this.child.stderr) {
      throw new AppError('PROCESS_STREAM_ERROR', 'Process stderr is not available', {
        command: this.command,
      });
    }
    return this.child.stderr;
  }

  isRunning(): boolean {
    return this._running && this.child.exitCode === null && this.child.signalCode === null;
  }

  getExitResult(): ProcessExitResult | null {
    return this._exitResult;
  }

  waitForExit(): Promise<ProcessExitResult> {
    return this._exitPromise;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (!this.isRunning()) {
      return false;
    }

    try {
      if (this.command.detached && this.pid) {
        try {
          process.kill(-this.pid, signal);
          return true;
        } catch {
          return this.child.kill(signal);
        }
      }
      return this.child.kill(signal);
    } catch {
      return false;
    }
  }

  async terminate(options?: TerminateProcessOptions): Promise<ProcessExitResult> {
    if (!this.isRunning()) {
      return this.waitForExit();
    }

    const initialSignal = options?.signal ?? 'SIGTERM';
    const forceSignal = options?.forceSignal ?? 'SIGKILL';
    const gracePeriodMs = Math.max(0, options?.gracePeriodMs ?? 10_000);

    // Send initial termination signal (SIGTERM)
    this.kill(initialSignal);

    let graceTimer: NodeJS.Timeout | null = null;

    if (gracePeriodMs > 0) {
      graceTimer = setTimeout(() => {
        if (this.isRunning()) {
          this.kill(forceSignal);
        }
      }, gracePeriodMs);
      graceTimer.unref?.();
    } else {
      if (this.isRunning()) {
        this.kill(forceSignal);
      }
    }

    try {
      return await this.waitForExit();
    } finally {
      if (graceTimer) {
        clearTimeout(graceTimer);
      }
    }
  }
}

export interface ProcessAdapterOptions {
  defaultEnvWhitelist?: readonly string[];
  baseEnv?: Record<string, string | undefined>;
  repositoryRegistry?: RepositoryRegistry;
}

export class ProcessAdapter {
  private _repositoryRegistry?: RepositoryRegistry;

  constructor(private readonly options: ProcessAdapterOptions = {}) {
    this._repositoryRegistry = options.repositoryRegistry;
  }

  getRepositoryRegistry(): RepositoryRegistry | undefined {
    return this._repositoryRegistry;
  }

  setRepositoryRegistry(registry: RepositoryRegistry | undefined): void {
    this._repositoryRegistry = registry;
  }

  /**
   * Spawns a child process safely without shell execution.
   *
   * Accepts either an AgentCommand object or individual arguments (exe, args, cwd, options).
   */
  spawn(command: AgentCommandInput): ProcessHandle;
  spawn(
    exe: string,
    args: string[],
    cwd: string,
    options?: Partial<Omit<AgentCommandInput, 'exe' | 'args' | 'cwd'>>,
  ): ProcessHandle;
  spawn(
    commandOrExe: AgentCommandInput | string,
    rawArgs?: string[],
    rawCwd?: string,
    rawOptions?: Partial<Omit<AgentCommandInput, 'exe' | 'args' | 'cwd'>>,
  ): ProcessHandle {
    let commandInput: AgentCommandInput;

    if (typeof commandOrExe === 'string') {
      commandInput = {
        exe: commandOrExe,
        args: rawArgs ?? [],
        cwd: rawCwd ?? process.cwd(),
        detached: rawOptions?.detached ?? false,
        env: rawOptions?.env,
        extraEnvWhitelist: rawOptions?.extraEnvWhitelist,
      };
    } else {
      commandInput = commandOrExe;
    }

    // 1. Validate command with Zod schema
    const parseResult = AgentCommandSchema.safeParse(commandInput);
    if (!parseResult.success) {
      throw new AppError('INVALID_COMMAND', 'Invalid process command parameters', {
        issues: parseResult.error.issues,
        received: commandInput,
      });
    }

    const command = parseResult.data;

    // 2. Validate cwd exists, is directory, and belongs to registered repository if registry is set
    if (this._repositoryRegistry) {
      this._repositoryRegistry.assertCwdValid(command.cwd);
    } else {
      if (!fs.existsSync(command.cwd)) {
        throw new AppError(
          'INVALID_WORKING_DIRECTORY',
          `Working directory does not exist: ${command.cwd}`,
          { cwd: command.cwd },
        );
      }

      try {
        const stat = fs.statSync(command.cwd);
        if (!stat.isDirectory()) {
          throw new AppError(
            'INVALID_WORKING_DIRECTORY',
            `Working directory path is not a directory: ${command.cwd}`,
            { cwd: command.cwd },
          );
        }
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError(
          'INVALID_WORKING_DIRECTORY',
          `Failed to inspect working directory: ${err instanceof Error ? err.message : String(err)}`,
          { cwd: command.cwd },
        );
      }
    }

    // 3. Build safe environment via whitelist
    const safeEnv = buildProcessEnv({
      sourceEnv: this.options.baseEnv ?? process.env,
      whitelist: this.options.defaultEnvWhitelist ?? DEFAULT_ENV_WHITELIST,
      extraWhitelist: command.extraEnvWhitelist,
      explicitEnv: command.env,
    });

    // 4. Spawn child process safely (NO shell, separated exe & args)
    let child: ChildProcess;
    try {
      child = spawn(command.exe, command.args, {
        cwd: command.cwd,
        env: safeEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: Boolean(command.detached),
        shell: false, // TUYỆT ĐỐI không dùng shell
      });
    } catch (err) {
      throw new AppError(
        'PROCESS_SPAWN_ERROR',
        `Failed to spawn process for "${command.exe}": ${err instanceof Error ? err.message : String(err)}`,
        { command, originalError: err instanceof Error ? err.message : String(err) },
      );
    }

    return new ProcessHandleImpl(child, command);
  }
}

export function createProcessAdapter(options?: ProcessAdapterOptions): ProcessAdapter {
  return new ProcessAdapter(options);
}

export const processAdapter = new ProcessAdapter();
