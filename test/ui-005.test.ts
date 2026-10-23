/**
 * Acceptance test for UI-005: Diff viewer — Xem diff thật
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { buildServer } from '../apps/orchestrator/src/server.js';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  FeatureRepository,
} from '../packages/db/src/index.js';
import { ScopeDiffService } from '../apps/orchestrator/src/services/scope-diff-service.js';
import { QualityConfigService } from '../apps/orchestrator/src/services/quality-config-service.js';
import { QualityRunner } from '../apps/orchestrator/src/services/quality-runner.js';
import { ApiClient } from '../apps/dashboard/src/lib/api.js';
import {
  parsePatchLines,
  type ParsedDiffLine,
  type TaskDiffData,
  type ScopeDiffResult,
  type FileDiffDetail,
} from '../packages/shared/src/index.js';

describe('UI-005 Acceptance: Diff viewer — Xem diff thật', () => {
  let db: Database.Database;
  let server: FastifyInstance;
  let orchestratorUrl: string;
  let api: ApiClient;
  let taskRepo: TaskRepository;
  let featureRepo: FeatureRepository;
  let scopeDiffService: ScopeDiffService;
  let testRepoDir: string;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);

    taskRepo = new TaskRepository(db);
    featureRepo = new FeatureRepository(db);

    // Initialize a real temporary git repository
    testRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-005-repo-'));
    execSync('git init -b main', { cwd: testRepoDir, stdio: 'ignore' });
    execSync('git config user.email "worker@ai-orchestrator.local"', { cwd: testRepoDir });
    execSync('git config user.name "AI Worker"', { cwd: testRepoDir });

    // Initial commit
    fs.mkdirSync(path.join(testRepoDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(testRepoDir, 'src', 'index.ts'),
      'export function hello(): string {\n  return "old world";\n}\n',
    );
    fs.writeFileSync(
      path.join(testRepoDir, 'README.md'),
      '# Test Repo\n',
    );
    execSync('git add .', { cwd: testRepoDir });
    execSync('git commit -m "initial commit"', { cwd: testRepoDir, stdio: 'ignore' });

    // Seed feature
    featureRepo.create({
      id: 'FEAT-DIFF',
      name: 'Diff Viewer Feature',
      description: 'Feature for testing UI-005 Diff Viewer',
      required_tasks: ['TSK-UI-DIFF-1'],
      integration_tests: ['pnpm test'],
      status: 'IN_PROGRESS',
    });

    // Seed task with scope_files
    taskRepo.create({
      id: 'TSK-UI-DIFF-1',
      feature_id: 'FEAT-DIFF',
      title: 'Update greeting message',
      description: 'Refactor greeting function in src/index.ts',
      phase: 'UI',
      worker_type: 'agy',
      repository: testRepoDir,
      scope_files: ['src/index.ts'],
      acceptance_criteria: ['Check git diff for updated return value'],
      test_commands: ['pnpm test'],
      priority: 1,
      max_attempts: 3,
      timeout_minutes: 30,
      status: 'VERIFYING',
      attempts: 1,
      dependencies: [],
    });

    const configService = new QualityConfigService({ db });
    const qualityRunner = new QualityRunner({ db, qualityConfigService: configService });
    scopeDiffService = new ScopeDiffService({
      db,
    });

    server = await buildServer({
      db,
      scopeDiffService,
      qualityConfigService: configService,
      qualityRunner,
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
    if (testRepoDir && fs.existsSync(testRepoDir)) {
      fs.rmSync(testRepoDir, { recursive: true, force: true });
    }
  });

  it('Nghiệm thu 1: Xem diff thật — Lấy raw unified diff và metadata tập tin qua API getTaskDiff', async () => {
    // Sửa file trong phạm vi task (src/index.ts)
    fs.writeFileSync(
      path.join(testRepoDir, 'src', 'index.ts'),
      'export function hello(): string {\n  // Refactored message\n  return "new world";\n}\n',
    );

    const diffData: TaskDiffData = await api.getTaskDiff('TSK-UI-DIFF-1');

    expect(diffData.taskId).toBe('TSK-UI-DIFF-1');
    expect(diffData.isScopeClean).toBe(true);
    expect(diffData.outOfScopeFiles).toHaveLength(0);
    expect(diffData.changedFiles).toContain('src/index.ts');
    expect(diffData.fileDiffs).toHaveLength(1);

    const fileDiff = diffData.fileDiffs[0]!;
    expect(fileDiff.path).toBe('src/index.ts');
    expect(fileDiff.inScope).toBe(true);
    expect(fileDiff.status).toBe('modified');
    expect(fileDiff.additions).toBeGreaterThan(0);
    expect(fileDiff.deletions).toBeGreaterThan(0);

    // Kiểm tra raw unified patch thật từ git
    expect(diffData.rawDiff).toContain('diff --git a/src/index.ts b/src/index.ts');
    expect(diffData.rawDiff).toContain('-  return "old world";');
    expect(diffData.rawDiff).toContain('+  return "new world";');

    // Kiểm tra thống kê
    expect(diffData.stats).toBeDefined();
    expect(diffData.stats?.totalChanged).toBe(1);
    expect(diffData.stats?.inScopeCount).toBe(1);
    expect(diffData.stats?.outOfScopeCount).toBe(0);
  });

  it('Nghiệm thu 2: Xem diff thật — Phát hiện file lạ ngoài scope (QLT-003) và đánh dấu rõ ràng', async () => {
    // Tạo file ngoài scope (untracked alien file)
    fs.writeFileSync(
      path.join(testRepoDir, 'unauthorized_script.sh'),
      '#!/bin/bash\necho "injected script"\n',
    );

    // Sửa file trong scope
    fs.writeFileSync(
      path.join(testRepoDir, 'src', 'index.ts'),
      'export function hello(): string {\n  return "updated";\n}\n',
    );

    const diffData: TaskDiffData = await api.getTaskDiff('TSK-UI-DIFF-1');

    expect(diffData.isScopeClean).toBe(false);
    expect(diffData.outOfScopeFiles).toContain('unauthorized_script.sh');
    expect(diffData.changedFiles).toHaveLength(2);

    const alienFile = diffData.fileDiffs.find((f: FileDiffDetail) => f.path === 'unauthorized_script.sh');
    expect(alienFile).toBeDefined();
    expect(alienFile?.inScope).toBe(false);
    expect(alienFile?.patch).toContain('injected script');

    const inScopeFile = diffData.fileDiffs.find((f: FileDiffDetail) => f.path === 'src/index.ts');
    expect(inScopeFile).toBeDefined();
    expect(inScopeFile?.inScope).toBe(true);

    // Kiểm tra API getTaskScopeDiff
    const scopeResult: ScopeDiffResult = await api.getTaskScopeDiff('TSK-UI-DIFF-1');
    expect(scopeResult.isScopeClean).toBe(false);
    expect(scopeResult.outOfScopeFiles).toContain('unauthorized_script.sh');
    expect(scopeResult.stats.outOfScopeCount).toBe(1);
    expect(scopeResult.stats.inScopeCount).toBe(1);
  });

  it('Nghiệm thu 3: Phân tích unified diff thành các dòng có loại (add/delete/chunk) và số dòng tương ứng', async () => {
    fs.writeFileSync(
      path.join(testRepoDir, 'src', 'index.ts'),
      'export function hello(): string {\n  // line 1\n  // line 2\n  return "awesome";\n}\n',
    );

    const diffData = await api.getTaskDiff('TSK-UI-DIFF-1');
    const filePatch = diffData.fileDiffs[0]?.patch ?? '';
    const parsedLines = parsePatchLines(filePatch);

    expect(parsedLines.length).toBeGreaterThan(0);

    const addLines = parsedLines.filter((l: ParsedDiffLine) => l.type === 'add');
    const delLines = parsedLines.filter((l: ParsedDiffLine) => l.type === 'delete');
    const chunkLines = parsedLines.filter((l: ParsedDiffLine) => l.type === 'chunk');

    expect(addLines.length).toBeGreaterThan(0);
    expect(delLines.length).toBeGreaterThan(0);
    expect(chunkLines.length).toBeGreaterThan(0);

    // Kiểm tra dòng thêm có số dòng mới
    expect(addLines[0]?.newLineNumber).toBeDefined();
    // Kiểm tra dòng xóa có số dòng cũ
    expect(delLines[0]?.oldLineNumber).toBeDefined();
    // Dòng chunk bắt đầu bằng @@
    expect(chunkLines[0]?.text).toMatch(/^@@/);
  });

  it('Nghiệm thu 4: API getTaskDiff trả về đúng khi không có thay đổi nào trong git (empty diff)', async () => {
    // Không có thay đổi nào so với commit ban đầu
    const diffData = await api.getTaskDiff('TSK-UI-DIFF-1');

    expect(diffData.changedFiles).toHaveLength(0);
    expect(diffData.fileDiffs).toHaveLength(0);
    expect(diffData.isScopeClean).toBe(true);
    expect(diffData.rawDiff).toBe('');
    expect(diffData.stats?.totalChanged).toBe(0);
  });

  it('Nghiệm thu 5: Gọi compareScopeDiff trực tiếp qua API POST /api/quality/scope-diff', async () => {
    fs.writeFileSync(
      path.join(testRepoDir, 'src', 'index.ts'),
      'export function hello() { return "direct-api"; }\n',
    );

    const result = await api.compareScopeDiff({
      repoPath: testRepoDir,
      scopeFiles: ['src/index.ts'],
    });

    expect(result.isScopeClean).toBe(true);
    expect(result.changedFiles).toContain('src/index.ts');
    expect(result.stats.additions).toBeGreaterThan(0);
  });
});
