import { spawn, ChildProcess } from 'node:child_process';
import {
  FLAG_CLI_MAP,
  PowerAssertionConfig,
  PowerAssertionConfigSchema,
  PowerAssertionState,
  logger,
} from '@ai-orchestrator/shared';

export type ChildProcessSpawner = (
  command: string,
  args: string[],
  options?: Record<string, unknown>
) => ChildProcess;

export interface CaffeinateManagerOptions {
  platform?: string;
  caffeinatePath?: string;
  spawner?: ChildProcessSpawner;
  autoCleanupOnExit?: boolean;
}

export class CaffeinateManager {
  private childProcess: ChildProcess | null = null;
  private activeState: PowerAssertionState;
  private readonly platform: string;
  private readonly caffeinatePath: string;
  private readonly spawner: ChildProcessSpawner;
  private cleanupHookRegistered = false;

  constructor(options?: CaffeinateManagerOptions) {
    this.platform = options?.platform ?? process.platform;
    this.caffeinatePath = options?.caffeinatePath ?? '/usr/bin/caffeinate';
    this.spawner = options?.spawner ?? ((cmd, args, opts) => spawn(cmd, args, opts));

    const isDarwin = this.platform === 'darwin';
    this.activeState = {
      active: false,
      pid: null,
      flags: [],
      reason: null,
      startedAt: null,
      platform: this.platform,
      available: isDarwin,
      command: null,
    };

    if (options?.autoCleanupOnExit !== false) {
      this.registerExitCleanup();
    }
  }

  public isAvailable(): boolean {
    return this.activeState.available;
  }

  public getStatus(): PowerAssertionState {
    // Check if child process died unexpectedly
    if (this.childProcess && this.childProcess.exitCode !== null) {
      this.childProcess = null;
      this.activeState = {
        ...this.activeState,
        active: false,
        pid: null,
        reason: null,
        startedAt: null,
        command: null,
      };
    }

    return { ...this.activeState };
  }

  public acquire(customConfig?: Partial<PowerAssertionConfig>): PowerAssertionState {
    const config = PowerAssertionConfigSchema.parse(customConfig ?? {});

    // If already active with the same config, return current state
    if (this.childProcess && this.activeState.active && !this.childProcess.killed) {
      logger.info('Power assertion (caffeinate) is already active', {
        pid: this.activeState.pid,
        flags: this.activeState.flags,
      });
      return this.getStatus();
    }

    // Build caffeinate CLI arguments
    const args: string[] = [];
    for (const flag of config.flags) {
      const cliFlag = FLAG_CLI_MAP[flag];
      if (cliFlag && !args.includes(cliFlag)) {
        args.push(cliFlag);
      }
    }

    if (config.timeoutSeconds && config.timeoutSeconds > 0) {
      args.push('-t', String(config.timeoutSeconds));
    }

    if (config.waitPid && config.waitPid > 0) {
      args.push('-w', String(config.waitPid));
    }

    const commandStr = `${this.caffeinatePath} ${args.join(' ')}`;

    // If platform is not macOS and no custom spawner is injected, log and return simulated assertion
    if (!this.activeState.available) {
      logger.warn('Power assertions via caffeinate are only natively available on macOS (darwin). Simulation mode enabled.', {
        platform: this.platform,
      });
      this.activeState = {
        active: true,
        pid: 99999, // Simulated PID
        flags: config.flags,
        reason: config.reason,
        startedAt: new Date().toISOString(),
        platform: this.platform,
        available: false,
        command: commandStr,
      };
      return this.getStatus();
    }

    try {
      logger.info('Acquiring power assertion via caffeinate to prevent sleep', {
        command: this.caffeinatePath,
        args,
        reason: config.reason,
      });

      const child = this.spawner(this.caffeinatePath, args, {
        stdio: 'ignore',
        detached: false,
      });

      this.childProcess = child;
      const startedAt = new Date().toISOString();

      this.activeState = {
        active: true,
        pid: child.pid ?? null,
        flags: config.flags,
        reason: config.reason,
        startedAt,
        platform: this.platform,
        available: true,
        command: commandStr,
      };

      child.on('error', (err) => {
        logger.error('Caffeinate process error:', { error: String(err) });
        this.activeState = {
          ...this.activeState,
          active: false,
          pid: null,
        };
        this.childProcess = null;
      });

      child.on('exit', (code, signal) => {
        logger.info('Caffeinate process exited', { code, signal });
        this.activeState = {
          ...this.activeState,
          active: false,
          pid: null,
        };
        this.childProcess = null;
      });

      return this.getStatus();
    } catch (error) {
      logger.error('Failed to spawn caffeinate process:', error);
      throw error;
    }
  }

  public release(): PowerAssertionState {
    if (this.childProcess) {
      try {
        logger.info('Releasing power assertion (terminating caffeinate)...', {
          pid: this.childProcess.pid,
        });
        this.childProcess.kill('SIGTERM');
      } catch (err) {
        logger.warn('Error killing caffeinate process:', { error: String(err) });
      } finally {
        this.childProcess = null;
      }
    }

    this.activeState = {
      ...this.activeState,
      active: false,
      pid: null,
      flags: [],
      reason: null,
      startedAt: null,
      command: null,
    };

    logger.info('Power assertion released. System may now idle sleep as normal.');
    return this.getStatus();
  }

  private registerExitCleanup(): void {
    if (this.cleanupHookRegistered) return;
    this.cleanupHookRegistered = true;

    const cleanup = () => {
      if (this.childProcess && !this.childProcess.killed) {
        try {
          this.childProcess.kill('SIGKILL');
        } catch {
          // Ignore
        }
      }
    };

    process.once('exit', cleanup);
    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
  }
}
