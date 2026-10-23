import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  type Report,
  type CreateReportInput,
  type ReportFilter,
  ReportSchema,
  CreateReportInputSchema,
  AppError,
} from '@ai-orchestrator/shared';

function rowToReport(row: Record<string, unknown>): Report {
  return ReportSchema.parse({
    id: String(row.id),
    run_id: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    kind: String(row.kind),
    content: String(row.content ?? ''),
    created_at: String(row.created_at),
  });
}

export class ReportRepository {
  private readonly getByIdStmt: Database.Statement;
  private readonly findByRunIdStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly countByRunIdStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.getByIdStmt = this.db.prepare('SELECT * FROM reports WHERE id = ?');
    this.findByRunIdStmt = this.db.prepare(
      'SELECT * FROM reports WHERE run_id = ? ORDER BY created_at ASC',
    );
    this.deleteStmt = this.db.prepare('DELETE FROM reports WHERE id = ?');
    this.countByRunIdStmt = this.db.prepare(
      'SELECT COUNT(*) as count FROM reports WHERE run_id = ?',
    );
  }

  create(input: CreateReportInput): Report {
    const validated = CreateReportInputSchema.parse(input);
    const id = validated.id ?? crypto.randomUUID();
    const createdAt = validated.created_at ?? new Date().toISOString();
    const content = validated.content ?? '';

    const stmt = this.db.prepare(
      `INSERT INTO reports (id, run_id, kind, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );

    try {
      stmt.run(id, validated.run_id ?? null, validated.kind, content, createdAt);
    } catch (err) {
      throw new AppError(
        'DATABASE_ERROR',
        `Failed to create report: ${err instanceof Error ? err.message : String(err)}`,
        { input: validated },
      );
    }

    const created = this.getById(id);
    if (!created) {
      throw new AppError('DATABASE_ERROR', `Report was inserted but could not be retrieved: ${id}`, {
        id,
      });
    }

    return created;
  }

  getById(id: string): Report | null {
    const row = this.getByIdStmt.get(id) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return rowToReport(row);
  }

  findByRunId(runId: string, filter?: ReportFilter): Report[] {
    const conditions: string[] = ['run_id = ?'];
    const values: unknown[] = [runId];

    if (filter?.kind) {
      conditions.push('kind = ?');
      values.push(filter.kind);
    }

    let sql = `SELECT * FROM reports WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC`;
    if (filter?.limit !== undefined) {
      sql += ' LIMIT ?';
      values.push(filter.limit);
      if (filter?.offset !== undefined) {
        sql += ' OFFSET ?';
        values.push(filter.offset);
      }
    }

    const rows = this.db.prepare(sql).all(...values) as Record<string, unknown>[];
    return rows.map(rowToReport);
  }

  findByTaskId(taskId: string): Report[] {
    const sql = `
      SELECT rep.* FROM reports rep
      INNER JOIN runs r ON rep.run_id = r.id
      WHERE r.task_id = ?
      ORDER BY rep.created_at ASC
    `;
    const rows = this.db.prepare(sql).all(taskId) as Record<string, unknown>[];
    return rows.map(rowToReport);
  }

  countByRunId(runId: string): number {
    const row = this.countByRunIdStmt.get(runId) as { count: number } | undefined;
    return row ? Number(row.count) : 0;
  }

  delete(id: string): boolean {
    const result = this.deleteStmt.run(id);
    return result.changes > 0;
  }
}
