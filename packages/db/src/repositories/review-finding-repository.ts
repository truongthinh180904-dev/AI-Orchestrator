import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  type ReviewFindingRecord,
  type CreateReviewFindingRecordInput,
  type ReviewFindingFilter,
  ReviewFindingRecordSchema,
  CreateReviewFindingRecordInputSchema,
  AppError,
} from '@ai-orchestrator/shared';

function rowToFindingRecord(row: Record<string, unknown>): ReviewFindingRecord {
  return ReviewFindingRecordSchema.parse({
    id: String(row.id),
    task_id: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    run_id: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    severity: String(row.severity),
    file: String(row.file),
    line: Number(row.line),
    message: String(row.message),
    category: row.category === null || row.category === undefined ? null : String(row.category),
    rule_id: row.rule_id === null || row.rule_id === undefined ? null : String(row.rule_id),
    suggestion: row.suggestion === null || row.suggestion === undefined ? null : String(row.suggestion),
    created_at: String(row.created_at),
  });
}

export class ReviewFindingRepository {
  private readonly getByIdStmt: Database.Statement;
  private readonly findByTaskIdStmt: Database.Statement;
  private readonly findByRunIdStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly deleteByTaskIdStmt: Database.Statement;
  private readonly deleteByRunIdStmt: Database.Statement;
  private readonly countStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.getByIdStmt = this.db.prepare('SELECT * FROM review_findings WHERE id = ?');
    this.findByTaskIdStmt = this.db.prepare(
      'SELECT * FROM review_findings WHERE task_id = ? ORDER BY created_at ASC',
    );
    this.findByRunIdStmt = this.db.prepare(
      'SELECT * FROM review_findings WHERE run_id = ? ORDER BY created_at ASC',
    );
    this.deleteStmt = this.db.prepare('DELETE FROM review_findings WHERE id = ?');
    this.deleteByTaskIdStmt = this.db.prepare('DELETE FROM review_findings WHERE task_id = ?');
    this.deleteByRunIdStmt = this.db.prepare('DELETE FROM review_findings WHERE run_id = ?');
    this.countStmt = this.db.prepare('SELECT COUNT(*) as count FROM review_findings');
  }

  create(input: CreateReviewFindingRecordInput): ReviewFindingRecord {
    const validated = CreateReviewFindingRecordInputSchema.parse(input);
    const id = validated.id ?? crypto.randomUUID();
    const createdAt = validated.created_at ?? new Date().toISOString();

    const insertStmt = this.db.prepare(`
      INSERT INTO review_findings (
        id, task_id, run_id, severity, file, line, message, category, rule_id, suggestion, created_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    try {
      insertStmt.run(
        id,
        validated.task_id ?? null,
        validated.run_id ?? null,
        validated.severity,
        validated.file,
        validated.line,
        validated.message,
        validated.category ?? null,
        validated.rule_id ?? null,
        validated.suggestion ?? null,
        createdAt,
      );
    } catch (err) {
      throw new AppError(
        'DB_INSERT_ERROR',
        `Failed to insert review finding: ${(err as Error).message}`,
        { id, input },
      );
    }

    const row = this.getByIdStmt.get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new AppError('RECORD_NOT_FOUND', `Failed to retrieve created finding with id ${id}`);
    }

    return rowToFindingRecord(row);
  }

  createBatch(inputs: CreateReviewFindingRecordInput[]): ReviewFindingRecord[] {
    if (inputs.length === 0) {
      return [];
    }

    const insertStmt = this.db.prepare(`
      INSERT INTO review_findings (
        id, task_id, run_id, severity, file, line, message, category, rule_id, suggestion, created_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    const createdIds: string[] = [];
    const transaction = this.db.transaction((items: CreateReviewFindingRecordInput[]) => {
      for (const item of items) {
        const validated = CreateReviewFindingRecordInputSchema.parse(item);
        const id = validated.id ?? crypto.randomUUID();
        const createdAt = validated.created_at ?? new Date().toISOString();

        insertStmt.run(
          id,
          validated.task_id ?? null,
          validated.run_id ?? null,
          validated.severity,
          validated.file,
          validated.line,
          validated.message,
          validated.category ?? null,
          validated.rule_id ?? null,
          validated.suggestion ?? null,
          createdAt,
        );
        createdIds.push(id);
      }
    });

    try {
      transaction(inputs);
    } catch (err) {
      throw new AppError(
        'DB_BATCH_INSERT_ERROR',
        `Failed to batch insert review findings: ${(err as Error).message}`,
        { count: inputs.length },
      );
    }

    return createdIds
      .map((id) => this.findById(id))
      .filter((r): r is ReviewFindingRecord => r !== null);
  }

  findById(id: string): ReviewFindingRecord | null {
    const row = this.getByIdStmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToFindingRecord(row);
  }

  findByTaskId(taskId: string): ReviewFindingRecord[] {
    const rows = this.findByTaskIdStmt.all(taskId) as Array<Record<string, unknown>>;
    return rows.map(rowToFindingRecord);
  }

  findByRunId(runId: string): ReviewFindingRecord[] {
    const rows = this.findByRunIdStmt.all(runId) as Array<Record<string, unknown>>;
    return rows.map(rowToFindingRecord);
  }

  find(filter: ReviewFindingFilter = {}): ReviewFindingRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.taskId) {
      conditions.push('task_id = ?');
      params.push(filter.taskId);
    }

    if (filter.runId) {
      conditions.push('run_id = ?');
      params.push(filter.runId);
    }

    if (filter.severity) {
      conditions.push('severity = ?');
      params.push(filter.severity);
    }

    if (filter.file) {
      conditions.push('file = ?');
      params.push(filter.file);
    }

    let sql = 'SELECT * FROM review_findings';
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY created_at ASC';

    if (filter.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
      if (filter.offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(filter.offset);
      }
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Array<Record<string, unknown>>;
    return rows.map(rowToFindingRecord);
  }

  count(filter: ReviewFindingFilter = {}): number {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.taskId) {
      conditions.push('task_id = ?');
      params.push(filter.taskId);
    }

    if (filter.runId) {
      conditions.push('run_id = ?');
      params.push(filter.runId);
    }

    if (filter.severity) {
      conditions.push('severity = ?');
      params.push(filter.severity);
    }

    if (filter.file) {
      conditions.push('file = ?');
      params.push(filter.file);
    }

    let sql = 'SELECT COUNT(*) as count FROM review_findings';
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    const stmt = this.db.prepare(sql);
    const result = stmt.get(...params) as { count: number } | undefined;
    return result?.count ?? 0;
  }

  delete(id: string): boolean {
    const info = this.deleteStmt.run(id);
    return info.changes > 0;
  }

  deleteByTaskId(taskId: string): number {
    const info = this.deleteByTaskIdStmt.run(taskId);
    return info.changes;
  }

  deleteByRunId(runId: string): number {
    const info = this.deleteByRunIdStmt.run(runId);
    return info.changes;
  }
}
