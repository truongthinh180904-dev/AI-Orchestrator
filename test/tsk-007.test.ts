import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, runMigrations } from '../packages/db/src/index.js';
import { buildServer } from '../apps/orchestrator/src/server.js';
import { ApiClient } from '../apps/dashboard/src/lib/api.js';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

describe('TSK-007 Acceptance: UI chọn repo + preview import, nút Xác nhận/Hủy — Import được từ UI', () => {
  let db: Database.Database;
  let server: FastifyInstance;
  let serverUrl: string;
  let api: ApiClient;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);

    server = await buildServer({ db, logger: false });
    const address = await server.listen({ port: 0, host: '127.0.0.1' });
    serverUrl = address;
    api = new ApiClient({ baseUrl: serverUrl });
  });

  afterEach(async () => {
    await server.close();
    db.close();
  });

  it('Nghiệm thu: Luồng hoàn chỉnh từ UI — Preview file Excel hợp lệ, xác nhận không ghi DB khi dry-run', async () => {
    const sampleFilePath = path.resolve(process.cwd(), 'fixtures/sample-tasks.xlsx');

    // 1. UI triggers preview (dry-run)
    const preview = await api.previewImport({
      repository: '.',
      filePath: sampleFilePath,
    });

    // Check preview data
    expect(preview.dryRun).toBe(true);
    expect(preview.valid).toBe(true);
    expect(preview.summary.tasksCount).toBeGreaterThan(0);
    expect(preview.summary.featuresCount).toBeGreaterThan(0);
    expect(preview.summary.errorsCount).toBe(0);
    expect(preview.preview.tasks.length).toBeGreaterThan(0);
    expect(preview.preview.features.length).toBeGreaterThan(0);

    // Verify DB remains clean (dry-run does NOT commit)
    const countTasks = db.prepare('SELECT COUNT(*) as count FROM tasks').get() as { count: number };
    expect(countTasks.count).toBe(0);
  });

  it('Nghiệm thu: Luồng hoàn chỉnh từ UI — Bấm Xác nhận Nhập (Commit) nạp thành công tasks và features vào DB', async () => {
    const sampleFilePath = path.resolve(process.cwd(), 'fixtures/sample-tasks.xlsx');

    // 1. UI runs preview
    const preview = await api.previewImport({
      repository: '.',
      filePath: sampleFilePath,
    });
    expect(preview.valid).toBe(true);

    // 2. UI confirms and commits import
    const commitResult = await api.commitImport({
      repository: '.',
      filePath: sampleFilePath,
    });

    expect(commitResult.dryRun).toBe(false);
    expect(commitResult.valid).toBe(true);
    expect(commitResult.imported.tasksCount).toBeGreaterThan(0);
    expect(commitResult.imported.featuresCount).toBeGreaterThan(0);

    // 3. UI retrieves tasks through API and verifies dependencies are linked
    const tasks = await api.getTasks();
    expect(tasks.length).toBeGreaterThanOrEqual(commitResult.imported.tasksCount);

    const task001 = await api.getTask('TSK-001');
    expect(task001.id).toBe('TSK-001');
    expect(task001.dependencies).toContain('FND-003');

    // 4. UI retrieves features through API
    const features = await api.getFeatures();
    expect(features.length).toBeGreaterThanOrEqual(commitResult.imported.featuresCount);
    const featureIds = features.map((f) => f.id);
    expect(featureIds).toContain('FEAT-001');
  });

  it('Nghiệm thu: Dữ liệu lỗi (trùng task_id) — UI preview hiển thị KHÔNG HỢP LỆ và từ chối commit', async () => {
    const invalidCsv = `task_id,title,dependencies,status\nTSK-001,Task One,,TODO\nTSK-001,Task Duplicate,,TODO`;

    // 1. UI runs preview with duplicate task_id
    const preview = await api.previewImport({
      fileContent: invalidCsv,
      filename: 'tasks.csv',
      repository: '.',
    });

    expect(preview.dryRun).toBe(true);
    expect(preview.valid).toBe(false);
    expect(preview.summary.errorsCount).toBeGreaterThan(0);
    expect(preview.report.errors.some((e) => e.code.includes('DUPLICATE'))).toBe(true);

    // 2. UI commit attempt is rejected with AppError
    await expect(
      api.commitImport({
        fileContent: invalidCsv,
        filename: 'tasks.csv',
        repository: '.',
      }),
    ).rejects.toMatchObject({
      code: 'IMPORT_VALIDATION_FAILED',
    });

    // 3. Database is untouched
    const countTasks = db.prepare('SELECT COUNT(*) as count FROM tasks').get() as { count: number };
    expect(countTasks.count).toBe(0);
  });

  it('Nghiệm thu: Dữ liệu chu trình (cycle) — UI preview hiển thị lỗi chu trình và không cho phép commit', async () => {
    const cycleCsv = `task_id,title,dependencies,status\nCYC-A,Cycle A,CYC-B,TODO\nCYC-B,Cycle B,CYC-A,TODO`;

    const preview = await api.previewImport({
      fileContent: cycleCsv,
      filename: 'tasks.csv',
    });

    expect(preview.valid).toBe(false);
    expect(preview.summary.errorsCount).toBeGreaterThan(0);
    const cycleError = preview.report.errors.find((e) => e.code.includes('CIRCULAR'));
    expect(cycleError).toBeDefined();

    // Commit is rejected
    await expect(
      api.commitImport({
        fileContent: cycleCsv,
        filename: 'tasks.csv',
      }),
    ).rejects.toMatchObject({
      code: 'IMPORT_VALIDATION_FAILED',
    });
  });

  it('Nghiệm thu: Upload file qua FormData từ UI — Preview và Commit thành công', async () => {
    const validCsv = `task_id,title,dependencies,status\nUP-001,Uploaded Task 1,,TODO\nUP-002,Uploaded Task 2,UP-001,TODO`;
    const blob = new Blob([validCsv], { type: 'text/csv' });

    // 1. Preview via upload
    const preview = await api.previewImport({
      file: blob,
      filename: 'uploaded.csv',
      repository: '.',
    });

    expect(preview.valid).toBe(true);
    expect(preview.summary.tasksCount).toBe(2);

    // 2. Commit via upload
    const commit = await api.commitImport({
      file: blob,
      filename: 'uploaded.csv',
      repository: '.',
    });

    expect(commit.valid).toBe(true);
    expect(commit.imported.tasksCount).toBe(2);

    const task2 = await api.getTask('UP-002');
    expect(task2.dependencies).toEqual(['UP-001']);
  });
});
