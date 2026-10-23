import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  createDatabase,
  runMigrations,
  PlanRepository,
  TaskRepository,
} from '../packages/db/src/index.js';
import {
  buildServer,
  RunService,
  TaskScheduler,
  PlannerService,
  PlanOrchestrator,
  createExecutionManager,
  type ExecutionManager,
} from '../apps/orchestrator/src/index.js';
import { AppError, type Plan } from '../packages/shared/src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mockCliPath = path.resolve(__dirname, '../fixtures/mock-agy-cli.cjs');

describe('ORC-008 Acceptance Tests: Điều phối theo plan đã duyệt (Chạy đúng thứ tự dependency)', () => {
  let db: Database.Database;
  let server: FastifyInstance;
  let planRepo: PlanRepository;
  let taskRepo: TaskRepository;
  let executionManager: ExecutionManager;
  let runService: RunService;
  let scheduler: TaskScheduler;
  let plannerService: PlannerService;
  let orchestrator: PlanOrchestrator;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);
    planRepo = new PlanRepository(db);
    taskRepo = new TaskRepository(db);
    executionManager = createExecutionManager();

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

    plannerService = new PlannerService({
      db,
      taskScheduler: scheduler,
    });

    orchestrator = plannerService.getOrchestrator();

    server = await buildServer({
      db,
      executionManager,
      taskScheduler: scheduler,
      plannerService,
      logger: false,
    });
    await server.ready();
  });

  afterEach(async () => {
    await scheduler.stop(true);
    await executionManager.stopAll();
    await server.close();
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
          id: 'ORC8-A',
          title: 'Task A: Database Migrations',
          dependencies: [],
          priority: 10,
        },
        {
          id: 'ORC8-B',
          title: 'Task B: Repositories and Logic',
          dependencies: ['ORC8-A'],
          priority: 20,
        },
        {
          id: 'ORC8-C',
          title: 'Task C: End-to-End API Integration',
          dependencies: ['ORC8-B'],
          priority: 30,
        },
      ];

    return planRepo.create({
      id: `plan-orc8-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: 'ORC-008 Orchestration Test Plan',
      description: 'Test plan verifying strict dependency order execution',
      repository: '.',
      status,
      tasks: planTasks.map((t) => ({
        id: t.id,
        title: t.title,
        description: null,
        scope_files: [`src/${t.id.toLowerCase()}.ts`],
        acceptance_criteria: [`Acceptance criterion for ${t.id}`],
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

  describe('Tiêu chí 1: Chưa duyệt → không thực thi (Strict approval enforcement)', () => {
    it('1.1: stepPlan từ chối kế hoạch PENDING_APPROVAL và ném lỗi PLAN_NOT_APPROVED', async () => {
      const plan = createTestPlan('PENDING_APPROVAL');

      await expect(orchestrator.stepPlan(plan.id)).rejects.toThrowError(/not approved/);
      try {
        await orchestrator.stepPlan(plan.id);
      } catch (err: unknown) {
        expect((err as AppError).code).toBe('PLAN_NOT_APPROVED');
      }
    });

    it('1.2: stepPlan từ chối kế hoạch REJECTED và ném lỗi PLAN_NOT_APPROVED', async () => {
      const plan = createTestPlan('REJECTED');

      await expect(orchestrator.stepPlan(plan.id)).rejects.toThrowError(/not approved/);
      try {
        await orchestrator.stepPlan(plan.id);
      } catch (err: unknown) {
        expect((err as AppError).code).toBe('PLAN_NOT_APPROVED');
      }
    });

    it('1.3: orchestratePlan từ chối kế hoạch DRAFT và ném lỗi PLAN_NOT_APPROVED', async () => {
      const plan = createTestPlan('DRAFT');

      await expect(orchestrator.orchestratePlan(plan.id)).rejects.toThrowError(/not approved/);
      try {
        await orchestrator.orchestratePlan(plan.id);
      } catch (err: unknown) {
        expect((err as AppError).code).toBe('PLAN_NOT_APPROVED');
      }
    });

    it('1.4: REST API POST /plans/:id/orchestrate chặn kế hoạch chưa duyệt với HTTP 400 PLAN_NOT_APPROVED', async () => {
      const plan = createTestPlan('PENDING_APPROVAL');

      const res = await server.inject({
        method: 'POST',
        url: `/plans/${plan.id}/orchestrate`,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('PLAN_NOT_APPROVED');
    });

    it('1.5: REST API POST /plans/:id/step chặn kế hoạch chưa duyệt với HTTP 400 PLAN_NOT_APPROVED', async () => {
      const plan = createTestPlan('REJECTED');

      const res = await server.inject({
        method: 'POST',
        url: `/plans/${plan.id}/step`,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('PLAN_NOT_APPROVED');
    });
  });

  describe('Tiêu chí 2: Điều phối chuỗi phụ thuộc tuyến tính (Linear DAG: A -> B -> C)', () => {
    it('2.1: Chạy đúng thứ tự dependency tuyến tính: A rồi B rồi C, không bao giờ chạy trước dependency', async () => {
      const plan = createTestPlan('APPROVED');

      // Bước 1: Chỉ task A chạy được (dependencies = [])
      const step1 = await orchestrator.stepPlan(plan.id);
      expect(step1.step.executed).toBe(true);
      expect(step1.step.taskId).toBe('ORC8-A');
      expect(taskRepo.findById('ORC8-A')?.status).toBe('DONE');
      expect(taskRepo.findById('ORC8-B')?.status).toBe('TODO');
      expect(taskRepo.findById('ORC8-C')?.status).toBe('TODO');

      // Bước 2: B chạy được sau khi A DONE; C chưa thể chạy vì B chưa xong
      const step2 = await orchestrator.stepPlan(plan.id);
      expect(step2.step.executed).toBe(true);
      expect(step2.step.taskId).toBe('ORC8-B');
      expect(taskRepo.findById('ORC8-B')?.status).toBe('DONE');
      expect(taskRepo.findById('ORC8-C')?.status).toBe('TODO');

      // Bước 3: C chạy được sau khi B DONE
      const step3 = await orchestrator.stepPlan(plan.id);
      expect(step3.step.executed).toBe(true);
      expect(step3.step.taskId).toBe('ORC8-C');
      expect(taskRepo.findById('ORC8-C')?.status).toBe('DONE');

      // Bước 4: Toàn bộ task đã xong, trạng thái kế hoạch tự động COMPLETED
      expect(step3.summary.isComplete).toBe(true);
      expect(step3.summary.completedTasks).toBe(3);
      expect(planRepo.findById(plan.id)?.status).toBe('COMPLETED');
    });

    it('2.2: orchestratePlan tự động điều phối toàn bộ chuỗi A -> B -> C theo thứ tự', async () => {
      const plan = createTestPlan('APPROVED');

      const result = await orchestrator.orchestratePlan(plan.id);

      expect(result.finalStatus).toBe('COMPLETED');
      expect(result.executedTasks).toEqual(['ORC8-A', 'ORC8-B', 'ORC8-C']);
      expect(result.summary.isComplete).toBe(true);
      expect(result.summary.completedTasks).toBe(3);
      expect(planRepo.findById(plan.id)?.status).toBe('COMPLETED');
    });
  });

  describe('Tiêu chí 3: Điều phối đồ thị phụ thuộc phân nhánh & hội tụ (Diamond DAG: Root -> [B1, B2] -> Join)', () => {
    it('3.1: Root chạy đầu, các nhánh chạy tiếp theo, task hội tụ (Join) CHỈ chạy khi CẢ 2 nhánh đều DONE', async () => {
      const diamondPlan = createTestPlan('APPROVED', [
        { id: 'ROOT', title: 'Task Gốc (Setup)', dependencies: [], priority: 10 },
        { id: 'BRANCH-1', title: 'Nhánh 1 (Frontend)', dependencies: ['ROOT'], priority: 20 },
        { id: 'BRANCH-2', title: 'Nhánh 2 (Backend)', dependencies: ['ROOT'], priority: 30 },
        { id: 'JOIN', title: 'Task Hội Tụ (Release)', dependencies: ['BRANCH-1', 'BRANCH-2'], priority: 40 },
      ]);

      const result = await orchestrator.orchestratePlan(diamondPlan.id);

      expect(result.finalStatus).toBe('COMPLETED');
      expect(result.executedTasks).toHaveLength(4);

      // ROOT phải là task đầu tiên
      expect(result.executedTasks[0]).toBe('ROOT');

      // BRANCH-2 có priority 30 > BRANCH-1 có priority 20
      expect(result.executedTasks[1]).toBe('BRANCH-2');
      expect(result.executedTasks[2]).toBe('BRANCH-1');

      // JOIN chỉ được chạy cuối cùng sau khi cả 2 nhánh hoàn thành
      expect(result.executedTasks[3]).toBe('JOIN');

      expect(result.summary.isComplete).toBe(true);
      expect(result.summary.completedTasks).toBe(4);
    });

    it('3.2: Kiểm tra từng bước: JOIN không thể thực thi nếu chỉ 1 nhánh hoàn tất', async () => {
      const diamondPlan = createTestPlan('APPROVED', [
        { id: 'DIA-ROOT', title: 'Root', dependencies: [], priority: 10 },
        { id: 'DIA-B1', title: 'Branch 1', dependencies: ['DIA-ROOT'], priority: 20 },
        { id: 'DIA-B2', title: 'Branch 2', dependencies: ['DIA-ROOT'], priority: 30 },
        { id: 'DIA-JOIN', title: 'Join', dependencies: ['DIA-B1', 'DIA-B2'], priority: 40 },
      ]);

      // Bước 1: ROOT chạy
      const s1 = await orchestrator.stepPlan(diamondPlan.id);
      expect(s1.step.taskId).toBe('DIA-ROOT');

      // Bước 2: DIA-B2 chạy (priority 30)
      const s2 = await orchestrator.stepPlan(diamondPlan.id);
      expect(s2.step.taskId).toBe('DIA-B2');

      // Tại thời điểm này: DIA-B2 DONE nhưng DIA-B1 vẫn TODO. DIA-JOIN có chạy được không?
      // Tiêu chí: JOIN CHƯA THỂ CHẠY!
      const joinDepStatus = taskRepo.getDependencyStatus('DIA-JOIN');
      expect(joinDepStatus.isReady).toBe(false);
      expect(joinDepStatus.unsatisfiedDependencies.map((d: { id: string }) => d.id)).toContain('DIA-B1');

      // Bước 3: DIA-B1 chạy
      const s3 = await orchestrator.stepPlan(diamondPlan.id);
      expect(s3.step.taskId).toBe('DIA-B1');

      // Giờ cả 2 nhánh đều DONE, DIA-JOIN mới ready
      const joinDepStatusAfter = taskRepo.getDependencyStatus('DIA-JOIN');
      expect(joinDepStatusAfter.isReady).toBe(true);

      // Bước 4: DIA-JOIN chạy
      const s4 = await orchestrator.stepPlan(diamondPlan.id);
      expect(s4.step.taskId).toBe('DIA-JOIN');
      expect(s4.summary.isComplete).toBe(true);
    });
  });

  describe('Tiêu chí 4: Xử lý cô lập lỗi khi một task thất bại (Failure isolation & Circuit breaker)', () => {
    it('4.1: Khi một task thất bại, các task phụ thuộc phía sau KHÔNG BAO GIỜ được chạy và kế hoạch chuyển sang FAILED', async () => {
      const failingPlan = createTestPlan('APPROVED', [
        { id: 'ERR-TASK-1', title: 'Task Sẽ Thất Bại', dependencies: [], priority: 10 },
        { id: 'ERR-TASK-2', title: 'Task Phụ Thuộc 1', dependencies: ['ERR-TASK-1'], priority: 20 },
        { id: 'ERR-TASK-3', title: 'Task Phụ Thuộc 2', dependencies: ['ERR-TASK-2'], priority: 30 },
      ]);

      // Setup failing run service
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
        scheduler: failingScheduler,
      });

      const result = await failingOrchestrator.orchestratePlan(failingPlan.id);

      expect(result.finalStatus).toBe('FAILED');
      expect(result.executedTasks).toEqual(['ERR-TASK-1']);

      // ERR-TASK-1 thất bại
      expect(taskRepo.findById('ERR-TASK-1')?.status).toBe('FAILED');

      // Các task phụ thuộc ERR-TASK-2 và ERR-TASK-3 KHÔNG ĐƯỢC CHẠY
      expect(taskRepo.findById('ERR-TASK-2')?.status).toBe('TODO');
      expect(taskRepo.findById('ERR-TASK-3')?.status).toBe('TODO');

      // Trạng thái DB của kế hoạch
      const inDb = planRepo.findById(failingPlan.id);
      expect(inDb?.status).toBe('FAILED');
    });
  });

  describe('Tiêu chí 5: Chế độ chạy thử (Dry Run Mode)', () => {
    it('5.1: Chế độ dryRun trả về thứ tự thực thi topo nhưng không tạo task trong database', async () => {
      const plan = createTestPlan('APPROVED');

      const result = await orchestrator.orchestratePlan(plan.id, { dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(result.executedTasks).toEqual([]);
      expect(taskRepo.findAll({ plan_id: plan.id })).toHaveLength(0);
      expect(planRepo.findById(plan.id)?.status).toBe('APPROVED');
    });
  });

  describe('Tiêu chí 6: Tích hợp REST API Orchestration', () => {
    it('6.1: POST /plans/:id/dispatch đồng bộ tasks và dependencies vào database', async () => {
      const plan = createTestPlan('APPROVED');

      const res = await server.inject({
        method: 'POST',
        url: `/plans/${plan.id}/dispatch`,
      });

      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data.planId).toBe(plan.id);
      expect(data.tasks).toHaveLength(3);

      const tasksInDb = taskRepo.findAll({ plan_id: plan.id });
      expect(tasksInDb).toHaveLength(3);
    });

    it('6.2: POST /plans/:id/step thực thi từng task qua HTTP theo đúng thứ tự dependency', async () => {
      const plan = createTestPlan('APPROVED');

      // Step 1 via API -> ORC8-A
      const res1 = await server.inject({
        method: 'POST',
        url: `/plans/${plan.id}/step`,
      });
      expect(res1.statusCode).toBe(200);
      expect(res1.json().data.step.taskId).toBe('ORC8-A');

      // Step 2 via API -> ORC8-B
      const res2 = await server.inject({
        method: 'POST',
        url: `/plans/${plan.id}/step`,
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().data.step.taskId).toBe('ORC8-B');

      // Step 3 via API -> ORC8-C
      const res3 = await server.inject({
        method: 'POST',
        url: `/plans/${plan.id}/step`,
      });
      expect(res3.statusCode).toBe(200);
      expect(res3.json().data.step.taskId).toBe('ORC8-C');
      expect(res3.json().data.summary.isComplete).toBe(true);
    });

    it('6.3: POST /plans/:id/orchestrate điều phối toàn bộ kế hoạch đến khi COMPLETED', async () => {
      const plan = createTestPlan('APPROVED');

      const res = await server.inject({
        method: 'POST',
        url: `/plans/${plan.id}/orchestrate`,
      });

      expect(res.statusCode).toBe(200);
      const result = res.json().data;
      expect(result.finalStatus).toBe('COMPLETED');
      expect(result.executedTasks).toEqual(['ORC8-A', 'ORC8-B', 'ORC8-C']);
      expect(result.summary.isComplete).toBe(true);
    });

    it('6.4: GET /plans/:id/execution và /plans/:id/status trả về chi tiết tiến độ thực thi', async () => {
      const plan = createTestPlan('APPROVED');

      // Run step 1
      await orchestrator.stepPlan(plan.id);

      const res = await server.inject({
        method: 'GET',
        url: `/plans/${plan.id}/execution`,
      });

      expect(res.statusCode).toBe(200);
      const summary = res.json().data;
      expect(summary.planId).toBe(plan.id);
      expect(summary.totalTasks).toBe(3);
      expect(summary.completedTasks).toBe(1);
      expect(summary.readyTasks).toBe(1); // ORC8-B is now ready
      expect(summary.pendingTasks).toBe(1); // ORC8-C is still pending
      expect(summary.isComplete).toBe(false);
    });

    it('6.5: POST /plans/:id/execute với orchestrate: true tự động hoàn tất toàn bộ kế hoạch', async () => {
      const plan = createTestPlan('APPROVED');

      const res = await server.inject({
        method: 'POST',
        url: `/plans/${plan.id}/execute`,
        payload: {
          orchestrate: true,
        },
      });

      expect(res.statusCode).toBe(200);
      const result = res.json().data;
      expect(result.finalStatus).toBe('COMPLETED');
      expect(result.executedTasks).toEqual(['ORC8-A', 'ORC8-B', 'ORC8-C']);
    });
  });

  describe('Tiêu chí 7: Bảo đảm Concurrency tối đa 1 coding process tại một thời điểm (ORC-003 Lock)', () => {
    it('7.1: Hai lời gọi stepPlan đồng thời không bao giờ chạy trùng 2 task', async () => {
      const plan = createTestPlan('APPROVED', [
        { id: 'PAR-A', title: 'Independent Task A', dependencies: [], priority: 10 },
        { id: 'PAR-B', title: 'Independent Task B', dependencies: [], priority: 20 },
      ]);

      orchestrator.materializePlanTasks(plan.id);

      // Gọi 2 stepPlan song song
      const [res1, res2] = await Promise.all([
        orchestrator.stepPlan(plan.id),
        orchestrator.stepPlan(plan.id),
      ]);

      // Chỉ 1 trong 2 lời gọi được thực thi thành công
      const executedCount = (res1.step.executed ? 1 : 0) + (res2.step.executed ? 1 : 0);
      expect(executedCount).toBe(1);

      // Task còn lại bị từ chối với lý do LOCK_HELD hoặc CONCURRENCY_LIMIT_EXCEEDED
      const rejectedResult = res1.step.executed ? res2 : res1;
      expect(['LOCK_HELD', 'CONCURRENCY_LIMIT_EXCEEDED', 'ACTIVE_RUN_EXISTS']).toContain(
        rejectedResult.step.reason,
      );

      // Lần gọi tiếp theo sau khi lock được nhả sẽ thực thi task còn lại
      const nextStep = await orchestrator.stepPlan(plan.id);
      expect(nextStep.step.executed).toBe(true);
      expect(nextStep.summary.completedTasks).toBe(2);
      expect(nextStep.summary.isComplete).toBe(true);
    });
  });
});
