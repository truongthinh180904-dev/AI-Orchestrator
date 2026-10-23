import type Database from 'better-sqlite3';
import {
  TaskRepository,
  RunRepository,
  EventRepository,
  CheckpointRepository,
  ReportRepository,
} from '@ai-orchestrator/db';
import {
  type Run,
  type Checkpoint,
  type Report,
  type CreateCheckpointInput,
  type CheckpointFilter,
  type CreateReportInput,
  type ReportFilter,
  type TaskRunHistory,
  type TaskAttemptHistoryItem,
  type RunDetail,
  type RunResultSummary,
  type RunOutcome,
  AppError,
} from '@ai-orchestrator/shared';

export interface TaskHistoryServiceOptions {
  db: Database.Database;
}

export class TaskHistoryService {
  private readonly db: Database.Database;
  private readonly taskRepo: TaskRepository;
  private readonly runRepo: RunRepository;
  private readonly eventRepo: EventRepository;
  private readonly checkpointRepo: CheckpointRepository;
  private readonly reportRepo: ReportRepository;

  constructor(options: TaskHistoryServiceOptions) {
    this.db = options.db;
    this.taskRepo = new TaskRepository(this.db);
    this.runRepo = new RunRepository(this.db);
    this.eventRepo = new EventRepository(this.db);
    this.checkpointRepo = new CheckpointRepository(this.db);
    this.reportRepo = new ReportRepository(this.db);
  }

  getCheckpointRepository(): CheckpointRepository {
    return this.checkpointRepo;
  }

  getReportRepository(): ReportRepository {
    return this.reportRepo;
  }

  /**
   * Computes a structured result summary for a given run based on its status,
   * exit code, duration, events, checkpoints, and reports.
   */
  computeRunResult(run: Run): RunResultSummary {
    let outcome: RunOutcome;
    let success: boolean;

    switch (run.status) {
      case 'SUCCESS':
        outcome = 'SUCCESS';
        success = true;
        break;
      case 'TIMEOUT':
        outcome = 'TIMEOUT';
        success = false;
        break;
      case 'CANCELLED':
        outcome = 'CANCELLED';
        success = false;
        break;
      case 'RUNNING':
      case 'PENDING':
        outcome = 'IN_PROGRESS';
        success = false;
        break;
      case 'ERROR':
      case 'INVALID_OUTPUT':
        outcome = 'ERROR';
        success = false;
        break;
      default:
        outcome = 'UNKNOWN';
        success = false;
        break;
    }

    let durationMs: number | null = null;
    if (run.started_at && run.finished_at) {
      const start = new Date(run.started_at).getTime();
      const end = new Date(run.finished_at).getTime();
      if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
        durationMs = end - start;
      }
    }

    // Event & checkpoint counts
    const eventCount = this.eventRepo.countByRunId(run.id);
    const checkpointCount = this.checkpointRepo.countByRunId(run.id);
    const reportCount = this.reportRepo.countByRunId(run.id);

    // Extract error message from events if execution failed
    let errorMessage: string | null = null;
    if (!success) {
      const errorEvents = this.eventRepo.findByRunId(run.id, { type: 'stderr' });
      if (errorEvents.length > 0) {
        const lastError = errorEvents[errorEvents.length - 1];
        if (lastError && typeof lastError.payload === 'object' && lastError.payload !== null) {
          const payloadObj = lastError.payload as Record<string, unknown>;
          errorMessage = typeof payloadObj['text'] === 'string' ? payloadObj['text'] : null;
        }
      }
      if (!errorMessage) {
        const resultEvents = this.eventRepo.findByRunId(run.id, { type: 'result' });
        if (resultEvents.length > 0) {
          const lastResult = resultEvents[resultEvents.length - 1];
          if (lastResult && typeof lastResult.payload === 'object' && lastResult.payload !== null) {
            const p = lastResult.payload as Record<string, unknown>;
            if (typeof p['error'] === 'string') errorMessage = p['error'];
            else if (typeof p['message'] === 'string') errorMessage = p['message'];
          }
        }
      }
    }

