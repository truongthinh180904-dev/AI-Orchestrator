import type Database from 'better-sqlite3';
import {
  type Plan,
  type PlanExecutionSummary,
  type PlanTaskExecutionState,
  type OrchestratePlanInput,
  type OrchestratePlanResult,
  type ScheduleNextOptions,
  type ScheduleStepResult,
  type TaskWithDependencies,
  assertPlanApproved,
  computePlanReviewSummary,
  OrchestratePlanInputSchema,
  AppError,
  logger,
} from '@ai-orchestrator/shared';
import { PlanRepository, TaskRepository } from '@ai-orchestrator/db';
import { TaskScheduler } from './task-scheduler.js';
import { TaskStateService } from './task-state-service.js';

export interface PlanOrchestratorOptions {
  db: Database.Database;
  planRepo?: PlanRepository;
  taskRepo?: TaskRepository;
  scheduler: TaskScheduler;
  stateService?: TaskStateService;
}

export interface StepPlanResult {
  step: ScheduleStepResult;
  summary: PlanExecutionSummary;
}

export class PlanOrchestrator {
  private readonly db: Database.Database;
  private readonly planRepo: PlanRepository;
  private readonly taskRepo: TaskRepository;
  private readonly scheduler: TaskScheduler;
  private readonly stateService: TaskStateService;

  constructor(options: PlanOrchestratorOptions) {
    this.db = options.db;
    this.planRepo = options.planRepo ?? new PlanRepository(this.db);
    this.taskRepo = options.taskRepo ?? new TaskRepository(this.db);
    this.scheduler = options.scheduler;
    this.stateService = options.stateService ?? new TaskStateService(this.db);
  }

  getScheduler(): TaskScheduler {
    return this.scheduler;
  }

  getPlanRepository(): PlanRepository {
    return this.planRepo;
  }

  getTaskRepository(): TaskRepository {
    return this.taskRepo;
  }

  /**
   * Asserts plan exists and is approved or already executing.
   * Throws AppError('PLAN_NOT_APPROVED') if plan is in PENDING_APPROVAL, REJECTED, or DRAFT.
   */
  assertPlanApprovedForExecution(planId: string): Plan {
    const plan = this.planRepo.findById(planId);
    if (!plan) {
      throw new AppError('PLAN_NOT_FOUND', `Plan with id '${planId}' not found`, { planId });
    }

    if (plan.status !== 'APPROVED' && plan.status !== 'EXECUTING' && plan.status !== 'COMPLETED') {
      assertPlanApproved(plan); // Will throw AppError('PLAN_NOT_APPROVED')
    }

    return plan;
  }

  /**
   * Materializes the tasks in an approved plan into SQLite tasks and task_dependencies tables.
   * Links tasks via plan_id. Idempotent: updates existing tasks if already materialized.
   */
  materializePlanTasks(planId: string): TaskWithDependencies[] {
    const plan = this.assertPlanApprovedForExecution(planId);

    const materializeTx = this.db.transaction(() => {
      const materialized: TaskWithDependencies[] = [];

      for (const task of plan.tasks) {
        const existing = this.taskRepo.findById(task.id);
        if (existing) {
          const updated = this.taskRepo.update(task.id, {
            plan_id: plan.id,
            feature_id: plan.feature_id ?? undefined,
            title: task.title,
            description: task.description,
            repository: plan.repository,
            scope_files: task.scope_files,
            acceptance_criteria: task.acceptance_criteria,
            test_commands: task.test_commands,
            priority: task.priority,
            timeout_minutes: task.timeout_minutes,
            worker_type: task.worker_type,
            dependencies: task.dependencies,
          });
          materialized.push(updated);
        } else {
          const created = this.taskRepo.create({
            id: task.id,
            plan_id: plan.id,
            feature_id: plan.feature_id ?? null,
            title: task.title,
            description: task.description,
            repository: plan.repository,
            scope_files: task.scope_files,
            acceptance_criteria: task.acceptance_criteria,
            test_commands: task.test_commands,
            priority: task.priority,
            timeout_minutes: task.timeout_minutes,
            worker_type: task.worker_type,
            status: 'TODO',
            dependencies: task.dependencies,
          });
          materialized.push(created);
        }
      }

      if (plan.status === 'APPROVED') {
        this.planRepo.update(plan.id, {
          status: 'EXECUTING',
        });
      }

      return materialized;
    });

    const result = materializeTx();

    logger.info('Plan tasks materialized in database', {
      planId,
      taskCount: result.length,
      taskIds: result.map((t) => t.id),
    });

    return result;
  }

