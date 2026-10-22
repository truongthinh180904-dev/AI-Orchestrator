import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../connection.js';
import { runMigrations } from '../migrator.js';
import { FeatureRepository } from '../repositories/feature-repository.js';
import { TaskRepository } from '../repositories/task-repository.js';
import { TaskDependencyRepository } from '../repositories/dependency-repository.js';

describe('TSK-001: DB Repositories (Task, Feature, TaskDependency)', () => {
  let db: Database.Database;
  let featureRepo: FeatureRepository;
  let taskRepo: TaskRepository;
  let depRepo: TaskDependencyRepository;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    featureRepo = new FeatureRepository(db);
    taskRepo = new TaskRepository(db);
    depRepo = new TaskDependencyRepository(db);
  });

  describe('FeatureRepository CRUD', () => {
    it('Creates and retrieves a feature with JSON arrays and default values', () => {
      const feat = featureRepo.create({
        id: 'FEAT-1',
        name: 'Feature One',
        description: 'First feature description',
        required_tasks: ['TSK-1', 'TSK-2'],
        integration_tests: ['test/feat1.test.ts'],
        release_policy: 'standard',
        status: 'TODO',
      });

      expect(feat.id).toBe('FEAT-1');
      expect(feat.name).toBe('Feature One');
      expect(feat.description).toBe('First feature description');
      expect(feat.required_tasks).toEqual(['TSK-1', 'TSK-2']);
      expect(feat.integration_tests).toEqual(['test/feat1.test.ts']);
      expect(feat.status).toBe('TODO');
      expect(feat.created_at).toBeDefined();
      expect(feat.updated_at).toBeDefined();

      const retrieved = featureRepo.findById('FEAT-1');
      expect(retrieved).toEqual(feat);
    });

    it('Rejects duplicate feature creation with FEATURE_ALREADY_EXISTS', () => {
      featureRepo.create({ id: 'FEAT-DUP', name: 'Original' });

      expect(() => featureRepo.create({ id: 'FEAT-DUP', name: 'Duplicate' })).toThrowError(
        expect.objectContaining({ code: 'FEATURE_ALREADY_EXISTS' }),
      );
    });

    it('Finds all features and filters by status', () => {
      featureRepo.create({ id: 'FEAT-A', name: 'Feat A', status: 'TODO' });
      featureRepo.create({ id: 'FEAT-B', name: 'Feat B', status: 'IN_PROGRESS' });
      featureRepo.create({ id: 'FEAT-C', name: 'Feat C', status: 'DONE' });

      expect(featureRepo.findAll()).toHaveLength(3);
      expect(featureRepo.findAll({ status: 'IN_PROGRESS' })).toHaveLength(1);
      expect(featureRepo.findAll({ status: 'IN_PROGRESS' })[0]?.id).toBe('FEAT-B');
    });

    it('Updates feature fields and timestamps', () => {
      featureRepo.create({ id: 'FEAT-UPD', name: 'Before Update' });
      const updated = featureRepo.update('FEAT-UPD', {
        name: 'After Update',
        status: 'DONE',
      });

      expect(updated.name).toBe('After Update');
      expect(updated.status).toBe('DONE');

      expect(() => featureRepo.update('NON-EXISTENT', { name: 'Fail' })).toThrowError(
        expect.objectContaining({ code: 'FEATURE_NOT_FOUND' }),
      );
    });

    it('Deletes feature and reports existence/count', () => {
      featureRepo.create({ id: 'FEAT-DEL', name: 'To be deleted' });
      expect(featureRepo.exists('FEAT-DEL')).toBe(true);
      expect(featureRepo.count()).toBe(1);

      expect(featureRepo.delete('FEAT-DEL')).toBe(true);
      expect(featureRepo.exists('FEAT-DEL')).toBe(false);
      expect(featureRepo.count()).toBe(0);
      expect(featureRepo.delete('FEAT-DEL')).toBe(false);
    });
  });

  describe('TaskRepository CRUD', () => {
    it('Creates and retrieves a task with dependencies and arrays', () => {
      featureRepo.create({ id: 'FEAT-1', name: 'Parent Feature' });

      // First create a dependency task
      taskRepo.create({
        id: 'TSK-0',
        title: 'Prerequisite Task',
      });

      const task = taskRepo.create({
        id: 'TSK-1',
        feature_id: 'FEAT-1',
        title: 'Main Task',
        description: 'Detailed description',
        phase: 'Phase 1',
        worker_type: 'agy',
        repository: '.',
        acceptance_criteria: ['Must pass tests', 'Must have docs'],
        test_commands: ['pnpm test'],
        priority: 10,
        max_attempts: 5,
        timeout_minutes: 45,
        status: 'TODO',
        dependencies: ['TSK-0'],
      });

      expect(task.id).toBe('TSK-1');
      expect(task.feature_id).toBe('FEAT-1');
      expect(task.priority).toBe(10);
      expect(task.acceptance_criteria).toEqual(['Must pass tests', 'Must have docs']);
      expect(task.test_commands).toEqual(['pnpm test']);
      expect(task.dependencies).toEqual(['TSK-0']);

      const fetched = taskRepo.findById('TSK-1');
      expect(fetched).toEqual(task);
    });

    it('Rejects duplicate task creation with TASK_ALREADY_EXISTS', () => {
      taskRepo.create({ id: 'TSK-DUP', title: 'First' });

      expect(() => taskRepo.create({ id: 'TSK-DUP', title: 'Second' })).toThrowError(
        expect.objectContaining({ code: 'TASK_ALREADY_EXISTS' }),
      );
    });

    it('Rejects self-dependency with SELF_DEPENDENCY_ERROR', () => {
      expect(() =>
        taskRepo.create({
          id: 'TSK-SELF',
          title: 'Self-dependent',
          dependencies: ['TSK-SELF'],
        }),
      ).toThrowError(expect.objectContaining({ code: 'SELF_DEPENDENCY_ERROR' }));
    });

    it('Enforces foreign key constraint on feature_id and dependencies', () => {
      expect(() =>
        taskRepo.create({
          id: 'TSK-FK-FEAT',
          title: 'Invalid Feature Ref',
          feature_id: 'NON-EXISTENT-FEAT',
        }),
      ).toThrowError(expect.objectContaining({ code: 'FOREIGN_KEY_VIOLATION' }));

      expect(() =>
        taskRepo.create({
          id: 'TSK-FK-DEP',
          title: 'Invalid Dep Ref',
          dependencies: ['NON-EXISTENT-TASK'],
        }),
      ).toThrowError(expect.objectContaining({ code: 'FOREIGN_KEY_VIOLATION' }));
    });

    it('Finds all tasks and filters by status, feature_id, and phase', () => {
      featureRepo.create({ id: 'FEAT-1', name: 'Feat 1' });
      featureRepo.create({ id: 'FEAT-2', name: 'Feat 2' });

      taskRepo.create({
        id: 'T-1',
        feature_id: 'FEAT-1',
        title: 'Task 1',
        phase: 'P1',
        status: 'TODO',
        priority: 5,
      });
      taskRepo.create({
        id: 'T-2',
        feature_id: 'FEAT-1',
        title: 'Task 2',
        phase: 'P2',
        status: 'DONE',
        priority: 10,
      });
      taskRepo.create({
        id: 'T-3',
        feature_id: 'FEAT-2',
        title: 'Task 3',
        phase: 'P1',
        status: 'TODO',
        priority: 1,
      });

      const all = taskRepo.findAll();
      expect(all).toHaveLength(3);
      // Priority ordering: T-2 (10), T-1 (5), T-3 (1)
      expect(all[0]?.id).toBe('T-2');
      expect(all[1]?.id).toBe('T-1');
      expect(all[2]?.id).toBe('T-3');

      expect(taskRepo.findAll({ status: 'DONE' })).toHaveLength(1);
      expect(taskRepo.findAll({ feature_id: 'FEAT-1' })).toHaveLength(2);
      expect(taskRepo.findAll({ phase: 'P1' })).toHaveLength(2);
    });

    it('Updates task fields, syncs dependencies, and updates timestamps', () => {
      taskRepo.create({ id: 'DEP-1', title: 'Dep 1' });
      taskRepo.create({ id: 'DEP-2', title: 'Dep 2' });
      taskRepo.create({ id: 'T-MAIN', title: 'Main Task', dependencies: ['DEP-1'] });

      const updated = taskRepo.update('T-MAIN', {
        title: 'Main Task Renamed',
        status: 'RUNNING',
        dependencies: ['DEP-2'],
      });

      expect(updated.title).toBe('Main Task Renamed');
      expect(updated.status).toBe('RUNNING');
      expect(updated.dependencies).toEqual(['DEP-2']);

      expect(() => taskRepo.update('NON-EXISTENT', { title: 'Fail' })).toThrowError(
        expect.objectContaining({ code: 'TASK_NOT_FOUND' }),
      );
    });

    it('Updates status and increments attempt count via updateStatus', () => {
      taskRepo.create({ id: 'T-STATUS', title: 'Status Task' });

      const s1 = taskRepo.updateStatus('T-STATUS', 'RUNNING', { incrementAttempt: true });
      expect(s1.status).toBe('RUNNING');
      expect(s1.attempts).toBe(1);

      const s2 = taskRepo.updateStatus('T-STATUS', 'DONE');
      expect(s2.status).toBe('DONE');
      expect(s2.attempts).toBe(1);
    });

    it('Deletes task and cascades deletion to task_dependencies', () => {
      taskRepo.create({ id: 'T-A', title: 'Task A' });
      taskRepo.create({ id: 'T-B', title: 'Task B', dependencies: ['T-A'] });

      expect(depRepo.getByTaskId('T-B')).toEqual(['T-A']);

      expect(taskRepo.delete('T-B')).toBe(true);
      expect(taskRepo.exists('T-B')).toBe(false);
      expect(depRepo.getByTaskId('T-B')).toEqual([]);
    });

    it('Cascades foreign key deletion when parent task is deleted', () => {
      taskRepo.create({ id: 'T-PARENT', title: 'Parent' });
      taskRepo.create({ id: 'T-CHILD', title: 'Child', dependencies: ['T-PARENT'] });

      expect(depRepo.getByTaskId('T-CHILD')).toEqual(['T-PARENT']);

      // Deleting the parent should cascade remove the dependency entry
      taskRepo.delete('T-PARENT');
      expect(depRepo.getByTaskId('T-CHILD')).toEqual([]);
    });

    it('Nullifies feature_id on task when feature is deleted', () => {
      featureRepo.create({ id: 'FEAT-X', name: 'Feature X' });
      taskRepo.create({ id: 'T-X', feature_id: 'FEAT-X', title: 'Task under X' });

      expect(taskRepo.findById('T-X')?.feature_id).toBe('FEAT-X');

      featureRepo.delete('FEAT-X');
      expect(taskRepo.findById('T-X')?.feature_id).toBeNull();
    });
  });

  describe('TaskDependencyRepository', () => {
    it('Manages dependencies directly (add, remove, query)', () => {
      taskRepo.create({ id: 'TASK-1', title: 'Task 1' });
      taskRepo.create({ id: 'TASK-2', title: 'Task 2' });
      taskRepo.create({ id: 'TASK-3', title: 'Task 3' });

      depRepo.add('TASK-2', 'TASK-1');
      depRepo.add('TASK-3', 'TASK-1');

      expect(depRepo.getByTaskId('TASK-2')).toEqual(['TASK-1']);
      expect(depRepo.getDependentsOf('TASK-1')).toEqual(['TASK-2', 'TASK-3']);
      expect(depRepo.count()).toBe(2);

      expect(depRepo.remove('TASK-2', 'TASK-1')).toBe(true);
      expect(depRepo.getByTaskId('TASK-2')).toEqual([]);
      expect(depRepo.count()).toBe(1);
    });

    it('Rejects duplicate dependency addition with DEPENDENCY_ALREADY_EXISTS', () => {
      taskRepo.create({ id: 'T1', title: '1' });
      taskRepo.create({ id: 'T2', title: '2' });

      depRepo.add('T2', 'T1');
      expect(() => depRepo.add('T2', 'T1')).toThrowError(
        expect.objectContaining({ code: 'DEPENDENCY_ALREADY_EXISTS' }),
      );
    });
  });
});
