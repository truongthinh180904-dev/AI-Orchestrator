import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  type SoakTestResult,
  SoakTestResultSchema,
  AppError,
} from '@ai-orchestrator/shared';

function safeParseJson<T>(raw: unknown, defaultValue: T): T {
  if (typeof raw !== 'string') {
    if (typeof raw === 'object' && raw !== null) {
      return raw as T;
    }
    return defaultValue;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return defaultValue;
  }
}

function rowToSoakTestResult(row: Record<string, unknown>): SoakTestResult {
  return SoakTestResultSchema.parse({
    id: String(row.id),
    name: String(row.name),
    mode: String(row.mode),
    target_duration_ms: Number(row.target_duration_ms),
    duration_ms: Number(row.duration_ms),
    iterations_completed: Number(row.iterations_completed),
    tasks_processed: Number(row.tasks_processed),
    faults_injected_count: Number(row.faults_injected_count),
    faults_recovered_count: Number(row.faults_recovered_count),
    duration_achieved: Boolean(Number(row.duration_achieved)),
    zero_data_loss: Boolean(Number(row.zero_data_loss)),
    status: String(row.status),
    data_integrity: safeParseJson(row.data_integrity, {}),
    memory_report: safeParseJson(row.memory_report, {}),
    faults_events: safeParseJson(row.faults_events, []),
    summary: String(row.summary),
    started_at: String(row.started_at),
    finished_at: String(row.finished_at),
  });
}

export interface SoakTestFilter {
  status?: string;
  limit?: number;
}

export class SoakTestRepository {
  private readonly getByIdStmt: Database.Statement;
  private readonly getLatestStmt: Database.Statement;
  private readonly countStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.getByIdStmt = this.db.prepare('SELECT * FROM soak_test_runs WHERE id = ?');
    this.getLatestStmt = this.db.prepare(
      'SELECT * FROM soak_test_runs ORDER BY created_at DESC LIMIT 1',
    );
    this.countStmt = this.db.prepare('SELECT COUNT(*) as count FROM soak_test_runs');
  }

  create(result: SoakTestResult): SoakTestResult {
    const validated = SoakTestResultSchema.parse(result);
    const id = validated.id || `soak-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    const insertStmt = this.db.prepare(`
      INSERT INTO soak_test_runs (
        id, name, mode, target_duration_ms, duration_ms,
        iterations_completed, tasks_processed, faults_injected_count,
        faults_recovered_count, duration_achieved, zero_data_loss,
        status, data_integrity, memory_report, faults_events,
        summary, started_at, finished_at, created_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?
      )
    `);

    insertStmt.run(
      id,
      validated.name,
      validated.mode,
      validated.target_duration_ms,
      validated.duration_ms,
      validated.iterations_completed,
      validated.tasks_processed,
      validated.faults_injected_count,
      validated.faults_recovered_count,
      validated.duration_achieved ? 1 : 0,
      validated.zero_data_loss ? 1 : 0,
      validated.status,
      JSON.stringify(validated.data_integrity),
      JSON.stringify(validated.memory_report),
      JSON.stringify(validated.faults_events),
      validated.summary,
      validated.started_at,
      validated.finished_at,
      now,
    );

    const created = this.getById(id);
    if (!created) {
      throw new AppError('SOAK_TEST_CREATE_FAILED', 'Failed to retrieve created soak test run');
    }
    return created;
  }

  getById(id: string): SoakTestResult | null {
    const row = this.getByIdStmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToSoakTestResult(row);
  }

  getLatest(): SoakTestResult | null {
    const row = this.getLatestStmt.get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToSoakTestResult(row);
  }

  findAll(filter?: SoakTestFilter): SoakTestResult[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.status) {
      conditions.push('status = ?');
      params.push(filter.status);
    }

    let sql = 'SELECT * FROM soak_test_runs';
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    sql += ' ORDER BY created_at DESC';

    if (filter?.limit && filter.limit > 0) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToSoakTestResult);
  }

  count(): number {
    const result = this.countStmt.get() as { count: number } | undefined;
    return result?.count ?? 0;
  }
}
