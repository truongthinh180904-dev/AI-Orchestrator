import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  type Env,
  type ReviewFinding,
  type ReviewFindingRecord,
  type ReviewResult,
  type ReviewDiffInput,
  type ReviewFindingFilter,
  type Task,
  ReviewDiffInputSchema,
  computeReviewStats,
  isReviewPassing,
  extractJsonFindings,
  validateReviewFindings,
  buildReviewerPrompt,
  AppError,
  logger,
  getGitDiff,
} from '@ai-orchestrator/shared';
import {
  ReviewFindingRepository,
  ReportRepository,
  TaskRepository,
} from '@ai-orchestrator/db';
import { processAdapter, ProcessAdapter, type ProcessHandle } from '../adapters/process-adapter.js';
import type { RepositoryRegistry } from '../adapters/repository-registry.js';
import type { ScopeDiffService } from './scope-diff-service.js';
import { getOrchestratorConfig } from '../config.js';
import { buildAgyArgs } from './agy-args.js';

export interface ReviewerServiceOptions {
  db: Database.Database;
  processAdapter?: ProcessAdapter;
  repositoryRegistry?: RepositoryRegistry;
  scopeDiffService?: ScopeDiffService;
  config?: Partial<Env>;
  findingRepo?: ReviewFindingRepository;
  reportRepo?: ReportRepository;
  taskRepo?: TaskRepository;
}

export interface ReviewTaskOptions {
  runId?: string;
  repoPath?: string;
  baseRef?: string;
  targetRef?: string;
  customPrompt?: string;
  timeoutMs?: number;
  command?: {
    exe?: string;
    args?: string[];
  };
}

export class ReviewerService {
  private readonly db: Database.Database;
  private readonly processAdapter: ProcessAdapter;
  private readonly repositoryRegistry?: RepositoryRegistry;
  private readonly scopeDiffService?: ScopeDiffService;
  private readonly findingRepo: ReviewFindingRepository;
  private readonly reportRepo: ReportRepository;
  private readonly taskRepo: TaskRepository;
  private readonly config: Partial<Env>;

