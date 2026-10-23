import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase, runMigrations, PlanRepository } from '@ai-orchestrator/db';
import { AppError } from '@ai-orchestrator/shared';
import { PlanReviewService } from '../services/plan-review-service.js';

describe('PlanReviewService Unit Tests', () => {
  let db: Database.Database;
  let planRepo: PlanRepository;
  let reviewService: PlanReviewService;

  const validTasks = [
    {
      id: 'TASK-1',
      title: 'Database Schema',
      scope_files: ['packages/db/migrations/005_test.sql'],
      acceptance_criteria: ['Migration applies'],
      dependencies: [],
      priority: 1,
      timeout_minutes: 10,
    },
    {
      id: 'TASK-2',
      title: 'Service Implementation',
      scope_files: ['apps/orchestrator/src/service.ts'],
      acceptance_criteria: ['Service logic works'],
      dependencies: ['TASK-1'],
      priority: 2,
      timeout_minutes: 20,
    },
    {
      id: 'TASK-3',
      title: 'REST Endpoints',
      scope_files: ['apps/orchestrator/src/routes.ts'],
      acceptance_criteria: ['Endpoints return 200'],
      dependencies: ['TASK-2'],
      priority: 0,
      timeout_minutes: 15,
    },
  ];

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    planRepo = new PlanRepository(db);
    reviewService = new PlanReviewService({ db, planRepo });
  });

  afterEach(() => {
    db.close();
  });

  function createTestPlan(status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'EXECUTING' = 'PENDING_APPROVAL') {
    return planRepo.create({
      title: 'Test Review Plan',
      description: 'Review workflow test plan',
      status,
      tasks: validTasks,
    });
  }

  describe('getPlan & getReviewSummary', () => {
    it('retrieves plan details or throws PLAN_NOT_FOUND', () => {
      const plan = createTestPlan();
      const found = reviewService.getPlan(plan.id);
      expect(found.id).toBe(plan.id);

      expect(() => reviewService.getPlan('non_existent')).toThrowError(AppError);
      try {
        reviewService.getPlan('non_existent');
      } catch (err: unknown) {
        expect((err as AppError).code).toBe('PLAN_NOT_FOUND');
      }
    });

    it('returns complete review summary with topological order and metrics', () => {
      const plan = createTestPlan('PENDING_APPROVAL');
      const summary = reviewService.getReviewSummary(plan.id);

      expect(summary.plan.id).toBe(plan.id);
      expect(summary.is_approved).toBe(false);
      expect(summary.can_execute).toBe(false);
      expect(summary.requires_approval).toBe(true);
      expect(summary.total_tasks).toBe(3);
      expect(summary.total_estimated_minutes).toBe(45);
      expect(summary.execution_order).toEqual(['TASK-1', 'TASK-2', 'TASK-3']);
      expect(summary.stages).toEqual([['TASK-1'], ['TASK-2'], ['TASK-3']]);
    });
  });

  describe('approvePlan', () => {
    it('approves a PENDING_APPROVAL plan, recording approved_by and approved_at', () => {
      const plan = createTestPlan('PENDING_APPROVAL');

      const approved = reviewService.approvePlan(plan.id, {
        approved_by: 'lead_engineer',
        comments: 'Ready for execution',
      });

      expect(approved.status).toBe('APPROVED');
      expect(approved.approved_by).toBe('lead_engineer');
      expect(approved.approved_at).toBeDefined();
      expect(approved.rejection_reason).toBeNull();
    });

    it('clears rejection reason when approving a previously REJECTED plan', () => {
      const plan = createTestPlan('REJECTED');
      planRepo.update(plan.id, { rejection_reason: 'Previous flaw' });

      const approved = reviewService.approvePlan(plan.id, {
        approved_by: 'lead_engineer',
      });

      expect(approved.status).toBe('APPROVED');
      expect(approved.rejection_reason).toBeNull();
    });

    it('applies edits during approval review and validates tasks graph', () => {
      const plan = createTestPlan('PENDING_APPROVAL');

      const approved = reviewService.approvePlan(plan.id, {
        approved_by: 'tech_lead',
        edits: {
          title: 'Updated Plan Title by Reviewer',
          tasks: [
            {
              id: 'TASK-A',
              title: 'Refactored Step A',
              scope_files: ['file_a.ts'],
              acceptance_criteria: ['Passes'],
              dependencies: [],
            },
          ],
        },
      });

      expect(approved.status).toBe('APPROVED');
      expect(approved.title).toBe('Updated Plan Title by Reviewer');
      expect(approved.tasks.length).toBe(1);
      expect(approved.tasks[0]?.id).toBe('TASK-A');
    });

    it('throws INVALID_PLAN_STATE_TRANSITION if plan is already EXECUTING', () => {
      const plan = createTestPlan('EXECUTING');

      expect(() =>
        reviewService.approvePlan(plan.id, { approved_by: 'someone' }),
      ).toThrowError(AppError);

      try {
        reviewService.approvePlan(plan.id, { approved_by: 'someone' });
      } catch (err: unknown) {
        expect((err as AppError).code).toBe('INVALID_PLAN_STATE_TRANSITION');
      }
    });
  });

  describe('rejectPlan', () => {
    it('rejects a plan with mandatory reason and clears approval metadata', () => {
      const plan = createTestPlan('PENDING_APPROVAL');

      const rejected = reviewService.rejectPlan(plan.id, {
        reason: 'Scope of TASK-2 must be split into two tasks',
        rejected_by: 'qa_reviewer',
      });

      expect(rejected.status).toBe('REJECTED');
      expect(rejected.rejection_reason).toBe('Scope of TASK-2 must be split into two tasks');
      expect(rejected.approved_at).toBeNull();
      expect(rejected.approved_by).toBeNull();
    });

    it('rejects plan with empty reason throws error', () => {
      const plan = createTestPlan('PENDING_APPROVAL');

      expect(() =>
        reviewService.rejectPlan(plan.id, { reason: '' }),
      ).toThrow();
    });

    it('throws INVALID_PLAN_STATE_TRANSITION when trying to reject an EXECUTING plan', () => {
      const plan = createTestPlan('EXECUTING');

      expect(() =>
        reviewService.rejectPlan(plan.id, { reason: 'Too late' }),
      ).toThrowError(AppError);
    });
  });

  describe('submitForReview', () => {
    it('transitions REJECTED plan back to PENDING_APPROVAL and clears rejection reason', () => {
      const plan = createTestPlan('REJECTED');
      planRepo.update(plan.id, { rejection_reason: 'Needs rework' });

      const resubmitted = reviewService.submitForReview(plan.id);
      expect(resubmitted.status).toBe('PENDING_APPROVAL');
      expect(resubmitted.rejection_reason).toBeNull();
    });

    it('is idempotent if plan is already PENDING_APPROVAL', () => {
      const plan = createTestPlan('PENDING_APPROVAL');
      const resubmitted = reviewService.submitForReview(plan.id);
      expect(resubmitted.status).toBe('PENDING_APPROVAL');
    });
  });

  describe('editPlan', () => {
    it('allows updating title and description in review mode', () => {
      const plan = createTestPlan('PENDING_APPROVAL');

      const edited = reviewService.editPlan(plan.id, {
        title: 'New Improved Title',
        description: 'New Description',
      });

      expect(edited.title).toBe('New Improved Title');
      expect(edited.description).toBe('New Description');
    });

    it('resets APPROVED status to PENDING_APPROVAL if tasks are modified', () => {
      const plan = createTestPlan('APPROVED');

      const edited = reviewService.editPlan(plan.id, {
        tasks: [
          {
            id: 'NEW-TASK-1',
            title: 'New Task',
            scope_files: ['index.ts'],
            acceptance_criteria: ['Works'],
            dependencies: [],
          },
        ],
      });

      expect(edited.status).toBe('PENDING_APPROVAL');
      expect(edited.approved_at).toBeNull();
      expect(edited.approved_by).toBeNull();
    });

    it('validates task graph and throws on circular dependency', () => {
      const plan = createTestPlan('PENDING_APPROVAL');

      expect(() =>
        reviewService.editPlan(plan.id, {
          tasks: [
            {
              id: 'T1',
              title: 'Task 1',
              scope_files: ['f1.ts'],
              acceptance_criteria: ['A'],
              dependencies: ['T2'],
            },
            {
              id: 'T2',
              title: 'Task 2',
              scope_files: ['f2.ts'],
              acceptance_criteria: ['B'],
              dependencies: ['T1'],
            },
          ],
        }),
      ).toThrowError(AppError);
    });
  });

  describe('Execution Guard ("Chưa duyệt → không thực thi")', () => {
    it('assertCanExecute throws PLAN_NOT_APPROVED for unapproved plan in PENDING_APPROVAL', () => {
      const plan = createTestPlan('PENDING_APPROVAL');

      expect(() => reviewService.assertCanExecute(plan.id)).toThrowError(AppError);
      try {
        reviewService.assertCanExecute(plan.id);
      } catch (err: unknown) {
        const error = err as AppError;
        expect(error.code).toBe('PLAN_NOT_APPROVED');
        expect(error.message).toContain('is not approved');
        expect(error.context).toEqual({
          planId: plan.id,
          status: 'PENDING_APPROVAL',
        });
      }
    });

    it('executePlan throws PLAN_NOT_APPROVED for unapproved plan in PENDING_APPROVAL', () => {
      const plan = createTestPlan('PENDING_APPROVAL');

      expect(() => reviewService.executePlan(plan.id)).toThrowError(AppError);
      try {
        reviewService.executePlan(plan.id);
      } catch (err: unknown) {
        const error = err as AppError;
        expect(error.code).toBe('PLAN_NOT_APPROVED');
      }
    });

    it('executePlan throws PLAN_NOT_APPROVED for REJECTED plan', () => {
      const plan = createTestPlan('REJECTED');

      expect(() => reviewService.executePlan(plan.id)).toThrowError(AppError);
      try {
        reviewService.executePlan(plan.id);
      } catch (err: unknown) {
        const error = err as AppError;
        expect(error.code).toBe('PLAN_NOT_APPROVED');
        expect(error.context).toEqual({
          planId: plan.id,
          status: 'REJECTED',
        });
      }
    });

    it('executePlan throws PLAN_NOT_APPROVED for DRAFT plan', () => {
      const plan = createTestPlan('DRAFT');

      expect(() => reviewService.executePlan(plan.id)).toThrowError(AppError);
      try {
        reviewService.executePlan(plan.id);
      } catch (err: unknown) {
        const error = err as AppError;
        expect(error.code).toBe('PLAN_NOT_APPROVED');
      }
    });

    it('executePlan succeeds for APPROVED plan and transitions status to EXECUTING', () => {
      const plan = createTestPlan('APPROVED');

      const result = reviewService.executePlan(plan.id);

      expect(result.status).toBe('EXECUTING');
      expect(result.plan.status).toBe('EXECUTING');
      expect(result.executionOrder).toEqual(['TASK-1', 'TASK-2', 'TASK-3']);

      // Check DB persistence
      const inDb = planRepo.findById(plan.id);
      expect(inDb?.status).toBe('EXECUTING');
    });

    it('executePlan supports dryRun without modifying DB status', () => {
      const plan = createTestPlan('APPROVED');

      const result = reviewService.executePlan(plan.id, { dryRun: true });

      expect(result.status).toBe('EXECUTING');
      expect(result.executionOrder).toEqual(['TASK-1', 'TASK-2', 'TASK-3']);

      // Status in DB remains APPROVED
      const inDb = planRepo.findById(plan.id);
      expect(inDb?.status).toBe('APPROVED');
    });
  });
});
