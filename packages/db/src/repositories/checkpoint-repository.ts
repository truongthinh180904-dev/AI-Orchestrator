import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  type Checkpoint,
  type CreateCheckpointInput,
  type CheckpointFilter,
  CheckpointSchema,
  CreateCheckpointInputSchema,
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

function rowToCheckpoint(row: Record<string, unknown>): Checkpoint {
  return CheckpointSchema.parse({
    id: String(row.id),
    task_id: String(row.task_id),
    run_id: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    attempt: Number(row.attempt ?? 1),
    step: String(row.step),
    status: row.status ?? 'COMPLETED',
    data: parseJsonData(row.data),
    created_at: String(row.created_at),
  });
}

export class CheckpointRepository {
  private readonly getByIdStmt: Database.Statement;
  private readonly findByRunIdStmt: Database.Statement;
  private readonly getLatestByTaskIdStmt: Database.Statement;
  private readonly getLatestByRunIdStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly countByRunIdStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.getByIdStmt = this.db.prepare('SELECT * FROM checkpoints WHERE id = ?');
    this.findByRunIdStmt = this.db.prepare(
      'SELECT * FROM checkpoints WHERE run_id = ? ORDER BY created_at ASC',
    );
    this.getLatestByTaskIdStmt = this.db.prepare(
      'SELECT * FROM checkpoints WHERE task_id = ? ORDER BY created_at DESC, attempt DESC LIMIT 1',
    );
    this.getLatestByRunIdStmt = this.db.prepare(
      'SELECT * FROM checkpoints WHERE run_id = ? ORDER BY created_at DESC LIMIT 1',
    );
    this.deleteStmt = this.db.prepare('DELETE FROM checkpoints WHERE id = ?');
    this.countByRunIdStmt = this.db.prepare(
      'SELECT COUNT(*) as count FROM checkpoints WHERE run_id = ?',
    );
  }

  create(input: CreateCheckpointInput): Checkpoint {
    const validated = CreateCheckpointInputSchema.parse(input);
    const id = validated.id ?? crypto.randomUUID();
    const createdAt = validated.created_at ?? new Date().toISOString();
    const attempt = validated.attempt ?? 1;
    const status = validated.status ?? 'COMPLETED';
    const dataStr = JSON.stringify(validated.data ?? {});

    const stmt = this.db.prepare(
      `INSERT INTO checkpoints (id, task_id, run_id, attempt, step, status, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    try {
      stmt.run(
        id,
        validated.task_id,
        validated.run_id ?? null,
        attempt,
        validated.step,
        status,
        dataStr,
        createdAt,
      );
    } catch (err) {
      throw new AppError(
        'DATABASE_ERROR',
        `Failed to create checkpoint: ${err instanceof Error ? err.message : String(err)}`,
        { input: validated },
      );
    }

    const created = this.getById(id);
    if (!created) {
      throw new AppError(
        'DATABASE_ERROR',
        `Checkpoint was inserted but could not be retrieved: ${id}`,
        { id },
      );
    }

    return created;
  }

  getById(id: string): Checkpoint | null {
    const row = this.getByIdStmt.get(id) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return rowToCheckpoint(row);
  }

  findByTaskId(taskId: string, filter?: CheckpointFilter): Checkpoint[] {
    const conditions: string[] = ['task_id = ?'];
    const values: unknown[] = [taskId];

    if (filter?.run_id) {
      conditions.push('run_id = ?');
      values.push(filter.run_id);
    }
    if (filter?.attempt !== undefined) {
      conditions.push('attempt = ?');
      values.push(filter.attempt);
    }
    if (filter?.step) {
      conditions.push('step = ?');
      values.push(filter.step);
    }
    if (filter?.status) {
      conditions.push('status = ?');
      values.push(filter.status);
    }

    let sql = `SELECT * FROM checkpoints WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC`;
    if (filter?.limit !== undefined) {
      sql += ' LIMIT ?';
      values.push(filter.limit);
      if (filter?.offset !== undefined) {
        sql += ' OFFSET ?';
        values.push(filter.offset);
      }
    }

    const rows = this.db.prepare(sql).all(...values) as Record<string, unknown>[];
    return rows.map(rowToCheckpoint);
  }

  findByRunId(runId: string): Checkpoint[] {
    const rows = this.findByRunIdStmt.all(runId) as Record<string, unknown>[];
    return rows.map(rowToCheckpoint);
  }

  getLatestByTaskId(taskId: string): Checkpoint | null {
    const row = this.getLatestByTaskIdStmt.get(taskId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return rowToCheckpoint(row);
  }

  getLatestByRunId(runId: string): Checkpoint | null {
    const row = this.getLatestByRunIdStmt.get(runId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return rowToCheckpoint(row);
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
