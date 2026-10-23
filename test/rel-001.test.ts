import { describe, expect, it } from 'vitest';
import {
  createDatabase,
  runMigrations,
  FeatureRepository,
  TaskRepository,
} from '../packages/db/src/index.js';
import { FeatureReleaseService } from '../apps/orchestrator/src/services/feature-release-service.js';
import { buildServer } from '../apps/orchestrator/src/server.js';

describe('REL-001: Xác định feature và tập task bắt buộc — Danh sách task thành phần', () => {
  function setupTestEnv() {
    const db = createDatabase(':memory:');
    runMigrations(db);

    const featureRepo = new FeatureRepository(db);
    const taskRepo = new TaskRepository(db);
    const releaseService = new FeatureReleaseService(db);

    return { db, featureRepo, taskRepo, releaseService };
  }

  it('Nghiệm thu 1: Xác định feature và tập task bắt buộc qua required_tasks và task.feature_id', () => {
    const { featureRepo, taskRepo, releaseService } = setupTestEnv();

    featureRepo.create({
      id: 'FEAT-AUTH',
      name: 'Authentication & Authorization',
      description: 'Cơ chế xác thực JWT và phân quyền người dùng',
      required_tasks: ['AUTH-001', 'AUTH-002'],
      integration_tests: ['pnpm test:auth'],
      release_policy: 'require_all_done',
    });

    taskRepo.create({
      id: 'AUTH-001',
      feature_id: 'FEAT-AUTH',
      title: 'Database Schema cho Users & Roles',
      status: 'DONE',
    });

    taskRepo.create({
      id: 'AUTH-002',
      feature_id: 'FEAT-AUTH',
      title: 'JWT Token Service & Middleware',
      status: 'DONE',
    });

    const manifest = releaseService.getComponentTasks('FEAT-AUTH');

    expect(manifest.feature_id).toBe('FEAT-AUTH');
    expect(manifest.feature_name).toBe('Authentication & Authorization');
    expect(manifest.required_task_ids).toEqual(['AUTH-001', 'AUTH-002']);
    expect(manifest.all_task_ids).toEqual(expect.arrayContaining(['AUTH-001', 'AUTH-002']));
    expect(manifest.tasks).toHaveLength(2);
  });

  it('Nghiệm thu 2: Trả về danh sách task thành phần với đầy đủ thuộc tính và metadata', () => {
    const { featureRepo, taskRepo, releaseService } = setupTestEnv();

    featureRepo.create({
      id: 'FEAT-PAYMENT',
      name: 'Payment Integration',
      required_tasks: ['PAY-001'],
    });

    taskRepo.create({
      id: 'PAY-001',
      feature_id: 'FEAT-PAYMENT',
      title: 'Stripe Checkout Integration',
      description: 'Tích hợp checkout session với Stripe API',
      phase: 'integration',
      priority: 25,
      status: 'DONE',
      worker_type: 'agy',
      repository: '.',
      acceptance_criteria: ['Stripe webhook handled', 'Order marked paid'],
      test_commands: ['pnpm test stripe'],
      scope_files: ['src/services/stripe.ts'],
    });

    const manifest = releaseService.getComponentTasks('FEAT-PAYMENT');
    const task = manifest.tasks.find((t) => t.id === 'PAY-001');

    expect(task).toBeDefined();
    expect(task?.title).toBe('Stripe Checkout Integration');
    expect(task?.description).toBe('Tích hợp checkout session với Stripe API');
    expect(task?.phase).toBe('integration');
    expect(task?.priority).toBe(25);
    expect(task?.status).toBe('DONE');
    expect(task?.worker_type).toBe('agy');
    expect(task?.repository).toBe('.');
    expect(task?.acceptance_criteria).toEqual(['Stripe webhook handled', 'Order marked paid']);
    expect(task?.test_commands).toEqual(['pnpm test stripe']);
    expect(task?.scope_files).toEqual(['src/services/stripe.ts']);
    expect(task?.is_required).toBe(true);
  });

  it('Nghiệm thu 3: Phân định rõ task bắt buộc (is_required: true) vs task tùy chọn', () => {
    const { featureRepo, taskRepo, releaseService } = setupTestEnv();

    // Feature chỉ định rõ ràng required_tasks: chỉ có FEAT-REQ là bắt buộc
    featureRepo.create({
      id: 'FEAT-SELECTIVE',
      name: 'Selective Requirements',
      required_tasks: ['FEAT-REQ'],
    });

    taskRepo.create({
      id: 'FEAT-REQ',
      feature_id: 'FEAT-SELECTIVE',
      title: 'Mandatory Core Logic',
      status: 'DONE',
    });

    taskRepo.create({
      id: 'FEAT-OPTIONAL',
      feature_id: 'FEAT-SELECTIVE',
      title: 'Optional Polish & Logging',
      status: 'TODO',
    });

    const manifest = releaseService.getComponentTasks('FEAT-SELECTIVE');
    const reqTask = manifest.tasks.find((t) => t.id === 'FEAT-REQ');
    const optTask = manifest.tasks.find((t) => t.id === 'FEAT-OPTIONAL');

    expect(reqTask?.is_required).toBe(true);
    expect(optTask?.is_required).toBe(false);

    // Khi không có danh sách required_tasks cụ thể: tất cả task gán cho feature đều mặc định là bắt buộc
    featureRepo.create({
      id: 'FEAT-ALL-REQ',
      name: 'All Default Required',
      required_tasks: [],
    });

    taskRepo.create({
      id: 'ALL-1',
      feature_id: 'FEAT-ALL-REQ',
      title: 'Task 1',
      status: 'DONE',
    });

    taskRepo.create({
      id: 'ALL-2',
      feature_id: 'FEAT-ALL-REQ',
      title: 'Task 2',
      status: 'DONE',
    });

    const manifestAll = releaseService.getComponentTasks('FEAT-ALL-REQ');
    expect(manifestAll.tasks.every((t) => t.is_required)).toBe(true);
  });

  it('Nghiệm thu 4: Sắp xếp thứ tự thực thi topo theo đồ thị phụ thuộc (execution_order)', () => {
    const { featureRepo, taskRepo, releaseService } = setupTestEnv();

    featureRepo.create({
      id: 'FEAT-PIPELINE',
      name: 'Data Pipeline',
      required_tasks: ['STEP-1', 'STEP-2', 'STEP-3'],
    });

    // STEP-3 phụ thuộc STEP-2, STEP-2 phụ thuộc STEP-1
    taskRepo.create({
      id: 'STEP-1',
      feature_id: 'FEAT-PIPELINE',
      title: 'Extract raw data',
      status: 'DONE',
    });

    taskRepo.create({
      id: 'STEP-2',
      feature_id: 'FEAT-PIPELINE',
      title: 'Transform data',
      status: 'DONE',
      dependencies: ['STEP-1'],
    });

    taskRepo.create({
      id: 'STEP-3',
      feature_id: 'FEAT-PIPELINE',
      title: 'Load into warehouse',
      status: 'DONE',
      dependencies: ['STEP-2'],
    });

    const manifest = releaseService.getComponentTasks('FEAT-PIPELINE');

    const s1 = manifest.tasks.find((t) => t.id === 'STEP-1')!;
    const s2 = manifest.tasks.find((t) => t.id === 'STEP-2')!;
    const s3 = manifest.tasks.find((t) => t.id === 'STEP-3')!;

    expect(s1.execution_order).toBeLessThan(s2.execution_order);
    expect(s2.execution_order).toBeLessThan(s3.execution_order);
  });

  it('Nghiệm thu 5: Phát hiện và báo cáo task bắt buộc bị thiếu trong DB (missing_task_ids)', () => {
    const { featureRepo, taskRepo, releaseService } = setupTestEnv();

    featureRepo.create({
      id: 'FEAT-DEFECTIVE',
      name: 'Defective Configuration',
      required_tasks: ['EXISTS-TASK', 'NON_EXISTENT_TASK_99'],
    });

    taskRepo.create({
      id: 'EXISTS-TASK',
      feature_id: 'FEAT-DEFECTIVE',
      title: 'Existing Task',
      status: 'DONE',
    });

    const manifest = releaseService.getComponentTasks('FEAT-DEFECTIVE');

    expect(manifest.missing_task_ids).toEqual(['NON_EXISTENT_TASK_99']);
    expect(manifest.summary.missing_count).toBe(1);
    expect(manifest.summary.is_all_required_done).toBe(false);
    expect(manifest.summary.ready_for_release).toBe(false);
  });

  it('Nghiệm thu 6: Thống kê trạng thái và tính toán điều kiện release chính xác', () => {
    const { featureRepo, taskRepo, releaseService } = setupTestEnv();

    featureRepo.create({
      id: 'FEAT-STATS',
      name: 'Status Statistics',
      required_tasks: ['T-DONE', 'T-TODO'],
    });

    taskRepo.create({
      id: 'T-DONE',
      feature_id: 'FEAT-STATS',
      title: 'Completed Task',
      status: 'DONE',
    });

    taskRepo.create({
      id: 'T-TODO',
      feature_id: 'FEAT-STATS',
      title: 'Pending Task',
      status: 'TODO',
    });

    taskRepo.create({
      id: 'T-OPT-FAIL',
      feature_id: 'FEAT-STATS',
      title: 'Optional Failed Task',
      status: 'FAILED',
    });

    const manifest = releaseService.getComponentTasks('FEAT-STATS');

    expect(manifest.summary.total_tasks).toBe(3);
    expect(manifest.summary.required_count).toBe(2);
    expect(manifest.summary.completed_count).toBe(1);
    expect(manifest.summary.pending_count).toBe(1);
    expect(manifest.summary.failed_count).toBe(1);
    expect(manifest.summary.missing_count).toBe(0);
    expect(manifest.summary.is_all_required_done).toBe(false);
    expect(manifest.summary.ready_for_release).toBe(false);

    // Chuyển T-TODO sang DONE
    taskRepo.updateStatus('T-TODO', 'DONE', { reason: 'Verification passed', force: true });
    const updatedManifest = releaseService.getComponentTasks('FEAT-STATS');

    expect(updatedManifest.summary.completed_count).toBe(2);
    expect(updatedManifest.summary.pending_count).toBe(0);
    // Cả 2 task bắt buộc đều DONE => is_all_required_done = true
    expect(updatedManifest.summary.is_all_required_done).toBe(true);
    expect(updatedManifest.summary.ready_for_release).toBe(true);
  });

  it('Nghiệm thu 7: defineFeatureTasks cập nhật required_tasks và gán/gỡ tasks thành công', () => {
    const { featureRepo, taskRepo, releaseService } = setupTestEnv();

    featureRepo.create({
      id: 'FEAT-DYNAMIC',
      name: 'Dynamic Feature Definition',
      required_tasks: ['TASK-1'],
    });

    taskRepo.create({ id: 'TASK-1', title: 'Task 1', status: 'DONE' });
    taskRepo.create({ id: 'TASK-2', title: 'Task 2', status: 'DONE' });
    taskRepo.create({ id: 'TASK-3', title: 'Task 3', status: 'DONE' });

    // Cập nhật tập task bắt buộc gồm TASK-1 và TASK-2, gán TASK-2 và TASK-3 vào feature
    const res1 = releaseService.defineFeatureTasks('FEAT-DYNAMIC', {
      required_tasks: ['TASK-1', 'TASK-2'],
      assign_task_ids: ['TASK-2', 'TASK-3'],
    });

    expect(res1.required_task_ids).toEqual(['TASK-1', 'TASK-2']);
    expect(res1.all_task_ids).toHaveLength(3);
    expect(res1.tasks.find((t) => t.id === 'TASK-2')?.is_required).toBe(true);
    expect(res1.tasks.find((t) => t.id === 'TASK-3')?.is_required).toBe(false);

    // Gỡ TASK-3 khỏi feature
    const res2 = releaseService.defineFeatureTasks('FEAT-DYNAMIC', {
      unassign_task_ids: ['TASK-3'],
    });

    expect(res2.all_task_ids).not.toContain('TASK-3');
    expect(taskRepo.findById('TASK-3')?.feature_id).toBeNull();
  });

  it('Nghiệm thu 8: REST API endpoints truy vấn danh sách task thành phần và cập nhật feature tasks', async () => {
    const { db, featureRepo, taskRepo } = setupTestEnv();

    featureRepo.create({
      id: 'FEAT-API',
      name: 'API Feature',
      required_tasks: ['API-TASK-1'],
    });

    taskRepo.create({
      id: 'API-TASK-1',
      feature_id: 'FEAT-API',
      title: 'First API Task',
      status: 'DONE',
    });

    taskRepo.create({
      id: 'API-TASK-2',
      title: 'Second API Task (Not yet assigned)',
      status: 'DONE',
    });

    const server = await buildServer({ db });

    // 1. GET /features/:id/tasks
    const getRes1 = await server.inject({
      method: 'GET',
      url: '/features/FEAT-API/tasks',
    });
    expect(getRes1.statusCode).toBe(200);
    const body1 = JSON.parse(getRes1.payload);
    expect(body1.data.feature_id).toBe('FEAT-API');
    expect(body1.data.tasks).toHaveLength(1);
    expect(body1.data.tasks[0].id).toBe('API-TASK-1');

    // 2. GET /api/features/:id/manifest
    const getRes2 = await server.inject({
      method: 'GET',
      url: '/api/features/FEAT-API/manifest',
    });
    expect(getRes2.statusCode).toBe(200);
    const body2 = JSON.parse(getRes2.payload);
    expect(body2.data.summary.is_all_required_done).toBe(true);

    // 3. POST /features/:id/tasks (Cập nhật required_tasks và gán API-TASK-2)
    const postRes = await server.inject({
      method: 'POST',
      url: '/features/FEAT-API/tasks',
      payload: {
        required_tasks: ['API-TASK-1', 'API-TASK-2'],
        assign_task_ids: ['API-TASK-2'],
      },
    });
    expect(postRes.statusCode).toBe(200);
    const body3 = JSON.parse(postRes.payload);
    expect(body3.data.required_task_ids).toEqual(['API-TASK-1', 'API-TASK-2']);
    expect(body3.data.tasks).toHaveLength(2);
    expect(body3.data.summary.ready_for_release).toBe(true);

    // 4. Kiểm tra lỗi 404 khi feature không tồn tại
    const notFoundRes = await server.inject({
      method: 'GET',
      url: '/features/FEAT-NOT-FOUND/tasks',
    });
    expect(notFoundRes.statusCode).toBe(404);
  });
});