  /**
   * Retrieves comprehensive live execution summary of a plan and its tasks.
   * Auto-updates plan status to COMPLETED if all tasks DONE, or FAILED if any task permanently failed.
   */
  getPlanExecutionSummary(planId: string): PlanExecutionSummary {
    const plan = this.planRepo.findById(planId);
    if (!plan) {
      throw new AppError('PLAN_NOT_FOUND', `Plan with id '${planId}' not found`, { planId });
    }

    const tasksInDb = this.taskRepo.findAll({ plan_id: planId });
    const taskMap = new Map<string, TaskWithDependencies>(tasksInDb.map((t) => [t.id, t]));

    const taskStates: PlanTaskExecutionState[] = [];
    let completedCount = 0;
    let runningCount = 0;
    let failedCount = 0;
    let readyCount = 0;
    let pendingCount = 0;

    const reviewSummary = computePlanReviewSummary(plan);
    const executionOrder = reviewSummary.execution_order;

    for (const planTask of plan.tasks) {
      const dbTask = taskMap.get(planTask.id);
      const status = dbTask ? dbTask.status : 'TODO';
      const attempts = dbTask ? dbTask.attempts : 0;
      const maxAttempts = dbTask ? dbTask.max_attempts : 3;

      if (status === 'DONE') {
        completedCount++;
      } else if (status === 'RUNNING' || status === 'VERIFYING') {
        runningCount++;
      } else if (status === 'FAILED') {
        failedCount++;
      } else if (status === 'READY') {
        readyCount++;
      } else {
        // Status TODO: check if dependencies are met
        if (dbTask) {
          const depStatus = this.taskRepo.getDependencyStatus(dbTask.id);
          if (depStatus.isReady) {
            readyCount++;
          } else {
            pendingCount++;
          }
        } else {
          pendingCount++;
        }
      }

      taskStates.push({
        id: planTask.id,
        title: planTask.title,
        status,
        dependencies: planTask.dependencies,
        attempts,
        max_attempts: maxAttempts,
        priority: planTask.priority,
        timeout_minutes: planTask.timeout_minutes,
        worker_type: planTask.worker_type,
      });
    }

    const totalTasks = plan.tasks.length;
    const isComplete = tasksInDb.length === totalTasks && completedCount === totalTasks;

    // A plan has failed if any task permanently failed, or if failures exist and no remaining task can run
    const hasFailed =
      failedCount > 0 &&
      (taskStates.some((t) => t.status === 'FAILED' && t.attempts >= t.max_attempts) ||
        (readyCount === 0 && runningCount === 0));

    // Auto update plan status in DB
    let currentStatus = plan.status;
    if (plan.status === 'EXECUTING') {
      if (isComplete) {
        this.planRepo.update(planId, { status: 'COMPLETED' });
        currentStatus = 'COMPLETED';
        logger.info('Plan execution completed successfully', { planId, completedCount });
      } else if (hasFailed) {
        this.planRepo.update(planId, { status: 'FAILED' });
        currentStatus = 'FAILED';
        logger.warn('Plan execution failed due to unrecoverable task failure', { planId });
      }
    }

    // Executed order: order of tasks that have finished or are running
    const executedOrder: string[] = [];
    for (const id of executionOrder) {
      const t = taskMap.get(id);
      if (t && (t.status === 'DONE' || t.status === 'RUNNING' || t.status === 'VERIFYING' || t.status === 'FAILED')) {
        executedOrder.push(id);
      }
    }

    return {
      planId: plan.id,
      title: plan.title,
      status: currentStatus,
      isComplete,
      hasFailed,
      totalTasks,
      completedTasks: completedCount,
      runningTasks: runningCount,
      failedTasks: failedCount,
      readyTasks: readyCount,
      pendingTasks: pendingCount,
      executionOrder,
      executedOrder,
      tasks: taskStates,
    };
  }

