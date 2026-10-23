import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import {
  createDatabase,
  runMigrations,
  PlanRepository,
  FeatureRepository,
} from '../packages/db/src/index.js';
import {
  buildServer,
  PlannerService,
  buildPlannerPrompt,
} from '../apps/orchestrator/src/index.js';
import {
  PlanSchema,
  PlanTaskSchema,
  PlanTaskInputSchema,
  PlanContentSchema,
  extractJsonPlan,
  validatePlanTasksGraph,
  AppError,
} from '../packages/shared/src/index.js';

describe('ORC-006 Acceptance Tests: Planner — gọi AGY sinh plan JSON (task, scope file, acceptance) từ repo — Plan qua zod hợp lệ', () => {
  let db: Database.Database;
  let server: FastifyInstance;
  let planRepo: PlanRepository;
  let featureRepo: FeatureRepository;
  let plannerService: PlannerService;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);
    planRepo = new PlanRepository(db);
    featureRepo = new FeatureRepository(db);

    plannerService = new PlannerService({
      db,
      config: {
        AGY_BIN: process.execPath,
      },
    });

    server = await buildServer({
      db,
      logger: false,
      plannerService,
    });
  });

  afterEach(async () => {
    await server.close();
    db.close();
  });

  describe('Tiêu chí 1: Sinh plan JSON từ repo qua AGY', () => {
    it('1.1: Gọi AGY sinh plan thành công từ repo với các task có id, scope_files, acceptance_criteria, dependencies', async () => {
      const generatedPlanContent = {
        title: 'Feature Release Workflow Implementation',
        description: 'Complete architecture implementation plan',
        tasks: [
          {
            id: 'REL-001',
            title: 'Define Release Models & Zod Schemas',
            description: 'Create Release and ReleaseTask schemas',
            scope_files: [
              'packages/shared/src/models/release.ts',
              'packages/shared/src/models/index.ts',
            ],
            acceptance_criteria: [
              'ReleaseSchema passes zod typecheck',
              'Exported via packages/shared/src/index.ts',
            ],
            dependencies: [],
            test_commands: ['pnpm test packages/shared/src/__tests__/release.test.ts'],
            priority: 1,
            timeout_minutes: 15,
          },
          {
            id: 'REL-002',
            title: 'Implement Release Repository',
            description: 'SQLite migration and repository for release tracking',
            scope_files: [
              'packages/db/migrations/005_releases.sql',
              'packages/db/src/repositories/release-repository.ts',
            ],
            acceptance_criteria: [
              'Migration executes cleanly',
              'CRUD methods for release entities pass tests',
            ],
            dependencies: ['REL-001'],
            test_commands: ['pnpm test packages/db/src/__tests__/release-repository.test.ts'],
            priority: 2,
            timeout_minutes: 20,
          },
        ],
      };

      // Mock CLI command using node -e to emit markdown code fence with JSON
      const mockScript = `console.log(\`Analysis complete. Generated plan:\\n\\\`\\\`\\\`json\\n${JSON.stringify(generatedPlanContent)}\\n\\\`\\\`\\\`\`);`;

      const customPlanner = new PlannerService({
        db,
        config: {
          AGY_BIN: process.execPath,
          AGY_ARGS: '-e',
        },
      });

      const plan = await customPlanner.generatePlan({
        goal: 'Implement Feature Release Workflow',
        command: { exe: process.execPath, args: ['-e', mockScript] },
        repository: '.',
      });

      expect(plan.id).toBeDefined();
      expect(plan.title).toBe('Feature Release Workflow Implementation');
      expect(plan.status).toBe('PENDING_APPROVAL');
      expect(plan.repository).toBe('.');
      expect(plan.tasks).toHaveLength(2);

      const task1 = plan.tasks[0];
      expect(task1?.id).toBe('REL-001');
      expect(task1?.scope_files).toEqual([
        'packages/shared/src/models/release.ts',
        'packages/shared/src/models/index.ts',
      ]);
      expect(task1?.acceptance_criteria).toEqual([
        'ReleaseSchema passes zod typecheck',
        'Exported via packages/shared/src/index.ts',
      ]);
      expect(task1?.dependencies).toEqual([]);

      const task2 = plan.tasks[1];
      expect(task2?.id).toBe('REL-002');
      expect(task2?.scope_files).toEqual([
        'packages/db/migrations/005_releases.sql',
        'packages/db/src/repositories/release-repository.ts',
      ]);
      expect(task2?.dependencies).toEqual(['REL-001']);

      // Verified stored in SQLite
      const stored = planRepo.findById(plan.id);
      expect(stored).toBeDefined();
      expect(stored?.tasks).toHaveLength(2);
    });

    it('1.3: Sinh prompt lập kế hoạch chuẩn xác với đầy đủ goal và ràng buộc kỹ thuật', () => {
      const prompt = buildPlannerPrompt('Build authentication system', {
        contextFiles: ['packages/shared/src/models/user.ts'],
      });

      expect(prompt).toContain('Build authentication system');
      expect(prompt).toContain('scope_files');
      expect(prompt).toContain('acceptance_criteria');
      expect(prompt).toContain('packages/shared/src/models/user.ts');
    });
  });

  describe('Tiêu chí 2: Kiểm định qua Zod Schema (Nghiệm thu: Plan qua zod hợp lệ)', () => {
    it('2.1: Plan hợp lệ schema Zod được chấp nhận đầy đủ các trường', () => {
      const validPlanData = {
        id: 'plan_test_1',
        feature_id: null,
        title: 'Core System Plan',
        description: 'Comprehensive test plan',
        repository: '.',
        status: 'PENDING_APPROVAL' as const,
        tasks: [
          {
            id: 'T1',
            title: 'Task One',
            description: 'First task',
            scope_files: ['file1.ts'],
            acceptance_criteria: ['Criterion A', 'Criterion B'],
            dependencies: [],
            test_commands: ['vitest run file1.test.ts'],
            priority: 0,
            timeout_minutes: 30,
            worker_type: 'agy',
          },
        ],
        raw_output: 'raw output text',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        approved_at: null,
        approved_by: null,
        rejection_reason: null,
      };

      const validated = PlanSchema.parse(validPlanData);
      expect(validated.title).toBe('Core System Plan');
      expect(validated.tasks[0]?.scope_files).toEqual(['file1.ts']);
      expect(validated.tasks[0]?.acceptance_criteria).toEqual(['Criterion A', 'Criterion B']);
    });

    it('2.2: Từ chối task thiếu scope_files theo schema Zod', () => {
      const taskWithoutScope = {
        id: 'INVALID-TASK-1',
        title: 'Missing scope files',
        scope_files: [],
        acceptance_criteria: ['Acceptance passes'],
      };

      expect(() => PlanTaskSchema.parse(taskWithoutScope)).toThrow();
    });

    it('2.3: Từ chối task thiếu acceptance_criteria theo schema Zod', () => {
      const taskWithoutAcceptance = {
        id: 'INVALID-TASK-2',
        title: 'Missing acceptance criteria',
        scope_files: ['file.ts'],
        acceptance_criteria: [],
      };

      expect(() => PlanTaskSchema.parse(taskWithoutAcceptance)).toThrow();
    });

    it('2.4: Từ chối plan có mảng tasks rỗng theo schema Zod', () => {
      const emptyTasksPlan = {
        title: 'Empty Tasks Plan',
        tasks: [],
      };

      expect(() => PlanContentSchema.parse(emptyTasksPlan)).toThrow();
    });

    it('2.5: Chuẩn hóa linh hoạt khi LLM dùng bí danh (files / scope / acceptance) thành scope_files và acceptance_criteria', () => {
      const aliasTask = {
        id: 'TASK-ALIAS',
        title: 'Task with aliased fields',
        files: ['path/to/one.ts', 'path/to/two.ts'],
        acceptance: ['Must pass lint', 'Must pass typecheck'],
      };

      const normalized = PlanTaskInputSchema.parse(aliasTask);
      expect(normalized.scope_files).toEqual(['path/to/one.ts', 'path/to/two.ts']);
      expect(normalized.acceptance_criteria).toEqual(['Must pass lint', 'Must pass typecheck']);
    });

    it('2.6: Bóc tách JSON an toàn từ markdown code fence, raw JSON và văn bản có lời giải thích', () => {
      const fenced = '```json\n{"title":"Fenced Plan","tasks":[{"id":"T1","title":"T1","scope_files":["f.ts"],"acceptance_criteria":["ok"]}]}\n```';
      const extractedFenced = extractJsonPlan(fenced) as { title: string };
      expect(extractedFenced.title).toBe('Fenced Plan');

      const textWithChatter = 'Here is the plan:\n{"title":"Chatter Plan","tasks":[{"id":"T1","title":"T1","scope_files":["f.ts"],"acceptance_criteria":["ok"]}]}\nHope this helps!';
      const extractedChatter = extractJsonPlan(textWithChatter) as { title: string };
      expect(extractedChatter.title).toBe('Chatter Plan');
    });
  });

  describe('Tiêu chí 3: Kiểm tra cấu trúc đồ thị phụ thuộc (Dependency Validation)', () => {
    it('3.1: Chấp nhận đồ thị phụ thuộc DAG hợp lệ giữa các task', () => {
      const validDagTasks = [
        {
          id: 'A',
          title: 'Task A',
          description: null,
          scope_files: ['a.ts'],
          acceptance_criteria: ['A ok'],
          dependencies: [],
          test_commands: [],
          priority: 0,
          timeout_minutes: 30,
          worker_type: 'agy',
        },
        {
          id: 'B',
          title: 'Task B',
          description: null,
          scope_files: ['b.ts'],
          acceptance_criteria: ['B ok'],
          dependencies: ['A'],
          test_commands: [],
          priority: 0,
          timeout_minutes: 30,
          worker_type: 'agy',
        },
        {
          id: 'C',
          title: 'Task C',
          description: null,
          scope_files: ['c.ts'],
          acceptance_criteria: ['C ok'],
          dependencies: ['A', 'B'],
          test_commands: [],
          priority: 0,
          timeout_minutes: 30,
          worker_type: 'agy',
        },
      ];

      expect(() => validatePlanTasksGraph(validDagTasks)).not.toThrow();
    });

    it('3.2: Phát hiện và từ chối khi phát hiện chu trình phụ thuộc vòng (circular dependency)', () => {
      const cyclicTasks = [
        {
          id: 'STEP-1',
          title: 'Step 1',
          description: null,
          scope_files: ['s1.ts'],
          acceptance_criteria: ['s1 ok'],
          dependencies: ['STEP-2'],
          test_commands: [],
          priority: 0,
          timeout_minutes: 30,
          worker_type: 'agy',
        },
        {
          id: 'STEP-2',
          title: 'Step 2',
          description: null,
          scope_files: ['s2.ts'],
          acceptance_criteria: ['s2 ok'],
          dependencies: ['STEP-1'],
          test_commands: [],
          priority: 0,
          timeout_minutes: 30,
          worker_type: 'agy',
        },
      ];

      expect(() => validatePlanTasksGraph(cyclicTasks)).toThrow(AppError);
      expect(() => validatePlanTasksGraph(cyclicTasks)).toThrow(/cycle/i);
    });

    it('3.3: Phát hiện và từ chối khi task phụ thuộc vào task ID không tồn tại trong plan', () => {
      const missingDepTasks = [
        {
          id: 'STEP-A',
          title: 'Step A',
          description: null,
          scope_files: ['sa.ts'],
          acceptance_criteria: ['sa ok'],
          dependencies: ['NON_EXISTENT_STEP'],
          test_commands: [],
          priority: 0,
          timeout_minutes: 30,
          worker_type: 'agy',
        },
      ];

      expect(() => validatePlanTasksGraph(missingDepTasks)).toThrow(AppError);
      expect(() => validatePlanTasksGraph(missingDepTasks)).toThrow(/non-existent task/i);
    });

    it('3.4: Phát hiện và từ chối khi có mã task ID trùng lặp trong plan', () => {
      const duplicateTasks = [
        {
          id: 'TASK-SAME',
          title: 'First instance',
          description: null,
          scope_files: ['f1.ts'],
          acceptance_criteria: ['ok'],
          dependencies: [],
          test_commands: [],
          priority: 0,
          timeout_minutes: 30,
          worker_type: 'agy',
        },
        {
          id: 'TASK-SAME',
          title: 'Second instance with same ID',
          description: null,
          scope_files: ['f2.ts'],
          acceptance_criteria: ['ok'],
          dependencies: [],
          test_commands: [],
          priority: 0,
          timeout_minutes: 30,
          worker_type: 'agy',
        },
      ];

      expect(() => validatePlanTasksGraph(duplicateTasks)).toThrow(AppError);
      expect(() => validatePlanTasksGraph(duplicateTasks)).toThrow(/duplicate task ID/i);
    });
  });

  describe('Tiêu chí 4: Lưu trữ và tra cứu kế hoạch (SQLite Persistence)', () => {
    it('4.1: Lưu trữ và tra cứu toàn vẹn dữ liệu qua PlanRepository', () => {
      const created = planRepo.create({
        id: 'plan_persist_1',
        title: 'Persistence Test Plan',
        description: 'Testing SQLite storage of plan',
        repository: './custom-repo',
        status: 'PENDING_APPROVAL',
        tasks: [
          {
            id: 'T1',
            title: 'Task 1',
            scope_files: ['src/app.ts'],
            acceptance_criteria: ['App bootstraps'],
          },
        ],
      });

      expect(created.id).toBe('plan_persist_1');
      expect(created.repository).toBe('./custom-repo');

      const fetched = planRepo.findById('plan_persist_1');
      expect(fetched).toBeDefined();
      expect(fetched?.title).toBe('Persistence Test Plan');
      expect(fetched?.tasks).toHaveLength(1);
    });

    it('4.2: Lọc kế hoạch theo status và repository', () => {
      planRepo.create({
        id: 'plan_approved',
        title: 'Approved Plan',
        status: 'APPROVED',
        repository: 'repo-1',
        tasks: [{ id: 'T1', title: 'T1', scope_files: ['a.ts'], acceptance_criteria: ['ok'] }],
      });

      planRepo.create({
        id: 'plan_rejected',
        title: 'Rejected Plan',
        status: 'REJECTED',
        repository: 'repo-2',
        tasks: [{ id: 'T2', title: 'T2', scope_files: ['b.ts'], acceptance_criteria: ['ok'] }],
      });

      const approvedList = planRepo.findAll({ status: 'APPROVED' });
      expect(approvedList).toHaveLength(1);
      expect(approvedList[0]?.id).toBe('plan_approved');

      const repo2List = planRepo.findAll({ repository: 'repo-2' });
      expect(repo2List).toHaveLength(1);
      expect(repo2List[0]?.id).toBe('plan_rejected');
    });

    it('4.3: Liên kết feature_id và kiểm soát toàn vẹn khóa ngoại', () => {
      featureRepo.create({
        id: 'FEAT-ORC-006',
        name: 'Planner Integration Feature',
        required_tasks: [],
        integration_tests: [],
      });

      const plan = planRepo.create({
        id: 'plan_with_feature',
        feature_id: 'FEAT-ORC-006',
        title: 'Feature Bound Plan',
        tasks: [{ id: 'T1', title: 'T1', scope_files: ['f.ts'], acceptance_criteria: ['ok'] }],
      });

      expect(plan.feature_id).toBe('FEAT-ORC-006');
    });
  });

  describe('Tiêu chí 5: REST API endpoints cho Planner (/plans/generate, /plans/validate, /plans/:id, /plans)', () => {
    it('5.1: POST /api/plans/generate gọi AGY, sinh plan qua zod, lưu DB và trả về 201 Created', async () => {
      const planPayload = {
        title: 'REST Generated Plan',
        tasks: [
          {
            id: 'REST-1',
            title: 'Endpoint task',
            scope_files: ['routes.ts'],
            acceptance_criteria: ['Returns 201'],
          },
        ],
      };

      const mockScript = `console.log(JSON.stringify(${JSON.stringify(planPayload)}));`;

      const customPlanner = new PlannerService({
        db,
        config: {
          AGY_BIN: process.execPath,
          AGY_ARGS: '-e',
        },
      });

      const customServer = await buildServer({
        db,
        plannerService: customPlanner,
      });

      const res = await customServer.inject({
        method: 'POST',
        url: '/api/plans/generate',
        payload: {
          goal: 'Build REST endpoints',
          command: { exe: process.execPath, args: ['-e', mockScript] },
          repository: '.',
        },
      });

      expect(res.statusCode).toBe(201);
      const json = JSON.parse(res.payload);
      expect(json.data.title).toBe('REST Generated Plan');
      expect(json.data.status).toBe('PENDING_APPROVAL');
      expect(json.data.tasks).toHaveLength(1);

      await customServer.close();
    });

    it('5.2: POST /api/plans/validate xác thực và bóc tách plan payload trực tiếp', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/plans/validate',
        payload: {
          rawOutput: JSON.stringify({
            title: 'Direct Validated Plan',
            tasks: [
              {
                id: 'VAL-1',
                title: 'Validation task',
                scope_files: ['val.ts'],
                acceptance_criteria: ['Validates correctly'],
              },
            ],
          }),
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.data.title).toBe('Direct Validated Plan');
      expect(json.data.tasks[0]?.id).toBe('VAL-1');
    });

    it('5.3: GET /api/plans/:id tra cứu chi tiết và trả về 404 khi không tồn tại', async () => {
      const notFoundRes = await server.inject({
        method: 'GET',
        url: '/api/plans/plan_missing_xyz',
      });

      expect(notFoundRes.statusCode).toBe(404);
      const notFoundJson = JSON.parse(notFoundRes.payload);
      expect(notFoundJson.error.code).toBe('PLAN_NOT_FOUND');

      // Create a plan and retrieve it
      const created = planRepo.create({
        id: 'plan_to_fetch',
        title: 'Fetchable Plan',
        tasks: [{ id: 'T1', title: 'T1', scope_files: ['f.ts'], acceptance_criteria: ['ok'] }],
      });

      const foundRes = await server.inject({
        method: 'GET',
        url: `/api/plans/${created.id}`,
      });

      expect(foundRes.statusCode).toBe(200);
      const foundJson = JSON.parse(foundRes.payload);
      expect(foundJson.data.id).toBe('plan_to_fetch');
      expect(foundJson.data.title).toBe('Fetchable Plan');
    });

    it('5.4: GET /api/plans liệt kê danh sách kế hoạch', async () => {
      planRepo.create({
        id: 'plan_list_test',
        title: 'Listed Plan Test',
        tasks: [{ id: 'T1', title: 'T1', scope_files: ['f.ts'], acceptance_criteria: ['ok'] }],
      });

      const res = await server.inject({
        method: 'GET',
        url: '/api/plans',
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.data.length).toBeGreaterThanOrEqual(1);
    });

    it('5.5: DELETE /api/plans/:id xóa kế hoạch khỏi DB', async () => {
      planRepo.create({
        id: 'plan_to_delete',
        title: 'Delete Me',
        tasks: [{ id: 'T1', title: 'T1', scope_files: ['f.ts'], acceptance_criteria: ['ok'] }],
      });

      const delRes = await server.inject({
        method: 'DELETE',
        url: '/api/plans/plan_to_delete',
      });

      expect(delRes.statusCode).toBe(200);
      expect(planRepo.findById('plan_to_delete')).toBeUndefined();
    });
  });
});
