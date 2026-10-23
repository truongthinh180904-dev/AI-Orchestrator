import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  type SecurityCheckRecord,
  type CreateSecurityCheckRecordInput,
  type SecurityCheckFilter,
  type SecretFinding,
  SecurityCheckRecordSchema,
  CreateSecurityCheckRecordInputSchema,
  AppError,
} from '@ai-orchestrator/shared';

function rowToSecurityCheckRecord(row: Record<string, unknown>): SecurityCheckRecord {
  return SecurityCheckRecordSchema.parse({
    id: String(row.id),
    task_id: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    run_id: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    repo_path: String(row.repo_path),
    passed: Boolean(row.passed),
    audit_passed: Boolean(row.audit_passed),
    secret_passed: Boolean(row.secret_passed),
    audit_high_critical_count: Number(row.audit_high_critical_count ?? 0),
    secret_findings_count: Number(row.secret_findings_count ?? 0),
    audit_summary: String(row.audit_summary ?? '{}'),
    secret_summary: String(row.secret_summary ?? '{}'),
    raw_details: String(row.raw_details ?? '{}'),
    duration_ms: Number(row.duration_ms ?? 0),
    created_at: String(row.created_at),
  });
}

function rowToSecretFinding(row: Record<string, unknown>): SecretFinding {
  return {
    id: String(row.id),
    rule_id: String(row.rule_id),
    description: String(row.description),
    file: String(row.file),
    line: Number(row.line),
    match_preview: String(row.match_preview),
    secret_hash: row.secret_hash ? String(row.secret_hash) : undefined,
  };
}

