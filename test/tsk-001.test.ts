import { describe, expect, it } from 'vitest';
import { createDatabase, runMigrations, FeatureRepository, TaskRepository, TaskDependencyRepository } from '../packages/db/src/index.js';
import {
  FeatureSchema,
  TaskDependencySchema,
  TaskWithDependenciesSchema,
  CreateTaskInputSchema,
  CreateFeatureInputSchema,
} from '../packages/shared/src/index.js';

describe('TSK-001: Schema + model Task/Feature/Dependency (zod + repository class)', () => {
  describe('Nghiệm thu 1: Migration', () => {
    it('Chạy migration trên DB mới thành công và áp dụng đúng các bảng liên quan', () => {
      const db = createDatabase(':memory:');
      const newlyApplied = runMigrations(db);

      expect(newlyApplied).toContain('001_initial_schema.sql');

      // Kiểm tra sự tồn tại của 3 bảng cốt lõi
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('features', 'tasks', 'task_dependencies')",
        )
        .all() as Array<{ name: string }>;

      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain('features');
      expect(tableNames).toContain('tasks');
      expect(tableNames).toContain('task_dependencies');
    });

    it('Chạy migration lần 2 an toàn (idempotent)', () => {
      const db = createDatabase(':memory:');
      runMigrations(db);
      const secondRun = runMigrations(db);
      expect(secondRun).toHaveLength(0);
    });
  });

  describe('Nghiệm thu 2: Test CRUD & Zod Schemas', () => {
    it('CRUD Feature: create, read, update, delete qua FeatureRepository và Zod model', () => {
      const db = createDatabase(':memory:');
      runMigrations(db);
      const featureRepo = new FeatureRepository(db);

      // 1. Create & Zod validation
      const featureInput = CreateFeatureInputSchema.parse({
        id: 'FEAT-ORC',
        name: 'Orchestrator Core',
        description: 'Core scheduler and task engine',
        required_tasks: ['TSK-001', 'TSK-002'],
        integration_tests: ['test/orc.test.ts'],
        status: 'TODO',
      });
      const createdFeature = featureRepo.create(featureInput);
      expect(FeatureSchema.parse(createdFeature)).toEqual(createdFeature);
      expect(createdFeature.id).toBe('FEAT-ORC');
      expect(createdFeature.name).toBe('Orchestrator Core');

      // 2. Read
      const foundFeature = featureRepo.findById('FEAT-ORC');
      expect(foundFeature).not.toBeNull();
      expect(foundFeature?.required_tasks).toEqual(['TSK-001', 'TSK-002']);

      // 3. Update
      const updatedFeature = featureRepo.update('FEAT-ORC', {
        name: 'Orchestrator Core V2',
        status: 'IN_PROGRESS',
      });
      expect(updatedFeature.name).toBe('Orchestrator Core V2');
      expect(updatedFeature.status).toBe('IN_PROGRESS');

      // 4. Delete
      const deleted = featureRepo.delete('FEAT-ORC');
      expect(deleted).toBe(true);
      expect(featureRepo.findById('FEAT-ORC')).toBeNull();
    });

    it('CRUD Task: create, read, update, delete qua TaskRepository và Zod model', () => {
      const db = createDatabase(':memory:');
      runMigrations(db);
      const taskRepo = new TaskRepository(db);

      // Create dependency task first
      taskRepo.create({
        id: 'TSK-FND',
        title: 'Foundation setup',
      });

      // 1. Create & Zod validation
      const taskInput = CreateTaskInputSchema.parse({
        id: 'TSK-001',
        title: 'Task models & schemas',
        description: 'Implement Zod models and repository classes',
        phase: 'GĐ 1 — Task Management',
        acceptance_criteria: ['Migration pass', 'CRUD test pass'],
        test_commands: ['pnpm test'],
        priority: 100,
        dependencies: ['TSK-FND'],
      });
      const createdTask = taskRepo.create(taskInput);
      expect(TaskWithDependenciesSchema.parse(createdTask)).toEqual(createdTask);
      expect(createdTask.id).toBe('TSK-001');
      expect(createdTask.dependencies).toEqual(['TSK-FND']);

      // 2. Read
      const foundTask = taskRepo.findById('TSK-001');
      expect(foundTask).not.toBeNull();
      expect(foundTask?.acceptance_criteria).toEqual(['Migration pass', 'CRUD test pass']);
      expect(foundTask?.priority).toBe(100);

      // 3. Update
      const updatedTask = taskRepo.update('TSK-001', {
        title: 'Task models & schemas (Updated)',
        status: 'DONE',
        dependencies: [],
      });
      expect(updatedTask.title).toBe('Task models & schemas (Updated)');
      expect(updatedTask.status).toBe('DONE');
      expect(updatedTask.dependencies).toEqual([]);

      // 4. Delete
      const deleted = taskRepo.delete('TSK-001');
      expect(deleted).toBe(true);
      expect(taskRepo.findById('TSK-001')).toBeNull();
    });

    it('CRUD Dependency: thêm, đọc, xóa quan hệ phụ thuộc', () => {
      const db = createDatabase(':memory:');
      runMigrations(db);
      const taskRepo = new TaskRepository(db);
      const depRepo = new TaskDependencyRepository(db);

      taskRepo.create({ id: 'TASK-A', title: 'Task A' });
      taskRepo.create({ id: 'TASK-B', title: 'Task B' });

      // Add dependency
      taskRepo.addDependency('TASK-B', 'TASK-A');
      expect(taskRepo.getDependencies('TASK-B')).toEqual(['TASK-A']);
      expect(taskRepo.getDependents('TASK-A')).toEqual(['TASK-B']);

      // Validate dependency model
      const allDeps = depRepo.getAll();
      expect(allDeps).toHaveLength(1);
      expect(TaskDependencySchema.parse(allDeps[0])).toEqual({
        task_id: 'TASK-B',
        depends_on_id: 'TASK-A',
      });

      // Remove dependency
      const removed = taskRepo.removeDependency('TASK-B', 'TASK-A');
      expect(removed).toBe(true);
      expect(taskRepo.getDependencies('TASK-B')).toEqual([]);
    });
  });
});
