import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  type RecoveryAudit,
  type CreateRecoveryAuditInput,
  RecoveryAuditSchema,
  CreateRecoveryAuditInputSchema,
  AppError,
} from '@ai-orchestrator/shared';

function parseJsonDetails(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') {
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
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

function rowToRecoveryAudit(row: Record<string, unknown>): RecoveryAudit {
  return RecoveryAuditSchema.parse({
    id: String(row.id),
    trigger: String(row.trigger),
    recovered_tasks_count: Number(row.recovered_tasks_count ?? 0),
    cleaned_runs_count: Number(row.cleaned_runs_count ?? 0),
    released_locks_count: Number(row.released_locks_count ?? 0),
    details: parseJsonDetails(row.details),
    created_at: String(row.created_at),
  });
}

export interface RecoveryAuditFilter {
  trigger?: string;
  limit?: number;
}

export class RecoveryAuditRepository {
  private readonly getByIdStmt: Database.Statement;
  private readonly getLatestStmt: Database.Statement;
  private readonly countStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.getByIdStmt = this.db.prepare('SELECT * FROM recovery_audits WHERE id = ?');
    this.getLatestStmt = this.db.prepare(
      'SELECT * FROM recovery_audits ORDER BY created_at DESC LIMIT 1',
    );
    this.countStmt = this.db.prepare('SELECT COUNT(*) as count FROM recovery_audits');
  }

  create(input: CreateRecoveryAuditInput): RecoveryAudit {
    const validated = CreateRecoveryAuditInputSchema.parse(input);
    const id = validated.id ?? crypto.randomUUID();
    const createdAt = validated.created_at ?? new Date().toISOString();
    const detailsJson = JSON.stringify(validated.details ?? {});

    try {
      this.db
        .prepare(
          `INSERT INTO recovery_audits (id, trigger, recovered_tasks_count, cleaned_runs_count, released_locks_count, details, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          validated.trigger,
          validated.recovered_tasks_count,
          validated.cleaned_runs_count,
          validated.released_locks_count,
          detailsJson,
          createdAt,
        );
    } catch (err) {
      throw new AppError(
        'DATABASE_ERROR',
        `Failed to create recovery audit: ${err instanceof Error ? err.message : String(err)}`,
        { input: validated },
      );
    }

    const created = this.getById(id);
    if (!created) {
      throw new AppError('DATABASE_ERROR', `Recovery audit inserted but could not be retrieved: ${id}`, {
        id,
      });
    }

    return created;
  }

  getById(id: string): RecoveryAudit | null {
    const row = this.getByIdStmt.get(id) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return rowToRecoveryAudit(row);
  }

  getLatest(): RecoveryAudit | null {
    const row = this.getLatestStmt.get() as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return rowToRecoveryAudit(row);
  }

  findAll(filter?: RecoveryAuditFilter): RecoveryAudit[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filter?.trigger) {
      conditions.push('trigger = ?');
      values.push(filter.trigger);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    let sql = `SELECT * FROM recovery_audits ${whereClause} ORDER BY created_at DESC`;

    if (filter?.limit !== undefined) {
      sql += ' LIMIT ?';
      values.push(filter.limit);
    }

    const rows = this.db.prepare(sql).all(...values) as Array<Record<string, unknown>>;
    return rows.map(rowToRecoveryAudit);
  }

  count(): number {
    const row = this.countStmt.get() as { count: number } | undefined;
    return row?.count ?? 0;
  }
}
