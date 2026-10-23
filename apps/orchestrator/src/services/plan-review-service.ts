import type Database from 'better-sqlite3';
import {
  type Plan,
  type PlanReviewSummary,
  type ApprovePlanInput,
  type RejectPlanInput,
  type UpdatePlanInput,
  type ExecutePlanInput,
  ApprovePlanInputSchema,
  RejectPlanInputSchema,
  UpdatePlanInputSchema,
  ExecutePlanInputSchema,
  computePlanReviewSummary,
  assertPlanApproved,
  validatePlanTasksGraph,
  AppError,
  logger,
} from '@ai-orchestrator/shared';
import { PlanRepository } from '@ai-orchestrator/db';

export interface PlanReviewServiceOptions {
  db: Database.Database;
  planRepo?: PlanRepository;
}

export interface ExecutePlanResult {
  plan: Plan;
  status: 'EXECUTING';
  executionOrder: string[];
}

export class PlanReviewService {
  private readonly db: Database.Database;
  private readonly planRepo: PlanRepository;

  constructor(options: PlanReviewServiceOptions) {
    this.db = options.db;
    this.planRepo = options.planRepo ?? new PlanRepository(this.db);
  }

  getPlanRepository(): PlanRepository {
    return this.planRepo;
  }

  /**
   * Retrieves a plan by ID or throws PLAN_NOT_FOUND.
   */
  getPlan(id: string): Plan {
    const plan = this.planRepo.findById(id);
    if (!plan) {
      throw new AppError('PLAN_NOT_FOUND', `Plan with id '${id}' not found`, { id });
    }
    return plan;
  }

  /**
   * Generates a comprehensive review summary for a plan including DAG execution order,
   * dependency depth stages, scope files, and approval state.
   */
  getReviewSummary(id: string): PlanReviewSummary {
    const plan = this.getPlan(id);
    return computePlanReviewSummary(plan);
  }

  /**
   * Approves a plan for execution.
   * Records approval timestamp, reviewer ID, clears any previous rejection reason,
   * and optionally applies edits submitted during the review.
   */
  approvePlan(id: string, input?: ApprovePlanInput): Plan {
    const plan = this.getPlan(id);

    if (plan.status === 'EXECUTING' || plan.status === 'COMPLETED') {
      throw new AppError(
        'INVALID_PLAN_STATE_TRANSITION',
        `Cannot approve plan '${id}' because it is already '${plan.status}'`,
        { planId: id, currentStatus: plan.status },
      );
    }

    const validatedInput = ApprovePlanInputSchema.parse(input ?? {});
    const now = new Date().toISOString();

    const updates: UpdatePlanInput = {
      status: 'APPROVED',
      approved_at: now,
      approved_by: validatedInput.approved_by,
      rejection_reason: null,
    };

    if (validatedInput.edits) {
      if (validatedInput.edits.title !== undefined) {
        updates.title = validatedInput.edits.title;
      }
      if (validatedInput.edits.description !== undefined) {
        updates.description = validatedInput.edits.description;
      }
      if (validatedInput.edits.tasks !== undefined) {
        // Validate tasks DAG before applying
        validatePlanTasksGraph(validatedInput.edits.tasks);
        updates.tasks = validatedInput.edits.tasks;
      }
    }

    logger.info('Plan approved', {
      planId: id,
      approvedBy: validatedInput.approved_by,
      hasEdits: Boolean(validatedInput.edits),
    });

    return this.planRepo.update(id, updates);
  }

  /**
   * Rejects a plan with a mandatory non-empty reason.
   * Resets any approval metadata and transitions status to REJECTED.
   */
  rejectPlan(id: string, input: RejectPlanInput): Plan {
    const plan = this.getPlan(id);

    if (plan.status === 'EXECUTING' || plan.status === 'COMPLETED') {
      throw new AppError(
        'INVALID_PLAN_STATE_TRANSITION',
        `Cannot reject plan '${id}' because it is already '${plan.status}'`,
        { planId: id, currentStatus: plan.status },
      );
    }

    const validatedInput = RejectPlanInputSchema.parse(input);

    logger.info('Plan rejected', {
      planId: id,
      reason: validatedInput.reason,
      rejectedBy: validatedInput.rejected_by,
    });

    return this.planRepo.update(id, {
      status: 'REJECTED',
      rejection_reason: validatedInput.reason,
      approved_at: null,
      approved_by: null,
    });
  }

