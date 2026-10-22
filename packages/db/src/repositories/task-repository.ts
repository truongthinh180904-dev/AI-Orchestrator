import type Database from 'better-sqlite3';
import {
  type TaskWithDependencies,
  type CreateTaskInput,
  type UpdateTaskInput,
  type TaskFilter,
  type TaskStatus,
  TaskWithDependenciesSchema,
  CreateTaskInputSchema,
  UpdateTaskInputSchema,
  TaskFilterSchema,
  TaskStatusSchema,
  AppError,
} from '@ai-orchestrator/shared';
import { TaskDependencyRepository } from './dependency-repository.js';

function rowToTask(
  row: Record<string, unknown>,
  dependencies: string[] = [],
): TaskWithDependencies {
  let acceptance_criteria: unknown = [];
  let test_commands: unknown = [];

  if (typeof row.acceptance_criteria === 'string') {
    try {
      acceptance_criteria = JSON.parse(row.acceptance_criteria);
    } catch {
      acceptance_criteria = [];
    }
  } else if (Array.isArray(row.acceptance_criteria)) {
    acceptance_criteria = row.acceptance_criteria;
  }

  if (typeof row.test_commands === 'string') {
    try {
      test_commands = JSON.parse(row.test_commands);
    } catch {
      test_commands = [];
    }
  } else if (Array.isArray(row.test_commands)) {
    test_commands = row.test_commands;
  }

  const raw = {
    ...row,
    acceptance_criteria,
    test_commands,
    dependencies,
  };

  return TaskWithDependenciesSchema.parse(raw);
}

export class TaskRepository {
  private readonly depRepo: TaskDependencyRepository;

  constructor(private readonly db: Database.Database) {
    this.depRepo = new TaskDependencyRepository(db);
  }

