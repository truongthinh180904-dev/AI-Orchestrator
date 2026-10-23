import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  PlanRepository,
  ReportRepository,
  RunRepository,
} from '../packages/db/src/index.js';
import type { ScopeDiffResult } from '../packages/shared/src/index.js';
import { ScopeDiffService } from '../apps/orchestrator/src/services/scope-diff-service.js';
import { QualityConfigService } from '../apps/orchestrator/src/services/quality-config-service.js';
import { QualityRunner } from '../apps/orchestrator/src/services/quality-runner.js';
import { buildServer } from '../apps/orchestrator/src/server.js';

describe('QLT-003 Acceptance Tests: So diff với phạm vi task, liệt kê file ngoài phạm vi — Báo đúng file lạ', () => {
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let planRepo: PlanRepository;
  let reportRepo: ReportRepository;
  let runRepo: RunRepository;
  let configService: QualityConfigService;
  let runner: QualityRunner;
  let scopeDiffService: ScopeDiffService;
  let app: FastifyInstance;
  let testRepoDir: string;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    planRepo = new PlanRepository(db);
    reportRepo = new ReportRepository(db);
    runRepo = new RunRepository(db);

    configService = new QualityConfigService({ db });
    runner = new QualityRunner({ db, qualityConfigService: configService });
    scopeDiffService = new ScopeDiffService({
      db,
    });

    // Khởi tạo một git repository thật để nghiệm thu
    testRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlt-003-repo-'));
    execSync('git init -b main', { cwd: testRepoDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: testRepoDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: testRepoDir, stdio: 'ignore' });

    fs.mkdirSync(path.join(testRepoDir, 'packages', 'db', 'src'), { recursive: true });
    fs.mkdirSync(path.join(testRepoDir, 'packages', 'shared', 'src'), { recursive: true });
    fs.mkdirSync(path.join(testRepoDir, 'apps', 'dashboard', 'src'), { recursive: true });

    fs.writeFileSync(
      path.join(testRepoDir, 'packages', 'db', 'src', 'task-repo.ts'),
      'export class TaskRepository {}\n',
    );
    fs.writeFileSync(
      path.join(testRepoDir, 'packages', 'shared', 'src', 'models.ts'),
      'export interface Task {}\n',
    );
    fs.writeFileSync(
      path.join(testRepoDir, 'apps', 'dashboard', 'src', 'main.ts'),
      'export const dashboardApp = 1;\n',
    );
    execSync('git add . && git commit -m "initial commit"', { cwd: testRepoDir, stdio: 'ignore' });

    app = await buildServer({
      db,
      qualityConfigService: configService,
      qualityRunner: runner,
      scopeDiffService,
    });
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(testRepoDir, { recursive: true, force: true });
  });

  // Tiêu chí 1: Khi chỉ sửa đổi các file trong phạm vi, diff sạch và không có file lạ
  it('Nghiệm thu 1: So diff trong phạm vi cho kết quả clean và không báo file lạ', async () => {
    taskRepo.create({
      id: 'TASK-IN-SCOPE',
      title: 'Task In Scope',
      repository: testRepoDir,
      scope_files: ['packages/db/src/task-repo.ts'],
    });

    // Chỉ sửa file được phép trong scope
    fs.writeFileSync(
      path.join(testRepoDir, 'packages', 'db', 'src', 'task-repo.ts'),
      'export class TaskRepository { public find() {} }\n',
    );

    const result = await scopeDiffService.checkTaskScope('TASK-IN-SCOPE');

    expect(result.isScopeClean).toBe(true);
    expect(result.outOfScopeFiles).toEqual([]);
    expect(result.inScopeFiles).toEqual(['packages/db/src/task-repo.ts']);
    expect(result.stats.outOfScopeCount).toBe(0);
    expect(result.stats.inScopeCount).toBe(1);
  });

  // Tiêu chí 2: Cốt lõi của QLT-003: "Báo đúng file lạ" khi sửa file ngoài phạm vi
  it('Nghiệm thu 2: Báo đúng file lạ khi chỉnh sửa file hiện hữu ngoài phạm vi', async () => {
    taskRepo.create({
      id: 'TASK-MOD-ALIEN',
      title: 'Task modifying alien files',
      repository: testRepoDir,
      scope_files: ['packages/db/src/task-repo.ts'],
    });

    // Sửa file hợp lệ
    fs.writeFileSync(
      path.join(testRepoDir, 'packages', 'db', 'src', 'task-repo.ts'),
      'export class TaskRepository { public save() {} }\n',
    );

    // Sửa file ngoài phạm vi (file lạ 1)
    fs.writeFileSync(
      path.join(testRepoDir, 'packages', 'shared', 'src', 'models.ts'),
      'export interface Task { id: string; }\n',
    );

    // Sửa file ngoài phạm vi (file lạ 2)
    fs.writeFileSync(
      path.join(testRepoDir, 'apps', 'dashboard', 'src', 'main.ts'),
      'export const dashboardApp = 99;\n',
    );

    const result = await scopeDiffService.checkTaskScope('TASK-MOD-ALIEN');

    expect(result.isScopeClean).toBe(false);
    // Báo chính xác 2 file lạ
    expect(result.outOfScopeFiles).toEqual([
      'apps/dashboard/src/main.ts',
      'packages/shared/src/models.ts',
    ]);
    expect(result.inScopeFiles).toEqual(['packages/db/src/task-repo.ts']);
    expect(result.stats.outOfScopeCount).toBe(2);
    expect(result.stats.inScopeCount).toBe(1);
    expect(result.stats.totalChanged).toBe(3);
  });

  // Tiêu chí 3: "Báo đúng file lạ" khi tạo thêm file mới chưa track (untracked alien file)
  it('Nghiệm thu 3: Báo đúng file lạ khi xuất hiện file mới untracked ngoài phạm vi', async () => {
    taskRepo.create({
      id: 'TASK-UNTRACKED-ALIEN',
      title: 'Task creating untracked alien file',
      repository: testRepoDir,
      scope_files: ['packages/db/src/task-repo.ts'],
    });

    // Tạo file mới hoàn toàn ngoài phạm vi
    fs.writeFileSync(
      path.join(testRepoDir, 'secret_credentials.env'),
      'API_KEY=123456789\n',
    );

    const result = await scopeDiffService.checkTaskScope('TASK-UNTRACKED-ALIEN');

    expect(result.isScopeClean).toBe(false);
    expect(result.outOfScopeFiles).toEqual(['secret_credentials.env']);
    expect(result.stats.outOfScopeCount).toBe(1);
  });

  // Tiêu chí 4: Hỗ trợ scope patterns dạng directory prefix và wildcard glob
  it('Nghiệm thu 4: Hỗ trợ pattern wildcard và chỉ báo đúng file không khớp pattern', async () => {
    taskRepo.create({
      id: 'TASK-WILDCARD',
      title: 'Task with wildcard scope',
      repository: testRepoDir,
      scope_files: ['packages/db/**', 'apps/dashboard/**'],
    });

    // Sửa file trong packages/db/** -> hợp lệ
    fs.writeFileSync(
      path.join(testRepoDir, 'packages', 'db', 'src', 'task-repo.ts'),
      '// updated db repo\n',
    );

    // Sửa file trong apps/dashboard/main.ts -> hợp lệ
    fs.writeFileSync(
      path.join(testRepoDir, 'apps', 'dashboard', 'src', 'main.ts'),
      '// updated dashboard\n',
    );

    // Sửa file trong packages/shared -> không thuộc pattern -> file lạ!
    fs.writeFileSync(
      path.join(testRepoDir, 'packages', 'shared', 'src', 'models.ts'),
      '// alien edit in shared\n',
    );

    const result = await scopeDiffService.checkTaskScope('TASK-WILDCARD');

    expect(result.isScopeClean).toBe(false);
    expect(result.outOfScopeFiles).toEqual(['packages/shared/src/models.ts']);
    expect(result.inScopeFiles).toEqual([
      'apps/dashboard/src/main.ts',
      'packages/db/src/task-repo.ts',
    ]);
  });

  // Tiêu chí 5: REST API POST /api/quality/scope-diff
  it('Nghiệm thu 5: API POST /api/quality/scope-diff nhận scopeFiles tùy chỉnh và báo đúng file lạ', async () => {
    // Sửa file trong test repo
    fs.writeFileSync(
      path.join(testRepoDir, 'packages', 'db', 'src', 'task-repo.ts'),
      '// changed\n',
    );
    fs.writeFileSync(
      path.join(testRepoDir, 'unauthorized-file.txt'),
      'unauthorized\n',
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/quality/scope-diff',
      payload: {
        repoPath: testRepoDir,
        scopeFiles: ['packages/db/src/task-repo.ts'],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const data = body.data as ScopeDiffResult;

    expect(data.isScopeClean).toBe(false);
    expect(data.outOfScopeFiles).toEqual(['unauthorized-file.txt']);
    expect(data.inScopeFiles).toEqual(['packages/db/src/task-repo.ts']);
  });

  // Tiêu chí 6: REST API GET /api/tasks/:id/scope-diff
  it('Nghiệm thu 6: API GET /api/tasks/:id/scope-diff tự động đối chiếu task scope từ DB và báo đúng file lạ', async () => {
    taskRepo.create({
      id: 'TASK-API-SCOPE',
      title: 'API Task Scope Verification',
      repository: testRepoDir,
      scope_files: ['packages/db/src/task-repo.ts'],
    });

    fs.writeFileSync(
      path.join(testRepoDir, 'alien-change.js'),
      'console.log("alien");\n',
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/tasks/TASK-API-SCOPE/scope-diff',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const data = body.data as ScopeDiffResult;

    expect(data.taskId).toBe('TASK-API-SCOPE');
    expect(data.isScopeClean).toBe(false);
    expect(data.outOfScopeFiles).toEqual(['alien-change.js']);
  });

  // Tiêu chí 7: REST API GET /api/tasks/:id/diff trả về unified diff cho Diff Viewer (UI-005)
  it('Nghiệm thu 7: API GET /api/tasks/:id/diff cung cấp đầy đủ diff thống kê và raw patch cho UI Diff Viewer', async () => {
    taskRepo.create({
      id: 'TASK-DIFF-VIEW',
      title: 'Task for Diff Viewer',
      repository: testRepoDir,
      scope_files: ['packages/db/src/task-repo.ts'],
    });

    fs.writeFileSync(
      path.join(testRepoDir, 'packages', 'db', 'src', 'task-repo.ts'),
      'export class TaskRepository {\n  public newMethod() {}\n}\n',
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/tasks/TASK-DIFF-VIEW/diff',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const data = body.data;

    expect(data.taskId).toBe('TASK-DIFF-VIEW');
    expect(data.rawDiff).toContain('diff --git');
    expect(data.rawDiff).toContain('newMethod');
    expect(data.fileDiffs).toHaveLength(1);
    expect(data.fileDiffs[0].path).toBe('packages/db/src/task-repo.ts');
    expect(data.fileDiffs[0].inScope).toBe(true);
  });

  // Tiêu chí 8: Lưu bản ghi kiểm toán scope_diff vào bảng reports của SQLite khi có runId
  it('Nghiệm thu 8: Tự động lưu bản ghi scope_diff vào bảng reports SQLite làm bằng chứng nghiệm thu', async () => {
    taskRepo.create({
      id: 'TASK-AUDIT',
      title: 'Audit Task',
      repository: testRepoDir,
      scope_files: ['packages/db/src/task-repo.ts'],
    });

    const run = runRepo.create({
      id: 'RUN-AUDIT-1',
      task_id: 'TASK-AUDIT',
      attempt: 1,
      status: 'RUNNING',
    });

    fs.writeFileSync(
      path.join(testRepoDir, 'sneaky.sh'),
      '#!/bin/bash\necho "secret"\n',
    );

    const result = await scopeDiffService.checkTaskScope('TASK-AUDIT', {
      runId: run.id,
    });

    expect(result.isScopeClean).toBe(false);
    expect(result.outOfScopeFiles).toEqual(['sneaky.sh']);

    // Xác nhận bản ghi report trong SQLite
    const reports = reportRepo.findByRunId(run.id, { kind: 'scope_diff' });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.kind).toBe('scope_diff');

    const content = JSON.parse(reports[0]!.content);
    expect(content.taskId).toBe('TASK-AUDIT');
    expect(content.outOfScopeFiles).toEqual(['sneaky.sh']);
    expect(content.isScopeClean).toBe(false);
  });
});
