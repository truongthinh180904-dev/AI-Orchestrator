import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  type QuotaEventRecord,
  type CreateQuotaEventInput,
  type QuotaEventType,
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

function rowToQuotaEvent(row: Record<string, unknown>): QuotaEventRecord {
  return {
    id: String(row.id),
    event_type: String(row.event_type) as QuotaEventType,
    task_id: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    run_id: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    backoff_ms: Number(row.backoff_ms ?? 0),
    consecutive_hits: Number(row.consecutive_hits ?? 0),
    details: parseJsonData(row.details),
    created_at: String(row.created_at),
  };
}

export interface QuotaEventFilter {
  eventType?: QuotaEventType;
  taskId?: string;
  runId?: string;
  since?: string;
  limit?: number;
}

export class QuotaEventRepository {
  private readonly getByIdStmt: Database.Statement;
  private readonly countHitsSinceStmt: Database.Statement;
  private readonly getLatestStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.getByIdStmt = this.db.prepare('SELECT * FROM quota_events WHERE id = ?');
    this.countHitsSinceStmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM quota_events WHERE event_type = 'QUOTA_HIT' AND created_at >= ?",
    );
    this.getLatestStmt = this.db.prepare(
      'SELECT * FROM quota_events ORDER BY created_at DESC LIMIT 1',
    );
  }

  create(input: CreateQuotaEventInput): QuotaEventRecord {
    const id = input.id ?? crypto.randomUUID();
    const createdAt = input.created_at ?? new Date().toISOString();
    const details = input.details ?? {};
    const backoffMs = input.backoff_ms ?? 0;
    const consecutiveHits = input.consecutive_hits ?? 0;

    try {
      this.db
        .prepare(
          `INSERT INTO quota_events (id, event_type, task_id, run_id, backoff_ms, consecutive_hits, details, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.event_type,
          input.task_id ?? null,
          input.run_id ?? null,
          backoffMs,
          consecutiveHits,
          JSON.stringify(details),
          createdAt,
        );
    } catch (err) {
      throw new AppError('QUOTA_EVENT_INSERT_FAILED', 'Failed to insert quota event', {
        cause: err instanceof Error ? err.message : String(err),
        input,
      });
    }

    return {
      id,
      event_type: input.event_type,
      task_id: input.task_id ?? null,
      run_id: input.run_id ?? null,
      backoff_ms: backoffMs,
      consecutive_hits: consecutiveHits,
      details,
      created_at: createdAt,
    };
  }

  getById(id: string): QuotaEventRecord | null {
    const row = this.getByIdStmt.get(id) as Record<string, unknown> | undefined;
    return row ? rowToQuotaEvent(row) : null;
  }

  getLatest(): QuotaEventRecord | null {
    const row = this.getLatestStmt.get() as Record<string, unknown> | undefined;
    return row ? rowToQuotaEvent(row) : null;
  }

  countHitsSince(sinceIso: string): number {
    const row = this.countHitsSinceStmt.get(sinceIso) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  list(filter?: QuotaEventFilter): QuotaEventRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter?.eventType) {
      clauses.push('event_type = ?');
      params.push(filter.eventType);
    }
    if (filter?.taskId) {
      clauses.push('task_id = ?');
      params.push(filter.taskId);
    }
    if (filter?.runId) {
      clauses.push('run_id = ?');
      params.push(filter.runId);
    }
    if (filter?.since) {
      clauses.push('created_at >= ?');
      params.push(filter.since);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = filter?.limit ? `LIMIT ${Math.max(1, filter.limit)}` : 'LIMIT 100';
    const sql = `SELECT * FROM quota_events ${where} ORDER BY created_at DESC ${limit}`;

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToQuotaEvent);
  }
}
