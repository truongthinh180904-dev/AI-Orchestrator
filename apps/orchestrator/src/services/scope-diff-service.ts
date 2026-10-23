import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  type ScopeDiffResult,
  type CompareScopeInput,
  type TaskWithDependencies,
  type FileDiffDetail,
  CompareScopeInputSchema,
  evaluateScopeCompliance,
  getGitDiff,
  AppError,
  logger,
} from '@ai-orchestrator/shared';
import {
  TaskRepository,
  PlanRepository,
  ReportRepository,
} from '@ai-orchestrator/db';
import type { RepositoryRegistry } from '../adapters/repository-registry.js';

export interface ScopeDiffServiceOptions {
  db: Database.Database;
  taskRepo?: TaskRepository;
  planRepo?: PlanRepository;
  reportRepo?: ReportRepository;
  repositoryRegistry?: RepositoryRegistry;
}

export class ScopeDiffService {
  private readonly db: Database.Database;
  private readonly taskRepo: TaskRepository;
  private readonly planRepo: PlanRepository;
  private readonly reportRepo: ReportRepository;
  private readonly repositoryRegistry?: RepositoryRegistry;

  constructor(options: ScopeDiffServiceOptions) {
    this.db = options.db;
    this.taskRepo = options.taskRepo ?? new TaskRepository(this.db);
    this.planRepo = options.planRepo ?? new PlanRepository(this.db);
    this.reportRepo = options.reportRepo ?? new ReportRepository(this.db);
    this.repositoryRegistry = options.repositoryRegistry;
  }

  /**
   * Resolves scope_files and repository directory for a task.
   * Pulls from task record, falling back to associated plan task definition if needed.
   */
  resolveTaskScope(taskId: string): {
    task: TaskWithDependencies;
    scopeFiles: string[];
    repoPath: string;
  } {
    const task = this.taskRepo.findById(taskId);
    if (!task) {
      throw new AppError('TASK_NOT_FOUND', `Task with id '${taskId}' not found`, { taskId });
    }

    let scopeFiles: string[] = task.scope_files ?? [];

    // Fallback: look up in associated plan if task's own scope_files is empty
    if (scopeFiles.length === 0 && task.plan_id) {
      const plan = this.planRepo.findById(task.plan_id);
      if (plan) {
        const planTask = plan.tasks.find((t) => t.id === taskId);
        if (planTask?.scope_files && planTask.scope_files.length > 0) {
          scopeFiles = planTask.scope_files;
        }
      }
    }

    // Resolve repository path
    let repoPath = task.repository && task.repository !== '.' ? task.repository : process.cwd();
    if (this.repositoryRegistry) {
      const regRepo = this.repositoryRegistry.get(repoPath);
      if (regRepo) {
        repoPath = regRepo.path;
      } else {
        repoPath = path.resolve(repoPath);
      }
    } else {
      repoPath = path.resolve(repoPath);
    }

    return {
      task,
      scopeFiles,
      repoPath,
    };
  }

  /**
   * Compares git diff of a repository against allowed scope patterns.
   * Correctly lists all out-of-scope files ("file lạ") and evaluates scope cleanliness.
   */
  async compareScope(input: CompareScopeInput): Promise<ScopeDiffResult> {
    const validated = CompareScopeInputSchema.parse(input);

    let repoPath = validated.repoPath;
    let scopeFiles = validated.scopeFiles ?? [];
    const taskId = validated.taskId ?? null;

    if (taskId) {
      const resolved = this.resolveTaskScope(taskId);
      if (!repoPath) {
        repoPath = resolved.repoPath;
      }
      if (scopeFiles.length === 0) {
        scopeFiles = resolved.scopeFiles;
      }
    }

    if (!repoPath) {
      repoPath = process.cwd();
    } else {
      repoPath = path.resolve(repoPath);
    }

    if (this.repositoryRegistry) {
      this.repositoryRegistry.assertCwdValid(repoPath);
    }

    // Retrieve git diff including untracked files
    const diffResult = await getGitDiff(repoPath, {
      baseRef: validated.baseRef,
      targetRef: validated.targetRef,
      includeUntracked: validated.includeUntracked ?? true,
    });

    // Evaluate scope compliance & detect out-of-scope files ("file lạ")
    const compliance = evaluateScopeCompliance({
      changedFiles: diffResult.changedFiles,
      scopeFiles,
      fileDiffs: diffResult.fileDiffs,
      rawDiff: diffResult.rawDiff,
      taskId,
      repoPath,
      baseRef: validated.baseRef ?? null,
      targetRef: validated.targetRef ?? null,
    });

    // Optionally persist report if associated with a run
    if (validated.runId) {
      try {
        this.reportRepo.create({
          run_id: validated.runId,
          kind: 'scope_diff',
          content: JSON.stringify(compliance),
        });
      } catch (err) {
        logger.warn('Failed to save scope_diff report for run', {
          runId: validated.runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('Scope diff evaluation completed', {
      taskId,
      repoPath,
      totalChanged: compliance.stats.totalChanged,
      inScopeCount: compliance.stats.inScopeCount,
      outOfScopeCount: compliance.stats.outOfScopeCount,
      outOfScopeFiles: compliance.outOfScopeFiles,
      isScopeClean: compliance.isScopeClean,
    });

    return compliance;
  }

  /**
   * Convenience helper to evaluate scope diff directly for a specific task.
   */
  async checkTaskScope(
    taskId: string,
    options?: {
      baseRef?: string;
      targetRef?: string;
      includeUntracked?: boolean;
      runId?: string;
    },
  ): Promise<ScopeDiffResult> {
    return this.compareScope({
      taskId,
      baseRef: options?.baseRef,
      targetRef: options?.targetRef,
      includeUntracked: options?.includeUntracked ?? true,
      runId: options?.runId,
    });
  }

  /**
   * Retrieves diff details specifically for a task, useful for UI diff viewers.
   */
  async getTaskDiff(
    taskId: string,
    options?: {
      baseRef?: string;
      targetRef?: string;
      includeUntracked?: boolean;
    },
  ): Promise<{
    taskId: string;
    repoPath: string;
    scopeFiles: string[];
    isScopeClean: boolean;
    outOfScopeFiles: string[];
    changedFiles: string[];
    fileDiffs: FileDiffDetail[];
    rawDiff: string;
  }> {
    const scopeResult = await this.checkTaskScope(taskId, options);
    return {
      taskId,
      repoPath: scopeResult.repoPath,
      scopeFiles: scopeResult.scopeFiles,
      isScopeClean: scopeResult.isScopeClean,
      outOfScopeFiles: scopeResult.outOfScopeFiles,
      changedFiles: scopeResult.changedFiles,
      fileDiffs: scopeResult.fileDiffs,
      rawDiff: scopeResult.rawDiff,
    };
  }
}