  create(input: CreateTaskInput): TaskWithDependencies {
    const validated = CreateTaskInputSchema.parse(input);
    const now = new Date().toISOString();
    const createdAt = validated.created_at ?? now;
    const updatedAt = validated.updated_at ?? now;

    const deps = validated.dependencies ?? [];
    for (const depId of deps) {
      if (depId === validated.id) {
        throw new AppError('SELF_DEPENDENCY_ERROR', `Task '${validated.id}' cannot depend on itself`, {
          taskId: validated.id,
          dependsOnId: depId,
        });
      }
    }

    const insertTaskTx = this.db.transaction(() => {
      this.db
        .prepare(`
          INSERT INTO tasks (
            id, feature_id, title, description, phase, worker_type, repository,
            acceptance_criteria, test_commands, priority, max_attempts, timeout_minutes,
            status, attempts, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          validated.id,
          validated.feature_id ?? null,
          validated.title,
          validated.description ?? null,
          validated.phase ?? null,
          validated.worker_type ?? 'agy',
          validated.repository ?? '.',
          JSON.stringify(validated.acceptance_criteria ?? []),
          JSON.stringify(validated.test_commands ?? []),
          validated.priority ?? 0,
          validated.max_attempts ?? 3,
          validated.timeout_minutes ?? 30,
          validated.status ?? 'TODO',
          validated.attempts ?? 0,
          createdAt,
          updatedAt,
        );

      if (deps.length > 0) {
        this.depRepo.setForTask(validated.id, deps);
      }
    });

    try {
      insertTaskTx();
    } catch (error: unknown) {
      this.handleSqliteError(error, validated.id);
    }

    const created = this.findById(validated.id);
    if (!created) {
      throw new AppError('TASK_CREATION_FAILED', `Failed to retrieve created task '${validated.id}'`, {
        taskId: validated.id,
      });
    }
    return created;
  }

  findById(id: string): TaskWithDependencies | null {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    const dependencies = this.depRepo.getByTaskId(id);
    return rowToTask(row, dependencies);
  }

  findAll(filter?: TaskFilter): TaskWithDependencies[] {
    const validatedFilter = filter ? TaskFilterSchema.parse(filter) : undefined;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (validatedFilter?.status) {
      conditions.push('status = ?');
      params.push(validatedFilter.status);
    }
    if (validatedFilter?.feature_id) {
      conditions.push('feature_id = ?');
      params.push(validatedFilter.feature_id);
    }
    if (validatedFilter?.phase) {
      conditions.push('phase = ?');
      params.push(validatedFilter.phase);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const query = `SELECT * FROM tasks ${whereClause} ORDER BY priority DESC, created_at ASC, id ASC`;
    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];

    if (rows.length === 0) {
      return [];
    }

    const taskIds = rows.map((r) => String(r.id));
    const placeholders = taskIds.map(() => '?').join(', ');
    const depRows = this.db
      .prepare(
        `SELECT task_id, depends_on_id FROM task_dependencies WHERE task_id IN (${placeholders}) ORDER BY depends_on_id ASC`,
      )
      .all(...taskIds) as Array<{ task_id: string; depends_on_id: string }>;

    const depMap = new Map<string, string[]>();
    for (const d of depRows) {
      const existing = depMap.get(d.task_id) ?? [];
      existing.push(d.depends_on_id);
      depMap.set(d.task_id, existing);
    }

    return rows.map((r) => rowToTask(r, depMap.get(String(r.id)) ?? []));
  }

  update(id: string, input: UpdateTaskInput): TaskWithDependencies {
    const validated = UpdateTaskInputSchema.parse(input);
    const existing = this.findById(id);
    if (!existing) {
      throw new AppError('TASK_NOT_FOUND', `Task with id '${id}' not found`, { taskId: id });
    }

    const updates: string[] = [];
    const params: unknown[] = [];

    if (validated.feature_id !== undefined) {
      updates.push('feature_id = ?');
      params.push(validated.feature_id);
    }
    if (validated.title !== undefined) {
      updates.push('title = ?');
      params.push(validated.title);
    }
    if (validated.description !== undefined) {
      updates.push('description = ?');
      params.push(validated.description);
    }
    if (validated.phase !== undefined) {
      updates.push('phase = ?');
      params.push(validated.phase);
    }
    if (validated.worker_type !== undefined) {
      updates.push('worker_type = ?');
      params.push(validated.worker_type);
    }
    if (validated.repository !== undefined) {
      updates.push('repository = ?');
      params.push(validated.repository);
    }
    if (validated.acceptance_criteria !== undefined) {
      updates.push('acceptance_criteria = ?');
      params.push(JSON.stringify(validated.acceptance_criteria));
    }
    if (validated.test_commands !== undefined) {
      updates.push('test_commands = ?');
      params.push(JSON.stringify(validated.test_commands));
    }
    if (validated.priority !== undefined) {
      updates.push('priority = ?');
      params.push(validated.priority);
    }
    if (validated.max_attempts !== undefined) {
      updates.push('max_attempts = ?');
      params.push(validated.max_attempts);
    }
    if (validated.timeout_minutes !== undefined) {
      updates.push('timeout_minutes = ?');
      params.push(validated.timeout_minutes);
    }
    if (validated.status !== undefined) {
      updates.push('status = ?');
      params.push(validated.status);
    }
    if (validated.attempts !== undefined) {
      updates.push('attempts = ?');
      params.push(validated.attempts);
    }

    const updatedAt = validated.updated_at ?? new Date().toISOString();
    updates.push('updated_at = ?');
    params.push(updatedAt);

    params.push(id);

    const updateTx = this.db.transaction(() => {
      if (updates.length > 1) {
        // More than just updated_at
        const query = `UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`;
        this.db.prepare(query).run(...params);
      } else {
        this.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(updatedAt, id);
      }

      if (validated.dependencies !== undefined) {
        this.depRepo.setForTask(id, validated.dependencies);
      }
    });

    try {
      updateTx();
    } catch (error: unknown) {
      this.handleSqliteError(error, id);
    }

    const updated = this.findById(id);
    if (!updated) {
      throw new AppError('TASK_NOT_FOUND', `Task with id '${id}' not found after update`, {
        taskId: id,
      });
    }
    return updated;
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    return result.changes > 0;
  }

  exists(id: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id);
    return row !== undefined;
  }

  count(filter?: TaskFilter): number {
    const validatedFilter = filter ? TaskFilterSchema.parse(filter) : undefined;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (validatedFilter?.status) {
      conditions.push('status = ?');
      params.push(validatedFilter.status);
    }
    if (validatedFilter?.feature_id) {
      conditions.push('feature_id = ?');
      params.push(validatedFilter.feature_id);
    }
    if (validatedFilter?.phase) {
      conditions.push('phase = ?');
      params.push(validatedFilter.phase);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const query = `SELECT COUNT(*) as count FROM tasks ${whereClause}`;
    const row = this.db.prepare(query).get(...params) as { count: number };
    return row.count;
  }

  addDependency(taskId: string, dependsOnId: string): void {
    const existing = this.findById(taskId);
    if (!existing) {
      throw new AppError('TASK_NOT_FOUND', `Task with id '${taskId}' not found`, { taskId });
    }
    this.depRepo.add(taskId, dependsOnId);
  }

  removeDependency(taskId: string, dependsOnId: string): boolean {
    return this.depRepo.remove(taskId, dependsOnId);
  }

  getDependencies(taskId: string): string[] {
    return this.depRepo.getByTaskId(taskId);
  }

  getDependents(taskId: string): string[] {
    return this.depRepo.getDependentsOf(taskId);
  }

  updateStatus(
    id: string,
    status: TaskStatus,
    options?: { incrementAttempt?: boolean },
  ): TaskWithDependencies {
    const validStatus = TaskStatusSchema.parse(status);
    const existing = this.findById(id);
    if (!existing) {
      throw new AppError('TASK_NOT_FOUND', `Task with id '${id}' not found`, { taskId: id });
    }

    const now = new Date().toISOString();
    const attempts = options?.incrementAttempt ? existing.attempts + 1 : existing.attempts;

    this.db
      .prepare('UPDATE tasks SET status = ?, attempts = ?, updated_at = ? WHERE id = ?')
      .run(validStatus, attempts, now, id);

    const updated = this.findById(id);
    if (!updated) {
      throw new AppError('TASK_NOT_FOUND', `Task with id '${id}' not found after status update`, {
        taskId: id,
      });
    }
    return updated;
  }

  private handleSqliteError(error: unknown, taskId: string): never {
    const sqliteErr = error as { code?: string; message?: string };
    if (
      sqliteErr.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
      sqliteErr.code === 'SQLITE_CONSTRAINT_UNIQUE'
    ) {
      throw new AppError('TASK_ALREADY_EXISTS', `Task with id '${taskId}' already exists`, {
        taskId,
      });
    }
    if (sqliteErr.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      throw new AppError(
        'FOREIGN_KEY_VIOLATION',
        `Foreign key constraint failed for task '${taskId}'`,
        { taskId, error: sqliteErr.message },
      );
    }
    throw error;
  }
}
