import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  type QualityCommandDefinition,
  type QualityCommandRecord,
  type CreateQualityCommandRecordInput,
  type QualityPipelineResult,
  type QualityRecordFilter,
  type RepoQualityConfig,
  getExecutionPipeline,
  AppError,
  logger,
} from '@ai-orchestrator/shared';
import {
  QualityCheckRepository,
  ReportRepository,
  TaskRepository,
} from '@ai-orchestrator/db';
import { ProcessAdapter, type ProcessHandle } from '../adapters/process-adapter.js';
import type { QualityConfigService } from './quality-config-service.js';

export interface QualityRunnerOptions {
  db?: Database.Database;
  qualityCheckRepo?: QualityCheckRepository;
  reportRepo?: ReportRepository;
  taskRepo?: TaskRepository;
  processAdapter?: ProcessAdapter;
  qualityConfigService?: QualityConfigService;
  maxOutputBytes?: number;
}

export interface RunPipelineOptions {
  taskId?: string;
  runId?: string;
  repoPath?: string;
  stopOnFirstFailure?: boolean;
  saveReport?: boolean;
  onCommandStart?: (cmd: QualityCommandDefinition) => void;
  onCommandComplete?: (record: QualityCommandRecord) => void;
}

const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024; // 5 MB per stream

export class QualityRunner {
  private readonly qualityCheckRepo?: QualityCheckRepository;
  private readonly reportRepo?: ReportRepository;
  private readonly taskRepo?: TaskRepository;
  private readonly processAdapter: ProcessAdapter;
  private readonly qualityConfigService?: QualityConfigService;
  private readonly maxOutputBytes: number;

