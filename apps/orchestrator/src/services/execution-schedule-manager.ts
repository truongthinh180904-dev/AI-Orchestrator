import type Database from 'better-sqlite3';
import {
  type ScheduleConfig,
  type ScheduleConfigInput,
  type ScheduleEvaluationResult,
  type ScheduleStatus,
  type ScheduleEventRecord,
  type ScheduleEventType,
  ScheduleConfigSchema,
  evaluateSchedule,
  logger,
} from '@ai-orchestrator/shared';
import { ExecutionScheduleRepository } from '@ai-orchestrator/db';

export interface ExecutionScheduleManagerOptions {
  db?: Database.Database;
  config?: ScheduleConfigInput;
  clock?: () => Date;
}

export class ExecutionScheduleManager {
  private config: ScheduleConfig;
  private readonly scheduleRepo?: ExecutionScheduleRepository;
  private readonly clock: () => Date;

  constructor(options?: ExecutionScheduleManagerOptions) {
    this.clock = options?.clock ?? (() => new Date());

    if (options?.db) {
      this.scheduleRepo = new ExecutionScheduleRepository(options.db);
    }

    // Try loading persisted config from database if available, otherwise use input or defaults
    const persisted = this.scheduleRepo?.getConfig(options?.config?.id ?? 'default_schedule');
    if (persisted) {
      this.config = persisted;
      if (options?.config) {
        // Merge explicit options into persisted config
        this.config = ScheduleConfigSchema.parse({ ...persisted, ...options.config });
      }
    } else {
      this.config = ScheduleConfigSchema.parse(options?.config ?? {});
      if (this.scheduleRepo) {
        try {
          this.scheduleRepo.upsertConfig(this.config);
        } catch {
          // non-critical
        }
      }
    }
  }

  get currentConfig(): ScheduleConfig {
    return { ...this.config };
  }

  /**
   * Updates schedule configuration dynamically and logs/persists changes.
   */
  updateConfig(updates: Partial<ScheduleConfigInput>): ScheduleConfig {
    const merged = { ...this.config, ...updates };
    this.config = ScheduleConfigSchema.parse(merged);

    logger.info('Execution schedule configuration updated', { config: this.config });

    if (this.scheduleRepo) {
      try {
        this.scheduleRepo.upsertConfig(this.config);
        this.scheduleRepo.createEvent({
          event_type: 'CONFIG_UPDATED',
          schedule_id: this.config.id,
          details: { config: this.config },
          created_at: this.clock().toISOString(),
        });
      } catch (err) {
        logger.warn('Failed to persist schedule config update', { error: err });
      }
    }

    return { ...this.config };
  }

  /**
   * Evaluates if execution is permitted at the current clock time (or specified date).
   */
  canExecute(date?: Date): ScheduleEvaluationResult {
    const evalDate = date ?? this.clock();
    const result = evaluateSchedule(this.config, evalDate);

    // Audit logging for block events
    if (!result.allowed && this.scheduleRepo) {
      try {
        this.scheduleRepo.createEvent({
          event_type: result.reason === 'DEADLINE_REACHED' ? 'DEADLINE_REACHED' : 'EXECUTION_BLOCKED',
          schedule_id: this.config.id,
          details: {
            reason: result.reason,
            message: result.message,
            timestamp: result.currentTimestamp,
            localTime: result.currentLocalTime,
          },
          created_at: evalDate.toISOString(),
        });
      } catch {
        // non-critical
      }
    }

    return result;
  }

  /**
   * Convenience boolean check.
   */
  isAllowed(date?: Date): boolean {
    return this.canExecute(date).allowed;
  }

  /**
   * Evaluates any arbitrary timestamp against the current schedule config (useful for APIs/dry-run).
   */
  evaluate(targetTime?: Date | string | number): ScheduleEvaluationResult {
    let date: Date;
    if (!targetTime) {
      date = this.clock();
    } else if (targetTime instanceof Date) {
      date = targetTime;
    } else {
      date = new Date(targetTime);
    }
    return evaluateSchedule(this.config, date);
  }

  /**
   * Retrieves full schedule status including evaluation snapshot.
   */
  getStatus(): ScheduleStatus {
    const now = this.clock();
    const evaluation = this.canExecute(now);
    return {
      config: this.currentConfig,
      evaluation,
    };
  }

  /**
   * Records a custom schedule event.
   */
  recordEvent(
    eventType: ScheduleEventType,
    details?: Record<string, unknown>,
    taskId?: string | null,
    runId?: string | null,
  ): void {
    if (!this.scheduleRepo) return;
    try {
      this.scheduleRepo.createEvent({
        event_type: eventType,
        schedule_id: this.config.id,
        task_id: taskId,
        run_id: runId,
        details: details ?? {},
        created_at: this.clock().toISOString(),
      });
    } catch {
      // non-critical
    }
  }

  /**
   * Retrieves audit events.
   */
  getEvents(limit = 50): ScheduleEventRecord[] {
    if (!this.scheduleRepo) return [];
    return this.scheduleRepo.findEvents({
      scheduleId: this.config.id,
      limit,
    });
  }
}
