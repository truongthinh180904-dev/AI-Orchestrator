import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  type Run,
  type CreateRunInput,
  type UpdateRunInput,
  type RunStatus,
  type RunFilter,
  RunSchema,
  CreateRunInputSchema,
  UpdateRunInputSchema,
  AppError,
} from '@ai-orchestrator/shared';

function rowToRun(row: Record<string, unknown>): Run {
  return RunSchema.parse({
    id: row.id,
    task_id: row.task_id,
    attempt: Number(row.attempt),
    status: row.status,
    exit_code: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
    pid: row.pid === null || row.pid === undefined ? null : Number(row.pid),
    started_at: row.started_at,
    finished_at: row.finished_at ?? null,
    branch: row.branch ?? null,
    commit_sha: row.commit_sha ?? null,
  });
}

export class RunRepository {
  private readonly getByIdStmt: Database.Statement;
  private readonly findByTaskIdStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.getByIdStmt = this.db.prepare('SELECT * FROM runs WHERE id = ?');
    this.findByTaskIdStmt = this.db.prepare(
      'SELECT * FROM runs WHERE task_id = ? ORDER BY attempt ASC, started_at ASC',
    );
    this.deleteStmt = this.db.prepare('DELETE FROM runs WHERE id = ?');
  }

  create(input: CreateRunInput): Run {
    const validated = CreateRunInputSchema.parse(input);
    const id = validated.id ?? crypto.randomUUID();
    const startedAt = validated.started_at ?? new Date().toISOString();
    const attempt = validated.attempt ?? 1;
    const status = validated.status ?? 'RUNNING';

    const stmt = this.db.prepare(
      `INSERT INTO runs (id, task_id, attempt, status, exit_code, pid, started_at, finished_at, branch, commit_sha)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    try {
      stmt.run(
        id,
        validated.task_id,
        attempt,
        status,
        validated.exit_code ?? null,
        validated.pid ?? null,
        startedAt,
        validated.finished_at ?? null,
        validated.branch ?? null,
        validated.commit_sha ?? null,
      );
    } catch (err) {
      throw new AppError(
        'DATABASE_ERROR',
        `Failed to create run: ${err instanceof Error ? err.message : String(err)}`,
        { input: validated },
      );
    }

    const created = this.getById(id);
    if (!created) {
      throw new AppError('DATABASE_ERROR', `Run was inserted but could not be retrieved: ${id}`, {
        id,
      });
    }

    return created;
  }

  getById(id: string): Run | null {
    const row = this.getByIdStmt.get(id) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return rowToRun(row);
  }

  findByTaskId(taskId: string): Run[] {
    const rows = this.findByTaskIdStmt.all(taskId) as Record<string, unknown>[];
    return rows.map(rowToRun);
  }

  findAll(filter?: RunFilter): Run[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    const taskId = filter?.taskId ?? filter?.task_id;
    if (taskId) {
      conditions.push('task_id = ?');
      values.push(taskId);
    }
    if (filter?.status) {
      conditions.push('status = ?');
      values.push(filter.status);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    let sql = `SELECT * FROM runs ${whereClause} ORDER BY started_at DESC`;

    if (filter?.limit !== undefined) {
      sql += ' LIMIT ?';
      values.push(filter.limit);
      if (filter?.offset !== undefined) {
        sql += ' OFFSET ?';
        values.push(filter.offset);
      }
    }

    const rows = this.db.prepare(sql).all(...values) as Record<string, unknown>[];
    return rows.map(rowToRun);
  }

  update(id: string, input: UpdateRunInput): Run {
    const validated = UpdateRunInputSchema.parse(input);
    const existing = this.getById(id);
    if (!existing) {
      throw new AppError('RUN_NOT_FOUND', `Run not found with id: ${id}`, { id });
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (validated.status !== undefined) {
      updates.push('status = ?');
      values.push(validated.status);
    }
    if (validated.exit_code !== undefined) {
      updates.push('exit_code = ?');
      values.push(validated.exit_code);
    }
    if (validated.pid !== undefined) {
      updates.push('pid = ?');
      values.push(validated.pid);
    }
    if (validated.finished_at !== undefined) {
      updates.push('finished_at = ?');
      values.push(validated.finished_at);
    }
    if (validated.branch !== undefined) {
      updates.push('branch = ?');
      values.push(validated.branch);
    }
    if (validated.commit_sha !== undefined) {
      updates.push('commit_sha = ?');
      values.push(validated.commit_sha);
    }

    if (updates.length > 0) {
      values.push(id);
      const sql = `UPDATE runs SET ${updates.join(', ')} WHERE id = ?`;
      this.db.prepare(sql).run(...values);
    }

    const updated = this.getById(id);
    if (!updated) {
      throw new AppError('DATABASE_ERROR', `Run was updated but could not be retrieved: ${id}`, {
        id,
      });
    }

    return updated;
  }

  updateStatus(
    id: string,
    status: RunStatus,
    details?: { exit_code?: number | null; finished_at?: string; pid?: number | null },
  ): Run {
    return this.update(id, {
      status,
      exit_code: details?.exit_code,
      finished_at:
        details?.finished_at ??
        (details?.exit_code !== undefined ? new Date().toISOString() : undefined),
      pid: details?.pid,
    });
  }

  delete(id: string): boolean {
    const result = this.deleteStmt.run(id);
    return result.changes > 0;
  }
}