    return {
      outcome,
      success,
      exit_code: run.exit_code,
      duration_ms: durationMs,
      error_message: errorMessage,
      event_count: eventCount,
      checkpoint_count: checkpointCount,
      report_count: reportCount,
    };
  }

  /**
   * Retrieves full chronological run history for a task, including each attempt,
   * associated run record, outcome result summary, checkpoints, and reports.
   */
  getTaskRunHistory(taskId: string): TaskRunHistory {
    const task = this.taskRepo.findById(taskId);
    if (!task) {
      throw new AppError('TASK_NOT_FOUND', `Task with id '${taskId}' not found`, { taskId });
    }

    const runs = this.runRepo.findByTaskId(taskId);
    const history: TaskAttemptHistoryItem[] = [];

    for (const run of runs) {
      const result = this.computeRunResult(run);
      const checkpoints = this.checkpointRepo.findByRunId(run.id);
      const reports = this.reportRepo.findByRunId(run.id);

      history.push({
        attempt: run.attempt,
        run,
        result,
        checkpoints,
        reports,
      });
    }

    const latestRun = runs.length > 0 ? (runs[runs.length - 1] ?? null) : null;
    const latestCheckpoint = this.checkpointRepo.getLatestByTaskId(taskId);

    return {
      taskId: task.id,
      taskTitle: task.title,
      taskStatus: task.status,
      attempts: task.attempts,
      maxAttempts: task.max_attempts,
      latestRun,
      latestCheckpoint,
      history,
    };
  }

  /**
   * Deep run inspection ("Truy lại từng run"): retrieves all metadata, outcome summary,
   * checkpoints, reports, events list, and event stats for a specific run ID.
   */
  getRunDetail(runId: string): RunDetail {
    const run = this.runRepo.getById(runId);
    if (!run) {
      throw new AppError('RUN_NOT_FOUND', `Run with id '${runId}' not found`, { runId });
    }

    const task = this.taskRepo.findById(run.task_id);
    const result = this.computeRunResult(run);
    const checkpoints = this.checkpointRepo.findByRunId(runId);
    const reports = this.reportRepo.findByRunId(runId);
    const events = this.eventRepo.findByRunId(runId);

    const byType: Record<string, number> = {};
    for (const ev of events) {
      byType[ev.type] = (byType[ev.type] ?? 0) + 1;
    }

    return {
      run,
      task: task ?? null,
      result,
      checkpoints,
      reports,
      events,
      eventStats: {
        total: events.length,
        byType,
      },
    };
  }

  /**
   * Creates an execution checkpoint for a task and optional run.
   */
  createCheckpoint(input: CreateCheckpointInput): Checkpoint {
    const task = this.taskRepo.findById(input.task_id);
    if (!task) {
      throw new AppError('TASK_NOT_FOUND', `Task with id '${input.task_id}' not found`, {
        taskId: input.task_id,
      });
    }

    if (input.run_id) {
      const run = this.runRepo.getById(input.run_id);
      if (!run) {
        throw new AppError('RUN_NOT_FOUND', `Run with id '${input.run_id}' not found`, {
          runId: input.run_id,
        });
      }
    }

    return this.checkpointRepo.create(input);
  }

  /**
   * Queries checkpoints by filter criteria.
   */
  getCheckpoints(filter: CheckpointFilter): Checkpoint[] {
    if (filter.task_id) {
      return this.checkpointRepo.findByTaskId(filter.task_id, filter);
    }
    if (filter.run_id) {
      return this.checkpointRepo.findByRunId(filter.run_id);
    }
    throw new AppError(
      'INVALID_FILTER',
      'At least taskId or runId must be provided to query checkpoints',
    );
  }

  /**
   * Retrieves the latest checkpoint for a task.
   */
  getLatestCheckpoint(taskId: string): Checkpoint | null {
    const task = this.taskRepo.findById(taskId);
    if (!task) {
      throw new AppError('TASK_NOT_FOUND', `Task with id '${taskId}' not found`, { taskId });
    }
    return this.checkpointRepo.getLatestByTaskId(taskId);
  }

  /**
   * Creates an execution report.
   */
  createReport(input: CreateReportInput): Report {
    if (input.run_id) {
      const run = this.runRepo.getById(input.run_id);
      if (!run) {
        throw new AppError('RUN_NOT_FOUND', `Run with id '${input.run_id}' not found`, {
          runId: input.run_id,
        });
      }
    }
    return this.reportRepo.create(input);
  }

  /**
   * Queries reports for a specific run.
   */
  getReports(runId: string, filter?: ReportFilter): Report[] {
    const run = this.runRepo.getById(runId);
    if (!run) {
      throw new AppError('RUN_NOT_FOUND', `Run with id '${runId}' not found`, { runId });
    }
    return this.reportRepo.findByRunId(runId, filter);
  }
}
