import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  FeatureRepository,
} from '../packages/db/src/index.js';
import { buildServer } from '../apps/orchestrator/src/server.js';
import { DependencyResolverService } from '../apps/orchestrator/src/services/dependency-resolver-service.js';
import { TaskStateService } from '../apps/orchestrator/src/services/task-state-service.js';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

describe('ORC-002: Dependency Resolver — Danh sách task READY (Chỉ trả task đủ dependency)', () => {
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let featureRepo: FeatureRepository;
  let taskStateService: TaskStateService;
  let resolverService: DependencyResolverService;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    featureRepo = new FeatureRepository(db);
    taskStateService = new TaskStateService(db);
    resolverService = new DependencyResolverService(db);
    app = await buildServer({ db });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  describe('Nghiệm thu 1: Tiêu chí cốt lõi — Chỉ trả task đủ dependency', () => {
    it('chỉ trả về các task mà 100% dependencies đã ở trạng thái DONE', () => {
      // 1. Tạo các root tasks với nhiều trạng thái khác nhau
      taskRepo.create({ id: 'ROOT-DONE-1', title: 'Root Done 1', status: 'DONE' });
      taskRepo.create({ id: 'ROOT-DONE-2', title: 'Root Done 2', status: 'DONE' });
      taskRepo.create({ id: 'ROOT-RUNNING', title: 'Root Running', status: 'RUNNING' });
      taskRepo.create({ id: 'ROOT-TODO', title: 'Root Todo', status: 'TODO' });
      taskRepo.create({ id: 'ROOT-FAILED', title: 'Root Failed', status: 'FAILED' });
      taskRepo.create({ id: 'ROOT-BLOCKED', title: 'Root Blocked', status: 'BLOCKED' });
      taskRepo.create({ id: 'ROOT-PAUSED', title: 'Root Paused', status: 'PAUSED' });
      taskRepo.create({ id: 'ROOT-CANCELLED', title: 'Root Cancelled', status: 'CANCELLED' });

      // 2. Tạo các child tasks phụ thuộc
      // CHILD-READY-1: Phụ thuộc 1 task đã DONE -> ĐỦ ĐIỀU KIỆN
      taskRepo.create({
        id: 'CHILD-READY-1',
        title: 'Child Ready 1',
        status: 'TODO',
        dependencies: ['ROOT-DONE-1'],
      });

      // CHILD-READY-2: Phụ thuộc 2 tasks đều đã DONE -> ĐỦ ĐIỀU KIỆN
      taskRepo.create({
        id: 'CHILD-READY-2',
        title: 'Child Ready 2',
        status: 'READY',
        dependencies: ['ROOT-DONE-1', 'ROOT-DONE-2'],
      });

      // CHILD-NOT-READY-RUNNING: Phụ thuộc task đang RUNNING -> CHƯA ĐỦ
      taskRepo.create({
        id: 'CHILD-NOT-READY-RUNNING',
        title: 'Child Waiting on Running',
        status: 'TODO',
        dependencies: ['ROOT-RUNNING'],
      });

      // CHILD-NOT-READY-TODO: Phụ thuộc task đang TODO -> CHƯA ĐỦ
      taskRepo.create({
        id: 'CHILD-NOT-READY-TODO',
        title: 'Child Waiting on Todo',
        status: 'TODO',
        dependencies: ['ROOT-TODO'],
      });

      // CHILD-NOT-READY-MIXED: Phụ thuộc 1 DONE và 1 RUNNING -> CHƯA ĐỦ
      taskRepo.create({
        id: 'CHILD-NOT-READY-MIXED',
        title: 'Child Waiting on 1 Done and 1 Running',
        status: 'TODO',
        dependencies: ['ROOT-DONE-1', 'ROOT-RUNNING'],
      });

      // CHILD-FAILED-DEP: Phụ thuộc task bị FAILED -> CHƯA ĐỦ
      taskRepo.create({
        id: 'CHILD-FAILED-DEP',
        title: 'Child Blocked by Failed',
        status: 'TODO',
        dependencies: ['ROOT-FAILED'],
      });

      // CHILD-BLOCKED-DEP: Phụ thuộc task bị BLOCKED -> CHƯA ĐỦ
      taskRepo.create({
        id: 'CHILD-BLOCKED-DEP',
        title: 'Child Blocked by Blocked',
        status: 'TODO',
        dependencies: ['ROOT-BLOCKED'],
      });

      // CHILD-PAUSED-DEP: Phụ thuộc task bị PAUSED -> CHƯA ĐỦ
      taskRepo.create({
        id: 'CHILD-PAUSED-DEP',
        title: 'Child Blocked by Paused',
        status: 'TODO',
        dependencies: ['ROOT-PAUSED'],
      });

      // CHILD-CANCELLED-DEP: Phụ thuộc task bị CANCELLED -> CHƯA ĐỦ
      taskRepo.create({
        id: 'CHILD-CANCELLED-DEP',
        title: 'Child Blocked by Cancelled',
        status: 'TODO',
        dependencies: ['ROOT-CANCELLED'],
      });

      // 3. Gọi findReadyTasks()
      const readyTasks = taskRepo.findReadyTasks();
      const readyIds = readyTasks.map((t) => t.id);

      // CÁC TASK HỢP LỆ:
      // ROOT-TODO: không có dependencies, status TODO
      expect(readyIds).toContain('ROOT-TODO');
      // CHILD-READY-1: dependencies là ROOT-DONE-1 (DONE)
      expect(readyIds).toContain('CHILD-READY-1');
      // CHILD-READY-2: dependencies là ROOT-DONE-1, ROOT-DONE-2 (đều DONE)
      expect(readyIds).toContain('CHILD-READY-2');

      // CÁC TASK TUYỆT ĐỐI KHÔNG ĐƯỢC XUẤT HIỆN:
      expect(readyIds).not.toContain('ROOT-DONE-1'); // Đã hoàn thành (DONE)
      expect(readyIds).not.toContain('ROOT-DONE-2'); // Đã hoàn thành (DONE)
      expect(readyIds).not.toContain('ROOT-RUNNING'); // Đang chạy (RUNNING)
      expect(readyIds).not.toContain('ROOT-FAILED'); // Thất bại (FAILED)
      expect(readyIds).not.toContain('ROOT-BLOCKED'); // Bị chặn (BLOCKED)
      expect(readyIds).not.toContain('ROOT-PAUSED'); // Tạm dừng (PAUSED)
      expect(readyIds).not.toContain('ROOT-CANCELLED'); // Đã hủy (CANCELLED)

      expect(readyIds).not.toContain('CHILD-NOT-READY-RUNNING');
      expect(readyIds).not.toContain('CHILD-NOT-READY-TODO');
      expect(readyIds).not.toContain('CHILD-NOT-READY-MIXED');
      expect(readyIds).not.toContain('CHILD-FAILED-DEP');
      expect(readyIds).not.toContain('CHILD-BLOCKED-DEP');
      expect(readyIds).not.toContain('CHILD-PAUSED-DEP');
      expect(readyIds).not.toContain('CHILD-CANCELLED-DEP');

      // 4. KIỂM ĐỊNH BẤT BIẾN: Toàn bộ dependencies của mọi task trong kết quả đều là DONE
      for (const task of readyTasks) {
        for (const depId of task.dependencies) {
          const dep = taskRepo.findById(depId);
          expect(dep).not.toBeNull();
          expect(dep?.status).toBe('DONE');
        }
      }
    });
  });

  describe('Nghiệm thu 2: Tiến trình chuỗi phụ thuộc tuyến tính (Linear Chain: T1 → T2 → T3)', () => {
    it('giải quyết tuần tự từng bước khi các task tiền đề hoàn thành', () => {
      taskRepo.create({ id: 'LIN-1', title: 'Linear Step 1', status: 'TODO' });
      taskRepo.create({ id: 'LIN-2', title: 'Linear Step 2', status: 'TODO', dependencies: ['LIN-1'] });
      taskRepo.create({ id: 'LIN-3', title: 'Linear Step 3', status: 'TODO', dependencies: ['LIN-2'] });

      // Ban đầu: chỉ LIN-1 sẵn sàng
      expect(taskRepo.findReadyTasks().map((t) => t.id)).toEqual(['LIN-1']);

      // LIN-1 chuyển sang READY rồi RUNNING: không có task nào khác sẵn sàng
      taskStateService.markReady('LIN-1');
      taskStateService.markRunning('LIN-1');
      expect(taskRepo.findReadyTasks().map((t) => t.id)).toEqual([]);

      // LIN-1 chuyển sang VERIFYING: LIN-2 vẫn chưa sẵn sàng (vì LIN-1 chưa DONE)
      taskStateService.markVerifying('LIN-1');
      expect(taskRepo.findReadyTasks().map((t) => t.id)).toEqual([]);

      // LIN-1 chuyển sang DONE: LIN-2 lập tức trở thành READY!
      taskStateService.markDone('LIN-1');
      const step2Ready = taskRepo.findReadyTasks();
      expect(step2Ready.map((t) => t.id)).toEqual(['LIN-2']);

      // LIN-2 hoàn thành DONE: LIN-3 lập tức trở thành READY!
      taskStateService.markReady('LIN-2');
      taskStateService.markRunning('LIN-2');
      taskStateService.markVerifying('LIN-2');
      taskStateService.markDone('LIN-2');

      const step3Ready = taskRepo.findReadyTasks();
      expect(step3Ready.map((t) => t.id)).toEqual(['LIN-3']);

      // LIN-3 hoàn thành DONE: không còn task nào cần chạy
      taskStateService.markReady('LIN-3');
      taskStateService.markRunning('LIN-3');
      taskStateService.markVerifying('LIN-3');
      taskStateService.markDone('LIN-3');

      expect(taskRepo.findReadyTasks().map((t) => t.id)).toEqual([]);
    });
  });

  describe('Nghiệm thu 3: Đồ thị kim cương (Diamond: A → (B, C) → D)', () => {
    it('chỉ trả D khi CẢ HAI nhánh B và C đều đã DONE', () => {
      taskRepo.create({ id: 'DIA-A', title: 'Diamond Root A', status: 'TODO' });
      taskRepo.create({ id: 'DIA-B', title: 'Diamond Branch B', status: 'TODO', dependencies: ['DIA-A'] });
      taskRepo.create({ id: 'DIA-C', title: 'Diamond Branch C', status: 'TODO', dependencies: ['DIA-A'] });
      taskRepo.create({
        id: 'DIA-D',
        title: 'Diamond Leaf D',
        status: 'TODO',
        dependencies: ['DIA-B', 'DIA-C'],
      });

      // Giai đoạn 0: chỉ DIA-A sẵn sàng
      expect(taskRepo.findReadyTasks().map((t) => t.id)).toEqual(['DIA-A']);

      // Hoàn thành A -> B và C cùng sẵn sàng, D chưa sẵn sàng
      taskStateService.markReady('DIA-A');
      taskStateService.markRunning('DIA-A');
      taskStateService.markVerifying('DIA-A');
      taskStateService.markDone('DIA-A');

      const readyAfterA = taskRepo.findReadyTasks();
      expect(readyAfterA.map((t) => t.id).sort()).toEqual(['DIA-B', 'DIA-C']);

      // B hoàn tất DONE, nhưng C mới đang RUNNING -> D TUYỆT ĐỐI CHƯA SẴN SÀNG
      taskStateService.markReady('DIA-B');
      taskStateService.markRunning('DIA-B');
      taskStateService.markVerifying('DIA-B');
      taskStateService.markDone('DIA-B');

      taskStateService.markReady('DIA-C');
      taskStateService.markRunning('DIA-C');

      expect(taskRepo.findReadyTasks().map((t) => t.id)).toEqual([]);

      // C hoàn tất VERIFYING rồi DONE -> D LẬP TỨC SẴN SÀNG!
      taskStateService.markVerifying('DIA-C');
      taskStateService.markDone('DIA-C');

      const readyAfterC = taskRepo.findReadyTasks();
      expect(readyAfterC.map((t) => t.id)).toEqual(['DIA-D']);
    });
  });

  describe('Nghiệm thu 4: Sắp xếp ưu tiên (Priority) và Deterministic Order', () => {
    it('sắp xếp danh sách READY theo priority giảm dần, createdAt tăng dần', () => {
      taskRepo.create({
        id: 'PRIO-LOW',
        title: 'Low Priority Task',
        priority: 10,
        status: 'TODO',
        created_at: '2026-10-23T01:00:00.000Z',
      });
      taskRepo.create({
        id: 'PRIO-HIGH',
        title: 'High Priority Task',
        priority: 100,
        status: 'TODO',
        created_at: '2026-10-23T02:00:00.000Z',
      });
      taskRepo.create({
        id: 'PRIO-MID-2',
        title: 'Mid Priority Task 2',
        priority: 50,
        status: 'TODO',
        created_at: '2026-10-23T01:30:00.000Z',
      });
      taskRepo.create({
        id: 'PRIO-MID-1',
        title: 'Mid Priority Task 1',
        priority: 50,
        status: 'TODO',
        created_at: '2026-10-23T01:00:00.000Z',
      });

      const ready = taskRepo.findReadyTasks();
      expect(ready.map((t) => t.id)).toEqual(['PRIO-HIGH', 'PRIO-MID-1', 'PRIO-MID-2', 'PRIO-LOW']);

      // getNextReadyTask() trả về task có priority cao nhất
      const nextTask = resolverService.getNextReadyTask();
      expect(nextTask?.id).toBe('PRIO-HIGH');
    });
  });

  describe('Nghiệm thu 5: Tự động chuyển đổi TODO → READY (Auto-transition & SQLite Transaction)', () => {
    it('resolveAndMarkReady tự động cập nhật trạng thái các task đủ điều kiện sang READY', () => {
      taskRepo.create({ id: 'PARENT-DONE', title: 'Parent Done', status: 'DONE' });
      taskRepo.create({
        id: 'TASK-ELIGIBLE-1',
        title: 'Eligible 1',
        status: 'TODO',
        dependencies: ['PARENT-DONE'],
      });
      taskRepo.create({
        id: 'TASK-ELIGIBLE-2',
        title: 'Eligible 2',
        status: 'TODO',
        dependencies: ['PARENT-DONE'],
      });
      taskRepo.create({
        id: 'TASK-INELIGIBLE',
        title: 'Ineligible',
        status: 'TODO',
        dependencies: ['TASK-ELIGIBLE-1'], // Chưa DONE
      });

      // Chạy resolveAndMarkReady
      const markedReady = taskRepo.resolveAndMarkReady();
      const markedIds = markedReady.map((t) => t.id).sort();

      expect(markedIds).toEqual(['TASK-ELIGIBLE-1', 'TASK-ELIGIBLE-2']);

      // Kiểm tra trực tiếp trong DB
      const inDb1 = taskRepo.findById('TASK-ELIGIBLE-1');
      expect(inDb1?.status).toBe('READY');

      const inDb2 = taskRepo.findById('TASK-ELIGIBLE-2');
      expect(inDb2?.status).toBe('READY');

      const inDbIneligible = taskRepo.findById('TASK-INELIGIBLE');
      expect(inDbIneligible?.status).toBe('TODO'); // Vẫn là TODO
    });
  });

  describe('Nghiệm thu 6: REST API GET /tasks/ready & GET /api/tasks/ready', () => {
    it('trả về HTTP 200 kèm danh sách các task đủ điều kiện dependency', async () => {
      featureRepo.create({ id: 'feat-api', name: 'Feature API' });
      taskRepo.create({ id: 'API-DEP-DONE', title: 'Api Dep Done', status: 'DONE', feature_id: 'feat-api' });
      taskRepo.create({
        id: 'API-TASK-READY',
        title: 'Api Task Ready',
        status: 'TODO',
        feature_id: 'feat-api',
        dependencies: ['API-DEP-DONE'],
      });
      taskRepo.create({
        id: 'API-TASK-NOT-READY',
        title: 'Api Task Not Ready',
        status: 'TODO',
        feature_id: 'feat-api',
        dependencies: ['API-TASK-READY'],
      });

      const res = await app.inject({
        method: 'GET',
        url: '/tasks/ready',
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(Array.isArray(json.data)).toBe(true);

      const ids = json.data.map((t: { id: string }) => t.id);
      expect(ids).toContain('API-TASK-READY');
      expect(ids).not.toContain('API-TASK-NOT-READY');
      expect(ids).not.toContain('API-DEP-DONE');
    });

    it('hỗ trợ query param feature_id và autoTransition=true', async () => {
      featureRepo.create({ id: 'feat-x', name: 'Feature X' });
      featureRepo.create({ id: 'feat-y', name: 'Feature Y' });
      taskRepo.create({ id: 'P-DONE', title: 'Parent Done', status: 'DONE', feature_id: 'feat-x' });
      taskRepo.create({
        id: 'TASK-X',
        title: 'Task X',
        status: 'TODO',
        feature_id: 'feat-x',
        dependencies: ['P-DONE'],
      });
      taskRepo.create({
        id: 'TASK-Y',
        title: 'Task Y',
        status: 'TODO',
        feature_id: 'feat-y',
        dependencies: ['P-DONE'],
      });

      const res = await app.inject({
        method: 'GET',
        url: '/tasks/ready?feature_id=feat-x&autoTransition=true',
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.data.map((t: { id: string }) => t.id)).toEqual(['TASK-X']);

      // Task X đã được tự động chuyển sang READY trong DB
      const taskXInDb = taskRepo.findById('TASK-X');
      expect(taskXInDb?.status).toBe('READY');
    });
  });

  describe('Nghiệm thu 7: REST API GET /tasks/:id/dependency-status', () => {
    it('trả về chi tiết tình trạng dependencies đầy đủ cho 1 task', async () => {
      taskRepo.create({ id: 'DEP-DONE', title: 'Dep Done', status: 'DONE' });
      taskRepo.create({ id: 'DEP-RUN', title: 'Dep Running', status: 'RUNNING' });
      taskRepo.create({
        id: 'TARGET-TASK',
        title: 'Target Task',
        status: 'TODO',
        dependencies: ['DEP-DONE', 'DEP-RUN'],
      });

      const res = await app.inject({
        method: 'GET',
        url: '/tasks/TARGET-TASK/dependency-status',
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.data).toMatchObject({
        taskId: 'TARGET-TASK',
        isReady: false,
        totalDependencies: 2,
        satisfiedDependencies: ['DEP-DONE'],
        unsatisfiedDependencies: [{ id: 'DEP-RUN', status: 'RUNNING' }],
        missingDependencies: [],
      });
      expect(json.data.reason).toContain('DEP-RUN (RUNNING)');
    });

    it('trả về 404 khi truy vấn dependency-status cho task không tồn tại', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/tasks/NON-EXISTENT/dependency-status',
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('Nghiệm thu 8: REST API POST /tasks/resolve-ready', () => {
    it('giải quyết và chuyển đổi các task TODO đủ điều kiện sang READY', async () => {
      taskRepo.create({ id: 'RESOLVE-P-DONE', title: 'Parent Done', status: 'DONE' });
      taskRepo.create({
        id: 'RESOLVE-CHILD-1',
        title: 'Child 1',
        status: 'TODO',
        dependencies: ['RESOLVE-P-DONE'],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/tasks/resolve-ready',
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.data.map((t: { id: string }) => t.id)).toContain('RESOLVE-CHILD-1');

      const childInDb = taskRepo.findById('RESOLVE-CHILD-1');
      expect(childInDb?.status).toBe('READY');
    });
  });

  describe('Nghiệm thu 9: Xử lý task có dependency bị FAILED / BLOCKED', () => {
    it('task có dependency bị FAILED thì không bao giờ được coi là READY', () => {
      taskRepo.create({ id: 'FAILED-PREREQ', title: 'Failed Prereq', status: 'FAILED' });
      taskRepo.create({
        id: 'BLOCKED-CHILD',
        title: 'Blocked Child',
        status: 'TODO',
        dependencies: ['FAILED-PREREQ'],
      });

      const ready = taskRepo.findReadyTasks();
      expect(ready.map((t) => t.id)).not.toContain('BLOCKED-CHILD');

      const status = taskRepo.getDependencyStatus('BLOCKED-CHILD');
      expect(status.isReady).toBe(false);
      expect(status.unsatisfiedDependencies).toEqual([{ id: 'FAILED-PREREQ', status: 'FAILED' }]);
    });
  });
});
