import { describe, it, expect } from 'vitest';
import {
  ApprovePlanInputSchema,
  RejectPlanInputSchema,
  ExecutePlanInputSchema,
  PlanReviewSummarySchema,
  assertPlanApproved,
  computePlanReviewSummary,
  type Plan,
} from '../models/plan.js';
import { AppError } from '../errors.js';

describe('Plan Review Schemas & Helpers', () => {
  const samplePlan: Plan = {
    id: 'plan_test_1',
    feature_id: 'feat_1',
    title: 'Test Plan Implementation',
    description: 'A plan for testing review mode',
    repository: '.',
    status: 'PENDING_APPROVAL',
    tasks: [
      {
        id: 'TASK-1',
        title: 'Setup DB',
        description: null,
        scope_files: ['packages/db/migrations/005_test.sql'],
        acceptance_criteria: ['Migration applies'],
        dependencies: [],
        test_commands: ['pnpm test'],
        priority: 1,
        timeout_minutes: 10,
        worker_type: 'agy',
      },
      {
        id: 'TASK-2',
        title: 'Implement Service',
        description: null,
        scope_files: ['apps/orchestrator/src/service.ts'],
        acceptance_criteria: ['Service handles business logic'],
        dependencies: ['TASK-1'],
        test_commands: ['pnpm test'],
        priority: 2,
        timeout_minutes: 20,
        worker_type: 'agy',
      },
      {
        id: 'TASK-3',
        title: 'Add REST API',
        description: null,
        scope_files: ['apps/orchestrator/src/service.ts', 'apps/orchestrator/src/routes.ts'],
        acceptance_criteria: ['Endpoints return 200'],
        dependencies: ['TASK-2'],
        test_commands: ['pnpm test'],
        priority: 0,
        timeout_minutes: 15,
        worker_type: 'agy',
      },
    ],
    raw_output: null,
    created_at: '2026-10-23T08:00:00.000Z',
    updated_at: '2026-10-23T08:00:00.000Z',
    approved_at: null,
    approved_by: null,
    rejection_reason: null,
  };

  describe('assertPlanApproved ("Chưa duyệt → không thực thi")', () => {
    it('throws AppError with code PLAN_NOT_APPROVED for PENDING_APPROVAL status', () => {
      expect(() => assertPlanApproved(samplePlan)).toThrowError(AppError);
      try {
        assertPlanApproved(samplePlan);
      } catch (err: unknown) {
        const error = err as AppError;
        expect(error.code).toBe('PLAN_NOT_APPROVED');
        expect(error.message).toContain("Plan 'plan_test_1' is not approved (current status: 'PENDING_APPROVAL')");
        expect(error.context).toEqual({
          planId: 'plan_test_1',
          status: 'PENDING_APPROVAL',
        });
      }
    });

    it('throws AppError with code PLAN_NOT_APPROVED for DRAFT, REJECTED, EXECUTING status', () => {
      const draftPlan = { ...samplePlan, status: 'DRAFT' as const };
      expect(() => assertPlanApproved(draftPlan)).toThrowError(AppError);

      const rejectedPlan = { ...samplePlan, status: 'REJECTED' as const };
      expect(() => assertPlanApproved(rejectedPlan)).toThrowError(AppError);

      const executingPlan = { ...samplePlan, status: 'EXECUTING' as const };
      expect(() => assertPlanApproved(executingPlan)).toThrowError(AppError);
    });

    it('does not throw when plan status is APPROVED', () => {
      const approvedPlan = {
        ...samplePlan,
        status: 'APPROVED' as const,
        approved_at: '2026-10-23T08:30:00.000Z',
        approved_by: 'lead_architect',
      };
      expect(() => assertPlanApproved(approvedPlan)).not.toThrow();
    });
  });

  describe('computePlanReviewSummary', () => {
    it('computes metrics, topological order, stages, and detects warnings', () => {
      const summary = computePlanReviewSummary(samplePlan);

      expect(summary.status).toBe('PENDING_APPROVAL');
      expect(summary.is_approved).toBe(false);
      expect(summary.can_execute).toBe(false);
      expect(summary.requires_approval).toBe(true);
      expect(summary.total_tasks).toBe(3);
      expect(summary.total_scope_files).toBe(4); // 1 in TASK-1, 1 in TASK-2, 2 in TASK-3
      expect(summary.unique_scope_files).toEqual([
        'apps/orchestrator/src/routes.ts',
        'apps/orchestrator/src/service.ts',
        'packages/db/migrations/005_test.sql',
      ]);
      expect(summary.total_estimated_minutes).toBe(45); // 10 + 20 + 15

      // Topological execution order should respect dependencies: TASK-1 -> TASK-2 -> TASK-3
      expect(summary.execution_order).toEqual(['TASK-1', 'TASK-2', 'TASK-3']);

      // Stages: stage 0 has TASK-1, stage 1 has TASK-2, stage 2 has TASK-3
      expect(summary.stages).toEqual([['TASK-1'], ['TASK-2'], ['TASK-3']]);

      // Warning: 'apps/orchestrator/src/service.ts' is modified by both TASK-2 and TASK-3
      expect(summary.warnings.length).toBe(1);
      expect(summary.warnings[0]).toContain("File 'apps/orchestrator/src/service.ts' is modified by multiple tasks: TASK-2, TASK-3");

      // Validates against PlanReviewSummarySchema
      expect(() => PlanReviewSummarySchema.parse(summary)).not.toThrow();
    });

    it('reflects approval state correctly when plan is approved', () => {
      const approvedPlan: Plan = {
        ...samplePlan,
        status: 'APPROVED',
        approved_at: '2026-10-23T08:30:00.000Z',
        approved_by: 'tech_lead',
      };

      const summary = computePlanReviewSummary(approvedPlan);
      expect(summary.is_approved).toBe(true);
      expect(summary.can_execute).toBe(true);
      expect(summary.requires_approval).toBe(false);
    });
  });

  describe('Review Input Schemas', () => {
    it('ApprovePlanInputSchema accepts default reviewer and optional comments/edits', () => {
      const parsed = ApprovePlanInputSchema.parse({});
      expect(parsed.approved_by).toBe('reviewer');

      const custom = ApprovePlanInputSchema.parse({
        approved_by: 'architect_alice',
        comments: 'Looks good to execute',
        edits: {
          title: 'Updated Plan Title',
        },
      });
      expect(custom.approved_by).toBe('architect_alice');
      expect(custom.comments).toBe('Looks good to execute');
      expect(custom.edits?.title).toBe('Updated Plan Title');
    });

    it('RejectPlanInputSchema requires non-empty reason', () => {
      expect(() => RejectPlanInputSchema.parse({ reason: '' })).toThrow();
      expect(() => RejectPlanInputSchema.parse({})).toThrow();

      const parsed = RejectPlanInputSchema.parse({
        reason: 'Scope of TASK-2 is too broad; split into smaller tasks',
        rejected_by: 'qa_reviewer',
      });
      expect(parsed.reason).toBe('Scope of TASK-2 is too broad; split into smaller tasks');
      expect(parsed.rejected_by).toBe('qa_reviewer');
    });

    it('ExecutePlanInputSchema parses optional executor and dryRun', () => {
      const parsed = ExecutePlanInputSchema.parse({});
      expect(parsed.executor).toBe('orchestrator');
      expect(parsed.dryRun).toBe(false);

      const custom = ExecutePlanInputSchema.parse({
        executor: 'custom_worker',
        dryRun: true,
      });
      expect(custom.executor).toBe('custom_worker');
      expect(custom.dryRun).toBe(true);
    });
  });
});
