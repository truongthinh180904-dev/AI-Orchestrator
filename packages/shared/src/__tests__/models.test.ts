import { describe, expect, it } from 'vitest';
import {
  CreateFeatureInputSchema,
  CreateTaskDependencyInputSchema,
  CreateTaskInputSchema,
  FeatureSchema,
  FeatureStatusSchema,
  TaskDependencySchema,
  TaskSchema,
  TaskStatusSchema,
  TaskWithDependenciesSchema,
  UpdateFeatureInputSchema,
  UpdateTaskInputSchema,
} from '../models/index.js';

describe('TSK-001: Zod Schemas & Domain Models', () => {
  describe('Task Models & Schemas', () => {
    it('Validates valid TaskStatus values and rejects invalid ones', () => {
      const validStatuses = [
        'TODO',
        'READY',
        'RUNNING',
        'VERIFYING',
        'DONE',
        'FAILED',
        'BLOCKED',
        'PAUSED',
        'CANCELLED',
      ];
      for (const s of validStatuses) {
        expect(TaskStatusSchema.parse(s)).toBe(s);
      }
      expect(() => TaskStatusSchema.parse('INVALID_STATUS')).toThrow();
    });

    it('Validates full TaskSchema object with defaults', () => {
      const task = TaskSchema.parse({
        id: 'TSK-001',
        title: 'Define schemas',
        created_at: '2026-10-23T00:00:00.000Z',
        updated_at: '2026-10-23T00:00:00.000Z',
      });

      expect(task.id).toBe('TSK-001');
      expect(task.title).toBe('Define schemas');
      expect(task.feature_id).toBeNull();
      expect(task.description).toBeNull();
      expect(task.phase).toBeNull();
      expect(task.worker_type).toBe('agy');
      expect(task.repository).toBe('.');
      expect(task.acceptance_criteria).toEqual([]);
      expect(task.test_commands).toEqual([]);
      expect(task.priority).toBe(0);
      expect(task.max_attempts).toBe(3);
      expect(task.timeout_minutes).toBe(30);
      expect(task.status).toBe('TODO');
      expect(task.attempts).toBe(0);
    });

    it('Validates TaskWithDependenciesSchema', () => {
      const taskWithDeps = TaskWithDependenciesSchema.parse({
        id: 'TSK-002',
        title: 'Parser Excel',
        dependencies: ['TSK-001'],
        created_at: '2026-10-23T00:00:00.000Z',
        updated_at: '2026-10-23T00:00:00.000Z',
      });

      expect(taskWithDeps.dependencies).toEqual(['TSK-001']);
    });

    it('Rejects CreateTaskInput when id or title is missing or empty', () => {
      expect(() =>
        CreateTaskInputSchema.parse({
          id: '',
          title: 'Valid title',
        }),
      ).toThrow();

      expect(() =>
        CreateTaskInputSchema.parse({
          id: 'TSK-001',
          title: '',
        }),
      ).toThrow();
    });

    it('Validates UpdateTaskInputSchema allows partial fields', () => {
      const update = UpdateTaskInputSchema.parse({
        title: 'Updated title',
        status: 'RUNNING',
        priority: 10,
      });

      expect(update.title).toBe('Updated title');
      expect(update.status).toBe('RUNNING');
      expect(update.priority).toBe(10);
      expect(update.description).toBeUndefined();
    });
  });

  describe('Feature Models & Schemas', () => {
    it('Validates FeatureStatus enum values', () => {
      const statuses = ['TODO', 'IN_PROGRESS', 'DONE', 'FAILED', 'BLOCKED'];
      for (const s of statuses) {
        expect(FeatureStatusSchema.parse(s)).toBe(s);
      }
      expect(() => FeatureStatusSchema.parse('UNKNOWN')).toThrow();
    });

    it('Validates FeatureSchema with defaults', () => {
      const feat = FeatureSchema.parse({
        id: 'FEAT-001',
        name: 'Task Management Engine',
        created_at: '2026-10-23T00:00:00.000Z',
        updated_at: '2026-10-23T00:00:00.000Z',
      });

      expect(feat.id).toBe('FEAT-001');
      expect(feat.name).toBe('Task Management Engine');
      expect(feat.description).toBeNull();
      expect(feat.required_tasks).toEqual([]);
      expect(feat.integration_tests).toEqual([]);
      expect(feat.release_policy).toBeNull();
      expect(feat.status).toBe('TODO');
    });

    it('Validates CreateFeatureInputSchema and UpdateFeatureInputSchema', () => {
      const created = CreateFeatureInputSchema.parse({
        id: 'FEAT-002',
        name: 'Worker Execution',
        required_tasks: ['AGY-001', 'AGY-002'],
      });
      expect(created.required_tasks).toEqual(['AGY-001', 'AGY-002']);

      const updated = UpdateFeatureInputSchema.parse({
        status: 'IN_PROGRESS',
      });
      expect(updated.status).toBe('IN_PROGRESS');
    });
  });

  describe('TaskDependency Models & Schemas', () => {
    it('Validates TaskDependencySchema and rejects empty strings', () => {
      const dep = TaskDependencySchema.parse({
        task_id: 'TSK-002',
        depends_on_id: 'TSK-001',
      });
      expect(dep.task_id).toBe('TSK-002');
      expect(dep.depends_on_id).toBe('TSK-001');

      expect(() =>
        CreateTaskDependencyInputSchema.parse({
          task_id: '',
          depends_on_id: 'TSK-001',
        }),
      ).toThrow();
    });
  });
});