  /**
   * Executes a single step for the plan:
   * 1. Enforces plan is approved ("Chưa duyệt → không thực thi")
   * 2. Materializes tasks if not yet done
   * 3. Steps the next ready task in dependency order using TaskScheduler
   * 4. Updates plan status and returns updated execution summary
   */
  async stepPlan(planId: string, options?: ScheduleNextOptions): Promise<StepPlanResult> {
    // 1. Guard: Chưa duyệt → không thực thi
    const plan = this.assertPlanApprovedForExecution(planId);

    // If already complete, return early without stepping
    if (plan.status === 'COMPLETED') {
      const summary = this.getPlanExecutionSummary(planId);
      return {
        step: {
          executed: false,
          reason: 'NO_READY_TASKS',
        },
        summary,
      };
    }

    // 2. Materialize tasks if needed
    if (plan.status === 'APPROVED') {
      this.materializePlanTasks(planId);
    }

    // 3. Step scheduler with planId filter (strict dependency order)
    const step = await this.scheduler.step({
      ...options,
      planId,
    });

    // 4. Update and return execution summary
    const summary = this.getPlanExecutionSummary(planId);

    return { step, summary };
  }

  /**
   * Orchestrates the entire plan sequentially to completion:
   * 1. Enforces plan is approved ("Chưa duyệt → không thực thi")
   * 2. Materializes tasks and dependencies into DB
   * 3. Loops calling stepPlan until all tasks are DONE or a task permanently fails
   * 4. Guarantees Concurrency: maximum 1 coding process at a time (lock 1 agent)
   * 5. Guarantees Dependency Order: dependencies must be DONE before dependent tasks run
   */
  async orchestratePlan(
    planId: string,
    options?: OrchestratePlanInput,
  ): Promise<OrchestratePlanResult> {
    // 1. Guard: Chưa duyệt → không thực thi
    const plan = this.assertPlanApprovedForExecution(planId);
    const validatedInput = OrchestratePlanInputSchema.parse(options ?? {});

    // Dry Run mode
    if (validatedInput.dryRun) {
      const summary = this.getPlanExecutionSummary(planId);
      return {
        plan,
        finalStatus: plan.status,
        executedTasks: [],
        steps: [],
        summary,
        dryRun: true,
      };
    }

    // 2. Materialize tasks into database
    this.materializePlanTasks(planId);

    const executedTasks: string[] = [];
    const steps: ScheduleStepResult[] = [];
    let stepCount = 0;
    const maxSteps = validatedInput.maxSteps ?? 500;

    // 3. Sequential orchestration loop
    while (stepCount < maxSteps) {
      stepCount++;

      const { step, summary } = await this.stepPlan(planId, {
        autoVerify: validatedInput.autoVerify,
        autoRetry: validatedInput.autoRetry,
        timeoutMs: validatedInput.timeoutMs,
        waitBackoff: validatedInput.waitBackoff,
      });

      if (!step.executed) {
        // No task ready to run (or scheduler locked/paused)
        break;
      }

      steps.push(step);
      if (step.taskId && !executedTasks.includes(step.taskId)) {
        executedTasks.push(step.taskId);
      }

      // Check if finished or failed
      if (summary.isComplete || summary.hasFailed) {
        break;
      }
    }

    const finalPlan = this.planRepo.findById(planId)!;
    const finalSummary = this.getPlanExecutionSummary(planId);

    logger.info('Plan orchestration loop finished', {
      planId,
      finalStatus: finalPlan.status,
      executedTasks,
      totalSteps: steps.length,
    });

    return {
      plan: finalPlan,
      finalStatus: finalPlan.status,
      executedTasks,
      steps,
      summary: finalSummary,
      dryRun: false,
    };
  }
}
