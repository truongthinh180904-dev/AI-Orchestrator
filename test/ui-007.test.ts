/**
 * Acceptance test for UI-007: Pause/Resume/Stop/Approve — Điều khiển backend thật
 * Dependencies: ORC-003, ORC-007
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { buildServer } from '../apps/orchestrator/src/server.js';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  FeatureRepository,
  RunRepository,
  PlanRepository,
  AgentLockRepository,
} from '../packages/db/src/index.js';
import { TaskScheduler } from '../apps/orchestrator/src/services/task-scheduler.js';
import { PlannerService } from '../apps/orchestrator/src/services/planner-service.js';
import { RunService } from '../apps/orchestrator/src/services/run-service.js';
import { ApiClient } from '../apps/dashboard/src/lib/api.js';

describe('UI-007 Acceptance: Pause/Resume/Stop/Approve — Điều khiển backend thật', () => {
  let db: Database.Database;
  let server: FastifyInstance;
  let orchestratorUrl: string;
  let api: ApiClient;

  let taskRepo: TaskRepository;
  let featureRepo: FeatureRepository;
  let runRepo: RunRepository;
  let planRepo: PlanRepository;
  let lockRepo: AgentLockRepository;

  let runService: RunService;
  let taskScheduler: TaskScheduler;
  let plannerService: PlannerService;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);

    taskRepo = new TaskRepository(db);
    featureRepo = new FeatureRepository(db);
    runRepo = new RunRepository(db);
    planRepo = new PlanRepository(db);
    lockRepo = new AgentLockRepository(db);

    runService = new RunService({ db });
    taskScheduler = new TaskScheduler({ db, runService });
    plannerService = new PlannerService({ db, taskScheduler });

    // Seed test feature
    featureRepo.create({
      id: 'FEAT-CTRL',
      name: 'Controls Integration Feature',
      description: 'Feature for UI-007 control operations testing',
      required_tasks: ['TSK-CTRL-01'],
      integration_tests: ['pnpm test'],
      status: 'IN_PROGRESS',
    });

    // Seed test task
    taskRepo.create({
      id: 'TSK-CTRL-01',
      feature_id: 'FEAT-CTRL',
      title: 'Task for scheduler step and pause',
      description: 'Test task',
      phase: 'UI',
      worker_type: 'agy',
      repository: '.',
      scope_files: ['apps/dashboard/src/components/SystemControls.tsx'],
      acceptance_criteria: ['Check pause, resume, stop'],
      test_commands: ['pnpm test'],
      priority: 10,
      max_attempts: 3,
      timeout_minutes: 30,
      status: 'READY',
      attempts: 0,
      dependencies: [],
    });

    // Build and start orchestrator server with real scheduler and planner services
    server = await buildServer({
      db,
      taskScheduler,
      plannerService,
    });

    await server.listen({ port: 0, host: '127.0.0.1' });
    const address = server.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 3000;
    orchestratorUrl = `http://127.0.0.1:${port}`;

    api = new ApiClient({ baseUrl: orchestratorUrl });
  });

  afterEach(async () => {
    if (server) {
      await server.close();
    }
    if (db) {
      db.close();
    }
  });

  // --- Nghiệm thu 1: Pause / Resume điều khiển backend thật ---
  it('Nghiệm thu 1: Pause và Resume Scheduler qua API client với backend Fastify thật', async () => {
    // 1. Initial status: isPaused is false
    const initialStatus = await api.getSchedulerStatus();
    expect(initialStatus.isRunning).toBe(false);
    expect(initialStatus.isPaused).toBe(false);
    expect(initialStatus.readyTasksCount).toBeGreaterThanOrEqual(1);

    // 2. Call POST /api/scheduler/pause
    const pauseResult = await api.pauseScheduler();
    expect(pauseResult.paused).toBe(true);
    expect(pauseResult.isPaused).toBe(true);

    // Verify status persists in backend
    const pausedStatus = await api.getSchedulerStatus();
    expect(pausedStatus.isPaused).toBe(true);

    // When paused, stepScheduler should return executed: false with reason SCHEDULER_PAUSED
    const stepWhenPaused = await api.stepScheduler();
    expect(stepWhenPaused.executed).toBe(false);
    expect(stepWhenPaused.reason).toBe('SCHEDULER_PAUSED');

    // 3. Call POST /api/scheduler/resume
    const resumeResult = await api.resumeScheduler();
    expect(resumeResult.resumed).toBe(true);
    expect(resumeResult.isPaused).toBe(false);

    // Verify status updated in backend
    const resumedStatus = await api.getSchedulerStatus();
    expect(resumedStatus.isPaused).toBe(false);
  });

  // --- Nghiệm thu 2: Stop điều khiển backend thật (Scheduler Stop & Run Stop) ---
  it('Nghiệm thu 2: Stop Scheduler và Stop Run qua API client với backend thật', async () => {
    // 1. Stop scheduler via POST /api/scheduler/stop
    const stopResult = await api.stopScheduler();
    expect(stopResult.stopped).toBe(true);
    expect(stopResult.isRunning).toBe(false);

    // 2. Stop an individual run via POST /api/runs/:id/stop
    runRepo.create({
      id: 'run-ctrl-stop-test',
      task_id: 'TSK-CTRL-01',
      attempt: 1,
      status: 'RUNNING',
      branch: 'dev',
    });

    const stopRunResult = await api.stopRun('run-ctrl-stop-test', {
      reason: 'Emergency operator stop from dashboard',
      force: true,
    });
    expect(stopRunResult.stopped).toBe(true);

    // Verify in DB that run was stopped / cancelled
    const stoppedRun = runRepo.getById('run-ctrl-stop-test');
    expect(stoppedRun).toBeDefined();
    expect(['CANCELLED', 'STOPPED', 'FAILED']).toContain(stoppedRun?.status);
  });

  // --- Nghiệm thu 3: Thẩm định & Phê duyệt Kế hoạch (Approve Plan - ORC-007) ---
  it('Nghiệm thu 3: Phê duyệt Kế hoạch (Approve Plan) cập nhật trạng thái APPROVED trong backend thật', async () => {
    planRepo.create({
      id: 'plan-ctrl-01',
      title: 'Kế hoạch phát triển Controls UI',
      description: 'Mô tả chi tiết kế hoạch',
      feature_id: 'FEAT-CTRL',
      repository: '.',
      status: 'PENDING_APPROVAL',
      tasks: [
        {
          id: 'CTRL-TASK-1',
          title: 'Triển khai SystemControls',
          description: null,
          scope_files: ['apps/dashboard/src/components/SystemControls.tsx'],
          acceptance_criteria: ['Pause/Resume/Stop/Approve'],
          dependencies: [],
          test_commands: ['pnpm test'],
          priority: 1,
          timeout_minutes: 20,
          worker_type: 'agy',
        },
      ],
    });

    // 1. List plans via API
    const plans = await api.listPlans();
    expect(plans.length).toBeGreaterThanOrEqual(1);
    const targetPlan = plans.find((p) => p.id === 'plan-ctrl-01');
    expect(targetPlan).toBeDefined();
    expect(targetPlan?.status).toBe('PENDING_APPROVAL');

    // 2. Check Plan Review Summary before approval
    const reviewBefore = await api.getPlanReview('plan-ctrl-01');
    expect(reviewBefore.is_approved).toBe(false);
    expect(reviewBefore.can_execute).toBe(false);
    expect(reviewBefore.requires_approval).toBe(true);
    expect(reviewBefore.unique_scope_files).toContain('apps/dashboard/src/components/SystemControls.tsx');

    // 3. Approve plan via API client POST /api/plans/:id/approve
    const approvedPlan = await api.approvePlan('plan-ctrl-01', {
      approved_by: 'security-reviewer',
      comments: 'Kiểm toán phạm vi hợp lệ, phê duyệt thực thi',
    });

    expect(approvedPlan.status).toBe('APPROVED');
    expect(approvedPlan.approved_by).toBe('security-reviewer');
    expect(approvedPlan.approved_at).toBeDefined();

    // 4. Verify Plan Review Summary after approval
    const reviewAfter = await api.getPlanReview('plan-ctrl-01');
    expect(reviewAfter.is_approved).toBe(true);
    expect(reviewAfter.can_execute).toBe(true);
    expect(reviewAfter.requires_approval).toBe(false);
  });

  // --- Nghiệm thu 4: Từ chối kế hoạch (Reject Plan) & Gửi lại (Submit Plan) ---
  it('Nghiệm thu 4: Từ chối kế hoạch (Reject) kèm lý do và Gửi lại (Submit for review) qua API', async () => {
    planRepo.create({
      id: 'plan-ctrl-02',
      title: 'Kế hoạch cần từ chối và sửa đổi',
      description: null,
      feature_id: 'FEAT-CTRL',
      repository: '.',
      status: 'PENDING_APPROVAL',
      tasks: [
        {
          id: 'CTRL-TASK-2',
          title: 'Task phạm vi không an toàn',
          description: null,
          scope_files: ['sensitive-config.json'],
          acceptance_criteria: ['Fix config'],
          dependencies: [],
          test_commands: ['pnpm test'],
          priority: 1,
          timeout_minutes: 20,
          worker_type: 'agy',
        },
      ],
    });

    // 1. Reject plan via POST /api/plans/:id/reject
    const rejectedPlan = await api.rejectPlan('plan-ctrl-02', {
      reason: 'Phát hiện file cấu hình nhạy cảm trong phạm vi',
      rejected_by: 'lead-auditor',
    });

    expect(rejectedPlan.status).toBe('REJECTED');
    expect(rejectedPlan.rejection_reason).toBe('Phát hiện file cấu hình nhạy cảm trong phạm vi');

    // 2. Submit back for review via POST /api/plans/:id/submit
    const resubmittedPlan = await api.submitPlanForReview('plan-ctrl-02');
    expect(resubmittedPlan.status).toBe('PENDING_APPROVAL');
  });

  // --- Nghiệm thu 5: Quy tắc cốt lõi: "Chưa duyệt → không thực thi" ---
  it('Nghiệm thu 5: Tuân thủ quy tắc "Chưa duyệt → không thực thi" — Chặn thực thi kế hoạch chưa duyệt', async () => {
    planRepo.create({
      id: 'plan-ctrl-unapproved',
      title: 'Kế hoạch chưa duyệt',
      description: null,
      feature_id: 'FEAT-CTRL',
      repository: '.',
      status: 'PENDING_APPROVAL',
      tasks: [
        {
          id: 'CTRL-TASK-UNAPP',
          title: 'Tác vụ chưa duyệt',
          description: null,
          scope_files: ['test.ts'],
          acceptance_criteria: ['Test'],
          dependencies: [],
          test_commands: ['pnpm test'],
          priority: 1,
          timeout_minutes: 20,
          worker_type: 'agy',
        },
      ],
    });

    // Attempting to execute unapproved plan must fail with PLAN_NOT_APPROVED (HTTP 400)
    let caughtError: unknown = null;
    try {
      await api.executePlan('plan-ctrl-unapproved', { autoStart: true });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).not.toBeNull();
    const appErr = caughtError as { code?: string; message?: string };
    expect(appErr.code).toBe('PLAN_NOT_APPROVED');

    // Now approve plan and verify execution is allowed
    await api.approvePlan('plan-ctrl-unapproved', { approved_by: 'approver' });
    const executeResult = await api.executePlan('plan-ctrl-unapproved');
    expect(executeResult.status).toBe('EXECUTING');
  });

  // --- Nghiệm thu 6: Giải phóng khóa Agent Lock cưỡng bức qua API ---
  it('Nghiệm thu 6: Giải phóng khóa Agent Lock cưỡng bức qua API releaseSchedulerLock', async () => {
    // Seed run first to satisfy foreign key constraint on agent_locks(run_id)
    runRepo.create({
      id: 'run-held-lock',
      task_id: 'TSK-CTRL-01',
      attempt: 1,
      status: 'RUNNING',
      branch: 'dev',
    });

    // Seed agent lock
    lockRepo.acquire({
      id: 'default_agent',
      task_id: 'TSK-CTRL-01',
      run_id: 'run-held-lock',
      owner_pid: 99999,
    });

    const statusWithLock = await api.getSchedulerStatus();
    expect(statusWithLock.activeLock).not.toBeNull();
    expect(statusWithLock.activeLock?.task_id).toBe('TSK-CTRL-01');

    // Call POST /api/scheduler/release-lock
    const releaseResult = await api.releaseSchedulerLock();
    expect(releaseResult.released).toBe(true);

    // Verify lock is cleared
    const statusAfter = await api.getSchedulerStatus();
    expect(statusAfter.activeLock).toBeNull();
  });

  // --- Nghiệm thu 7: Chuyển trạng thái Task (transitionTask & retryTask) ---
  it('Nghiệm thu 7: Điều khiển chuyển đổi trạng thái Task qua API client', async () => {
    // 1. Transition TSK-CTRL-01 from READY to CANCELLED
    const cancelledTask = await api.transitionTask('TSK-CTRL-01', 'CANCELLED', {
      reason: 'Cancelled by operator in dashboard',
    });
    expect(cancelledTask.status).toBe('CANCELLED');

    // 2. Transition from CANCELLED to TODO
    const todoTask = await api.transitionTask('TSK-CTRL-01', 'TODO', {
      reason: 'Requeued by operator',
    });
    expect(todoTask.status).toBe('TODO');

    // 3. Transition from TODO to READY, then RUNNING, then FAILED to test retry
    await api.transitionTask('TSK-CTRL-01', 'READY');
    await api.transitionTask('TSK-CTRL-01', 'RUNNING');
    await api.transitionTask('TSK-CTRL-01', 'FAILED', { reason: 'Simulation failure' });

    // 4. Retry task from FAILED transitions to READY (ORC-004 retry policy)
    const retryResult = await api.retryTask('TSK-CTRL-01', {
      reason: 'Operator retry in dashboard',
      force: true,
    });
    expect(retryResult.retried).toBe(true);
    expect(retryResult.task.status).toBe('READY');
  });
});
