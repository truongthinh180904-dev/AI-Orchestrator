import type Database from 'better-sqlite3';
import { TaskRepository } from '@ai-orchestrator/db';
import {
  AppError,
  type TaskWithDependencies,
  type TaskFilter,
  type UpdateTaskInput,
  type TaskStatus,
} from '@ai-orchestrator/shared';
import { TaskStateService, type TransitionTaskOptions } from './task-state-service.js';

export class TaskService {
  private readonly taskRepo: TaskRepository;
  private readonly stateService: TaskStateService;

  constructor(db: Database.Database) {
    this.taskRepo = new TaskRepository(db);
    this.stateService = new TaskStateService(db);
  }

  get state(): TaskStateService {
    return this.stateService;
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

  transition(
    id: string,
    targetStatus: TaskStatus,
    options?: TransitionTaskOptions,
  ): TaskWithDependencies {
    return this.stateService.transition(id, targetStatus, options);
  }

  getAllowedTransitions(id: string): readonly TaskStatus[] {
    return this.stateService.getAllowedTransitions(id);
  }
}

