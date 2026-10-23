import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  type QualityCommandRecord,
  type CreateQualityCommandRecordInput,
  type QualityRecordFilter,
  QualityCommandRecordSchema,
  CreateQualityCommandRecordInputSchema,
  AppError,
} from '@ai-orchestrator/shared';

function parseArgs(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map(String);
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(String);
      }
    } catch {
      // Fallback
    }
  }
  return [];
}

function rowToQualityRecord(row: Record<string, unknown>): QualityCommandRecord {
  return QualityCommandRecordSchema.parse({
    id: String(row.id),
    task_id: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    run_id: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    stage: String(row.stage),
    command_id: String(row.command_id),
    name: String(row.name),
    command: String(row.command),
    exe: String(row.exe),
    args: parseArgs(row.args),
    cwd: String(row.cwd),
    exit_code: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
    signal: row.signal === null || row.signal === undefined ? null : String(row.signal),
    status: String(row.status),
    stdout: String(row.stdout ?? ''),
    stderr: String(row.stderr ?? ''),
    duration_ms: Number(row.duration_ms ?? 0),
    started_at: String(row.started_at),
    finished_at: String(row.finished_at),
    created_at: String(row.created_at),
  });
}

export class QualityCheckRepository {
  private readonly getByIdStmt: Database.Statement;
  private readonly findByTaskIdStmt: Database.Statement;
  private readonly findByRunIdStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly deleteByTaskIdStmt: Database.Statement;
  private readonly deleteByRunIdStmt: Database.Statement;
  private readonly countStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.getByIdStmt = this.db.prepare('SELECT * FROM quality_command_records WHERE id = ?');
    this.findByTaskIdStmt = this.db.prepare(
      'SELECT * FROM quality_command_records WHERE task_id = ? ORDER BY created_at ASC',
    );
    this.findByRunIdStmt = this.db.prepare(
      'SELECT * FROM quality_command_records WHERE run_id = ? ORDER BY created_at ASC',
    );
    this.deleteStmt = this.db.prepare('DELETE FROM quality_command_records WHERE id = ?');
    this.deleteByTaskIdStmt = this.db.prepare('DELETE FROM quality_command_records WHERE task_id = ?');
    this.deleteByRunIdStmt = this.db.prepare('DELETE FROM quality_command_records WHERE run_id = ?');
    this.countStmt = this.db.prepare('SELECT COUNT(*) as count FROM quality_command_records');
  }

  create(input: CreateQualityCommandRecordInput): QualityCommandRecord {
    const validated = CreateQualityCommandRecordInputSchema.parse(input);
    const id = validated.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const startedAt = validated.started_at ?? now;
    const finishedAt = validated.finished_at ?? now;
    const createdAt = validated.created_at ?? now;
    const argsJson = JSON.stringify(validated.args ?? []);

    const stmt = this.db.prepare(
      `INSERT INTO quality_command_records (
        id, task_id, run_id, stage, command_id, name, command, exe,
        args, cwd, exit_code, signal, status, stdout, stderr,
        duration_ms, started_at, finished_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    try {
      stmt.run(
        id,
        validated.task_id ?? null,
        validated.run_id ?? null,
        validated.stage,
        validated.command_id,
        validated.name,
        validated.command,
        validated.exe,
        argsJson,
        validated.cwd,
        validated.exit_code ?? null,
        validated.signal ?? null,
        validated.status,
        validated.stdout ?? '',
        validated.stderr ?? '',
        validated.duration_ms ?? 0,
        startedAt,
        finishedAt,
        createdAt,
      );
    } catch (err) {
      throw new AppError(
        'DATABASE_ERROR',
        `Failed to create quality command record: ${err instanceof Error ? err.message : String(err)}`,
        { input: validated },
      );
    }

    const created = this.getById(id);
    if (!created) {
      throw new AppError(
        'DATABASE_ERROR',
        `Quality command record was inserted but could not be retrieved: ${id}`,
        { id },
      );
    }

    return created;
  }

  createBatch(inputs: CreateQualityCommandRecordInput[]): QualityCommandRecord[] {
    if (inputs.length === 0) {
      return [];
    }

    const insertTx = this.db.transaction((items: CreateQualityCommandRecordInput[]) => {
      return items.map((item) => this.create(item));
    });

    return insertTx(inputs);
  }

  getById(id: string): QualityCommandRecord | null {
    const row = this.getByIdStmt.get(id) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return rowToQualityRecord(row);
  }

  findByTaskId(taskId: string): QualityCommandRecord[] {
    const rows = this.findByTaskIdStmt.all(taskId) as Record<string, unknown>[];
    return rows.map(rowToQualityRecord);
  }

  findByRunId(runId: string): QualityCommandRecord[] {
    const rows = this.findByRunIdStmt.all(runId) as Record<string, unknown>[];
    return rows.map(rowToQualityRecord);
  }

  findAll(filter?: QualityRecordFilter): QualityCommandRecord[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filter?.task_id) {
      conditions.push('task_id = ?');
      values.push(filter.task_id);
    }

    if (filter?.run_id) {
      conditions.push('run_id = ?');
      values.push(filter.run_id);
    }

    if (filter?.stage) {
      conditions.push('stage = ?');
      values.push(filter.stage);
    }

    if (filter?.status) {
      conditions.push('status = ?');
      values.push(filter.status);
    }

    let sql = 'SELECT * FROM quality_command_records';
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    sql += ' ORDER BY created_at ASC';

    if (filter?.limit !== undefined) {
      sql += ' LIMIT ?';
      values.push(filter.limit);
      if (filter?.offset !== undefined) {
        sql += ' OFFSET ?';
        values.push(filter.offset);
      }
    }

    const rows = this.db.prepare(sql).all(...values) as Record<string, unknown>[];
    return rows.map(rowToQualityRecord);
  }

  delete(id: string): boolean {
    const result = this.deleteStmt.run(id);
    return result.changes > 0;
  }

  deleteByTaskId(taskId: string): number {
    const result = this.deleteByTaskIdStmt.run(taskId);
    return result.changes;
  }

  deleteByRunId(runId: string): number {
    const result = this.deleteByRunIdStmt.run(runId);
    return result.changes;
  }

  count(): number {
    const row = this.countStmt.get() as { count: number };
    return row.count;
  }
}
