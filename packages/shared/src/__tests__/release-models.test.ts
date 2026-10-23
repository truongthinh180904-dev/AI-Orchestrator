import { describe, it, expect } from 'vitest';
import {
  FeatureComponentTaskSchema,
  FeatureTaskSummarySchema,
  FeatureComponentTasksResultSchema,
  DefineFeatureTasksInputSchema,
  FeatureReleaseCheckResultSchema,
  formatFeatureReleaseCheckMarkdownReport,
} from '../models/release.js';

describe('Feature Release Models & Zod Schemas', () => {
  describe('FeatureComponentTaskSchema', () => {
    it('Validates a complete component task', () => {
      const task = FeatureComponentTaskSchema.parse({
        id: 'TSK-001',
        feature_id: 'FEAT-001',
        title: 'Task 1 title',
        description: 'Task description',
        phase: 'foundation',
        priority: 10,
        status: 'DONE',
        worker_type: 'agy',
        repository: '.',
        acceptance_criteria: ['Criterion 1'],
        test_commands: ['pnpm test'],
        scope_files: ['src/index.ts'],
        dependencies: ['TSK-000'],
        is_required: true,
        execution_order: 1,
      });

      expect(task.id).toBe('TSK-001');
      expect(task.is_required).toBe(true);
      expect(task.execution_order).toBe(1);
      expect(task.status).toBe('DONE');
    });

    it('Applies default values for optional fields', () => {
      const task = FeatureComponentTaskSchema.parse({
        id: 'TSK-002',
        title: 'Minimal task',
        status: 'TODO',
      });

      expect(task.feature_id).toBeNull();
      expect(task.description).toBeNull();
      expect(task.phase).toBeNull();
      expect(task.priority).toBe(0);
      expect(task.worker_type).toBe('agy');
      expect(task.repository).toBe('.');
      expect(task.acceptance_criteria).toEqual([]);
      expect(task.test_commands).toEqual([]);
      expect(task.scope_files).toBeNull();
      expect(task.dependencies).toEqual([]);
      expect(task.is_required).toBe(false);
      expect(task.execution_order).toBe(0);
    });

    it('Fails validation when id or title is empty or status is invalid', () => {
      expect(() =>
        FeatureComponentTaskSchema.parse({
          id: '',
          title: 'Title',
          status: 'TODO',
        }),
      ).toThrow();

      expect(() =>
        FeatureComponentTaskSchema.parse({
          id: 'TSK-1',
          title: '',
          status: 'TODO',
        }),
      ).toThrow();

      expect(() =>
        FeatureComponentTaskSchema.parse({
          id: 'TSK-1',
          title: 'Valid',
          status: 'INVALID_STATUS',
        }),
      ).toThrow();
    });
  });

  describe('FeatureTaskSummarySchema', () => {
    it('Validates a valid summary', () => {
      const summary = FeatureTaskSummarySchema.parse({
        total_tasks: 3,
        required_count: 2,
        completed_count: 2,
        pending_count: 1,
        failed_count: 0,
        missing_count: 0,
        is_all_required_done: true,
        ready_for_release: true,
      });

      expect(summary.total_tasks).toBe(3);
      expect(summary.is_all_required_done).toBe(true);
    });

    it('Rejects negative counts', () => {
      expect(() =>
        FeatureTaskSummarySchema.parse({
          total_tasks: -1,
          required_count: 0,
          completed_count: 0,
          pending_count: 0,
          failed_count: 0,
          missing_count: 0,
          is_all_required_done: false,
          ready_for_release: false,
        }),
      ).toThrow();
    });
  });

  describe('FeatureComponentTasksResultSchema', () => {
    it('Validates a full feature component tasks result (Manifest)', () => {
      const result = FeatureComponentTasksResultSchema.parse({
        feature_id: 'FEAT-001',
        feature_name: 'Authentication Module',
        description: 'User login and registration',
        status: 'IN_PROGRESS',
        release_policy: 'require_all_done',
        integration_tests: ['pnpm test:auth'],
        required_task_ids: ['AUTH-001', 'AUTH-002'],
        all_task_ids: ['AUTH-001', 'AUTH-002', 'AUTH-003'],
        tasks: [
          {
            id: 'AUTH-001',
            feature_id: 'FEAT-001',
            title: 'Setup DB schema',
            status: 'DONE',
            is_required: true,
            execution_order: 1,
          },
          {
            id: 'AUTH-002',
            feature_id: 'FEAT-001',
            title: 'JWT logic',
            status: 'RUNNING',
            is_required: true,
            execution_order: 2,
          },
        ],
        missing_task_ids: [],
        summary: {
          total_tasks: 2,
          required_count: 2,
          completed_count: 1,
          pending_count: 1,
          failed_count: 0,
          missing_count: 0,
          is_all_required_done: false,
          ready_for_release: false,
        },
      });

      expect(result.feature_id).toBe('FEAT-001');
      expect(result.tasks).toHaveLength(2);
      expect(result.tasks[0]?.id).toBe('AUTH-001');
      expect(result.summary.is_all_required_done).toBe(false);
    });
  });

  describe('DefineFeatureTasksInputSchema', () => {
    it('Validates empty and partial input', () => {
      expect(DefineFeatureTasksInputSchema.parse({})).toEqual({});
      const parsed = DefineFeatureTasksInputSchema.parse({
        required_tasks: ['T-1', 'T-2'],
        assign_task_ids: ['T-3'],
        unassign_task_ids: ['T-4'],
      });
      expect(parsed.required_tasks).toEqual(['T-1', 'T-2']);
      expect(parsed.assign_task_ids).toEqual(['T-3']);
      expect(parsed.unassign_task_ids).toEqual(['T-4']);
    });
  });

  describe('FeatureReleaseCheckResultSchema & Helpers', () => {
    it('Validates a complete release check result (READY)', () => {
      const manifest = FeatureComponentTasksResultSchema.parse({
        feature_id: 'FEAT-READY',
        feature_name: 'Ready Feature',
        status: 'DONE',
        required_task_ids: ['T-1'],
        all_task_ids: ['T-1'],
        tasks: [
          {
            id: 'T-1',
            feature_id: 'FEAT-READY',
            title: 'Task 1',
            status: 'DONE',
            is_required: true,
            execution_order: 1,
          },
        ],
        missing_task_ids: [],
        summary: {
          total_tasks: 1,
          required_count: 1,
          completed_count: 1,
          pending_count: 0,
          failed_count: 0,
          missing_count: 0,
          is_all_required_done: true,
          ready_for_release: true,
        },
      });

      const checkResult = FeatureReleaseCheckResultSchema.parse({
        feature_id: 'FEAT-READY',
        feature_name: 'Ready Feature',
        can_release: true,
        status: 'READY',
        blocking_reasons: [],
        rule_evaluations: [
          {
            rule_id: 'REQUIRED_TASKS_COMPLETED',
            name: 'Required Tasks Completed',
            passed: true,
            status: 'PASSED',
            message: 'All required tasks are DONE',
            details: {},
          },
        ],
        task_summary: manifest.summary,
        manifest,
        integration_test_results: [
          {
            command: 'pnpm test:integration',
            status: 'SUCCESS',
            exit_code: 0,
            stdout: 'PASS',
            stderr: '',
            duration_ms: 120,
          },
        ],
        checked_at: new Date().toISOString(),
      });

      expect(checkResult.can_release).toBe(true);
      expect(checkResult.status).toBe('READY');
      expect(checkResult.blocking_reasons).toHaveLength(0);

      const report = formatFeatureReleaseCheckMarkdownReport(checkResult);
      expect(report).toContain('READY FOR RELEASE');
      expect(report).toContain('pnpm test:integration');
    });

    it('Validates a blocked release check result with blocking reasons', () => {
      const manifest = FeatureComponentTasksResultSchema.parse({
        feature_id: 'FEAT-BLOCKED',
        feature_name: 'Blocked Feature',
        status: 'IN_PROGRESS',
        required_task_ids: ['T-1', 'T-2'],
        all_task_ids: ['T-1'],
        tasks: [
          {
            id: 'T-1',
            feature_id: 'FEAT-BLOCKED',
            title: 'Task 1',
            status: 'TODO',
            is_required: true,
            execution_order: 1,
          },
        ],
        missing_task_ids: ['T-2'],
        summary: {
          total_tasks: 1,
          required_count: 2,
          completed_count: 0,
          pending_count: 1,
          failed_count: 0,
          missing_count: 1,
          is_all_required_done: false,
          ready_for_release: false,
        },
      });

      const checkResult = FeatureReleaseCheckResultSchema.parse({
        feature_id: 'FEAT-BLOCKED',
        feature_name: 'Blocked Feature',
        can_release: false,
        status: 'BLOCKED',
        blocking_reasons: [
          'Missing required task(s): T-2',
          'Required task T-1 is not DONE (status: TODO)',
        ],
        rule_evaluations: [
          {
            rule_id: 'NO_MISSING_TASKS',
            name: 'No Missing Tasks',
            passed: false,
            status: 'FAILED',
            message: 'Missing required task(s): T-2',
            details: { missing: ['T-2'] },
          },
        ],
        task_summary: manifest.summary,
        manifest,
        integration_test_results: [],
        checked_at: new Date().toISOString(),
      });

      expect(checkResult.can_release).toBe(false);
      expect(checkResult.status).toBe('BLOCKED');
      expect(checkResult.blocking_reasons).toHaveLength(2);

      const report = formatFeatureReleaseCheckMarkdownReport(checkResult);
      expect(report).toContain('BLOCKED');
      expect(report).toContain('Missing required task(s): T-2');
    });
  });
});
