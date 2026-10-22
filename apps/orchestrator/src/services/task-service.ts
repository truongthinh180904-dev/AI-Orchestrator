import type Database from 'better-sqlite3';
import { TaskRepository } from '@ai-orchestrator/db';
import {
  AppError,
  type TaskWithDependencies,
  type TaskFilter,
  type UpdateTaskInput,
} from '@ai-orchestrator/shared';

export class TaskService {
  private readonly taskRepo: TaskRepository;

  constructor(db: Database.Database) {
    this.taskRepo = new TaskRepository(db);
  }

  list(filter?: TaskFilter, search?: string): TaskWithDependencies[] {
    let tasks = this.taskRepo.findAll(filter);
    if (search && search.trim().length > 0) {
      const q = search.trim().toLowerCase();
      tasks = tasks.filter(
        (t) =>
          t.id.toLowerCase().includes(q) ||
          t.title.toLowerCase().includes(q) ||
          (t.description && t.description.toLowerCase().includes(q)),
      );
    }
    return tasks;
  }

  getById(id: string): TaskWithDependencies {
    const task = this.taskRepo.findById(id);
    if (!task) {
      throw new AppError('TASK_NOT_FOUND', `Task with id '${id}' not found`, { taskId: id });
    }
    return task;
  }

  update(id: string, input: UpdateTaskInput): TaskWithDependencies {
    return this.taskRepo.update(id, input);
  }
}