  constructor(options: QualityRunnerOptions = {}) {
    if (options.qualityCheckRepo) {
      this.qualityCheckRepo = options.qualityCheckRepo;
    } else if (options.db) {
      this.qualityCheckRepo = new QualityCheckRepository(options.db);
    }

    if (options.reportRepo) {
      this.reportRepo = options.reportRepo;
    } else if (options.db) {
      this.reportRepo = new ReportRepository(options.db);
    }

    if (options.taskRepo) {
      this.taskRepo = options.taskRepo;
    } else if (options.db) {
      this.taskRepo = new TaskRepository(options.db);
    }

    this.processAdapter = options.processAdapter ?? new ProcessAdapter();
    this.qualityConfigService = options.qualityConfigService;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  /**
   * Runs a single quality command definition, capturing its stdout, stderr, exit code,
   * duration, and persisting the record to the database.
   */
  async runCommand(
    cmd: QualityCommandDefinition,
    context?: { taskId?: string; runId?: string },
  ): Promise<QualityCommandRecord> {
    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    let exitCode: number | null = null;
    let signal: string | null = null;
    let status: 'SUCCESS' | 'FAILURE' | 'TIMEOUT' | 'ERROR';

    let timeoutTimer: NodeJS.Timeout | null = null;
    let timedOut = false;

    try {
      const handle: ProcessHandle = this.processAdapter.spawn({
        exe: cmd.exe,
        args: cmd.args,
        cwd: cmd.cwd,
        env: cmd.env,
      });

      // Stream stdout
      handle.on('stdout', (chunk: Buffer) => {
        if (stdoutTruncated) return;
        if (Buffer.byteLength(stdoutBuffer, 'utf8') + chunk.length > this.maxOutputBytes) {
          stdoutTruncated = true;
          stdoutBuffer += chunk.toString('utf8').slice(0, 1024) + '\n[TRUNCATED: output limit reached]';
        } else {
          stdoutBuffer += chunk.toString('utf8');
        }
      });

      // Stream stderr
      handle.on('stderr', (chunk: Buffer) => {
        if (stderrTruncated) return;
        if (Buffer.byteLength(stderrBuffer, 'utf8') + chunk.length > this.maxOutputBytes) {
          stderrTruncated = true;
          stderrBuffer += chunk.toString('utf8').slice(0, 1024) + '\n[TRUNCATED: output limit reached]';
        } else {
          stderrBuffer += chunk.toString('utf8');
        }
      });

      // Set command timeout
      if (cmd.timeout_ms > 0) {
        timeoutTimer = setTimeout(async () => {
          timedOut = true;
          logger.warn(`Quality command timed out: ${cmd.name} (${cmd.command})`, {
            commandId: cmd.id,
            timeoutMs: cmd.timeout_ms,
          });
          try {
            await handle.terminate({ gracePeriodMs: 1500 });
          } catch {
            handle.kill('SIGKILL');
          }
        }, cmd.timeout_ms);
      }

      // Wait for process completion
      const result = await handle.waitForExit();
      exitCode = result.exitCode;
      signal = result.signal;

      if (timedOut) {
        status = 'TIMEOUT';
      } else if (exitCode === 0) {
        status = 'SUCCESS';
      } else {
        status = 'FAILURE';
      }
    } catch (err) {
      if (timedOut) {
        status = 'TIMEOUT';
      } else {
        status = 'ERROR';
        const errorMsg = err instanceof Error ? err.message : String(err);
        stderrBuffer += (stderrBuffer ? '\n' : '') + `Execution error: ${errorMsg}`;
      }
    } finally {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
    }

    const durationMs = Math.max(0, Date.now() - startTime);
    const finishedAt = new Date().toISOString();

    const recordInput: CreateQualityCommandRecordInput = {
      id: crypto.randomUUID(),
      task_id: context?.taskId ?? null,
      run_id: context?.runId ?? null,
      stage: cmd.stage,
      command_id: cmd.id,
      name: cmd.name,
      command: cmd.command,
      exe: cmd.exe,
      args: cmd.args,
      cwd: cmd.cwd,
      exit_code: exitCode,
      signal,
      status,
      stdout: stdoutBuffer,
      stderr: stderrBuffer,
      duration_ms: durationMs,
      started_at: startedAt,
      finished_at: finishedAt,
      created_at: finishedAt,
    };

    let record: QualityCommandRecord;
    if (this.qualityCheckRepo) {
      record = this.qualityCheckRepo.create(recordInput);
    } else {
      record = {
        id: recordInput.id!,
        task_id: recordInput.task_id ?? null,
        run_id: recordInput.run_id ?? null,
        stage: recordInput.stage,
        command_id: recordInput.command_id,
        name: recordInput.name,
        command: recordInput.command,
        exe: recordInput.exe,
        args: recordInput.args ?? [],
        cwd: recordInput.cwd,
        exit_code: recordInput.exit_code ?? null,
        signal: recordInput.signal ?? null,
        status: recordInput.status,
        stdout: recordInput.stdout ?? '',
        stderr: recordInput.stderr ?? '',
        duration_ms: recordInput.duration_ms ?? 0,
        started_at: recordInput.started_at!,
        finished_at: recordInput.finished_at!,
        created_at: recordInput.created_at!,
      };
    }

    return record;
  }

  /**
   * Runs a full verification pipeline (format -> lint -> typecheck -> test -> build -> custom).
   * Respects stop_on_first_failure, required, and continueOnError.
   * Records every command execution into database.
   */
  async runPipeline(
    commands: QualityCommandDefinition[],
    options: RunPipelineOptions = {},
  ): Promise<QualityPipelineResult> {
    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    const records: QualityCommandRecord[] = [];
    const stopOnFirstFailure = options.stopOnFirstFailure ?? true;
    let abortRemaining = false;

    for (const cmd of commands) {
      if (!cmd.enabled) {
        continue;
      }

      options.onCommandStart?.(cmd);

      if (abortRemaining) {
        const now = new Date().toISOString();
        const skippedInput: CreateQualityCommandRecordInput = {
          id: crypto.randomUUID(),
          task_id: options.taskId ?? null,
          run_id: options.runId ?? null,
          stage: cmd.stage,
          command_id: cmd.id,
          name: cmd.name,
          command: cmd.command,
          exe: cmd.exe,
          args: cmd.args,
          cwd: cmd.cwd,
          exit_code: null,
          signal: null,
          status: 'SKIPPED',
          stdout: '',
          stderr: 'Skipped due to prior stage failure',
          duration_ms: 0,
          started_at: now,
          finished_at: now,
          created_at: now,
        };

        const skippedRecord = this.qualityCheckRepo
          ? this.qualityCheckRepo.create(skippedInput)
          : ({
              id: skippedInput.id!,
              task_id: skippedInput.task_id ?? null,
              run_id: skippedInput.run_id ?? null,
              stage: skippedInput.stage,
              command_id: skippedInput.command_id,
              name: skippedInput.name,
              command: skippedInput.command,
              exe: skippedInput.exe,
              args: skippedInput.args ?? [],
              cwd: skippedInput.cwd,
              exit_code: null,
              signal: null,
              status: 'SKIPPED' as const,
              stdout: '',
              stderr: 'Skipped due to prior stage failure',
              duration_ms: 0,
              started_at: now,
              finished_at: now,
              created_at: now,
            } as QualityCommandRecord);

        records.push(skippedRecord);
        options.onCommandComplete?.(skippedRecord);
        continue;
      }

      const record = await this.runCommand(cmd, {
        taskId: options.taskId,
        runId: options.runId,
      });

      records.push(record);
      options.onCommandComplete?.(record);

      const isFailed = record.status !== 'SUCCESS';
      const isRequired = cmd.required !== false;
      const shouldStop = isFailed && isRequired && !cmd.continueOnError;

      if (shouldStop && stopOnFirstFailure) {
        abortRemaining = true;
      }
    }

    const durationMs = Math.max(0, Date.now() - startTime);
    const finishedAt = new Date().toISOString();

    const passedCommands = records.filter((r) => r.status === 'SUCCESS').length;
    const failedCommands = records.filter((r) => ['FAILURE', 'TIMEOUT', 'ERROR'].includes(r.status)).length;
    const skippedCommands = records.filter((r) => r.status === 'SKIPPED').length;

    // A pipeline is considered successful only if all required commands passed and none failed/timed-out
    const requiredCommands = commands.filter((c) => c.enabled && c.required !== false);
    const requiredFailed = records.some((r) => {
      const def = commands.find((c) => c.id === r.command_id);
      const isReq = def ? def.required !== false && !def.continueOnError : true;
      return isReq && r.status !== 'SUCCESS';
    });

    const success = requiredCommands.length > 0 ? !requiredFailed : failedCommands === 0;

    const firstCmd = commands[0];
    const repoPath = options.repoPath ?? (firstCmd ? firstCmd.cwd : '.');

    const result: QualityPipelineResult = {
      task_id: options.taskId ?? null,
      run_id: options.runId ?? null,
      repo_path: repoPath,
      success,
      total_commands: records.length,
      passed_commands: passedCommands,
      failed_commands: failedCommands,
      skipped_commands: skippedCommands,
      duration_ms: durationMs,
      records,
      started_at: startedAt,
      finished_at: finishedAt,
    };

    // Save report in reports table if reportRepo and runId/taskId are available
    if (options.saveReport !== false && this.reportRepo && (options.runId || options.taskId)) {
      try {
        this.reportRepo.create({
          id: crypto.randomUUID(),
          run_id: options.runId ?? null,
          kind: 'quality_report',
          content: JSON.stringify(result, null, 2),
          created_at: finishedAt,
        });
      } catch (err) {
        logger.error(`Failed to store quality report: ${(err as Error).message}`, {
          runId: options.runId,
          taskId: options.taskId,
        });
      }
    }

    return result;
  }

  /**
   * Resolves and runs the verification pipeline for a repository.
   */
  async runForRepo(
    repoIdOrPath: string,
    options: RunPipelineOptions = {},
  ): Promise<QualityPipelineResult> {
    if (!this.qualityConfigService) {
      throw new AppError(
        'INVALID_CONFIGURATION',
        'QualityConfigService is required to run verification for repo',
      );
    }

    const config: RepoQualityConfig = this.qualityConfigService.getConfigForRepo(repoIdOrPath);
    const pipeline = getExecutionPipeline(config);

    return this.runPipeline(pipeline, {
      ...options,
      repoPath: config.repo_path,
      stopOnFirstFailure: options.stopOnFirstFailure ?? config.stop_on_first_failure,
    });
  }

  /**
   * Resolves and runs the verification pipeline for a specific task.
   */
  async runForTask(
    taskId: string,
    options: RunPipelineOptions = {},
  ): Promise<QualityPipelineResult> {
    if (!this.qualityConfigService) {
      throw new AppError(
        'INVALID_CONFIGURATION',
        'QualityConfigService is required to run verification for task',
      );
    }

    const config: RepoQualityConfig = this.qualityConfigService.getConfigForTask(taskId);
    const pipeline = getExecutionPipeline(config);

    return this.runPipeline(pipeline, {
      taskId,
      ...options,
      repoPath: config.repo_path,
      stopOnFirstFailure: options.stopOnFirstFailure ?? config.stop_on_first_failure,
    });
  }

  getRecord(id: string): QualityCommandRecord | null {
    if (!this.qualityCheckRepo) {
      return null;
    }
    return this.qualityCheckRepo.getById(id);
  }

  getRecordsForTask(taskId: string): QualityCommandRecord[] {
    if (!this.qualityCheckRepo) {
      return [];
    }
    return this.qualityCheckRepo.findByTaskId(taskId);
  }

  getRecordsForRun(runId: string): QualityCommandRecord[] {
    if (!this.qualityCheckRepo) {
      return [];
    }
    return this.qualityCheckRepo.findByRunId(runId);
  }

  findRecords(filter?: QualityRecordFilter): QualityCommandRecord[] {
    if (!this.qualityCheckRepo) {
      return [];
    }
    return this.qualityCheckRepo.findAll(filter);
  }
}
