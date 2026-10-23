import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createDatabase,
  runMigrations,
  PlanRepository,
  TaskRepository,
} from '@ai-orchestrator/db';
import { AppError, type Plan } from '@ai-orchestrator/shared';
import { RunService } from '../services/run-service.js';
import { TaskScheduler } from '../services/task-scheduler.js';
import { TaskStateService } from '../services/task-state-service.js';
import { PlanOrchestrator } from '../services/plan-orchestrator.js';
import { createExecutionManager, type ExecutionManager } from '../adapters/execution-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mockCliPath = path.resolve(__dirname, '../../../../fixtures/mock-agy-cli.cjs');

describe('PlanOrchestrator Unit Tests', () => {
  let db: Database.Database;
  let planRepo: PlanRepository;
  let taskRepo: TaskRepository;
  let executionManager: ExecutionManager;
  let runService: RunService;
  let scheduler: TaskScheduler;
  let stateService: TaskStateService;
  let orchestrator: PlanOrchestrator;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    planRepo = new PlanRepository(db);
    taskRepo = new TaskRepository(db);
    executionManager = createExecutionManager();
    stateService = new TaskStateService(db);

    runService = new RunService({
      db,
      executionManager,
      config: {
        AGY_BIN: 'node',
        AGY_ARGS: mockCliPath,
      },
    });

    scheduler = new TaskScheduler({
      db,
      runService,
      autoVerify: true,
      autoRetry: false,
    });

    orchestrator = new PlanOrchestrator({
      db,
      planRepo,
      taskRepo,
      scheduler,
      stateService,
    });
  });

  afterEach(async () => {
    await scheduler.stop(true);
    await executionManager.stopAll();
    db.close();
  });

  function createTestPlan(
    status: Plan['status'] = 'APPROVED',
    tasks?: Array<{
      id: string;
      title: string;
      dependencies?: string[];
      priority?: number;
    }>,
  ): Plan {
    const planTasks =
      tasks ?? [
        {
          id: 'TASK-A',
          title: 'Task A: Foundation',
          dependencies: [],
          priority: 10,
        },
        {
          id: 'TASK-B',
          title: 'Task B: Core Logic',
          dependencies: ['TASK-A'],
          priority: 20,
        },
        {
          id: 'TASK-C',
          title: 'Task C: Integration',
          dependencies: ['TASK-B'],
          priority: 30,
        },
      ];

    return planRepo.create({
      id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title: 'Test Deployment Plan',
      description: 'Automated test plan',
      repository: '.',
      status,
      tasks: planTasks.map((t) => ({
        id: t.id,
        title: t.title,
        description: null,
        scope_files: [`src/${t.id.toLowerCase()}.ts`],
        acceptance_criteria: [`Criterion for ${t.id}`],
        dependencies: t.dependencies ?? [],
        test_commands: ['pnpm test'],
        priority: t.priority ?? 0,
        timeout_minutes: 30,
        worker_type: 'agy',
      })),
      approved_at: status === 'APPROVED' ? new Date().toISOString() : null,
      approved_by: status === 'APPROVED' ? 'reviewer' : null,
    });
  }

  describe('materializePlanTasks', () => {
    it('materializes tasks into tasks and task_dependencies tables and sets plan_id', () => {
      const plan = createTestPlan('APPROVED');
      const tasks = orchestrator.materializePlanTasks(plan.id);

      expect(tasks).toHaveLength(3);
      expect(tasks.map((t) => t.id)).toEqual(['TASK-A', 'TASK-B', 'TASK-C']);

      // Check DB
      const inDbA = taskRepo.findById('TASK-A');
      expect(inDbA).toBeDefined();
      expect(inDbA?.plan_id).toBe(plan.id);
      expect(inDbA?.dependencies).toEqual([]);

      const inDbB = taskRepo.findById('TASK-B');
      expect(inDbB).toBeDefined();
      expect(inDbB?.plan_id).toBe(plan.id);
      expect(inDbB?.dependencies).toEqual(['TASK-A']);

      const inDbC = taskRepo.findById('TASK-C');
      expect(inDbC).toBeDefined();
      expect(inDbC?.plan_id).toBe(plan.id);
      expect(inDbC?.dependencies).toEqual(['TASK-B']);

      // Plan transitions to EXECUTING
      const updatedPlan = planRepo.findById(plan.id);
      expect(updatedPlan?.status).toBe('EXECUTING');
    });

    it('throws PLAN_NOT_APPROVED when attempting to materialize unapproved plan', () => {
      const unapprovedPlan = createTestPlan('PENDING_APPROVAL');

      expect(() => orchestrator.materializePlanTasks(unapprovedPlan.id)).toThrowError(AppError);
      try {
        orchestrator.materializePlanTasks(unapprovedPlan.id);
      } catch (err: unknown) {
        expect((err as AppError).code).toBe('PLAN_NOT_APPROVED');
      }
    });

    it('is idempotent when called repeatedly', () => {
      const plan = createTestPlan('APPROVED');
      const first = orchestrator.materializePlanTasks(plan.id);
      const second = orchestrator.materializePlanTasks(plan.id);

      expect(first).toHaveLength(3);
      expect(second).toHaveLength(3);
      expect(taskRepo.findAll({ plan_id: plan.id })).toHaveLength(3);
    });
  });

  describe('Execution in Dependency Order: Linear DAG (A -> B -> C)', () => {
    it('steps sequentially strictly in dependency order: A -> B -> C', async () => {
      const plan = createTestPlan('APPROVED');

      // Step 1: Only TASK-A should be ready and execute (has 0 dependencies)
      const res1 = await orchestrator.stepPlan(plan.id);
      expect(res1.step.executed).toBe(true);
      expect(res1.step.taskId).toBe('TASK-A');
      expect(res1.summary.completedTasks).toBe(1);
      expect(res1.summary.status).toBe('EXECUTING');
      expect(taskRepo.findById('TASK-A')?.status).toBe('DONE');
      expect(taskRepo.findById('TASK-B')?.status).toBe('TODO');
      expect(taskRepo.findById('TASK-C')?.status).toBe('TODO');

      // Step 2: Now TASK-B is ready (A is DONE), but C is NOT ready (B is not yet DONE)
      const res2 = await orchestrator.stepPlan(plan.id);
      expect(res2.step.executed).toBe(true);
      expect(res2.step.taskId).toBe('TASK-B');
      expect(res2.summary.completedTasks).toBe(2);
      expect(taskRepo.findById('TASK-B')?.status).toBe('DONE');
      expect(taskRepo.findById('TASK-C')?.status).toBe('TODO');

      // Step 3: Now TASK-C is ready (B is DONE)
      const res3 = await orchestrator.stepPlan(plan.id);
      expect(res3.step.executed).toBe(true);
      expect(res3.step.taskId).toBe('TASK-C');
      expect(res3.summary.completedTasks).toBe(3);
      expect(res3.summary.isComplete).toBe(true);
      expect(res3.summary.status).toBe('COMPLETED');
      expect(taskRepo.findById('TASK-C')?.status).toBe('DONE');

      // Step 4: No more ready tasks, executed = false
      const res4 = await orchestrator.stepPlan(plan.id);
      expect(res4.step.executed).toBe(false);
      expect(res4.step.reason).toBe('NO_READY_TASKS');

      // Check DB plan status
      expect(planRepo.findById(plan.id)?.status).toBe('COMPLETED');
    });

    it('orchestratePlan runs entire plan to completion in correct order', async () => {
      const plan = createTestPlan('APPROVED');

      const result = await orchestrator.orchestratePlan(plan.id);

      expect(result.finalStatus).toBe('COMPLETED');
      expect(result.executedTasks).toEqual(['TASK-A', 'TASK-B', 'TASK-C']);
      expect(result.steps).toHaveLength(3);
      expect(result.summary.isComplete).toBe(true);
      expect(result.summary.completedTasks).toBe(3);

      const inDb = planRepo.findById(plan.id);
      expect(inDb?.status).toBe('COMPLETED');
    });
  });

  describe('Execution in Dependency Order: Diamond DAG (A -> B, A -> C, [B, C] -> D)', () => {
    it('executes root A first, branches B & C, and only runs join D when both B and C are DONE', async () => {
      const diamondPlan = createTestPlan('APPROVED', [
        { id: 'T-ROOT', title: 'Root A', dependencies: [], priority: 10 },
        { id: 'T-BRANCH-1', title: 'Branch B', dependencies: ['T-ROOT'], priority: 20 },
        { id: 'T-BRANCH-2', title: 'Branch C', dependencies: ['T-ROOT'], priority: 30 },
        { id: 'T-JOIN', title: 'Join D', dependencies: ['T-BRANCH-1', 'T-BRANCH-2'], priority: 40 },
      ]);

      const result = await orchestrator.orchestratePlan(diamondPlan.id);

      expect(result.finalStatus).toBe('COMPLETED');
      expect(result.executedTasks[0]).toBe('T-ROOT');
      // Branch 2 has higher priority (30) than Branch 1 (20)
      expect(result.executedTasks[1]).toBe('T-BRANCH-2');
      expect(result.executedTasks[2]).toBe('T-BRANCH-1');
      // Join D must be last
      expect(result.executedTasks[3]).toBe('T-JOIN');
      expect(result.summary.isComplete).toBe(true);
    });
  });

  describe('Failure Isolation and Halting', () => {
    it('stops execution and sets plan to FAILED when an upstream task fails without retries', async () => {
      const failingPlan = createTestPlan('APPROVED', [
        { id: 'T-FAIL', title: 'Failing Task', dependencies: [], priority: 10 },
        { id: 'T-DEPENDENT', title: 'Dependent Task', dependencies: ['T-FAIL'], priority: 20 },
      ]);

      // Configure runService to use error scenario
      const failingRunService = new RunService({
        db,
        executionManager,
        config: {
          AGY_BIN: 'node',
          AGY_ARGS: `${mockCliPath} error`,
        },
      });

      const failingScheduler = new TaskScheduler({
        db,
        runService: failingRunService,
        autoRetry: false,
      });

      const failingOrchestrator = new PlanOrchestrator({
        db,
        planRepo,
        taskRepo,
        scheduler: failingScheduler,
        stateService,
      });

      const result = await failingOrchestrator.orchestratePlan(failingPlan.id, {
        autoRetry: false,
      });

      expect(result.finalStatus).toBe('FAILED');
      expect(result.executedTasks).toEqual(['T-FAIL']);

      // T-FAIL is FAILED
      expect(taskRepo.findById('T-FAIL')?.status).toBe('FAILED');

      // T-DEPENDENT was NEVER executed (still TODO)
      expect(taskRepo.findById('T-DEPENDENT')?.status).toBe('TODO');
      expect(result.summary.failedTasks).toBe(1);
      expect(result.summary.hasFailed).toBe(true);
      expect(result.summary.isComplete).toBe(false);

      // Verify in DB
      expect(planRepo.findById(failingPlan.id)?.status).toBe('FAILED');
    });
  });

  describe('Dry Run Mode', () => {
    it('does not create tasks or execute workers in dryRun mode', async () => {
      const plan = createTestPlan('APPROVED');

      const result = await orchestrator.orchestratePlan(plan.id, { dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(result.executedTasks).toEqual([]);
      expect(result.steps).toEqual([]);
      expect(taskRepo.findAll({ plan_id: plan.id })).toHaveLength(0);
      expect(planRepo.findById(plan.id)?.status).toBe('APPROVED');
    });
  });
});
