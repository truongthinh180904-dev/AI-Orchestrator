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
  QualityGateRepository,
  FeatureReleaseRepository,
} from '../packages/db/src/index.js';
import { FeatureReleaseService } from '../apps/orchestrator/src/services/feature-release-service.js';
import { FeatureService } from '../apps/orchestrator/src/services/feature-service.js';
import { buildServer } from '../apps/orchestrator/src/server.js';
import {
  AppError,
  QualityGatePolicySchema,
  QualityGateEvidenceSummarySchema,
  gitBranchExists,
  gitGetCurrentBranch,
  gitListBranches,
} from '../packages/shared/src/index.js';

describe('REL-003: Tạo branch feature an toàn (không ghi đè)', () => {
  let tmpGitDir: string;

  beforeEach(() => {
    tmpGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel003-acceptance-'));
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
    const qgRepo = new QualityGateRepository(db);
    const releaseRepo = new FeatureReleaseRepository(db);

    const releaseService = new FeatureReleaseService(db);
    const featureService = new FeatureService(db, { releaseService });

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
      qgRepo,
      releaseRepo,
      releaseService,
      featureService,
      seedQGPass,
    };
  }

  // --- Tiêu chí cốt lõi 1 ---
  it('Nghiệm thu 1: Tạo branch feature an toàn với tên mặc định feature/<feature-id>', async () => {
    const { featureRepo, taskRepo, releaseService, seedQGPass } = setupTestEnv();

    featureRepo.create({
      id: 'FEAT-PAYMENT',
      name: 'Payment Processing Service',
      required_tasks: ['PAY-001'],
    });

    taskRepo.create({
      id: 'PAY-001',
      feature_id: 'FEAT-PAYMENT',
      title: 'Payment Gateway Integration',
      status: 'DONE',
    });

    seedQGPass('PAY-001');

    const result = await releaseService.createFeatureBranch('FEAT-PAYMENT', {
      repo_path: tmpGitDir,
    });

    expect(result.feature_id).toBe('FEAT-PAYMENT');
    expect(result.branch).toBe('feature/FEAT-PAYMENT');
    expect(result.base_branch).toBe('main');
    expect(result.commit_sha).toHaveLength(40);
    expect(result.created).toBe(true);
    expect(result.status).toBe('BRANCH_CREATED');

    // Xác nhận branch thật sự tồn tại trong git repo
    const exists = await gitBranchExists(tmpGitDir, 'feature/FEAT-PAYMENT');
    expect(exists).toBe(true);

    const branchList = await gitListBranches(tmpGitDir);
    expect(branchList).toContain('feature/FEAT-PAYMENT');
  });

  // --- Tiêu chí cốt lõi 2 (Nghiệm thu chính): Branch trùng → lỗi ---
  it('Nghiệm thu 2: Branch trùng -> ném lỗi BRANCH_ALREADY_EXISTS, tuyệt đối không ghi đè', async () => {
    const { featureRepo, taskRepo, releaseService, seedQGPass } = setupTestEnv();

    featureRepo.create({
      id: 'FEAT-DUP',
      name: 'Duplicate Feature Test',
      required_tasks: ['DUP-001'],
    });

    taskRepo.create({
      id: 'DUP-001',
      feature_id: 'FEAT-DUP',
      title: 'Dup Task',
      status: 'DONE',
    });

    seedQGPass('DUP-001');

    // Lần 1: Tạo branch thành công
    await releaseService.createFeatureBranch('FEAT-DUP', {
      repo_path: tmpGitDir,
    });

    await expect(
      releaseService.createFeatureBranch('FEAT-DUP', {
        repo_path: tmpGitDir,
      }),
    ).rejects.toMatchObject({
      code: 'BRANCH_ALREADY_EXISTS',
    });

  });

  // --- Tiêu chí 3: Chặn release khi feature chưa đạt điều kiện (REL-002) ---
  it('Nghiệm thu 3: Chặn tạo branch feature khi chưa đạt release readiness (thiếu task hoặc task chưa DONE)', async () => {
    const { featureRepo, taskRepo, releaseService } = setupTestEnv();

    featureRepo.create({
      id: 'FEAT-UNREADY',
      name: 'Unready Feature',
      required_tasks: ['TASK-INCOMPLETE'],
    });

    taskRepo.create({
      id: 'TASK-INCOMPLETE',
      feature_id: 'FEAT-UNREADY',
      title: 'Incomplete Task',
      status: 'TODO', // Chưa DONE
    });

    await expect(
      releaseService.createFeatureBranch('FEAT-UNREADY', {
        repo_path: tmpGitDir,
      }),
    ).rejects.toMatchObject({
      code: 'FEATURE_RELEASE_BLOCKED',
    });


    // Với skip_readiness_check: true, cho phép tạo branch chủ động
    const forced = await releaseService.createFeatureBranch('FEAT-UNREADY', {
      repo_path: tmpGitDir,
      skip_readiness_check: true,
    });
    expect(forced.created).toBe(true);
    expect(forced.branch).toBe('feature/FEAT-UNREADY');
  });

  // --- Tiêu chí 4: Chặn khi repo dirty ---
  it('Nghiệm thu 4: Chặn tạo branch khi repo dirty (có file chưa commit)', async () => {
    const { featureRepo, taskRepo, releaseService, seedQGPass } = setupTestEnv();

    featureRepo.create({
      id: 'FEAT-CLEAN-CHECK',
      name: 'Clean Check Feature',
      required_tasks: ['TASK-CLEAN'],
    });

    taskRepo.create({
      id: 'TASK-CLEAN',
      feature_id: 'FEAT-CLEAN-CHECK',
      title: 'Clean Task',
      status: 'DONE',
    });

    seedQGPass('TASK-CLEAN');

    // Tạo file uncommitted trong repo
    fs.writeFileSync(path.join(tmpGitDir, 'dirty-untracked.txt'), 'dirty state');

    await expect(
      releaseService.createFeatureBranch('FEAT-CLEAN-CHECK', {
        repo_path: tmpGitDir,
        require_clean: true,
      }),
    ).rejects.toMatchObject({
      code: 'REPO_DIRTY',
    });
  });


  // --- Tiêu chí 5: Tên branch không hợp lệ ---
  it('Nghiệm thu 5: Từ chối tên branch không đúng định dạng Git (INVALID_BRANCH_NAME)', async () => {
    const { featureRepo, releaseService } = setupTestEnv();

    featureRepo.create({
      id: 'FEAT-INVALID-BRANCH',
      name: 'Invalid Branch Feature',
      required_tasks: [],
    });

    const invalidNames = [
      'feature/has space',
      '/starts-with-slash',
      'ends-with-slash/',
      'feature..double-dot',
      'feature.lock',
      'feature~tilde',
      'feature^caret',
      'feature:colon',
    ];

    for (const badName of invalidNames) {
      try {
        await releaseService.createFeatureBranch('FEAT-INVALID-BRANCH', {
          repo_path: tmpGitDir,
          branch_name: badName,
          skip_readiness_check: true,
        });
        expect.unreachable(`Should have thrown for bad branch name: ${badName}`);
      } catch (err: unknown) {
        expect((err as AppError).code).toBe('INVALID_BRANCH_NAME');
      }
    }
  });

  // --- Tiêu chí 6: Tùy chọn checkout ---
  it('Nghiệm thu 6: Tùy chọn checkout: true chuyển sang branch mới tạo', async () => {
    const { featureRepo, releaseService } = setupTestEnv();

    featureRepo.create({
      id: 'FEAT-CO',
      name: 'Checkout Feature',
      required_tasks: [],
    });

    await releaseService.createFeatureBranch('FEAT-CO', {
      repo_path: tmpGitDir,
      skip_readiness_check: true,
      checkout: true,
    });

    const currentBranch = await gitGetCurrentBranch(tmpGitDir);
    expect(currentBranch).toBe('feature/FEAT-CO');
  });

  // --- Tiêu chí 7: Lưu vết vào SQLite feature_releases ---
  it('Nghiệm thu 7: Lưu vết đầy đủ vào bảng feature_releases trong SQLite', async () => {
    const { featureRepo, taskRepo, releaseRepo, releaseService, seedQGPass } = setupTestEnv();

    featureRepo.create({
      id: 'FEAT-DB-RECORD',
      name: 'DB Record Feature',
      required_tasks: ['TASK-REC'],
    });

    taskRepo.create({
      id: 'TASK-REC',
      feature_id: 'FEAT-DB-RECORD',
      title: 'DB Task',
      status: 'DONE',
    });

    seedQGPass('TASK-REC');

    const result = await releaseService.createFeatureBranch('FEAT-DB-RECORD', {
      repo_path: tmpGitDir,
    });

    const dbRelease = releaseRepo.findById(result.release_id);
    expect(dbRelease).not.toBeNull();
    expect(dbRelease?.feature_id).toBe('FEAT-DB-RECORD');
    expect(dbRelease?.branch).toBe('feature/FEAT-DB-RECORD');
    expect(dbRelease?.base_branch).toBe('main');
    expect(dbRelease?.commit_sha).toBe(result.commit_sha);
    expect(dbRelease?.status).toBe('BRANCH_CREATED');
  });

  // --- Tiêu chí 8: REST API endpoints POST/GET /features/:id/branch ---
  it('Nghiệm thu 8: REST API endpoints POST và GET /features/:id/branch hoạt động chính xác', async () => {
    const { db, featureRepo, taskRepo, seedQGPass } = setupTestEnv();

    featureRepo.create({
      id: 'FEAT-API-TEST',
      name: 'API Feature Test',
      required_tasks: ['API-TASK-1'],
    });

    taskRepo.create({
      id: 'API-TASK-1',
      feature_id: 'FEAT-API-TEST',
      title: 'API Task',
      status: 'DONE',
    });

    seedQGPass('API-TASK-1');

    const server = await buildServer({ db });

    // 1. Tạo branch qua POST
    const createRes = await server.inject({
      method: 'POST',
      url: '/features/FEAT-API-TEST/branch',
      payload: {
        repo_path: tmpGitDir,
      },
    });

    expect(createRes.statusCode).toBe(201);
    const createBody = JSON.parse(createRes.body);
    expect(createBody.data.branch).toBe('feature/FEAT-API-TEST');
    expect(createBody.data.created).toBe(true);

    // 2. Thử tạo lại -> HTTP 409 Conflict (Branch trùng -> lỗi)
    const dupRes = await server.inject({
      method: 'POST',
      url: '/features/FEAT-API-TEST/branch',
      payload: {
        repo_path: tmpGitDir,
      },
    });

    expect(dupRes.statusCode).toBe(409);
    const dupBody = JSON.parse(dupRes.body);
    expect(dupBody.error.code).toBe('BRANCH_ALREADY_EXISTS');

    // 3. Lấy thông tin branch qua GET
    const getRes = await server.inject({
      method: 'GET',
      url: `/features/FEAT-API-TEST/branch?repo_path=${encodeURIComponent(tmpGitDir)}`,
    });

    expect(getRes.statusCode).toBe(200);
    const getBody = JSON.parse(getRes.body);
    expect(getBody.data.branch).toBe('feature/FEAT-API-TEST');
    expect(getBody.data.exists_locally).toBe(true);

    // 4. Feature không tồn tại -> 404
    const notFoundRes = await server.inject({
      method: 'POST',
      url: '/features/NON-EXISTENT-XYZ/branch',
      payload: {},
    });
    expect(notFoundRes.statusCode).toBe(404);

    await server.close();
  });
});
