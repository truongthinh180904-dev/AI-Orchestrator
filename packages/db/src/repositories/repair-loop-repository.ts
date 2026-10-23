import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  type RepairLoopRecord,
  type RepairIterationRecord,
  type CreateRepairLoopInput,
  type CreateRepairIterationInput,
  type RepairFeedback,
  RepairLoopRecordSchema,
  RepairIterationRecordSchema,
  CreateRepairLoopInputSchema,
  CreateRepairIterationInputSchema,
  AppError,
} from '@ai-orchestrator/shared';

function rowToRepairLoopRecord(row: Record<string, unknown>): RepairLoopRecord {
  return RepairLoopRecordSchema.parse({
    id: String(row.id),
    task_id: String(row.task_id),
    run_id: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    max_iterations: Number(row.max_iterations ?? 3),
    current_iteration: Number(row.current_iteration ?? 0),
    status: String(row.status ?? 'RUNNING'),
    passed: Boolean(row.passed),
    final_reason: row.final_reason === null || row.final_reason === undefined ? null : String(row.final_reason),
    feedback_summary:
      row.feedback_summary === null || row.feedback_summary === undefined ? null : String(row.feedback_summary),
    created_at: String(row.created_at),
    finished_at: row.finished_at === null || row.finished_at === undefined ? null : String(row.finished_at),
  });
}

function rowToRepairIterationRecord(row: Record<string, unknown>): RepairIterationRecord {
  let feedbackObj: RepairFeedback = { command_failures: [], review_findings: [], summary: '' };
  try {
    if (typeof row.feedback_json === 'string' && row.feedback_json.trim()) {
      feedbackObj = JSON.parse(row.feedback_json) as RepairFeedback;
    }
  } catch {
    // fallback
  }

  return RepairIterationRecordSchema.parse({
    id: String(row.id),
    repair_loop_id: String(row.repair_loop_id),
    iteration_number: Number(row.iteration_number),
    run_id: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    status: String(row.status ?? 'IN_PROGRESS'),
    passed: Boolean(row.passed),
    command_failures_count: Number(row.command_failures_count ?? 0),
    review_findings_count: Number(row.review_findings_count ?? 0),
    prompt: String(row.prompt ?? ''),
    feedback: feedbackObj,
    duration_ms: Number(row.duration_ms ?? 0),
    created_at: String(row.created_at),
  });
}

