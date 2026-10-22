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
  RunStatusSchema,
  RunSchema,
  CreateRunInputSchema,
  UpdateRunInputSchema,
  EventRecordSchema,
  CreateEventInputSchema,
  STANDARD_EVENT_TYPES,
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

  describe('Run & Event Models & Schemas (AGY-003)', () => {
    it('Validates RunStatusSchema and rejects invalid statuses', () => {
      const validStatuses = [
        'PENDING',
        'RUNNING',
        'SUCCESS',
        'ERROR',
        'INVALID_OUTPUT',
        'TIMEOUT',
        'CANCELLED',
      ];
      for (const s of validStatuses) {
        expect(RunStatusSchema.parse(s)).toBe(s);
      }
      expect(() => RunStatusSchema.parse('NOT_A_STATUS')).toThrow();
    });

    it('Validates RunSchema defaults and constraints', () => {
      const run = RunSchema.parse({
        id: 'run-123',
        task_id: 'TSK-001',
        status: 'RUNNING',
        started_at: '2026-10-23T00:00:00.000Z',
      });

      expect(run.id).toBe('run-123');
      expect(run.task_id).toBe('TSK-001');
      expect(run.attempt).toBe(1);
      expect(run.status).toBe('RUNNING');
      expect(run.exit_code).toBeNull();
      expect(run.pid).toBeNull();
      expect(run.finished_at).toBeNull();
      expect(run.branch).toBeNull();
      expect(run.commit_sha).toBeNull();
    });

    it('Validates CreateRunInputSchema and UpdateRunInputSchema', () => {
      const createInput = CreateRunInputSchema.parse({
        task_id: 'TSK-001',
        status: 'RUNNING',
        pid: 9999,
      });
      expect(createInput.task_id).toBe('TSK-001');
      expect(createInput.attempt).toBe(1);
      expect(createInput.pid).toBe(9999);

      const updateInput = UpdateRunInputSchema.parse({
        status: 'SUCCESS',
        exit_code: 0,
        finished_at: '2026-10-23T01:00:00.000Z',
      });
      expect(updateInput.status).toBe('SUCCESS');
      expect(updateInput.exit_code).toBe(0);
    });

    it('Validates EventRecordSchema, CreateEventInputSchema, and STANDARD_EVENT_TYPES', () => {
      expect(STANDARD_EVENT_TYPES.STDOUT).toBe('stdout');
      expect(STANDARD_EVENT_TYPES.STDERR).toBe('stderr');
      expect(STANDARD_EVENT_TYPES.PARSE_ERROR).toBe('parse_error');
      expect(STANDARD_EVENT_TYPES.PROCESS_START).toBe('process_start');
      expect(STANDARD_EVENT_TYPES.PROCESS_EXIT).toBe('process_exit');

      const event = EventRecordSchema.parse({
        id: 1,
        run_id: 'run-123',
        seq: 1,
        type: 'stdout',
        payload: { text: 'Building...' },
        ts: '2026-10-23T00:00:00.000Z',
      });

      expect(event.id).toBe(1);
      expect(event.run_id).toBe('run-123');
      expect(event.seq).toBe(1);
      expect(event.type).toBe('stdout');
      expect(event.payload).toEqual({ text: 'Building...' });

      expect(() =>
        CreateEventInputSchema.parse({
          run_id: '',
          type: 'stdout',
          payload: 'test',
        }),
      ).toThrow();
    });
  });
});
