import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  type QualityGateResult,
  type QualityGatePolicy,
  type QualityGateEvidenceInput,
  type TaskWithDependencies,
  evaluateQualityGate,
  AppError,
  logger,
} from '@ai-orchestrator/shared';
import {
  QualityGateRepository,
  TaskRepository,
  RunRepository,
  ReportRepository,
} from '@ai-orchestrator/db';
import type { QualityRunner } from './quality-runner.js';
import type { ScopeDiffService } from './scope-diff-service.js';
import type { ReviewerService } from './reviewer-service.js';
import type { SecurityCheckService } from './security-check-service.js';
import type { QualityConfigService } from './quality-config-service.js';
import { TaskStateService } from './task-state-service.js';

export interface QualityGateServiceOptions {
  db: Database.Database;
  qualityRunner?: QualityRunner;
  scopeDiffService?: ScopeDiffService;
  reviewerService?: ReviewerService;
  securityCheckService?: SecurityCheckService;
  qualityConfigService?: QualityConfigService;
  qualityGateRepo?: QualityGateRepository;
  taskRepo?: TaskRepository;
  runRepo?: RunRepository;
  reportRepo?: ReportRepository;
  stateService?: TaskStateService;
  defaultPolicy?: Partial<QualityGatePolicy>;
}

export interface RunQualityGateOptions {
  runId?: string;
  repoPath?: string;
  policy?: Partial<QualityGatePolicy>;
  skipCommands?: boolean;
  skipScope?: boolean;
  skipReview?: boolean;
  skipSecurity?: boolean;
  evidenceOverrides?: Partial<QualityGateEvidenceInput>;
}

export interface VerifyTaskOptions extends RunQualityGateOptions {
  customReason?: string;
  autoTransition?: boolean; // default true
}

export class QualityGateService {
  private readonly db: Database.Database;
  private readonly qualityRunner?: QualityRunner;
  private readonly scopeDiffService?: ScopeDiffService;
  private readonly reviewerService?: ReviewerService;
  private readonly securityCheckService?: SecurityCheckService;
  private readonly qualityConfigService?: QualityConfigService;
  private readonly qualityGateRepo: QualityGateRepository;
  private readonly taskRepo: TaskRepository;
  private readonly runRepo: RunRepository;
  private readonly reportRepo: ReportRepository;
  private readonly stateService: TaskStateService;
  private readonly defaultPolicy?: Partial<QualityGatePolicy>;

  constructor(options: QualityGateServiceOptions) {
    this.db = options.db;
    this.qualityRunner = options.qualityRunner;
    this.scopeDiffService = options.scopeDiffService;
    this.reviewerService = options.reviewerService;
    this.securityCheckService = options.securityCheckService;
    this.qualityConfigService = options.qualityConfigService;
    this.qualityGateRepo = options.qualityGateRepo ?? new QualityGateRepository(this.db);
    this.taskRepo = options.taskRepo ?? new TaskRepository(this.db);
    this.runRepo = options.runRepo ?? new RunRepository(this.db);
    this.reportRepo = options.reportRepo ?? new ReportRepository(this.db);
    this.stateService =
      options.stateService ??
      new TaskStateService(this.db);
    this.defaultPolicy = options.defaultPolicy;
  }