  constructor(options: ReviewerServiceOptions) {
    this.db = options.db;
    this.processAdapter = options.processAdapter ?? processAdapter;
    this.repositoryRegistry = options.repositoryRegistry;
    this.scopeDiffService = options.scopeDiffService;
    this.findingRepo = options.findingRepo ?? new ReviewFindingRepository(this.db);
    this.reportRepo = options.reportRepo ?? new ReportRepository(this.db);
    this.taskRepo = options.taskRepo ?? new TaskRepository(this.db);

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

  getFindingRepository(): ReviewFindingRepository {
    return this.findingRepo;
  }

  /**
   * Parses raw text from agent output, extracts JSON findings, validates them against Zod schema,
   * evaluates Quality Gate pass/fail status, and persists records in SQLite and reports table.
   */
  parseAndValidateReview(
    rawOutput: string,
    context?: {
      taskId?: string;
      runId?: string;
      reviewerType?: string;
    },
  ): ReviewResult {
    let rawJson: unknown;
    try {
      rawJson = extractJsonFindings(rawOutput);
    } catch (err) {
      throw new AppError(
        'INVALID_REVIEW_FINDINGS',
        `Failed to extract JSON from reviewer agent output: ${(err as Error).message}`,
        { rawOutput },
      );
    }

    let findings: ReviewFinding[];
    try {
      findings = validateReviewFindings(rawJson);
    } catch (err) {
      throw new AppError(
        'INVALID_REVIEW_SCHEMA',
        `Reviewer output failed schema validation: ${(err as Error).message}`,
        { rawJson, rawOutput },
      );
    }

    const stats = computeReviewStats(findings);
    const passed = isReviewPassing(findings);
    const now = new Date().toISOString();
    const resultId = crypto.randomUUID();

    const summary = passed
      ? findings.length === 0
        ? 'Review passed: No issues found.'
        : `Review passed with ${findings.length} minor finding(s). 0 critical, 0 high.`
      : `Review failed: Found ${stats.critical} critical and ${stats.high} high severity issue(s).`;

    // Check FK validity before database insertion to prevent SQLite constraint failures
    let validTaskId: string | null = null;
    if (context?.taskId) {
      const taskExists = this.taskRepo.findById(context.taskId);
      if (taskExists) {
        validTaskId = context.taskId;
      }
    }

    let validRunId: string | null = null;
    if (context?.runId) {
      const runExists = this.db.prepare('SELECT id FROM runs WHERE id = ?').get(context.runId);
      if (runExists) {
        validRunId = context.runId;
      }
    }

    // Persist individual findings to database
    if (findings.length > 0) {
      try {
        this.findingRepo.createBatch(
          findings.map((f) => ({
            id: f.id ?? crypto.randomUUID(),
            task_id: validTaskId,
            run_id: validRunId,
            severity: f.severity,
            file: f.file,
            line: f.line,
            message: f.message,
            category: f.category ?? null,
            rule_id: f.rule_id ?? null,
            suggestion: f.suggestion ?? null,
            created_at: now,
          })),
        );
      } catch (err) {
        logger.error(`Failed to persist review findings: ${(err as Error).message}`, {
          taskId: context?.taskId,
          runId: context?.runId,
        });
      }
    }

    const result: ReviewResult = {
      id: resultId,
      task_id: context?.taskId ?? null,
      run_id: context?.runId ?? null,
      passed,
      findings,
      stats,
      summary,
      raw_output: rawOutput,
      reviewed_at: now,
      reviewer_type: context?.reviewerType ?? 'agy',
    };

    // Store review report in reports table
    if (validRunId || (context?.runId && !this.db.prepare('PRAGMA foreign_keys').get())) {
      try {
        this.reportRepo.create({
          id: crypto.randomUUID(),
          run_id: validRunId,
          kind: 'review_findings',
          content: JSON.stringify(result, null, 2),
          created_at: now,
        });
      } catch (err) {
        logger.warn(`Failed to store review_findings report: ${(err as Error).message}`, {
          taskId: context?.taskId,
          runId: context?.runId,
        });
      }
    } else if (context?.taskId) {
      try {
        this.reportRepo.create({
          id: crypto.randomUUID(),
          run_id: null,
          kind: 'review_findings',
          content: JSON.stringify(result, null, 2),
          created_at: now,
        });
      } catch (err) {
        logger.warn(`Failed to store review_findings report: ${(err as Error).message}`, {
          taskId: context?.taskId,
        });
      }
    }

    return result;
  }

  /**
   * Runs the reviewer agent against a code diff and task specification.
   */
  async reviewDiff(input: ReviewDiffInput): Promise<ReviewResult> {
    const validatedInput = ReviewDiffInputSchema.parse(input);

    const repoPath = validatedInput.repoPath ? path.resolve(validatedInput.repoPath) : process.cwd();
    if (!fs.existsSync(repoPath)) {
      throw new AppError('PATH_NOT_FOUND', `Repository directory does not exist: ${repoPath}`, {
        repoPath,
      });
    }

    if (this.repositoryRegistry) {
      this.repositoryRegistry.assertCwdValid(repoPath);
    }

    const prompt =
      validatedInput.customPrompt ??
      buildReviewerPrompt({
        diff: validatedInput.diff,
        changedFiles: validatedInput.changedFiles,
        task: {
          id: validatedInput.taskId,
          title: validatedInput.taskTitle,
          description: validatedInput.taskDescription,
          acceptance_criteria: validatedInput.acceptanceCriteria,
          scope_files: validatedInput.scopeFiles,
        },
      });

    const exe = validatedInput.command?.exe ?? this.config.AGY_BIN ?? 'agy';
    let args: string[];
    if (validatedInput.command?.args) {
      args = [...validatedInput.command.args];
    } else {
      args = buildAgyArgs(this.config.AGY_ARGS, prompt);
    }

    logger.info('Executing reviewer agent', {
      exe,
      repoPath,
      taskId: validatedInput.taskId,
      runId: validatedInput.runId,
    });

    let handle: ProcessHandle;
    try {
      handle = this.processAdapter.spawn({
        exe,
        args,
        cwd: repoPath,
      });
    } catch (err) {
      throw new AppError(
        'REVIEWER_SPAWN_ERROR',
        `Failed to spawn reviewer process: ${(err as Error).message}`,
        { exe, args, repoPath },
      );
    }

    let stdoutData = '';
    let stderrData = '';

    handle.stdout.on('data', (chunk) => {
      stdoutData += chunk.toString('utf8');
    });

    handle.stderr.on('data', (chunk) => {
      stderrData += chunk.toString('utf8');
    });

    let timeoutTimer: NodeJS.Timeout | undefined;
    if (validatedInput.timeoutMs && validatedInput.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        try {
          void handle.terminate({ forceSignal: 'SIGKILL', gracePeriodMs: 2000 });
        } catch {
          // ignore
        }
      }, validatedInput.timeoutMs);
    }

