import path from 'node:path';
import type Database from 'better-sqlite3';
import { TaskRepository, RunRepository } from '@ai-orchestrator/db';
import {
  AppError,
  type TaskWithDependencies,
  type TaskFilter,
  type UpdateTaskInput,
  type TaskStatus,
  type TaskDependencyStatus,
  type TaskRunHistory,
  type Checkpoint,
  type CreateCheckpointInput,
  type CheckpointFilter,
  type RecordTaskCommitInput,
  type RecordTaskCommitResult,
  RecordTaskCommitInputSchema,
  RecordTaskCommitResultSchema,
  gitCommit,
  formatConventionalCommit,
  validateConventionalCommit,
} from '@ai-orchestrator/shared';
import { TaskStateService, type TransitionTaskOptions } from './task-state-service.js';
import {
  DependencyResolverService,
  type ResolveServiceOptions,
} from './dependency-resolver-service.js';
import { TaskHistoryService } from './task-history-service.js';

export class TaskService {
  private readonly taskRepo: TaskRepository;
  private readonly runRepo: RunRepository;
  private readonly stateService: TaskStateService;
  private readonly resolverService: DependencyResolverService;
  private readonly historyService: TaskHistoryService;

  constructor(db: Database.Database) {
    this.taskRepo = new TaskRepository(db);
    this.runRepo = new RunRepository(db);
    this.stateService = new TaskStateService(db);
    this.resolverService = new DependencyResolverService(db);
    this.historyService = new TaskHistoryService({ db });
  }

  get state(): TaskStateService {
    return this.stateService;
  }

  get resolver(): DependencyResolverService {
    return this.resolverService;
  }

  get history(): TaskHistoryService {
    return this.historyService;
  }

  list(filter?: TaskFilter, search?: string): TaskWithDependencies[] {
    let tasks = this.taskRepo.findAll(filter);
    if (search && search.trim().length > 0) {
      const q = search.trim().toLowerCase();
      tasks = tasks.filter(
        (t) =>
          t.id.toLowerCase().includes(q) ||
          t.title.toLowerCase().includes(q) ||
          (t.description && t.description.toLowerCase().includes(q)),
      );
    }
    return tasks;
  }

  getById(id: string): TaskWithDependencies {
    const task = this.taskRepo.findById(id);
    if (!task) {
      throw new AppError('TASK_NOT_FOUND', `Task with id '${id}' not found`, { taskId: id });
    }
    return task;
  }

  update(id: string, input: UpdateTaskInput): TaskWithDependencies {
    return this.taskRepo.update(id, input);
  }

  transition(
    id: string,
    targetStatus: TaskStatus,
    options?: TransitionTaskOptions,
  ): TaskWithDependencies {
    return this.stateService.transition(id, targetStatus, options);
  }

  getAllowedTransitions(id: string): readonly TaskStatus[] {
    return this.stateService.getAllowedTransitions(id);
  }

  getReadyTasks(filter?: TaskFilter, options?: ResolveServiceOptions): TaskWithDependencies[] {
    return this.resolverService.getReadyTasks(filter, options);
  }

  getNextReadyTask(
    filter?: TaskFilter,
    options?: { autoTransition?: boolean },
  ): TaskWithDependencies | null {
    return this.resolverService.getNextReadyTask(filter, options);
  }

  getDependencyStatus(id: string): TaskDependencyStatus {
    return this.resolverService.getDependencyStatus(id);
  }

  resolveReady(filter?: TaskFilter): TaskWithDependencies[] {
    return this.resolverService.resolveAndTransitionReady(filter);
  }

  retry(
    id: string,
    options?: {
      reason?: string;
      runId?: string;
      force?: boolean;
    },
  ) {
    return this.stateService.retryTask(id, options);
  }

  resetAttempts(id: string, newAttempts = 0): TaskWithDependencies {
    return this.stateService.resetAttempts(id, newAttempts);
  }

  getHistory(id: string): TaskRunHistory {
    return this.historyService.getTaskRunHistory(id);
  }

  getCheckpoints(id: string, filter?: Omit<CheckpointFilter, 'task_id'>): Checkpoint[] {
    return this.historyService.getCheckpoints({ ...filter, task_id: id });
  }

  createCheckpoint(input: CreateCheckpointInput): Checkpoint {
    return this.historyService.createCheckpoint(input);
  }

  getLatestCheckpoint(id: string): Checkpoint | null {
    return this.historyService.getLatestCheckpoint(id);
  }

  /**
   * Thực hiện commit chuẩn hóa và/hoặc ghi nhận commit SHA cho task vào DB (REL-004).
   */
  async recordTaskCommit(
    id: string,
    input?: RecordTaskCommitInput,
  ): Promise<RecordTaskCommitResult> {
    const task = this.getById(id);
    const validated = RecordTaskCommitInputSchema.parse(input ?? {});

    let commitSha: string;
    let message: string;
    let shortSha: string;

    if (validated.commit_sha) {
      commitSha = validated.commit_sha;
      shortSha = commitSha.slice(0, 7);
      message = validated.message ?? `feat(${id}): ${task.title}`;
    } else {
      const type = (validated.type || 'feat') as
        | 'feat'
        | 'fix'
        | 'docs'
        | 'style'
        | 'refactor'
        | 'perf'
        | 'test'
        | 'build'
        | 'ci'
        | 'chore'
        | 'revert';
      const scope = validated.scope || id;
      const subject = validated.subject || task.title;
      message =
        validated.message ??
        formatConventionalCommit({
          type,
          scope,
          subject,
          body: validated.body,
        });
      validateConventionalCommit(message);

      const repoPath = path.resolve(validated.repo_path ?? task.repository ?? '.');
      const gitResult = await gitCommit(repoPath, {
        message,
        files: validated.files,
        stageAll: validated.stage_all,
        allowEmpty: validated.allow_empty,
        validateMessage: true,
      });
      commitSha = gitResult.commitSha;
      shortSha = gitResult.shortSha;
      message = gitResult.message;
    }

    // Lưu SHA vào DB (bảng runs)
    let runId: string | null = null;
    if (validated.run_id) {
      runId = validated.run_id;
      this.runRepo.update(runId, { commit_sha: commitSha });
    } else {
      const runs = this.runRepo.findByTaskId(id);
      if (runs.length > 0) {
        // Runs are sorted by started_at DESC in typical queries, update the latest run
        const latestRun = runs[runs.length - 1];
        if (latestRun) {
          runId = latestRun.id;
          this.runRepo.update(runId, { commit_sha: commitSha });
        }
      }
    }

    const recordedAt = new Date().toISOString();

    return RecordTaskCommitResultSchema.parse({
      task_id: id,
      run_id: runId,
      commit_sha: commitSha,
      short_sha: shortSha,
      message,
      recorded_at: recordedAt,
    });
  }
}
