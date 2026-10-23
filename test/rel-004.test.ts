import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import {
  createDatabase,
  runMigrations,
  FeatureRepository,
  TaskRepository,
  RunRepository,
  QualityGateRepository,
  FeatureReleaseRepository,
} from '../packages/db/src/index.js';
import { FeatureReleaseService } from '../apps/orchestrator/src/services/feature-release-service.js';
import { FeatureService } from '../apps/orchestrator/src/services/feature-service.js';
import { TaskService } from '../apps/orchestrator/src/services/task-service.js';
import { buildServer } from '../apps/orchestrator/src/server.js';
import {
  AppError,
  QualityGatePolicySchema,
  QualityGateEvidenceSummarySchema,
  gitCommit,
  gitGetCommitDetails,
  formatConventionalCommit,
  validateConventionalCommit,
  isConventionalCommit,
  CONVENTIONAL_COMMIT_TYPES,
} from '../packages/shared/src/index.js';

describe('REL-004: Commit chuẩn hóa, lưu SHA', () => {
  let tmpGitDir: string;

  beforeEach(() => {
    tmpGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel004-acceptance-'));
    execSync('git init -b main', { cwd: tmpGitDir, stdio: 'ignore' });
    execSync('git config user.email "orchestrator@ai.local"', { cwd: tmpGitDir, stdio: 'ignore' });
    execSync('git config user.name "AI Orchestrator"', { cwd: tmpGitDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpGitDir, 'README.md'), '# AI Orchestrator Release Test\n');
    execSync('git add . && git commit -m "chore: initial release base commit"', {
      cwd: tmpGitDir,
      stdio: 'ignore',
    });
  });

  afterEach(() => {
    if (tmpGitDir && fs.existsSync(tmpGitDir)) {
      fs.rmSync(tmpGitDir, { recursive: true, force: true });
    }
  });

  function setupTestEnv() {
    const db = createDatabase(':memory:');
    runMigrations(db);

    const featureRepo = new FeatureRepository(db);
    const taskRepo = new TaskRepository(db);
    const runRepo = new RunRepository(db);
    const qgRepo = new QualityGateRepository(db);
    const releaseRepo = new FeatureReleaseRepository(db);

    const releaseService = new FeatureReleaseService(db);
    const featureService = new FeatureService(db, { releaseService });
    const taskService = new TaskService(db);

    function seedQGPass(taskId: string) {
      return qgRepo.create({
        id: `qg-pass-${taskId}`,
        task_id: taskId,
        run_id: null,
        repo_path: tmpGitDir,
        passed: true,
        status: 'PASSED',
        summary: 'All checks passed',
        policy: QualityGatePolicySchema.parse({}),
        rule_evaluations: [],
        evidence_summary: QualityGateEvidenceSummarySchema.parse({
          cliExitCode: 0,
          cliStatus: 'SUCCESS',
          cliSucceeded: true,
          totalCommands: 1,
          passedCommands: 1,
        }),
        command_records: [],
        scope_result: null,
        review_result: null,
        security_result: null,
        duration_ms: 50,
        evaluated_at: new Date().toISOString(),
      });
    }

    return {
      db,
      featureRepo,
      taskRepo,
      runRepo,
      qgRepo,
      releaseRepo,
      releaseService,
      featureService,
      taskService,
      seedQGPass,
    };
  }

  // --- Nghiệm thu 1: Commit chuẩn hóa Conventional Commits ---
  it('Nghiệm thu 1: Định dạng commit chuẩn hóa Conventional Commits hỗ trợ đầy đủ các type chuẩn', () => {
    for (const type of CONVENTIONAL_COMMIT_TYPES) {
      const msg = formatConventionalCommit({
        type,
        scope: 'REL-004',
        subject: `implement feature for ${type}`,
      });
      expect(msg).toBe(`${type}(REL-004): implement feature for ${type}`);
      expect(isConventionalCommit(msg)).toBe(true);

      const parsed = validateConventionalCommit(msg);
      expect(parsed.type).toBe(type);
      expect(parsed.scope).toBe('REL-004');
      expect(parsed.subject).toBe(`implement feature for ${type}`);
    }
  });

  // --- Nghiệm thu 2: Từ chối commit message không chuẩn với INVALID_COMMIT_MESSAGE ---
  it('Nghiệm thu 2: Từ chối commit message không chuẩn với lỗi INVALID_COMMIT_MESSAGE', async () => {
    const invalidMessages = [
      'fix some bug',
      'WIP: working on it',
      'Update file.txt',
      'foo(bar): unknown type',
      '',
    ];

    for (const msg of invalidMessages) {
      expect(isConventionalCommit(msg)).toBe(false);
      expect(() => validateConventionalCommit(msg)).toThrow(AppError);

      try {
        validateConventionalCommit(msg);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('INVALID_COMMIT_MESSAGE');
      }
    }
  });

  // --- Nghiệm thu 3: gitCommit thực thi commit thật, sinh SHA 40 ký tự hex ---
  it('Nghiệm thu 3: gitCommit thực thi commit thật và trả về SHA 40 ký tự hex', async () => {
    fs.writeFileSync(path.join(tmpGitDir, 'feature-code.ts'), 'export const active = true;\n');

    const result = await gitCommit(tmpGitDir, {
      message: 'feat(REL-004): standardized git commit implementation',
      stageAll: true,
    });

    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/i);
    expect(result.shortSha).toHaveLength(7);
    expect(result.message).toBe('feat(REL-004): standardized git commit implementation');
    expect(result.filesCommitted).toContain('feature-code.ts');

    const commitInfo = await gitGetCommitDetails(tmpGitDir, result.commitSha);
    expect(commitInfo?.commitSha).toBe(result.commitSha);
    expect(commitInfo?.subject).toBe('feat(REL-004): standardized git commit implementation');
  });

  // --- Nghiệm thu 4 & 5: Lưu commit_sha vào SQLite database (bảng feature_releases) và cập nhật trạng thái COMMITTED ---
  it('Nghiệm thu 4 & 5: Lưu commit_sha vào SQLite database (bảng feature_releases) và cập nhật trạng thái COMMITTED', async () => {
    const { featureRepo, releaseService, releaseRepo } = setupTestEnv();

    featureRepo.create({
      id: 'FEAT-RELEASE-COMMIT',
      name: 'Release Commit Feature',
      required_tasks: [],
    });

    // Tạo branch an toàn (REL-003)
    await releaseService.createFeatureBranch('FEAT-RELEASE-COMMIT', {
      repo_path: tmpGitDir,
      checkout: true,
      skip_readiness_check: true,
    });

    // Thêm thay đổi cần commit
    fs.writeFileSync(path.join(tmpGitDir, 'release-note.md'), '# Release v1.0.0\n');

    const commitResult = await releaseService.commitFeatureRelease('FEAT-RELEASE-COMMIT', {
      repo_path: tmpGitDir,
      message: 'feat(FEAT-RELEASE-COMMIT): commit feature files and update metadata',
    });

    expect(commitResult.commit_sha).toMatch(/^[0-9a-f]{40}$/i);
    expect(commitResult.status).toBe('COMMITTED');

    // Xác nhận SHA được lưu trong DB
    const releaseRecord = releaseRepo.findByFeatureId('FEAT-RELEASE-COMMIT');
    expect(releaseRecord).not.toBeNull();
    expect(releaseRecord?.commit_sha).toBe(commitResult.commit_sha);
    expect(releaseRecord?.status).toBe('COMMITTED');
    expect(releaseRecord?.metadata).toMatchObject({
      last_commit_message: 'feat(FEAT-RELEASE-COMMIT): commit feature files and update metadata',
    });
  });

  // --- Nghiệm thu 6: Lưu commit_sha cho task run vào bảng runs trong SQLite database ---
  it('Nghiệm thu 6: Lưu commit_sha cho task run vào bảng runs trong SQLite database', async () => {
    const { taskRepo, runRepo, taskService } = setupTestEnv();

    taskRepo.create({
      id: 'TSK-COMM-001',
      title: 'Task with Git Commit',
      acceptance_criteria: ['Commit created'],
    });

    // Tạo run cho task
    const run = runRepo.create({
      id: 'run-comm-001',
      task_id: 'TSK-COMM-001',
      attempt: 1,
      status: 'RUNNING',
    });

    fs.writeFileSync(path.join(tmpGitDir, 'task-file.ts'), 'export const taskDone = true;\n');

    const taskCommitResult = await taskService.recordTaskCommit('TSK-COMM-001', {
      repo_path: tmpGitDir,
      run_id: run.id,
      message: 'feat(TSK-COMM-001): complete task implementation',
    });

    expect(taskCommitResult.commit_sha).toMatch(/^[0-9a-f]{40}$/i);
    expect(taskCommitResult.run_id).toBe(run.id);

    // Xác nhận SHA được lưu trong bảng runs
    const updatedRun = runRepo.getById(run.id);
    expect(updatedRun?.commit_sha).toBe(taskCommitResult.commit_sha);
  });

  // --- Nghiệm thu 7: Truy vấn DB xác nhận commit_sha khớp chính xác 100% với git rev-parse HEAD ---
  it('Nghiệm thu 7: Truy vấn DB xác nhận commit_sha khớp chính xác với git rev-parse HEAD', async () => {
    const { featureRepo, releaseService, releaseRepo } = setupTestEnv();

    featureRepo.create({
      id: 'FEAT-MATCH-SHA',
      name: 'Match SHA Feature',
      required_tasks: [],
    });

    await releaseService.createFeatureBranch('FEAT-MATCH-SHA', {
      repo_path: tmpGitDir,
      checkout: true,
      skip_readiness_check: true,
    });

    fs.writeFileSync(path.join(tmpGitDir, 'verified.ts'), 'export const verified = true;\n');

    await releaseService.commitFeatureRelease('FEAT-MATCH-SHA', {
      repo_path: tmpGitDir,
      message: 'feat(FEAT-MATCH-SHA): ensure sha strictly matches git HEAD',
    });

    // Lấy SHA thật từ git rev-parse HEAD
    const actualGitHeadSha = execSync('git rev-parse HEAD', { cwd: tmpGitDir })
      .toString()
      .trim();

    // Lấy SHA từ SQLite
    const releaseInDb = releaseRepo.findByFeatureId('FEAT-MATCH-SHA');
    expect(releaseInDb?.commit_sha).toBe(actualGitHeadSha);
  });

  // --- Nghiệm thu 8: REST API POST /features/:id/commit và GET /features/:id/release ---
  it('Nghiệm thu 8: REST API POST /features/:id/commit và GET /features/:id/release hoạt động chuẩn xác', async () => {
    const { db, featureRepo, releaseService } = setupTestEnv();
    const server = await buildServer({ db });

    featureRepo.create({
      id: 'FEAT-API-COMMIT',
      name: 'API Commit Feature',
      required_tasks: [],
    });

    await releaseService.createFeatureBranch('FEAT-API-COMMIT', {
      repo_path: tmpGitDir,
      checkout: true,
      skip_readiness_check: true,
    });

    fs.writeFileSync(path.join(tmpGitDir, 'api-change.ts'), 'export const api = 1;\n');

    // 1. POST /features/:id/commit thực hiện commit
    const commitRes = await server.inject({
      method: 'POST',
      url: '/features/FEAT-API-COMMIT/commit',
      payload: {
        repo_path: tmpGitDir,
        message: 'feat(FEAT-API-COMMIT): commit via rest api',
      },
    });

    expect(commitRes.statusCode).toBe(201);
    const commitBody = commitRes.json();
    expect(commitBody.data.commit_sha).toMatch(/^[0-9a-f]{40}$/i);
    expect(commitBody.data.status).toBe('COMMITTED');

    // 2. GET /features/:id/release lấy thông tin release và SHA đã lưu
    const getRes = await server.inject({
      method: 'GET',
      url: '/features/FEAT-API-COMMIT/release',
    });

    expect(getRes.statusCode).toBe(200);
    const getBody = getRes.json();
    expect(getBody.data.commit_sha).toBe(commitBody.data.commit_sha);
    expect(getBody.data.status).toBe('COMMITTED');

    // 3. Từ chối commit khi message không hợp lệ (HTTP 400)
    fs.writeFileSync(path.join(tmpGitDir, 'api-change.ts'), 'export const api = 2;\n');
    const badRes = await server.inject({
      method: 'POST',
      url: '/features/FEAT-API-COMMIT/commit',
      payload: {
        repo_path: tmpGitDir,
        message: 'invalid non-conventional message',
      },
    });
    expect(badRes.statusCode).toBe(400);
    expect(badRes.json().error.code).toBe('INVALID_COMMIT_MESSAGE');

    await server.close();
  });

  // --- Nghiệm thu 9: REST API POST /tasks/:id/commit lưu SHA cho task trong runs ---
  it('Nghiệm thu 9: REST API POST /tasks/:id/commit lưu commit SHA cho task vào DB', async () => {
    const { db, taskRepo, runRepo } = setupTestEnv();
    const server = await buildServer({ db });

    taskRepo.create({
      id: 'TSK-API-COMM',
      title: 'Task for API Commit',
      acceptance_criteria: ['Done'],
    });

    const run = runRepo.create({
      id: 'run-api-001',
      task_id: 'TSK-API-COMM',
      attempt: 1,
      status: 'RUNNING',
    });

    fs.writeFileSync(path.join(tmpGitDir, 'task-api.ts'), 'export const taskApi = true;\n');

    const res = await server.inject({
      method: 'POST',
      url: '/tasks/TSK-API-COMM/commit',
      payload: {
        repo_path: tmpGitDir,
        run_id: run.id,
        message: 'feat(TSK-API-COMM): commit task through api',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.commit_sha).toMatch(/^[0-9a-f]{40}$/i);

    const updatedRun = runRepo.getById(run.id);
    expect(updatedRun?.commit_sha).toBe(body.data.commit_sha);

    await server.close();
  });
});