  /**
   * Submits or re-submits a plan for review (transitions DRAFT/REJECTED -> PENDING_APPROVAL).
   */
  submitForReview(id: string): Plan {
    const plan = this.getPlan(id);

    if (plan.status === 'EXECUTING' || plan.status === 'COMPLETED') {
      throw new AppError(
        'INVALID_PLAN_STATE_TRANSITION',
        `Cannot submit plan '${id}' for review because it is already '${plan.status}'`,
        { planId: id, currentStatus: plan.status },
      );
    }

    if (plan.status === 'PENDING_APPROVAL') {
      return plan;
    }

    logger.info('Plan submitted for review', { planId: id, previousStatus: plan.status });

    return this.planRepo.update(id, {
      status: 'PENDING_APPROVAL',
      rejection_reason: null,
    });
  }

  /**
   * Updates plan content (title, description, tasks) in review mode.
   * Validates schema and dependency graph.
   * If tasks are modified on an APPROVED plan, resets status to PENDING_APPROVAL
   * so the revised content must be re-reviewed before execution.
   */
  editPlan(id: string, updates: UpdatePlanInput): Plan {
    const plan = this.getPlan(id);

    if (plan.status === 'EXECUTING' || plan.status === 'COMPLETED') {
      throw new AppError(
        'INVALID_PLAN_STATE_TRANSITION',
        `Cannot edit plan '${id}' while status is '${plan.status}'`,
        { planId: id, currentStatus: plan.status },
      );
    }

    const validatedUpdates = UpdatePlanInputSchema.parse(updates);

    if (validatedUpdates.tasks !== undefined) {
      validatePlanTasksGraph(validatedUpdates.tasks);
    }

    // Reset approval if tasks changed on an approved plan
    if (plan.status === 'APPROVED' && validatedUpdates.tasks !== undefined && validatedUpdates.status === undefined) {
      validatedUpdates.status = 'PENDING_APPROVAL';
      validatedUpdates.approved_at = null;
      validatedUpdates.approved_by = null;
    }

    // Clear rejection if editing a rejected plan
    if (plan.status === 'REJECTED' && validatedUpdates.status === undefined) {
      validatedUpdates.status = 'PENDING_APPROVAL';
      validatedUpdates.rejection_reason = null;
    }

    logger.info('Plan edited during review', { planId: id });

    return this.planRepo.update(id, validatedUpdates);
  }

  /**
   * Guard enforcing: "Chưa duyệt → không thực thi".
   * Throws AppError('PLAN_NOT_APPROVED') if plan is not in APPROVED status.
   */
  assertCanExecute(id: string): Plan {
    const plan = this.getPlan(id);
    assertPlanApproved(plan);
    return plan;
  }

  /**
   * Executes an approved plan.
   * STRICT ENFORCEMENT: If the plan is not approved, throws PLAN_NOT_APPROVED immediately.
   * If approved, transitions plan status to EXECUTING and prepares task execution order.
   */
  executePlan(id: string, input?: ExecutePlanInput): ExecutePlanResult {
    // 1. Enforce execution guard: "Chưa duyệt → không thực thi"
    const plan = this.assertCanExecute(id);

    // 2. Validate execution options
    const validatedInput = ExecutePlanInputSchema.parse(input ?? {});

    // 3. Compute topological order
    const summary = computePlanReviewSummary(plan);

    // 4. Update status to EXECUTING if not dry run
    let updatedPlan = plan;
    if (!validatedInput.dryRun) {
      updatedPlan = this.planRepo.update(id, {
        status: 'EXECUTING',
      });
    }

    logger.info('Plan execution initiated', {
      planId: id,
      executor: validatedInput.executor,
      dryRun: validatedInput.dryRun,
      taskCount: plan.tasks.length,
    });

    return {
      plan: updatedPlan,
      status: 'EXECUTING',
      executionOrder: summary.execution_order,
    };
  }
}