export class SecurityCheckRepository {
  private readonly getByIdStmt: Database.Statement;
  private readonly findByTaskIdStmt: Database.Statement;
  private readonly findByRunIdStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly countStmt: Database.Statement;
  private readonly findFindingsByCheckIdStmt: Database.Statement;
  private readonly findFindingsByTaskIdStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.getByIdStmt = this.db.prepare('SELECT * FROM security_checks WHERE id = ?');
    this.findByTaskIdStmt = this.db.prepare(
      'SELECT * FROM security_checks WHERE task_id = ? ORDER BY created_at DESC',
    );
    this.findByRunIdStmt = this.db.prepare(
      'SELECT * FROM security_checks WHERE run_id = ? ORDER BY created_at DESC',
    );
    this.deleteStmt = this.db.prepare('DELETE FROM security_checks WHERE id = ?');
    this.countStmt = this.db.prepare('SELECT COUNT(*) as count FROM security_checks');
    this.findFindingsByCheckIdStmt = this.db.prepare(
      'SELECT * FROM secret_findings WHERE security_check_id = ? ORDER BY file ASC, line ASC',
    );
    this.findFindingsByTaskIdStmt = this.db.prepare(
      'SELECT * FROM secret_findings WHERE task_id = ? ORDER BY file ASC, line ASC',
    );
  }

  create(
    input: CreateSecurityCheckRecordInput,
    secretFindings: SecretFinding[] = [],
  ): SecurityCheckRecord {
    const validated = CreateSecurityCheckRecordInputSchema.parse(input);
    const id = validated.id ?? crypto.randomUUID();
    const createdAt = validated.created_at ?? new Date().toISOString();

    const insertCheckStmt = this.db.prepare(`
      INSERT INTO security_checks (
        id, task_id, run_id, repo_path, passed, audit_passed, secret_passed,
        audit_high_critical_count, secret_findings_count, audit_summary, secret_summary,
        raw_details, duration_ms, created_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    const insertFindingStmt = this.db.prepare(`
      INSERT INTO secret_findings (
        id, security_check_id, task_id, rule_id, description, file, line, match_preview, secret_hash, created_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    const insertReportStmt = this.db.prepare(`
      INSERT INTO reports (id, run_id, kind, content, created_at)
      VALUES (?, ?, 'security_check', ?, ?)
    `);

    const tx = this.db.transaction(() => {
      insertCheckStmt.run(
        id,
        validated.task_id ?? null,
        validated.run_id ?? null,
        validated.repo_path,
        validated.passed ? 1 : 0,
        validated.audit_passed ? 1 : 0,
        validated.secret_passed ? 1 : 0,
        validated.audit_high_critical_count,
        validated.secret_findings_count,
        validated.audit_summary,
        validated.secret_summary,
        validated.raw_details,
        validated.duration_ms,
        createdAt,
      );

      for (const finding of secretFindings) {
        insertFindingStmt.run(
          finding.id ?? crypto.randomUUID(),
          id,
          validated.task_id ?? null,
          finding.rule_id,
          finding.description,
          finding.file,
          finding.line,
          finding.match_preview,
          finding.secret_hash ?? null,
          createdAt,
        );
      }

      // Automatically store in reports table if run_id is available
      if (validated.run_id) {
        const reportContent = JSON.stringify({
          security_check_id: id,
          task_id: validated.task_id,
          run_id: validated.run_id,
          repo_path: validated.repo_path,
          passed: validated.passed,
          audit_passed: validated.audit_passed,
          secret_passed: validated.secret_passed,
          audit_high_critical_count: validated.audit_high_critical_count,
          secret_findings_count: validated.secret_findings_count,
          created_at: createdAt,
        });
        insertReportStmt.run(crypto.randomUUID(), validated.run_id, reportContent, createdAt);
      }
    });

    try {
      tx();
    } catch (err) {
      throw new AppError(
        'DB_INSERT_ERROR',
        `Failed to insert security check: ${(err as Error).message}`,
        { id, input },
      );
    }

    const created = this.findById(id);
    if (!created) {
      throw new AppError('RECORD_NOT_FOUND', `Failed to retrieve created security check with id ${id}`);
    }

    return created;
  }

  findById(id: string): SecurityCheckRecord | null {
    const row = this.getByIdStmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToSecurityCheckRecord(row);
  }

  findByTaskId(taskId: string): SecurityCheckRecord[] {
    const rows = this.findByTaskIdStmt.all(taskId) as Array<Record<string, unknown>>;
    return rows.map(rowToSecurityCheckRecord);
  }

  findByRunId(runId: string): SecurityCheckRecord[] {
    const rows = this.findByRunIdStmt.all(runId) as Array<Record<string, unknown>>;
    return rows.map(rowToSecurityCheckRecord);
  }

  findSecretFindingsByCheckId(checkId: string): SecretFinding[] {
    const rows = this.findFindingsByCheckIdStmt.all(checkId) as Array<Record<string, unknown>>;
    return rows.map(rowToSecretFinding);
  }

  findSecretFindingsByTaskId(taskId: string): SecretFinding[] {
    const rows = this.findFindingsByTaskIdStmt.all(taskId) as Array<Record<string, unknown>>;
    return rows.map(rowToSecretFinding);
  }

  find(filter: SecurityCheckFilter = {}): SecurityCheckRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.task_id !== undefined) {
      conditions.push('task_id = ?');
      params.push(filter.task_id);
    }

    if (filter.run_id !== undefined) {
      conditions.push('run_id = ?');
      params.push(filter.run_id);
    }

    if (filter.passed !== undefined) {
      conditions.push('passed = ?');
      params.push(filter.passed ? 1 : 0);
    }

    let query = 'SELECT * FROM security_checks';
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ' ORDER BY created_at DESC';

    if (filter.limit !== undefined) {
      query += ` LIMIT ${filter.limit}`;
      if (filter.offset !== undefined) {
        query += ` OFFSET ${filter.offset}`;
      }
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Array<Record<string, unknown>>;
    return rows.map(rowToSecurityCheckRecord);
  }

  count(filter: SecurityCheckFilter = {}): number {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.task_id !== undefined) {
      conditions.push('task_id = ?');
      params.push(filter.task_id);
    }

    if (filter.run_id !== undefined) {
      conditions.push('run_id = ?');
      params.push(filter.run_id);
    }

    if (filter.passed !== undefined) {
      conditions.push('passed = ?');
      params.push(filter.passed ? 1 : 0);
    }

    if (conditions.length === 0) {
      const res = this.countStmt.get() as { count: number };
      return res.count;
    }

    const query = `SELECT COUNT(*) as count FROM security_checks WHERE ${conditions.join(' AND ')}`;
    const stmt = this.db.prepare(query);
    const res = stmt.get(...params) as { count: number };
    return res.count;
  }

  delete(id: string): boolean {
    const res = this.deleteStmt.run(id);
    return res.changes > 0;
  }
}
