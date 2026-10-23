import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  type ScheduleConfig,
  type ScheduleEventRecord,
  type CreateScheduleEventInput,
  type ScheduleEventType,
  ScheduleConfigSchema,
  AppError,
} from '@ai-orchestrator/shared';

function parseJsonData(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') {
    if (typeof raw === 'object' && raw !== null) {
      return raw as Record<string, unknown>;
    }
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { text: raw };
  }
}

function parseJsonArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return [];
    }
  }
  return [];
}

function rowToScheduleConfig(row: Record<string, unknown>): ScheduleConfig {
  const windows = parseJsonArray(row.windows);
  return ScheduleConfigSchema.parse({
    id: String(row.id),
    name: String(row.name),
    enabled: Boolean(row.enabled),
    timezone: String(row.timezone ?? 'UTC'),
    mode: String(row.mode ?? 'ALLOW'),
    windows,
    stop_at_hour:
      row.stop_at_hour === null || row.stop_at_hour === undefined ? null : Number(row.stop_at_hour),
    graceful_completion: Boolean(row.graceful_completion ?? 1),
    max_runs_per_window:
      row.max_runs_per_window === null || row.max_runs_per_window === undefined
        ? null
        : Number(row.max_runs_per_window),
  });
}

function rowToScheduleEvent(row: Record<string, unknown>): ScheduleEventRecord {
  return {
    id: String(row.id),
    event_type: String(row.event_type) as ScheduleEventType,
    schedule_id: String(row.schedule_id),
    task_id: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    run_id: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    details: parseJsonData(row.details),
    created_at: String(row.created_at),
  };
}

export interface ScheduleEventFilter {
  scheduleId?: string;
  eventType?: ScheduleEventType;
  taskId?: string;
  runId?: string;
  since?: string;
  limit?: number;
}

export class ExecutionScheduleRepository {
  private readonly getConfigStmt: Database.Statement;
  private readonly upsertConfigStmt: Database.Statement;
  private readonly getEventByIdStmt: Database.Statement;
  private readonly insertEventStmt: Database.Statement;
  private readonly getLatestEventStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.getConfigStmt = this.db.prepare('SELECT * FROM execution_schedules WHERE id = ?');
    this.upsertConfigStmt = this.db.prepare(`
      INSERT INTO execution_schedules (
        id, name, enabled, timezone, mode, windows, stop_at_hour, graceful_completion, max_runs_per_window, created_at, updated_at
      ) VALUES (
        @id, @name, @enabled, @timezone, @mode, @windows, @stop_at_hour, @graceful_completion, @max_runs_per_window, @created_at, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        enabled = excluded.enabled,
        timezone = excluded.timezone,
        mode = excluded.mode,
        windows = excluded.windows,
        stop_at_hour = excluded.stop_at_hour,
        graceful_completion = excluded.graceful_completion,
        max_runs_per_window = excluded.max_runs_per_window,
        updated_at = excluded.updated_at
    `);

    this.getEventByIdStmt = this.db.prepare('SELECT * FROM schedule_events WHERE id = ?');
    this.insertEventStmt = this.db.prepare(`
      INSERT INTO schedule_events (
        id, event_type, schedule_id, task_id, run_id, details, created_at
      ) VALUES (
        @id, @event_type, @schedule_id, @task_id, @run_id, @details, @created_at
      )
    `);
    this.getLatestEventStmt = this.db.prepare(
      'SELECT * FROM schedule_events ORDER BY created_at DESC LIMIT 1',
    );
  }

  /**
   * Retrieves schedule configuration by id.
   */
  getConfig(id = 'default_schedule'): ScheduleConfig | null {
    const row = this.getConfigStmt.get(id) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return rowToScheduleConfig(row);
  }

  /**
   * Persists or updates schedule configuration.
   */
  upsertConfig(config: ScheduleConfig): ScheduleConfig {
    const validated = ScheduleConfigSchema.parse(config);
    const now = new Date().toISOString();

    this.upsertConfigStmt.run({
      id: validated.id,
      name: validated.name,
      enabled: validated.enabled ? 1 : 0,
      timezone: validated.timezone,
      mode: validated.mode,
      windows: JSON.stringify(validated.windows),
      stop_at_hour: validated.stop_at_hour,
      graceful_completion: validated.graceful_completion ? 1 : 0,
      max_runs_per_window: validated.max_runs_per_window,
      created_at: now,
      updated_at: now,
    });

    const saved = this.getConfig(validated.id);
    if (!saved) {
      throw new AppError(
        'SCHEDULE_CONFIG_SAVE_FAILED',
        `Failed to save schedule config '${validated.id}'`,
      );
    }
    return saved;
  }

  /**
   * Creates an audit event in schedule_events.
   */
  createEvent(input: CreateScheduleEventInput): ScheduleEventRecord {
    const id = crypto.randomUUID();
    const createdAt = input.created_at ?? new Date().toISOString();
    const scheduleId = input.schedule_id ?? 'default_schedule';
    const detailsJson = JSON.stringify(input.details ?? {});

    this.insertEventStmt.run({
      id,
      event_type: input.event_type,
      schedule_id: scheduleId,
      task_id: input.task_id ?? null,
      run_id: input.run_id ?? null,
      details: detailsJson,
      created_at: createdAt,
    });

    const event = this.getEventById(id);
    if (!event) {
      throw new AppError('SCHEDULE_EVENT_CREATE_FAILED', 'Failed to retrieve created schedule event');
    }
    return event;
  }

  getEventById(id: string): ScheduleEventRecord | null {
    const row = this.getEventByIdStmt.get(id) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return rowToScheduleEvent(row);
  }

  getLatestEvent(): ScheduleEventRecord | null {
    const row = this.getLatestEventStmt.get() as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return rowToScheduleEvent(row);
  }

  findEvents(filter: ScheduleEventFilter = {}): ScheduleEventRecord[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.scheduleId) {
      conditions.push('schedule_id = ?');
      params.push(filter.scheduleId);
    }
    if (filter.eventType) {
      conditions.push('event_type = ?');
      params.push(filter.eventType);
    }
    if (filter.taskId) {
      conditions.push('task_id = ?');
      params.push(filter.taskId);
    }
    if (filter.runId) {
      conditions.push('run_id = ?');
      params.push(filter.runId);
    }
    if (filter.since) {
      conditions.push('created_at >= ?');
      params.push(filter.since);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit ?? 50;

    const sql = `SELECT * FROM schedule_events ${whereClause} ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(rowToScheduleEvent);
  }
}
