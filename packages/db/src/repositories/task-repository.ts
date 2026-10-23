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
  DependencyGraph,
  type CycleDetectionResult,
  assertValidTaskTransition,
  DependencyResolver,
  type TaskDependencyStatus,
  type ResolveReadyOptions,
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

    if (this.exists(validated.id)) {
      throw new AppError('TASK_ALREADY_EXISTS', `Task with id '${validated.id}' already exists`, {
        taskId: validated.id,
      });
    }

    if (deps.length > 0) {
      const missing = this.findMissingDependencies(deps);
      if (missing.length > 0) {
        throw new AppError(
          'FOREIGN_KEY_VIOLATION',
          `Cannot create task '${validated.id}': referenced dependency '${missing.join(', ')}' does not exist`,
          {
            taskId: validated.id,
            missingDependencies: missing,
          },
        );
      }
    }

    const insertTaskTx = this.db.transaction(() => {
      this.db
        .prepare(`
          INSERT INTO tasks (
            id, feature_id, plan_id, title, description, phase, worker_type, repository,
            acceptance_criteria, test_commands, priority, max_attempts, timeout_minutes,
            status, attempts, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          validated.id,
          validated.feature_id ?? null,
          validated.plan_id ?? null,
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
    if (validatedFilter?.plan_id) {
      conditions.push('plan_id = ?');
      params.push(validatedFilter.plan_id);
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
    if (validated.plan_id !== undefined) {
      updates.push('plan_id = ?');
      params.push(validated.plan_id);
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

    if (validated.dependencies !== undefined && validated.dependencies.length > 0) {
      const missing = this.findMissingDependencies(validated.dependencies);
      if (missing.length > 0) {
        throw new AppError(
          'FOREIGN_KEY_VIOLATION',
          `Cannot update task '${id}': referenced dependency '${missing.join(', ')}' does not exist`,
          {
            taskId: id,
            missingDependencies: missing,
          },
        );
      }
    }

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
    if (validatedFilter?.plan_id) {
      conditions.push('plan_id = ?');
      params.push(validatedFilter.plan_id);
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

  findMissingDependencies(dependencies: string[]): string[] {
    if (dependencies.length === 0) return [];
    const uniqueDeps = Array.from(new Set(dependencies));
    const placeholders = uniqueDeps.map(() => '?').join(',');
    const existingRows = this.db
      .prepare(`SELECT id FROM tasks WHERE id IN (${placeholders})`)
      .all(...uniqueDeps) as Array<{ id: string }>;
    const existingSet = new Set(existingRows.map((r) => r.id));
    return uniqueDeps.filter((dep) => !existingSet.has(dep));
  }

  addDependency(taskId: string, dependsOnId: string): void {
    const existing = this.findById(taskId);
    if (!existing) {
      throw new AppError('TASK_NOT_FOUND', `Task with id '${taskId}' not found`, { taskId });
    }
    if (!this.exists(dependsOnId)) {
      throw new AppError(
        'FOREIGN_KEY_VIOLATION',
        `Referenced dependency task '${dependsOnId}' does not exist`,
        { taskId, dependsOnId },
      );
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

  /**
   * Tạo nhiều task đồng thời trong 1 transaction an toàn (atomic bulk insert).
   * Phát hiện trùng lặp task_id trong batch và trong DB, phát hiện dependency không tồn tại.
   * Nếu có bất kỳ lỗi nào, toàn bộ giao dịch bị hủy và không có task nào được ghi vào DB.
   */
  createMany(tasks: CreateTaskInput[]): TaskWithDependencies[] {
    if (tasks.length === 0) return [];

    // 1. Validate Zod và kiểm tra tự phụ thuộc
    const validatedTasks = tasks.map((t) => CreateTaskInputSchema.parse(t));

    // 2. Kiểm tra trùng lặp ID trong batch
    const seenBatch = new Set<string>();
    for (const task of validatedTasks) {
      if (seenBatch.has(task.id)) {
        throw new AppError('DUPLICATE_TASK_ID', `Duplicate task id '${task.id}' found in batch`, {
          taskId: task.id,
        });
      }
      seenBatch.add(task.id);
    }

    // 3. Kiểm tra trùng lặp với DB
    const batchIds = Array.from(seenBatch);
    const placeholders = batchIds.map(() => '?').join(',');
    const existingRows = this.db
      .prepare(`SELECT id FROM tasks WHERE id IN (${placeholders})`)
      .all(...batchIds) as Array<{ id: string }>;
    if (existingRows.length > 0) {
      const conflictId = existingRows[0]?.id;
      throw new AppError('TASK_ALREADY_EXISTS', `Task with id '${conflictId}' already exists in database`, {
        taskId: conflictId,
      });
    }

    // 4. Kiểm tra dependencies: mọi dependency phải tồn tại trong batch hoặc trong DB
    const allCandidateIds = new Set<string>(batchIds);
    const allReferencedDeps = new Set<string>();
    for (const task of validatedTasks) {
      const deps = task.dependencies ?? [];
      for (const dep of deps) {
        if (dep === task.id) {
          throw new AppError('SELF_DEPENDENCY_ERROR', `Task '${task.id}' cannot depend on itself`, {
            taskId: task.id,
            dependsOnId: dep,
          });
        }
        allReferencedDeps.add(dep);
      }
    }

    const externalDeps = Array.from(allReferencedDeps).filter((dep) => !allCandidateIds.has(dep));
    if (externalDeps.length > 0) {
      const missing = this.findMissingDependencies(externalDeps);
      if (missing.length > 0) {
        throw new AppError(
          'FOREIGN_KEY_VIOLATION',
          `Referenced dependency task(s) do not exist: ${missing.join(', ')}`,
          { missingDependencies: missing },
        );
      }
    }

    // 5. Kiểm tra chu trình phụ thuộc (Circular Dependency Check)
    const existingDeps = this.depRepo.getAll();
    const batchGraph = new DependencyGraph();
    for (const dep of existingDeps) {
      batchGraph.addDependency(dep.task_id, dep.depends_on_id);
    }
    for (const task of validatedTasks) {
      batchGraph.addNode(task.id, task.priority ?? 0);
      const deps = task.dependencies ?? [];
      for (const dep of deps) {
        batchGraph.addDependency(task.id, dep);
      }
    }
    const cycleResult = batchGraph.detectCycleDFS();
    if (cycleResult.hasCycle && cycleResult.cycle) {
      throw new AppError(
        'CIRCULAR_DEPENDENCY_ERROR',
        `Cannot create tasks: circular dependency detected: ${cycleResult.cyclePathString}`,
        {
          cycle: cycleResult.cycle,
          cyclePathString: cycleResult.cyclePathString,
        },
      );
    }

    // 6. Atomic transaction insert: chèn toàn bộ tasks trước, sau đó chèn dependencies
    const now = new Date().toISOString();
    const insertTaskStmt = this.db.prepare(`
      INSERT INTO tasks (
        id, feature_id, plan_id, title, description, phase, worker_type, repository,
        acceptance_criteria, test_commands, priority, max_attempts, timeout_minutes,
        status, attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const bulkTx = this.db.transaction(() => {
      for (const task of validatedTasks) {
        const createdAt = task.created_at ?? now;
        const updatedAt = task.updated_at ?? now;
        insertTaskStmt.run(
          task.id,
          task.feature_id ?? null,
          task.plan_id ?? null,
          task.title,
          task.description ?? null,
          task.phase ?? null,
          task.worker_type ?? 'agy',
          task.repository ?? '.',
          JSON.stringify(task.acceptance_criteria ?? []),
          JSON.stringify(task.test_commands ?? []),
          task.priority ?? 0,
          task.max_attempts ?? 3,
          task.timeout_minutes ?? 30,
          task.status ?? 'TODO',
          task.attempts ?? 0,
          createdAt,
          updatedAt,
        );
      }

      for (const task of validatedTasks) {
        const deps = task.dependencies ?? [];
        if (deps.length > 0) {
          this.depRepo.setForTask(task.id, deps);
        }
      }
    });

    try {
      bulkTx();
    } catch (error: unknown) {
      if (error instanceof AppError) {
        throw error;
      }
      this.handleSqliteError(error, 'batch');
    }

    return batchIds.map((id) => {
      const task = this.findById(id);
      if (!task) {
        throw new AppError('TASK_NOT_FOUND', `Failed to retrieve task '${id}' after batch creation`, {
          taskId: id,
        });
      }
      return task;
    });
  }

  /**
   * Chuyển đổi trạng thái task theo quy tắc State Machine (ORC-001).
   * Kiểm tra nghiêm ngặt tính hợp lệ của chuyển đổi (nếu không dùng force: true).
   * Chuyển trạng thái trái phép → ném AppError('ILLEGAL_STATE_TRANSITION', ...).
   */
  transitionStatus(
    id: string,
    status: TaskStatus,
    options?: { incrementAttempt?: boolean; force?: boolean; reason?: string },
  ): TaskWithDependencies {
    const validStatus = TaskStatusSchema.parse(status);
    const existing = this.findById(id);
    if (!existing) {
      throw new AppError('TASK_NOT_FOUND', `Task with id '${id}' not found`, { taskId: id });
    }

    if (!options?.force) {
      assertValidTaskTransition(existing.status, validStatus, {
        taskId: id,
        reason: options?.reason,
      });
    }

    const now = new Date().toISOString();
    const attempts = options?.incrementAttempt ? existing.attempts + 1 : existing.attempts;

    this.db
      .prepare('UPDATE tasks SET status = ?, attempts = ?, updated_at = ? WHERE id = ?')
      .run(validStatus, attempts, now, id);

    const updated = this.findById(id);
    if (!updated) {
      throw new AppError('TASK_NOT_FOUND', `Task with id '${id}' not found after status transition`, {
        taskId: id,
      });
    }
    return updated;
  }

  updateStatus(
    id: string,
    status: TaskStatus,
    options?: {
      incrementAttempt?: boolean;
      enforceTransitions?: boolean;
      force?: boolean;
      reason?: string;
    },
  ): TaskWithDependencies {
    if (options?.enforceTransitions) {
      return this.transitionStatus(id, status, options);
    }

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

  detectCycle(options?: { algorithm?: 'dfs' | 'kahn' }): CycleDetectionResult {
    const tasks = this.findAll();
    const graph = new DependencyGraph();
    for (const task of tasks) {
      graph.addNode(task.id, task.priority);
      for (const depId of task.dependencies) {
        graph.addDependency(task.id, depId);
      }
    }
    return graph.detectCycle(options);
  }

  getExecutionOrder(taskIds?: string[]): string[] {
    const allTasks = this.findAll();
    const graph = new DependencyGraph();

    for (const task of allTasks) {
      graph.addNode(task.id, task.priority);
      for (const depId of task.dependencies) {
        graph.addDependency(task.id, depId);
      }
    }

    const fullOrder = graph.topologicalSort();

    if (!taskIds || taskIds.length === 0) {
      return fullOrder;
    }

    const requestedSet = new Set(taskIds);
    return fullOrder.filter((id) => requestedSet.has(id));
  }

  findReadyTasks(
    filter?: TaskFilter,
    options?: ResolveReadyOptions,
  ): TaskWithDependencies[] {
    const allTasks = this.findAll();
    const resolver = new DependencyResolver(allTasks);
    return resolver.getReadyTasks({
      ...options,
      featureId: filter?.feature_id ?? options?.featureId,
      planId: filter?.plan_id ?? options?.planId,
      phase: filter?.phase ?? options?.phase,
    });
  }

  getDependencyStatus(taskId: string): TaskDependencyStatus {
    const allTasks = this.findAll();
    const resolver = new DependencyResolver(allTasks);
    return resolver.checkTask(taskId);
  }

  resolveAndMarkReady(filter?: TaskFilter): TaskWithDependencies[] {
    const transitionTx = this.db.transaction(() => {
      const allTasks = this.findAll();
      const resolver = new DependencyResolver(allTasks);
      // Chỉ tìm các task 'TODO' có đầy đủ dependencies 'DONE'
      const eligibleTodoTasks = resolver.getReadyTasks({
        featureId: filter?.feature_id,
        planId: filter?.plan_id,
        phase: filter?.phase,
        candidateStatuses: ['TODO'],
      });

      for (const task of eligibleTodoTasks) {
        this.transitionStatus(task.id, 'READY', {
          reason: 'Dependencies satisfied (resolved ready)',
        });
      }

      // Trả về danh sách toàn bộ các task READY hiện tại
      return this.findReadyTasks(filter, { candidateStatuses: ['READY'] });
    });

    return transitionTx();
  }

  private handleSqliteError(error: unknown, taskId: string): never {
    if (error instanceof AppError) {
      throw error;
    }
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
        `Foreign key constraint failed for task '${taskId}': referenced entity does not exist`,
        { taskId, error: sqliteErr.message },
      );
    }
    throw error;
  }
}
