import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  type QualityGateResult,
  QualityGateResultSchema,
  formatQualityGateMarkdownReport,
  AppError,
} from '@ai-orchestrator/shared';

function rowToQualityGateResult(row: Record<string, unknown>): QualityGateResult {
  const policy = JSON.parse(String(row.policy_json || '{}'));
  const ruleEvaluations = JSON.parse(String(row.evaluations_json || '[]'));
  const evidenceSummary = JSON.parse(String(row.evidence_summary_json || '{}'));
  const evidence = JSON.parse(String(row.evidence_json || '{}'));

  return QualityGateResultSchema.parse({
    id: String(row.id),
    task_id: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    run_id: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    repo_path: String(evidence.repo_path || '.'),
    passed: Boolean(row.passed),
    status: String(row.status),
    summary: String(row.summary),
    policy,
    rule_evaluations: ruleEvaluations,
    evidence_summary: evidenceSummary,
    command_records: evidence.command_records || [],
    scope_result: evidence.scope_result || null,
    review_result: evidence.review_result || null,
    security_result: evidence.security_result || null,
    duration_ms: Number(row.duration_ms ?? 0),
    evaluated_at: String(row.evaluated_at),
  });
}

export class QualityGateRepository {
  private readonly getByIdStmt: Database.Statement;
  private readonly findByTaskIdStmt: Database.Statement;
  private readonly findLatestByTaskIdStmt: Database.Statement;
  private readonly findByRunIdStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly countStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.getByIdStmt = this.db.prepare('SELECT * FROM quality_gate_evaluations WHERE id = ?');
    this.findByTaskIdStmt = this.db.prepare(
      'SELECT * FROM quality_gate_evaluations WHERE task_id = ? ORDER BY evaluated_at DESC LIMIT ?',
    );
    this.findLatestByTaskIdStmt = this.db.prepare(
      'SELECT * FROM quality_gate_evaluations WHERE task_id = ? ORDER BY evaluated_at DESC LIMIT 1',
    );
    this.findByRunIdStmt = this.db.prepare(
      'SELECT * FROM quality_gate_evaluations WHERE run_id = ? ORDER BY evaluated_at DESC',
    );
    this.deleteStmt = this.db.prepare('DELETE FROM quality_gate_evaluations WHERE id = ?');
    this.countStmt = this.db.prepare('SELECT COUNT(*) as count FROM quality_gate_evaluations');
  }

  create(result: QualityGateResult): QualityGateResult {
    const validated = QualityGateResultSchema.parse(result);
    const createdAt = new Date().toISOString();

    const insertEvaluationStmt = this.db.prepare(`
      INSERT INTO quality_gate_evaluations (
        id, task_id, run_id, passed, status, summary,
        policy_json, evaluations_json, evidence_summary_json,
        evidence_json, duration_ms, evaluated_at, created_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?
      )
    `);

    const insertReportStmt = this.db.prepare(`
      INSERT INTO reports (id, run_id, kind, content, created_at)
      VALUES (?, ?, 'quality_gate', ?, ?)
    `);

    const evidenceJson = JSON.stringify({
      repo_path: validated.repo_path,
      command_records: validated.command_records,
      scope_result: validated.scope_result,
      review_result: validated.review_result,
      security_result: validated.security_result,
    });

    const tx = this.db.transaction(() => {
      insertEvaluationStmt.run(
        validated.id,
        validated.task_id,
        validated.run_id,
        validated.passed ? 1 : 0,
        validated.status,
        validated.summary,
        JSON.stringify(validated.policy),
        JSON.stringify(validated.rule_evaluations),
        JSON.stringify(validated.evidence_summary),
        evidenceJson,
        validated.duration_ms,
        validated.evaluated_at,
        createdAt,
      );

      // Automatically persist formatted markdown report to reports table if run_id is available
      if (validated.run_id) {
        const reportContent = formatQualityGateMarkdownReport(validated);
        insertReportStmt.run(
          crypto.randomUUID(),
          validated.run_id,
          reportContent,
          createdAt,
        );
      }
    });

    try {
      tx();
    } catch (err) {
      throw new AppError(
        'DB_QUALITY_GATE_INSERT_FAILED',
        `Failed to store quality gate evaluation: ${err instanceof Error ? err.message : String(err)}`,
        { evaluationId: validated.id, taskId: validated.task_id },
      );
    }

    return validated;
  }

  getById(id: string): QualityGateResult | null {
    const row = this.getByIdStmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToQualityGateResult(row);
  }

  findLatestByTaskId(taskId: string): QualityGateResult | null {
    const row = this.findLatestByTaskIdStmt.get(taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToQualityGateResult(row);
  }

  findByTaskId(taskId: string, limit = 50): QualityGateResult[] {
    const rows = this.findByTaskIdStmt.all(taskId, limit) as Record<string, unknown>[];
    return rows.map(rowToQualityGateResult);
  }

  findByRunId(runId: string): QualityGateResult[] {
    const rows = this.findByRunIdStmt.all(runId) as Record<string, unknown>[];
    return rows.map(rowToQualityGateResult);
  }

  count(filter?: { taskId?: string; passed?: boolean }): number {
    if (!filter || (filter.taskId === undefined && filter.passed === undefined)) {
      const row = this.countStmt.get() as { count: number };
      return row.count;
    }

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.taskId !== undefined) {
      conditions.push('task_id = ?');
      params.push(filter.taskId);
    }
    if (filter.passed !== undefined) {
      conditions.push('passed = ?');
      params.push(filter.passed ? 1 : 0);
    }

    const query = `SELECT COUNT(*) as count FROM quality_gate_evaluations WHERE ${conditions.join(' AND ')}`;
    const row = this.db.prepare(query).get(...params) as { count: number };
    return row.count;
  }

  delete(id: string): boolean {
    const result = this.deleteStmt.run(id);
    return result.changes > 0;
  }
}
