import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import {
  createDatabase,
  runMigrations,
  PlanRepository,
} from '../packages/db/src/index.js';
import {
  buildServer,
  PlannerService,
  PlanReviewService,
} from '../apps/orchestrator/src/index.js';
import {
  AppError,
  assertPlanApproved,
} from '../packages/shared/src/index.js';

describe('ORC-007 Acceptance Tests: Chế độ review: plan chờ approve mới chạy — Chưa duyệt → không thực thi', () => {
  let db: Database.Database;
  let server: FastifyInstance;
  let planRepo: PlanRepository;
  let plannerService: PlannerService;
  let reviewService: PlanReviewService;

  const standardTasks = [
    {
      id: 'TASK-001',
      title: 'Database Schema Migration',
      description: 'Setup SQLite tables',
      scope_files: ['packages/db/migrations/005_feature.sql'],
      acceptance_criteria: ['Migration applies cleanly'],
      dependencies: [],
      test_commands: ['pnpm test packages/db'],
      priority: 1,
      timeout_minutes: 15,
      worker_type: 'agy',
    },
    {
      id: 'TASK-002',
      title: 'Domain Model Implementation',
      description: 'Write domain entities and zod schemas',
      scope_files: ['packages/shared/src/models/feature.ts'],
      acceptance_criteria: ['Passes zod validation'],
      dependencies: ['TASK-001'],
      test_commands: ['pnpm test packages/shared'],
      priority: 2,
      timeout_minutes: 20,
      worker_type: 'agy',
    },
    {
      id: 'TASK-003',
      title: 'REST API & Controller',
      description: 'Expose endpoints for feature',
      scope_files: ['apps/orchestrator/src/routes/features.ts'],
      acceptance_criteria: ['Endpoints return 200 with valid payload'],
      dependencies: ['TASK-002'],
      test_commands: ['pnpm test apps/orchestrator'],
      priority: 0,
      timeout_minutes: 25,
      worker_type: 'agy',
    },
  ];

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);
    planRepo = new PlanRepository(db);

    plannerService = new PlannerService({
      db,
      config: {
        AGY_BIN: process.execPath,
      },
    });
    reviewService = plannerService.getReviewService();

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

  function createTestPlan(status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'EXECUTING' = 'PENDING_APPROVAL') {
    return planRepo.create({
      title: 'Review Mode Feature Plan',
      description: 'Acceptance testing plan review workflow',
      repository: '.',
      status,
      tasks: standardTasks,
    });
  }

  describe('Tiêu chí 1: Chế độ review kế hoạch (Review mode inspection & revision)', () => {
    it('1.1: Kế hoạch mới sinh mặc định ở trạng thái PENDING_APPROVAL, chưa duyệt và chưa thể thực thi', async () => {
      const plan = createTestPlan('PENDING_APPROVAL');

      const res = await server.inject({
        method: 'GET',
        url: `/plans/${plan.id}`,
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.data.status).toBe('PENDING_APPROVAL');
      expect(json.data.approved_at).toBeNull();
      expect(json.data.approved_by).toBeNull();
      expect(json.data.rejection_reason).toBeNull();
    });

    it('1.2: GET /plans/:id/review trả về tóm tắt phân tích DAG topo, các tầng song song, scope files và cảnh báo', async () => {
      const plan = createTestPlan('PENDING_APPROVAL');

      const res = await server.inject({
        method: 'GET',
        url: `/plans/${plan.id}/review`,
      });

      expect(res.statusCode).toBe(200);
      const review = res.json().data;

      expect(review.status).toBe('PENDING_APPROVAL');
      expect(review.is_approved).toBe(false);
      expect(review.can_execute).toBe(false);
      expect(review.requires_approval).toBe(true);
      expect(review.total_tasks).toBe(3);
      expect(review.total_estimated_minutes).toBe(60); // 15 + 20 + 25

      // DAG topological order must strictly obey dependencies
      expect(review.execution_order).toEqual(['TASK-001', 'TASK-002', 'TASK-003']);
      expect(review.stages).toEqual([['TASK-001'], ['TASK-002'], ['TASK-003']]);
      expect(review.unique_scope_files).toEqual([
        'apps/orchestrator/src/routes/features.ts',
        'packages/db/migrations/005_feature.sql',
        'packages/shared/src/models/feature.ts',
      ]);
    });

    it('1.3: Chỉnh sửa kế hoạch trong review mode PATCH /plans/:id cập nhật nội dung thành công', async () => {
      const plan = createTestPlan('PENDING_APPROVAL');

      const res = await server.inject({
        method: 'PATCH',
        url: `/plans/${plan.id}`,
        payload: {
          title: 'Updated Architecture Plan',
          description: 'Updated architectural details by reviewer',
        },
      });

      expect(res.statusCode).toBe(200);
      const updated = res.json().data;
      expect(updated.title).toBe('Updated Architecture Plan');
      expect(updated.description).toBe('Updated architectural details by reviewer');
    });

    it('1.4: Chặn các chỉnh sửa task vi phạm DAG (chu trình phụ thuộc) và trả về HTTP 400', async () => {
      const plan = createTestPlan('PENDING_APPROVAL');

      const res = await server.inject({
        method: 'PATCH',
        url: `/plans/${plan.id}`,
        payload: {
          tasks: [
            {
              id: 'A',
              title: 'Step A',
              scope_files: ['a.ts'],
              acceptance_criteria: ['A done'],
              dependencies: ['B'],
            },
            {
              id: 'B',
              title: 'Step B',
              scope_files: ['b.ts'],
              acceptance_criteria: ['B done'],
              dependencies: ['A'],
            },
          ],
        },
      });

      expect(res.statusCode).toBe(400);
      const error = res.json().error;
      expect(error.code).toBe('PLAN_DEPENDENCY_CYCLE');
      expect(error.message).toContain('cycle');
    });

    it('1.5: POST /plans/:id/reject từ chối kế hoạch kèm lý do bắt buộc và cập nhật REJECTED', async () => {
      const plan = createTestPlan('PENDING_APPROVAL');

      const res = await server.inject({
        method: 'POST',
        url: `/plans/${plan.id}/reject`,
        payload: {
          reason: 'Need to add security scanning step before deployment',
          rejected_by: 'security_auditor',
        },
      });

      expect(res.statusCode).toBe(200);
      const rejected = res.json().data;
      expect(rejected.status).toBe('REJECTED');
      expect(rejected.rejection_reason).toBe('Need to add security scanning step before deployment');
      expect(rejected.approved_at).toBeNull();
      expect(rejected.approved_by).toBeNull();

      // Check DB persistence
      const inDb = planRepo.findById(plan.id);
      expect(inDb?.status).toBe('REJECTED');
      expect(inDb?.rejection_reason).toBe('Need to add security scanning step before deployment');
    });

    it('1.6: POST /plans/:id/reject từ chối nếu thiếu lý do (empty reason) trả về HTTP 400', async () => {
      const plan = createTestPlan('PENDING_APPROVAL');

      const res = await server.inject({
        method: 'POST',
        url: `/plans/${plan.id}/reject`,
        payload: {
          reason: '',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('1.7: POST /plans/:id/submit gửi lại kế hoạch review chuyển từ REJECTED về PENDING_APPROVAL', async () => {
      const plan = createTestPlan('REJECTED');
      planRepo.update(plan.id, { rejection_reason: 'Previous flaw' });

      const res = await server.inject({
        method: 'POST',
        url: `/plans/${plan.id}/submit`,
      });

      expect(res.statusCode).toBe(200);
      const resubmitted = res.json().data;
      expect(resubmitted.status).toBe('PENDING_APPROVAL');
      expect(resubmitted.rejection_reason).toBeNull();
    });
  });

  describe('Tiêu chí 2: Nghiệm thu cốt lõi: "Chưa duyệt → không thực thi"', () => {
    it('2.1: Chặn thực thi kế hoạch PENDING_APPROVAL qua API: POST /plans/:id/execute trả về HTTP 400 PLAN_NOT_APPROVED', async () => {
      const plan = createTestPlan('PENDING_APPROVAL');

      const res = await server.inject({
        method: 'POST',
        url: `/plans/${plan.id}/execute`,
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe('PLAN_NOT_APPROVED');
      expect(json.error.message).toContain(`Plan '${plan.id}' is not approved (current status: 'PENDING_APPROVAL')`);
      expect(json.error.context.status).toBe('PENDING_APPROVAL');
    });

    it('2.2: Chặn thực thi kế hoạch REJECTED qua API: POST /plans/:id/execute trả về HTTP 400 PLAN_NOT_APPROVED', async () => {
      const plan = createTestPlan('REJECTED');

      const res = await server.inject({
        method: 'POST',
        url: `/plans/${plan.id}/execute`,
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe('PLAN_NOT_APPROVED');
      expect(json.error.message).toContain(`Plan '${plan.id}' is not approved (current status: 'REJECTED')`);
      expect(json.error.context.status).toBe('REJECTED');
    });

    it('2.3: Chặn thực thi kế hoạch DRAFT qua API: POST /plans/:id/execute trả về HTTP 400 PLAN_NOT_APPROVED', async () => {
      const plan = createTestPlan('DRAFT');

      const res = await server.inject({
        method: 'POST',
        url: `/plans/${plan.id}/execute`,
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe('PLAN_NOT_APPROVED');
      expect(json.error.context.status).toBe('DRAFT');
    });

    it('2.4: assertPlanApproved ném ngoại lệ AppError("PLAN_NOT_APPROVED") cho kế hoạch chưa duyệt', () => {
      const unapprovedPlan = createTestPlan('PENDING_APPROVAL');

      expect(() => assertPlanApproved(unapprovedPlan)).toThrowError(AppError);
      try {
        assertPlanApproved(unapprovedPlan);
      } catch (err: unknown) {
        const error = err as AppError;
        expect(error.code).toBe('PLAN_NOT_APPROVED');
        expect(error.context).toEqual({
          planId: unapprovedPlan.id,
          status: 'PENDING_APPROVAL',
        });
      }
    });

    it('2.5: ReviewService.executePlan ném PLAN_NOT_APPROVED khi gọi trực tiếp trên kế hoạch chưa duyệt', () => {
      const plan = createTestPlan('PENDING_APPROVAL');

      expect(() => reviewService.executePlan(plan.id)).toThrowError(/not approved/);
      try {
        reviewService.executePlan(plan.id);
      } catch (err: unknown) {
        expect((err as AppError).code).toBe('PLAN_NOT_APPROVED');
      }
    });
  });

  describe('Tiêu chí 3: Phê duyệt kế hoạch (Approve) và cho phép thực thi sau khi duyệt', () => {
    it('3.1: POST /plans/:id/approve phê duyệt kế hoạch, thiết lập status APPROVED, approved_by, approved_at', async () => {
      const plan = createTestPlan('PENDING_APPROVAL');

      const res = await server.inject({
        method: 'POST',
        url: `/plans/${plan.id}/approve`,
        payload: {
          approved_by: 'lead_architect',
          comments: 'Approved after architecture review',
        },
      });

      expect(res.statusCode).toBe(200);
      const approved = res.json().data;
      expect(approved.status).toBe('APPROVED');
      expect(approved.approved_by).toBe('lead_architect');
      expect(approved.approved_at).toBeDefined();
      expect(approved.rejection_reason).toBeNull();

      // Verify DB persistence
      const inDb = planRepo.findById(plan.id);
      expect(inDb?.status).toBe('APPROVED');
      expect(inDb?.approved_by).toBe('lead_architect');
    });

    it('3.2: POST /plans/:id/approve hỗ trợ áp dụng chỉnh sửa đồng thời khi duyệt', async () => {
      const plan = createTestPlan('PENDING_APPROVAL');

      const res = await server.inject({
        method: 'POST',
        url: `/plans/${plan.id}/approve`,
        payload: {
          approved_by: 'tech_lead',
          edits: {
            title: 'Approved With Edits Title',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const approved = res.json().data;
      expect(approved.status).toBe('APPROVED');
      expect(approved.title).toBe('Approved With Edits Title');
    });

    it('3.3: Sau khi duyệt, GET /plans/:id/review trả về is_approved = true và can_execute = true', async () => {
      const plan = createTestPlan('PENDING_APPROVAL');

      // Approve plan
      await server.inject({
        method: 'POST',
        url: `/plans/${plan.id}/approve`,
        payload: { approved_by: 'lead_architect' },
      });

      const res = await server.inject({
        method: 'GET',
        url: `/plans/${plan.id}/review`,
      });

      expect(res.statusCode).toBe(200);
      const review = res.json().data;
      expect(review.is_approved).toBe(true);
      expect(review.can_execute).toBe(true);
      expect(review.requires_approval).toBe(false);
    });

    it('3.4: Kế hoạch đã APPROVED thực thi thành công qua POST /plans/:id/execute: chuyển sang EXECUTING', async () => {
      const plan = createTestPlan('APPROVED');

      const res = await server.inject({
        method: 'POST',
        url: `/plans/${plan.id}/execute`,
      });

      expect(res.statusCode).toBe(200);
      const result = res.json().data;
      expect(result.status).toBe('EXECUTING');
      expect(result.plan.status).toBe('EXECUTING');
      expect(result.executionOrder).toEqual(['TASK-001', 'TASK-002', 'TASK-003']);

      // Check DB
      const inDb = planRepo.findById(plan.id);
      expect(inDb?.status).toBe('EXECUTING');
    });

    it('3.5: Khi sửa đổi tasks trên kế hoạch đã APPROVED, hệ thống tự động reset về PENDING_APPROVAL yêu cầu duyệt lại', async () => {
      const plan = createTestPlan('APPROVED');

      const res = await server.inject({
        method: 'PATCH',
        url: `/plans/${plan.id}`,
        payload: {
          tasks: [
            {
              id: 'TASK-REV-1',
              title: 'Revised Task',
              scope_files: ['revised.ts'],
              acceptance_criteria: ['Tested'],
              dependencies: [],
            },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const updated = res.json().data;
      expect(updated.status).toBe('PENDING_APPROVAL');
      expect(updated.approved_at).toBeNull();
      expect(updated.approved_by).toBeNull();

      // Calling execute again must fail because it's back to unapproved!
      const execRes = await server.inject({
        method: 'POST',
        url: `/plans/${plan.id}/execute`,
      });
      expect(execRes.statusCode).toBe(400);
      expect(execRes.json().error.code).toBe('PLAN_NOT_APPROVED');
    });
  });
});
