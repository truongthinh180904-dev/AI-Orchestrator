import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDatabase, runMigrations } from '../packages/db/src/index.js';
import { buildServer } from '../apps/orchestrator/src/server.js';
import type Database from 'better-sqlite3';

describe('TSK-006 Acceptance Tests: API POST /import (dry-run + commit), GET/PATCH /tasks, GET /features — Test API (inject Fastify)', () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);
    app = await buildServer({ db, logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  // ==========================================
  // 1. POST /import (dry-run)
  // ==========================================
  describe('Nghiệm thu 1: POST /import ở chế độ dry-run', () => {
    it('dry-run với file Excel hợp lệ (fixtures/sample-tasks.xlsx): trả về preview, report hợp lệ và KHÔNG ghi DB', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/import',
        payload: {
          filePath: 'fixtures/sample-tasks.xlsx',
          dryRun: true,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.data).toBeDefined();
      expect(json.data.dryRun).toBe(true);
      expect(json.data.valid).toBe(true);
      expect(json.data.summary.tasksCount).toBeGreaterThan(0);
      expect(json.data.summary.featuresCount).toBeGreaterThan(0);
      expect(json.data.preview.tasks.length).toBeGreaterThan(0);
      expect(json.data.report.valid).toBe(true);

      // Xác nhận DB chưa có bất kỳ task nào được lưu (dry-run không ghi DB)
      const countRow = db.prepare('SELECT COUNT(*) as count FROM tasks').get() as { count: number };
      expect(countRow.count).toBe(0);
    });

    it('dry-run với mode = "dry-run" và dữ liệu CSV hợp lệ', async () => {
      const csvTasks = `id,title,description,dependencies,status\nT-01,Khởi tạo dự án,,,\nT-02,Cài đặt DB,,T-01,TODO`;
      const res = await app.inject({
        method: 'POST',
        url: '/import',
        payload: {
          fileContent: csvTasks,
          filename: 'tasks.csv',
          mode: 'dry-run',
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.data.dryRun).toBe(true);
      expect(json.data.valid).toBe(true);
      expect(json.data.summary.tasksCount).toBe(2);

      const countRow = db.prepare('SELECT COUNT(*) as count FROM tasks').get() as { count: number };
      expect(countRow.count).toBe(0);
    });

    it('dry-run phát hiện lỗi dữ liệu (trùng task_id) và trả về valid: false trong report mà không crash', async () => {
      const csvDuplicate = `id,title,status\nT-01,Task một,TODO\nT-01,Task trùng ID,TODO`;
      const res = await app.inject({
        method: 'POST',
        url: '/import',
        payload: {
          fileContent: csvDuplicate,
          dryRun: true,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.data.dryRun).toBe(true);
      expect(json.data.valid).toBe(false);
      expect(json.data.report.valid).toBe(false);
      expect(json.data.summary.errorsCount).toBeGreaterThanOrEqual(1);

      const dupError = json.data.report.errors.find((e: { code: string }) => e.code === 'DUPLICATE_TASK_ID');
      expect(dupError).toBeDefined();

      // DB vẫn hoàn toàn sạch
      const countRow = db.prepare('SELECT COUNT(*) as count FROM tasks').get() as { count: number };
      expect(countRow.count).toBe(0);
    });

    it('dry-run phát hiện chu trình phụ thuộc (cycle) và báo lỗi trong report', async () => {
      const csvCycle = `id,title,dependencies\nCYC-A,Task A,CYC-B\nCYC-B,Task B,CYC-A`;
      const res = await app.inject({
        method: 'POST',
        url: '/import',
        payload: {
          fileContent: csvCycle,
          mode: 'dry-run',
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.data.dryRun).toBe(true);
      expect(json.data.valid).toBe(false);
      const cycleError = json.data.report.errors.find((e: { code: string }) => e.code === 'CIRCULAR_DEPENDENCY');
      expect(cycleError).toBeDefined();

      const countRow = db.prepare('SELECT COUNT(*) as count FROM tasks').get() as { count: number };
      expect(countRow.count).toBe(0);
    });
  });

  // ==========================================
  // 2. POST /import (commit)
  // ==========================================
  describe('Nghiệm thu 2: POST /import ở chế độ commit (ghi DB atomic)', () => {
    it('commit import thành công từ file Excel: ghi nhận tasks và features vào DB', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/import',
        payload: {
          filePath: 'fixtures/sample-tasks.xlsx',
          mode: 'commit',
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.data.dryRun).toBe(false);
      expect(json.data.valid).toBe(true);
      expect(json.data.imported.tasksCount).toBeGreaterThan(0);
      expect(json.data.imported.featuresCount).toBeGreaterThan(0);
      expect(json.data.tasks.length).toBeGreaterThan(0);
      expect(json.data.features.length).toBeGreaterThan(0);

      // Kiểm tra DB thật
      const taskCount = db.prepare('SELECT COUNT(*) as count FROM tasks').get() as { count: number };
      expect(taskCount.count).toBeGreaterThanOrEqual(json.data.imported.tasksCount);

      const featCount = db.prepare('SELECT COUNT(*) as count FROM features').get() as { count: number };
      expect(featCount.count).toBe(json.data.imported.featuresCount);
    });

    it('commit import từ chối khi dữ liệu có lỗi (trùng task_id) và rollback toàn bộ transaction', async () => {
      const csvDuplicate = `id,title,status\nT-FAIL-1,First,TODO\nT-FAIL-1,Duplicate,TODO`;
      const res = await app.inject({
        method: 'POST',
        url: '/import',
        payload: {
          fileContent: csvDuplicate,
          mode: 'commit',
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error).toBeDefined();
      expect(json.error.code).toBe('IMPORT_VALIDATION_FAILED');
      expect(json.error.context.errors).toBeDefined();

      // DB không có task nào được ghi
      const countRow = db.prepare('SELECT COUNT(*) as count FROM tasks').get() as { count: number };
      expect(countRow.count).toBe(0);
    });

    it('commit import từ chối khi dữ liệu có dependency không tồn tại', async () => {
      const csvMissingDep = `id,title,dependencies\nT-01,Task 1,NON-EXISTENT-XYZ`;
      const res = await app.inject({
        method: 'POST',
        url: '/import',
        payload: {
          fileContent: csvMissingDep,
          mode: 'commit',
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe('IMPORT_VALIDATION_FAILED');

      const countRow = db.prepare('SELECT COUNT(*) as count FROM tasks').get() as { count: number };
      expect(countRow.count).toBe(0);
    });

    it('commit import từ chối khi import task đã tồn tại trong DB (ngăn ghi đè trùng ID)', async () => {
      // 1. Import task ban đầu
      const csvInitial = `id,title,status\nT-EXIST,Initial Task,TODO`;
      const res1 = await app.inject({
        method: 'POST',
        url: '/import',
        payload: { fileContent: csvInitial, mode: 'commit' },
      });
      expect(res1.statusCode).toBe(200);

      // 2. Import lại cùng ID
      const res2 = await app.inject({
        method: 'POST',
        url: '/import',
        payload: { fileContent: csvInitial, mode: 'commit' },
      });
      expect(res2.statusCode).toBe(400);
      const json2 = res2.json();
      expect(json2.error.code).toBe('IMPORT_VALIDATION_FAILED');
    });

    it('commit import từ chối khi không cung cấp nguồn dữ liệu (INVALID_INPUT)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/import',
        payload: { mode: 'commit' },
      });
      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe('INVALID_INPUT');
    });
  });

  // ==========================================
  // 3. GET /tasks
  // ==========================================
  describe('Nghiệm thu 3: GET /tasks (danh sách, filter, search)', () => {
    beforeEach(async () => {
      // Nạp dữ liệu mẫu vào DB
      await app.inject({
        method: 'POST',
        url: '/import',
        payload: {
          filePath: 'fixtures/sample-tasks.xlsx',
          mode: 'commit',
        },
      });
    });

    it('GET /tasks trả về toàn bộ danh sách task kèm dependencies', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/tasks',
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(Array.isArray(json.data)).toBe(true);
      expect(json.data.length).toBeGreaterThan(0);

      const firstTask = json.data[0];
      expect(firstTask).toHaveProperty('id');
      expect(firstTask).toHaveProperty('title');
      expect(firstTask).toHaveProperty('dependencies');
      expect(firstTask).toHaveProperty('status');
      expect(Array.isArray(firstTask.dependencies)).toBe(true);
    });

    it('GET /tasks?status=DONE lọc chính xác các task có trạng thái DONE', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/tasks?status=DONE',
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.data.length).toBeGreaterThan(0);
      for (const t of json.data) {
        expect(t.status).toBe('DONE');
      }
    });

    it('GET /tasks?feature_id=... lọc theo feature_id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/tasks?feature_id=FEAT-001',
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.data.length).toBeGreaterThan(0);
      for (const t of json.data) {
        expect(t.feature_id).toBe('FEAT-001');
      }
    });

    it('GET /tasks?search=... tìm kiếm theo từ khóa trong title/description', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/tasks?search=Schema',
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.data.length).toBeGreaterThanOrEqual(1);
      expect(json.data[0].title).toContain('Schema');
    });

    it('GET /tasks từ chối query status không hợp lệ với VALIDATION_ERROR', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/tasks?status=INVALID_STATUS_XYZ',
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ==========================================
  // 4. GET /tasks/:id
  // ==========================================
  describe('Nghiệm thu 4: GET /tasks/:id', () => {
    beforeEach(async () => {
      await app.inject({
        method: 'POST',
        url: '/import',
        payload: {
          filePath: 'fixtures/sample-tasks.xlsx',
          mode: 'commit',
        },
      });
    });

    it('GET /tasks/TSK-001 trả về thông tin chi tiết task kèm dependencies', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/tasks/TSK-001',
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.data.id).toBe('TSK-001');
      expect(json.data.title).toContain('Schema');
      expect(json.data.dependencies).toContain('FND-003');
    });

    it('GET /tasks/NON-EXISTENT trả về 404 TASK_NOT_FOUND', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/tasks/TASK-DOES-NOT-EXIST',
      });

      expect(res.statusCode).toBe(404);
      const json = res.json();
      expect(json.error.code).toBe('TASK_NOT_FOUND');
      expect(json.error.context.taskId).toBe('TASK-DOES-NOT-EXIST');
    });
  });

  // ==========================================
  // 5. PATCH /tasks/:id và PATCH /tasks
  // ==========================================
  describe('Nghiệm thu 5: PATCH /tasks/:id và PATCH /tasks', () => {
    beforeEach(async () => {
      await app.inject({
        method: 'POST',
        url: '/import',
        payload: {
          filePath: 'fixtures/sample-tasks.xlsx',
          mode: 'commit',
        },
      });
    });

    it('PATCH /tasks/:id cập nhật trạng thái task thành RUNNING', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/tasks/TSK-001',
        payload: {
          status: 'RUNNING',
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.data.id).toBe('TSK-001');
      expect(json.data.status).toBe('RUNNING');

      // Xác minh DB đã lưu
      const verifyRes = await app.inject({ method: 'GET', url: '/tasks/TSK-001' });
      expect(verifyRes.json().data.status).toBe('RUNNING');
    });

    it('PATCH /tasks/:id cập nhật title, priority và acceptance_criteria', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/tasks/TSK-002',
        payload: {
          title: 'Tiêu đề mới cho TSK-002',
          priority: 99,
          acceptance_criteria: ['Nghiệm thu mới 1', 'Nghiệm thu mới 2'],
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.data.title).toBe('Tiêu đề mới cho TSK-002');
      expect(json.data.priority).toBe(99);
      expect(json.data.acceptance_criteria).toEqual(['Nghiệm thu mới 1', 'Nghiệm thu mới 2']);
    });

    it('PATCH /tasks/:id từ chối cập nhật dependency không tồn tại với FOREIGN_KEY_VIOLATION', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/tasks/TSK-001',
        payload: {
          dependencies: ['NON-EXISTENT-TASK-ID'],
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe('FOREIGN_KEY_VIOLATION');
    });

    it('PATCH /tasks/:id từ chối cập nhật tạo chu trình phụ thuộc với CIRCULAR_DEPENDENCY_ERROR', async () => {
      // TSK-002 phụ thuộc TSK-001; thử cập nhật TSK-001 phụ thuộc TSK-002 -> Cycle!
      const res = await app.inject({
        method: 'PATCH',
        url: '/tasks/TSK-001',
        payload: {
          dependencies: ['TSK-002'],
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe('CIRCULAR_DEPENDENCY_ERROR');
    });

    it('PATCH /tasks/:id trả về 404 khi cập nhật task không tồn tại', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/tasks/UNKNOWN-TASK',
        payload: {
          status: 'DONE',
        },
      });

      expect(res.statusCode).toBe(404);
      const json = res.json();
      expect(json.error.code).toBe('TASK_NOT_FOUND');
    });

    it('PATCH /tasks (root path với id trong body) cập nhật thành công', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/tasks',
        payload: {
          id: 'TSK-001',
          priority: 88,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.data.id).toBe('TSK-001');
      expect(json.data.priority).toBe(88);
    });

    it('PATCH /tasks từ chối khi thiếu id trong URL lẫn body với INVALID_INPUT', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/tasks',
        payload: {
          status: 'DONE',
        },
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe('INVALID_INPUT');
    });
  });

  // ==========================================
  // 6. GET /features và GET /features/:id
  // ==========================================
  describe('Nghiệm thu 6: GET /features và GET /features/:id', () => {
    beforeEach(async () => {
      await app.inject({
        method: 'POST',
        url: '/import',
        payload: {
          filePath: 'fixtures/sample-tasks.xlsx',
          mode: 'commit',
        },
      });
    });

    it('GET /features trả về danh sách tất cả features', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/features',
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(Array.isArray(json.data)).toBe(true);
      expect(json.data.length).toBeGreaterThan(0);

      const feat = json.data[0];
      expect(feat).toHaveProperty('id');
      expect(feat).toHaveProperty('name');
      expect(feat).toHaveProperty('status');
      expect(feat).toHaveProperty('required_tasks');
    });

    it('GET /features?status=TODO lọc features theo trạng thái', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/features?status=TODO',
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      for (const f of json.data) {
        expect(f.status).toBe('TODO');
      }
    });

    it('GET /features/:id trả về feature cụ thể', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/features/FEAT-001',
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.data.id).toBe('FEAT-001');
      expect(json.data.name).toBe('Task Management Engine');
    });

    it('GET /features/:id trả về 404 FEATURE_NOT_FOUND khi không tìm thấy', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/features/FEAT-NON-EXISTENT',
      });

      expect(res.statusCode).toBe(404);
      const json = res.json();
      expect(json.error.code).toBe('FEATURE_NOT_FOUND');
    });
  });

  // ==========================================
  // 7. Route /api/* alias và GET /health
  // ==========================================
  describe('Nghiệm thu 7: Các route alias /api/* và Health check', () => {
    it('GET /health trả về status ok', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.status).toBe('ok');
    });

    it('GET /api/tasks hoạt động tương đương GET /tasks', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/tasks' });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json().data)).toBe(true);
    });

    it('GET /api/features hoạt động tương đương GET /features', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/features' });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json().data)).toBe(true);
    });
  });
});