  /**
   * Directly evaluates provided evidence against policy and saves evaluation record.
   */
  evaluate(
    evidence: QualityGateEvidenceInput,
    options: {
      policy?: Partial<QualityGatePolicy>;
      taskId?: string;
      runId?: string;
      repoPath?: string;
      durationMs?: number;
    } = {},
  ): QualityGateResult {
    const combinedPolicy: Partial<QualityGatePolicy> = {
      ...this.defaultPolicy,
      ...options.policy,
    };

    const result = evaluateQualityGate(combinedPolicy, evidence, {
      taskId: options.taskId,
      runId: options.runId,
      repoPath: options.repoPath,
      durationMs: options.durationMs,
    });

    try {
      this.qualityGateRepo.create(result);
    } catch (err) {
      logger.error('Failed to persist quality gate evaluation in repository', {
        id: result.id,
        taskId: result.task_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return result;
  }

  /**
   * Executes multidimensional Quality Gate verification for a task.
   * Gathers evidence across QualityRunner (QLT-002), ScopeDiff (QLT-003),
   * ReviewerAgent (QLT-004), and SecurityCheck (QLT-005).
   *
   * Crucial rule: "Không PASS chỉ vì CLI báo SUCCESS".
   */
  async runQualityGateForTask(
    taskId: string,
    options: RunQualityGateOptions = {},
  ): Promise<QualityGateResult> {
    const startTime = Date.now();
    const task = this.taskRepo.findById(taskId);
    if (!task) {
      throw new AppError('TASK_NOT_FOUND', `Task with id '${taskId}' not found`, { taskId });
    }

    // Determine target repository directory
    let repoPath = options.repoPath ? path.resolve(options.repoPath) : process.cwd();
    if (!options.repoPath && this.scopeDiffService) {
      try {
        const resolved = this.scopeDiffService.resolveTaskScope(taskId);
        if (resolved.repoPath) {
          repoPath = resolved.repoPath;
        }
      } catch {
        // Fall back to cwd
      }
    }

    // Determine Run and CLI status if available
    let runId = options.runId ?? null;
    let cliExitCode: number | null = null;
    let cliStatus: string | null = null;

    if (runId) {
      const run = this.runRepo.getById(runId);
      if (run) {
        cliExitCode = run.exit_code ?? null;
        cliStatus = run.status;
      }
    } else {
      const runs = this.runRepo.findByTaskId(taskId);
      if (runs.length > 0) {
        const latestRun = runs[runs.length - 1];
        if (latestRun) {
          runId = latestRun.id;
          cliExitCode = latestRun.exit_code ?? null;
          cliStatus = latestRun.status;
        }
      }
    }

    // 1. Verification Commands Pipeline (QLT-002)
    let commandRecords = options.evidenceOverrides?.commandRecords ?? [];
    if (!options.skipCommands && (!options.evidenceOverrides?.commandRecords || options.evidenceOverrides.commandRecords.length === 0)) {
      if (this.qualityRunner && this.qualityConfigService) {
        try {
          const pipelineResult = await this.qualityRunner.runForTask(taskId, {
            runId: runId ?? undefined,
            repoPath,
            stopOnFirstFailure: false, // Run all commands to collect full evidence
          });
          commandRecords = pipelineResult.records;
        } catch (runnerErr) {
          logger.warn(`QualityRunner failed to execute pipeline for task '${taskId}'`, {
            taskId,
            error: runnerErr instanceof Error ? runnerErr.message : String(runnerErr),
          });
        }
      }
    }

    // 2. Scope Diff Verification (QLT-003)
    let scopeResult = options.evidenceOverrides?.scopeResult ?? null;
    if (!options.skipScope && !options.evidenceOverrides?.scopeResult && this.scopeDiffService) {
      try {
        scopeResult = await this.scopeDiffService.checkTaskScope(taskId, {
          runId: runId ?? undefined,
        });
      } catch (scopeErr) {
        logger.warn(`ScopeDiffService failed for task '${taskId}'`, {
          taskId,
          error: scopeErr instanceof Error ? scopeErr.message : String(scopeErr),
        });
      }
    }

    // 3. Reviewer Agent Verification (QLT-004)
    let reviewResult = options.evidenceOverrides?.reviewResult ?? null;
    if (!options.skipReview && !options.evidenceOverrides?.reviewResult && this.reviewerService) {
      try {
        reviewResult = await this.reviewerService.reviewTask(taskId, {
          runId: runId ?? undefined,
          repoPath,
        });
      } catch (reviewErr) {
        logger.warn(`ReviewerService failed for task '${taskId}'`, {
          taskId,
          error: reviewErr instanceof Error ? reviewErr.message : String(reviewErr),
        });
      }
    }

    // 4. Security Check: Audit & Secrets (QLT-005)
    let securityResult = options.evidenceOverrides?.securityResult ?? null;
    if (!options.skipSecurity && !options.evidenceOverrides?.securityResult && this.securityCheckService) {
      try {
        securityResult = await this.securityCheckService.checkTask(taskId, {
          runId: runId ?? undefined,
          repoPath,
        });
      } catch (secErr) {
        logger.warn(`SecurityCheckService failed for task '${taskId}'`, {
          taskId,
          error: secErr instanceof Error ? secErr.message : String(secErr),
        });
      }
    }

    const durationMs = Math.max(0, Date.now() - startTime);

    const evidenceInput: QualityGateEvidenceInput = {
      cliExitCode: options.evidenceOverrides?.cliExitCode !== undefined ? options.evidenceOverrides.cliExitCode : cliExitCode,
      cliStatus: options.evidenceOverrides?.cliStatus !== undefined ? options.evidenceOverrides.cliStatus : cliStatus,
      commandRecords,
      scopeResult,
      reviewResult,
      securityResult,
    };

    return this.evaluate(evidenceInput, {
      policy: options.policy,
      taskId,
      runId: runId ?? undefined,
      repoPath,
      durationMs,
    });
  }

  /**
   * Executes Quality Gate verification and updates task state machine based on evidence.
   * If PASSED -> task transitions to DONE.
   * If FAILED -> task transitions to FAILED.
   *
   * Crucial rule: Task is NEVER marked DONE simply because CLI exited 0!
   */
  async verifyAndTransitionTask(
    taskId: string,
    options: VerifyTaskOptions = {},
  ): Promise<{ result: QualityGateResult; task: TaskWithDependencies }> {
    const existingTask = this.taskRepo.findById(taskId);
    if (!existingTask) {
      throw new AppError('TASK_NOT_FOUND', `Task with id '${taskId}' not found`, { taskId });
    }

    // If task is in RUNNING, transition to VERIFYING first
    if (existingTask.status === 'RUNNING') {
      this.stateService.markVerifying(taskId, {
        reason: options.customReason ?? 'Execution completed, commencing Quality Gate verification',
        runId: options.runId,
      });
    }

    // Execute Quality Gate
    const result = await this.runQualityGateForTask(taskId, options);

    const autoTransition = options.autoTransition ?? true;
    let updatedTask = this.taskRepo.findById(taskId)!;

    if (autoTransition) {
      const currentTask = this.taskRepo.findById(taskId);
      if (currentTask && (currentTask.status === 'VERIFYING' || currentTask.status === 'RUNNING')) {
        if (result.passed) {
          logger.info(`Task '${taskId}' passed Quality Gate. Transitioning to DONE.`, {
            taskId,
            summary: result.summary,
          });
          updatedTask = this.stateService.markDone(taskId, {
            reason: options.customReason ?? `Quality Gate PASSED: ${result.summary}`,
            runId: options.runId ?? result.run_id ?? undefined,
          });
        } else {
          logger.warn(`Task '${taskId}' failed Quality Gate. Transitioning to FAILED.`, {
            taskId,
            summary: result.summary,
          });
          updatedTask = this.stateService.markFailed(taskId, {
            reason: options.customReason ?? `Quality Gate FAILED: ${result.summary}`,
            runId: options.runId ?? result.run_id ?? undefined,
          });
        }
      }
    }

    return { result, task: updatedTask };
  }

  getLatestForTask(taskId: string): QualityGateResult | null {
    return this.qualityGateRepo.findLatestByTaskId(taskId);
  }

  getById(id: string): QualityGateResult | null {
    return this.qualityGateRepo.getById(id);
  }

  getHistoryForTask(taskId: string, limit = 50): QualityGateResult[] {
    return this.qualityGateRepo.findByTaskId(taskId, limit);
  }

  getByRunId(runId: string): QualityGateResult[] {
    return this.qualityGateRepo.findByRunId(runId);
  }
}
