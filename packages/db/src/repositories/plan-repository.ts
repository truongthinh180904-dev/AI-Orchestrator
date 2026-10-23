import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  type Plan,
  type CreatePlanInput,
  type UpdatePlanInput,
  type PlanFilter,
  PlanSchema,
  CreatePlanInputSchema,
  UpdatePlanInputSchema,
  PlanFilterSchema,
  AppError,
} from '@ai-orchestrator/shared';

function rowToPlan(row: Record<string, unknown>): Plan {
  let tasks: unknown = [];
  if (typeof row.tasks === 'string') {
    try {
      tasks = JSON.parse(row.tasks);
    } catch {
      tasks = [];
    }
  } else if (Array.isArray(row.tasks)) {
    tasks = row.tasks;
  }

  const raw = {
    ...row,
    feature_id: row.feature_id === null || row.feature_id === undefined ? null : String(row.feature_id),
    description: row.description === null || row.description === undefined ? null : String(row.description),
    raw_output: row.raw_output === null || row.raw_output === undefined ? null : String(row.raw_output),
    approved_at: row.approved_at === null || row.approved_at === undefined ? null : String(row.approved_at),
    approved_by: row.approved_by === null || row.approved_by === undefined ? null : String(row.approved_by),
    rejection_reason:
      row.rejection_reason === null || row.rejection_reason === undefined
        ? null
        : String(row.rejection_reason),
    tasks,
  };

  return PlanSchema.parse(raw);
}

export class PlanRepository {
  private readonly getByIdStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.getByIdStmt = this.db.prepare('SELECT * FROM plans WHERE id = ?');
    this.deleteStmt = this.db.prepare('DELETE FROM plans WHERE id = ?');
  }

  create(input: CreatePlanInput): Plan {
    const validated = CreatePlanInputSchema.parse(input);
    const id = validated.id ?? `plan_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const createdAt = validated.created_at ?? now;
    const updatedAt = validated.updated_at ?? now;

    const stmt = this.db.prepare(`
      INSERT INTO plans (
        id, feature_id, title, description, repository, status, tasks,
        raw_output, created_at, updated_at, approved_at, approved_by, rejection_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      stmt.run(
        id,
        validated.feature_id ?? null,
        validated.title,
        validated.description ?? null,
        validated.repository ?? '.',
        validated.status ?? 'PENDING_APPROVAL',
        JSON.stringify(validated.tasks),
        validated.raw_output ?? null,
        createdAt,
        updatedAt,
        validated.approved_at ?? null,
        validated.approved_by ?? null,
        validated.rejection_reason ?? null,
      );
    } catch (err: unknown) {
      const error = err as { code?: string; message?: string };
      if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        throw new AppError('DUPLICATE_PLAN_ID', `Plan with id '${id}' already exists`, { id });
      }
      if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        throw new AppError(
          'FOREIGN_KEY_VIOLATION',
          `Foreign key constraint failed for feature_id: '${validated.feature_id}'`,
          { featureId: validated.feature_id },
        );
      }
      throw new AppError('DATABASE_ERROR', `Failed to create plan: ${error.message}`, { id });
    }

    const created = this.findById(id);
    if (!created) {
      throw new AppError('DATABASE_ERROR', 'Plan was not found after insertion', { id });
    }
    return created;
  }

  findById(id: string): Plan | undefined {
    const row = this.getByIdStmt.get(id) as Record<string, unknown> | undefined;
    if (!row) {
      return undefined;
    }
    return rowToPlan(row);
  }

  findAll(filter?: PlanFilter): Plan[] {
    const validatedFilter = filter ? PlanFilterSchema.parse(filter) : {};
    let query = 'SELECT * FROM plans WHERE 1=1';
    const params: unknown[] = [];

    if (validatedFilter.status) {
      query += ' AND status = ?';
      params.push(validatedFilter.status);
    }
    if (validatedFilter.feature_id) {
      query += ' AND feature_id = ?';
      params.push(validatedFilter.feature_id);
    }
    if (validatedFilter.repository) {
      query += ' AND repository = ?';
      params.push(validatedFilter.repository);
    }

    query += ' ORDER BY created_at DESC';

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map(rowToPlan);
  }

  update(id: string, updates: UpdatePlanInput): Plan {
    const existing = this.findById(id);
    if (!existing) {
      throw new AppError('PLAN_NOT_FOUND', `Plan with id '${id}' not found`, { id });
    }

    const validatedUpdates = UpdatePlanInputSchema.parse(updates);
    const updatedAt = validatedUpdates.updated_at ?? new Date().toISOString();

    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [updatedAt];

    if (validatedUpdates.title !== undefined) {
      fields.push('title = ?');
      values.push(validatedUpdates.title);
    }
    if (validatedUpdates.description !== undefined) {
      fields.push('description = ?');
      values.push(validatedUpdates.description ?? null);
    }
    if (validatedUpdates.feature_id !== undefined) {
      fields.push('feature_id = ?');
      values.push(validatedUpdates.feature_id ?? null);
    }
    if (validatedUpdates.repository !== undefined) {
      fields.push('repository = ?');
      values.push(validatedUpdates.repository);
    }
    if (validatedUpdates.status !== undefined) {
      fields.push('status = ?');
      values.push(validatedUpdates.status);
    }
    if (validatedUpdates.tasks !== undefined) {
      fields.push('tasks = ?');
      values.push(JSON.stringify(validatedUpdates.tasks));
    }
    if (validatedUpdates.raw_output !== undefined) {
      fields.push('raw_output = ?');
      values.push(validatedUpdates.raw_output ?? null);
    }
    if (validatedUpdates.approved_at !== undefined) {
      fields.push('approved_at = ?');
      values.push(validatedUpdates.approved_at ?? null);
    }
    if (validatedUpdates.approved_by !== undefined) {
      fields.push('approved_by = ?');
      values.push(validatedUpdates.approved_by ?? null);
    }
    if (validatedUpdates.rejection_reason !== undefined) {
      fields.push('rejection_reason = ?');
      values.push(validatedUpdates.rejection_reason ?? null);
    }

    values.push(id);
    const query = `UPDATE plans SET ${fields.join(', ')} WHERE id = ?`;

    try {
      this.db.prepare(query).run(...values);
    } catch (err: unknown) {
      const error = err as { code?: string; message?: string };
      if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        throw new AppError(
          'FOREIGN_KEY_VIOLATION',
          `Foreign key constraint failed during plan update`,
          { id, updates },
        );
      }
      throw new AppError('DATABASE_ERROR', `Failed to update plan '${id}': ${error.message}`, {
        id,
      });
    }

    const updated = this.findById(id);
    if (!updated) {
      throw new AppError('PLAN_NOT_FOUND', `Plan with id '${id}' not found after update`, { id });
    }
    return updated;
  }

  delete(id: string): boolean {
    const result = this.deleteStmt.run(id);
    return result.changes > 0;
  }

  count(filter?: PlanFilter): number {
    const validatedFilter = filter ? PlanFilterSchema.parse(filter) : {};
    let query = 'SELECT COUNT(*) as count FROM plans WHERE 1=1';
    const params: unknown[] = [];

    if (validatedFilter.status) {
      query += ' AND status = ?';
      params.push(validatedFilter.status);
    }
    if (validatedFilter.feature_id) {
      query += ' AND feature_id = ?';
      params.push(validatedFilter.feature_id);
    }
    if (validatedFilter.repository) {
      query += ' AND repository = ?';
      params.push(validatedFilter.repository);
    }

    const stmt = this.db.prepare(query);
    const row = stmt.get(...params) as { count: number };
    return row.count;
  }
}