    const exitResult = await handle.waitForExit().finally(() => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
    });

    const rawOutput = stdoutData.trim() || stderrData.trim();
    if (exitResult.exitCode !== 0 && !rawOutput) {
      throw new AppError(
        'REVIEWER_EXECUTION_FAILED',
        `Reviewer process exited with code ${exitResult.exitCode}: ${stderrData.trim() || 'No output'}`,
        {
          exitCode: exitResult.exitCode,
          stderr: stderrData,
          stdout: stdoutData,
        },
      );
    }

    return this.parseAndValidateReview(rawOutput, {
      taskId: validatedInput.taskId,
      runId: validatedInput.runId,
      reviewerType: 'agy',
    });
  }

  /**
   * Reviews a specific task by resolving its git diff, metadata and running reviewer agent.
   */
  async reviewTask(taskId: string, options: ReviewTaskOptions = {}): Promise<ReviewResult> {
    const task: Task | null = this.taskRepo.findById(taskId);
    if (!task) {
      throw new AppError('TASK_NOT_FOUND', `Task with id ${taskId} does not exist`, { taskId });
    }

    let repoPath = options.repoPath ? path.resolve(options.repoPath) : process.cwd();
    if (this.scopeDiffService) {
      const resolved = this.scopeDiffService.resolveTaskScope(taskId);
      if (resolved.repoPath && !options.repoPath) {
        repoPath = resolved.repoPath;
      }
    }

    // Extract git diff for the repository
    let diff = '';
    let changedFiles: string[] = [];
    try {
      const diffResult = await getGitDiff(repoPath, {
        baseRef: options.baseRef,
        targetRef: options.targetRef,
        includeUntracked: true,
      });
      diff = diffResult.rawDiff;
      changedFiles = diffResult.changedFiles;
    } catch (err) {
      logger.warn(`Could not extract git diff for task review: ${(err as Error).message}`, {
        taskId,
        repoPath,
      });
    }

    return this.reviewDiff({
      taskId: task.id,
      runId: options.runId,
      repoPath,
      diff,
      changedFiles,
      taskTitle: task.title,
      taskDescription: task.description,
      acceptanceCriteria: task.acceptance_criteria,
      scopeFiles: task.scope_files,
      customPrompt: options.customPrompt,
      timeoutMs: options.timeoutMs,
      command: options.command,
    });
  }

  getFindingsForTask(taskId: string): ReviewFindingRecord[] {
    return this.findingRepo.findByTaskId(taskId);
  }

  getFindingsForRun(runId: string): ReviewFindingRecord[] {
    return this.findingRepo.findByRunId(runId);
  }

  listFindings(filter: ReviewFindingFilter = {}): ReviewFindingRecord[] {
    return this.findingRepo.find(filter);
  }

  countFindings(filter: ReviewFindingFilter = {}): number {
    return this.findingRepo.count(filter);
  }

  deleteFindingsForTask(taskId: string): number {
    return this.findingRepo.deleteByTaskId(taskId);
  }

  deleteFindingsForRun(runId: string): number {
    return this.findingRepo.deleteByRunId(runId);
  }
}
