import type Database from 'better-sqlite3';
import {
  type CreateTaskDependencyInput,
  type TaskDependency,
  TaskDependencySchema,
  AppError,
  DependencyGraph,
} from '@ai-orchestrator/shared';

export class TaskDependencyRepository {
  constructor(private readonly db: Database.Database) {}

  add(taskId: string, dependsOnId: string): void {
    if (taskId === dependsOnId) {
      throw new AppError('SELF_DEPENDENCY_ERROR', `Task '${taskId}' cannot depend on itself`, {
        taskId,
        dependsOnId,
      });
    }

    const validated: CreateTaskDependencyInput = TaskDependencySchema.parse({
      task_id: taskId,
      depends_on_id: dependsOnId,
    });

    // Kiểm tra xem việc thêm dependency có tạo chu trình không
    const cycleCheck = this.getCycleIfAdded(validated.task_id, validated.depends_on_id);
    if (cycleCheck.hasCycle && cycleCheck.cycle) {
      throw new AppError(
        'CIRCULAR_DEPENDENCY_ERROR',
        `Cannot add dependency: '${validated.task_id}' depending on '${validated.depends_on_id}' creates a circular dependency: ${cycleCheck.cyclePathString}`,
        {
          taskId: validated.task_id,
          dependsOnId: validated.depends_on_id,
          cycle: cycleCheck.cycle,
          cyclePathString: cycleCheck.cyclePathString,
        },
      );
    }

    try {
      this.db
        .prepare('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)')
        .run(validated.task_id, validated.depends_on_id);
    } catch (error: unknown) {
      this.handleSqliteError(error, validated.task_id, validated.depends_on_id);
    }
  }

  remove(taskId: string, dependsOnId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?')
      .run(taskId, dependsOnId);
    return result.changes > 0;
  }

  getByTaskId(taskId: string): string[] {
    const rows = this.db
      .prepare('SELECT depends_on_id FROM task_dependencies WHERE task_id = ? ORDER BY depends_on_id ASC')
      .all(taskId) as Array<{ depends_on_id: string }>;
    return rows.map((r) => r.depends_on_id);
  }

  getDependentsOf(taskId: string): string[] {
    const rows = this.db
      .prepare('SELECT task_id FROM task_dependencies WHERE depends_on_id = ? ORDER BY task_id ASC')
      .all(taskId) as Array<{ task_id: string }>;
    return rows.map((r) => r.task_id);
  }

  setForTask(taskId: string, dependsOnIds: string[]): void {
    for (const depId of dependsOnIds) {
      if (depId === taskId) {
        throw new AppError('SELF_DEPENDENCY_ERROR', `Task '${taskId}' cannot depend on itself`, {
          taskId,
          dependsOnId: depId,
        });
      }
    }

    const uniqueDeps = Array.from(new Set(dependsOnIds));

    // Kiểm tra nếu việc cập nhật dependencies tạo chu trình
    const cycleCheck = this.getCycleIfSetForTask(taskId, uniqueDeps);
    if (cycleCheck.hasCycle && cycleCheck.cycle) {
      throw new AppError(
        'CIRCULAR_DEPENDENCY_ERROR',
        `Cannot set dependencies for '${taskId}': creates circular dependency: ${cycleCheck.cyclePathString}`,
        {
          taskId,
          dependencies: uniqueDeps,
          cycle: cycleCheck.cycle,
          cyclePathString: cycleCheck.cyclePathString,
        },
      );
    }

    const syncTx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM task_dependencies WHERE task_id = ?').run(taskId);
      const insertStmt = this.db.prepare(
        'INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)',
      );
      for (const depId of uniqueDeps) {
        insertStmt.run(taskId, depId);
      }
    });

    try {
      syncTx();
    } catch (error: unknown) {
      this.handleSqliteError(error, taskId);
    }
  }

  buildGraph(): DependencyGraph {
    const all = this.getAll();
    const graph = new DependencyGraph();
    for (const dep of all) {
      graph.addDependency(dep.task_id, dep.depends_on_id);
    }
    return graph;
  }

  getCycleIfAdded(
    taskId: string,
    dependsOnId: string,
  ): { hasCycle: boolean; cycle: string[] | null; cyclePathString: string | null } {
    if (taskId === dependsOnId) {
      return {
        hasCycle: true,
        cycle: [taskId, taskId],
        cyclePathString: `${taskId} -> ${taskId}`,
      };
    }
    const graph = this.buildGraph();
    graph.addDependency(taskId, dependsOnId);
    const result = graph.detectCycleDFS();
    return {
      hasCycle: result.hasCycle,
      cycle: result.cycle,
      cyclePathString: result.cyclePathString,
    };
  }

  getCycleIfSetForTask(
    taskId: string,
    dependsOnIds: string[],
  ): { hasCycle: boolean; cycle: string[] | null; cyclePathString: string | null } {
    const all = this.getAll().filter((dep) => dep.task_id !== taskId);
    const graph = new DependencyGraph();
    for (const dep of all) {
      graph.addDependency(dep.task_id, dep.depends_on_id);
    }
    graph.addNode(taskId);
    for (const depId of dependsOnIds) {
      graph.addDependency(taskId, depId);
    }
    const result = graph.detectCycleDFS();
    return {
      hasCycle: result.hasCycle,
      cycle: result.cycle,
      cyclePathString: result.cyclePathString,
    };
  }

  getAll(): TaskDependency[] {
    const rows = this.db
      .prepare('SELECT task_id, depends_on_id FROM task_dependencies ORDER BY task_id ASC, depends_on_id ASC')
      .all() as Array<{ task_id: string; depends_on_id: string }>;

    return rows.map((r) => TaskDependencySchema.parse(r));
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM task_dependencies').get() as {
      count: number;
    };
    return row.count;
  }

  private handleSqliteError(error: unknown, taskId: string, dependsOnId?: string): never {
    const sqliteErr = error as { code?: string; message?: string };
    if (sqliteErr.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || sqliteErr.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new AppError(
        'DEPENDENCY_ALREADY_EXISTS',
        `Dependency between '${taskId}' and '${dependsOnId}' already exists`,
        { taskId, dependsOnId },
      );
    }
    if (sqliteErr.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      throw new AppError(
        'FOREIGN_KEY_VIOLATION',
        `Foreign key constraint violated for dependency: referenced task does not exist`,
        { taskId, dependsOnId, error: sqliteErr.message },
      );
    }
    throw error;
  }
}