export class RepairLoopRepository {
  private readonly getLoopByIdStmt: Database.Statement;
  private readonly findLoopsByTaskIdStmt: Database.Statement;
  private readonly getIterationByIdStmt: Database.Statement;
  private readonly findIterationsByLoopIdStmt: Database.Statement;
  private readonly countLoopsStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.getLoopByIdStmt = this.db.prepare('SELECT * FROM repair_loops WHERE id = ?');
    this.findLoopsByTaskIdStmt = this.db.prepare(
      'SELECT * FROM repair_loops WHERE task_id = ? ORDER BY created_at DESC',
    );
    this.getIterationByIdStmt = this.db.prepare('SELECT * FROM repair_iterations WHERE id = ?');
    this.findIterationsByLoopIdStmt = this.db.prepare(
      'SELECT * FROM repair_iterations WHERE repair_loop_id = ? ORDER BY iteration_number ASC',
    );
    this.countLoopsStmt = this.db.prepare('SELECT COUNT(*) as count FROM repair_loops');
  }

  /**
   * Creates a new repair_loop record in SQLite.
   */
  createLoop(input: CreateRepairLoopInput): RepairLoopRecord {
    const validated = CreateRepairLoopInputSchema.parse(input);
    const id = validated.id || `loop_${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    try {
      this.db
        .prepare(
          `INSERT INTO repair_loops (
            id, task_id, run_id, max_iterations, current_iteration,
            status, passed, final_reason, feedback_summary, created_at, finished_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          validated.task_id,
          validated.run_id ?? null,
          validated.max_iterations,
          0,
          'RUNNING',
          0,
          null,
          validated.feedback_summary ?? null,
          now,
          null,
        );

      const loop = this.getLoopById(id);
      if (!loop) {
        throw new AppError('REPAIR_LOOP_INSERT_FAILED', 'Failed to retrieve inserted repair loop');
      }
      return loop;
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('REPAIR_LOOP_CREATE_ERROR', `Failed to create repair loop: ${(err as Error).message}`, {
        taskId: input.task_id,
      });
    }
  }

  /**
   * Updates an existing repair loop record.
   */
  updateLoop(
    id: string,
    updates: {
      status?: string;
      passed?: boolean;
      current_iteration?: number;
      final_reason?: string | null;
      feedback_summary?: string | null;
      finished_at?: string | null;
    },
  ): RepairLoopRecord {
    const existing = this.getLoopById(id);
    if (!existing) {
      throw new AppError('REPAIR_LOOP_NOT_FOUND', `Repair loop '${id}' not found`);
    }

    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.passed !== undefined) {
      fields.push('passed = ?');
      values.push(updates.passed ? 1 : 0);
    }
    if (updates.current_iteration !== undefined) {
      fields.push('current_iteration = ?');
      values.push(updates.current_iteration);
    }
    if (updates.final_reason !== undefined) {
      fields.push('final_reason = ?');
      values.push(updates.final_reason);
    }
    if (updates.feedback_summary !== undefined) {
      fields.push('feedback_summary = ?');
      values.push(updates.feedback_summary);
    }
    if (updates.finished_at !== undefined) {
      fields.push('finished_at = ?');
      values.push(updates.finished_at);
    }

    if (fields.length > 0) {
      values.push(id);
      this.db.prepare(`UPDATE repair_loops SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }

    const updated = this.getLoopById(id);
    if (!updated) {
      throw new AppError('REPAIR_LOOP_NOT_FOUND', `Repair loop '${id}' not found after update`);
    }
    return updated;
  }

  /**
   * Gets a repair loop by ID without iterations.
   */
  getLoopById(id: string): RepairLoopRecord | null {
    const row = this.getLoopByIdStmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToRepairLoopRecord(row);
  }

  /**
   * Gets a repair loop by ID including all associated iterations.
   */
  getLoopWithIterations(id: string): RepairLoopRecord | null {
    const loop = this.getLoopById(id);
    if (!loop) return null;
    const iterations = this.getIterationsByLoopId(id);
    return {
      ...loop,
      iterations,
    };
  }

  /**
   * Finds all repair loops for a specific task ID.
   */
  findLoopsByTaskId(taskId: string): RepairLoopRecord[] {
    const rows = this.findLoopsByTaskIdStmt.all(taskId) as Array<Record<string, unknown>>;
    return rows.map(rowToRepairLoopRecord);
  }

  /**
   * Creates a new repair iteration record.
   */
  createIteration(input: CreateRepairIterationInput): RepairIterationRecord {
    const validated = CreateRepairIterationInputSchema.parse(input);
    const id = validated.id || `iter_${crypto.randomUUID()}`;
    const now = validated.created_at || new Date().toISOString();
    const feedbackJson = JSON.stringify(validated.feedback);

    try {
      this.db
        .prepare(
          `INSERT INTO repair_iterations (
            id, repair_loop_id, iteration_number, run_id, status,
            passed, command_failures_count, review_findings_count,
            prompt, feedback_json, duration_ms, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          validated.repair_loop_id,
          validated.iteration_number,
          validated.run_id ?? null,
          validated.status,
          validated.passed ? 1 : 0,
          validated.command_failures_count,
          validated.review_findings_count,
          validated.prompt ?? '',
          feedbackJson,
          validated.duration_ms,
          now,
        );

      const iter = this.getIterationById(id);
      if (!iter) {
        throw new AppError('REPAIR_ITERATION_INSERT_FAILED', 'Failed to retrieve inserted repair iteration');
      }
      return iter;
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(
        'REPAIR_ITERATION_CREATE_ERROR',
        `Failed to create repair iteration: ${(err as Error).message}`,
        { loopId: input.repair_loop_id, iteration: input.iteration_number },
      );
    }
  }

  /**
   * Updates a repair iteration record.
   */
  updateIteration(
    id: string,
    updates: {
      status?: string;
      passed?: boolean;
      command_failures_count?: number;
      review_findings_count?: number;
      duration_ms?: number;
      run_id?: string | null;
      feedback?: RepairFeedback;
    },
  ): RepairIterationRecord {
    const existing = this.getIterationById(id);
    if (!existing) {
      throw new AppError('REPAIR_ITERATION_NOT_FOUND', `Repair iteration '${id}' not found`);
    }

    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.passed !== undefined) {
      fields.push('passed = ?');
      values.push(updates.passed ? 1 : 0);
    }
    if (updates.command_failures_count !== undefined) {
      fields.push('command_failures_count = ?');
      values.push(updates.command_failures_count);
    }
    if (updates.review_findings_count !== undefined) {
      fields.push('review_findings_count = ?');
      values.push(updates.review_findings_count);
    }
    if (updates.duration_ms !== undefined) {
      fields.push('duration_ms = ?');
      values.push(updates.duration_ms);
    }
    if (updates.run_id !== undefined) {
      fields.push('run_id = ?');
      values.push(updates.run_id);
    }
    if (updates.feedback !== undefined) {
      fields.push('feedback_json = ?');
      values.push(JSON.stringify(updates.feedback));
    }

    if (fields.length > 0) {
      values.push(id);
      this.db.prepare(`UPDATE repair_iterations SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }

    const updated = this.getIterationById(id);
    if (!updated) {
      throw new AppError('REPAIR_ITERATION_NOT_FOUND', `Repair iteration '${id}' not found after update`);
    }
    return updated;
  }

  /**
   * Gets an iteration by ID.
   */
  getIterationById(id: string): RepairIterationRecord | null {
    const row = this.getIterationByIdStmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToRepairIterationRecord(row);
  }

  /**
   * Gets all iterations for a given repair loop.
   */
  getIterationsByLoopId(loopId: string): RepairIterationRecord[] {
    const rows = this.findIterationsByLoopIdStmt.all(loopId) as Array<Record<string, unknown>>;
    return rows.map(rowToRepairIterationRecord);
  }

  /**
   * Counts the total number of repair loops.
   */
  countLoops(): number {
    const result = this.countLoopsStmt.get() as { count: number };
    return result.count;
  }
}
