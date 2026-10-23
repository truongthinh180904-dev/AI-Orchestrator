import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
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
  ReportRepository,
  FeatureReleaseRepository,
} from '../packages/db/src/index.js';
import { FeatureReleaseService } from '../apps/orchestrator/src/services/feature-release-service.js';
import { FeatureService } from '../apps/orchestrator/src/services/feature-service.js';
import { buildServer } from '../apps/orchestrator/src/server.js';
import {
  QualityGatePolicySchema,
  QualityGateEvidenceSummarySchema,
  sanitizeGhOutput,
} from '../packages/shared/src/index.js';

describe('REL-006: Tạo PR (gh pr create) + báo cáo release', () => {
  let tmpGitDir: string;
  let tmpRemoteDir: string;

  beforeEach(() => {
    // 1. Tạo bare remote repository
    tmpRemoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel006-remote-bare-'));
    execSync('git init --bare', { cwd: tmpRemoteDir, stdio: 'ignore' });

    // 2. Tạo local working repository
    tmpGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel006-local-repo-'));
    execSync('git init -b main', { cwd: tmpGitDir, stdio: 'ignore' });
    execSync('git config user.email "orchestrator@ai.local"', { cwd: tmpGitDir, stdio: 'ignore' });
    execSync('git config user.name "AI Orchestrator"', { cwd: tmpGitDir, stdio: 'ignore' });

    fs.writeFileSync(path.join(tmpGitDir, 'README.md'), '# AI Orchestrator REL-006 Test\n');
    execSync('git add . && git commit -m "chore: initial release commit"', {
      cwd: tmpGitDir,
      stdio: 'ignore',
    });

    // Cấu hình remote 'origin'
    execSync(`git remote add origin "${tmpRemoteDir}"`, { cwd: tmpGitDir, stdio: 'ignore' });
  });

  afterEach(() => {
    if (tmpGitDir && fs.existsSync(tmpGitDir)) {
      fs.rmSync(tmpGitDir, { recursive: true, force: true });
    }
    if (tmpRemoteDir && fs.existsSync(tmpRemoteDir)) {
      fs.rmSync(tmpRemoteDir, { recursive: true, force: true });
    }
  });

  function setupTestEnv(options?: {
    mockGhRunner?: (
      args: string[],
      cwd: string,
      env?: Record<string, string>,
    ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  }) {
    const db = createDatabase(':memory:');
    runMigrations(db);

    const featureRepo = new FeatureRepository(db);
    const taskRepo = new TaskRepository(db);
    const qgRepo = new QualityGateRepository(db);
    const reportRepo = new ReportRepository(db);
    const releaseRepo = new FeatureReleaseRepository(db);

    const releaseService = new FeatureReleaseService(db, {
      ghRunner: options?.mockGhRunner,
    });
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
          buildPassed: true,
          unitTestsPassed: true,
          lintPassed: true,
          noOutOfScopeFiles: true,
          noHighSeverityFindings: true,
          securityPassed: true,
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
      reportRepo,
      releaseRepo,
      releaseService,
      featureService,
      seedQGPass,
    };
  }

  // =========================================================================
  // Tiêu chí 1: Tạo PR thành công và lưu URL, SHA, quality report
  // =========================================================================
  it('Nghiệm thu 1: Tạo PR thành công (gh pr create) và lưu URL, SHA, quality report vào DB', async () => {
    const mockGhRunner = vi.fn().mockResolvedValue({
      stdout: 'https://github.com/my-org/my-repo/pull/77\n',
      stderr: '',
      exitCode: 0,
    });

    const env = setupTestEnv({ mockGhRunner });

    // 1. Chuẩn bị feature & task đạt chuẩn release
    const feat = env.featureRepo.create({
      id: 'FEAT-PR-01',
      name: 'User Management Feature',
      description: 'Feature implementing user management',
      required_tasks: ['TSK-201'],
      integration_tests: [],
    });
    env.taskRepo.create({
      id: 'TSK-201',
      feature_id: 'FEAT-PR-01',
      title: 'Task 201 for user management',
      status: 'DONE',
    });
    env.seedQGPass('TSK-201');

    // 2. Tạo branch, commit và push lên remote
    await env.featureService.createFeatureBranch(feat.id, {
      repo_path: tmpGitDir,
      base_branch: 'main',
    });

    fs.writeFileSync(path.join(tmpGitDir, 'users.ts'), 'export const users = [];\n');
    const commitRes = await env.featureService.commitFeatureRelease(feat.id, {
      repo_path: tmpGitDir,
      message: 'feat(FEAT-PR-01): implement user list',
    });

    await env.featureService.pushFeatureRelease(feat.id, {
      repo_path: tmpGitDir,
      remote: 'origin',
    });

    // 3. Thực hiện createFeaturePr (REL-006)
    const prResult = await env.featureService.createFeaturePr(feat.id, {
      repo_path: tmpGitDir,
      title: 'feat(FEAT-PR-01): release user management feature',
    });

    // TIÊU CHÍ NGHIỆM THU: Lưu URL, SHA, quality report
    expect(prResult.pr_url).toBe('https://github.com/my-org/my-repo/pull/77');
    expect(prResult.pr_number).toBe(77);
    expect(prResult.commit_sha).toBe(commitRes.commit_sha);
    expect(prResult.status).toBe('READY_FOR_REVIEW');
    expect(prResult.quality_report_id).toBeDefined();
    expect(prResult.quality_report_path).toContain('reports/FEAT-PR-01.md');

    // Kiểm tra trực tiếp trong SQLite DB (bảng feature_releases)
    const releaseInDb = env.releaseRepo.findByFeatureId(feat.id);
    expect(releaseInDb).not.toBeNull();
    expect(releaseInDb?.pr_url).toBe('https://github.com/my-org/my-repo/pull/77');
    expect(releaseInDb?.commit_sha).toBe(commitRes.commit_sha);
    expect(releaseInDb?.status).toBe('READY_FOR_REVIEW');
    expect(releaseInDb?.metadata?.quality_report_id).toBe(prResult.quality_report_id);

    // Kiểm tra báo cáo trong bảng reports
    const reportInDb = env.reportRepo.getById(prResult.quality_report_id!);
    expect(reportInDb).not.toBeNull();
    expect(reportInDb?.kind).toBe('feature_release');
    expect(reportInDb?.content).toContain('# Feature Release Report: User Management Feature (FEAT-PR-01)');
    expect(reportInDb?.content).toContain(commitRes.commit_sha);

    // Kiểm tra lệnh gh pr create được gọi chuẩn hóa
    expect(mockGhRunner).toHaveBeenCalledTimes(1);
    const calledArgs = mockGhRunner.mock.calls[0]?.[0];
    expect(calledArgs).toContain('pr');
    expect(calledArgs).toContain('create');
    expect(calledArgs).toContain('--base');
    expect(calledArgs).toContain('main');
    expect(calledArgs).toContain('--head');
    expect(calledArgs).toContain('feature/FEAT-PR-01');
    expect(calledArgs).toContain('--title');
    expect(calledArgs).toContain('feat(FEAT-PR-01): release user management feature');
    expect(calledArgs).toContain('--body-file');
  });

  // =========================================================================
  // Tiêu chí 2: Lưu báo cáo release vào file trên đĩa
  // =========================================================================
  it('Nghiệm thu 2: Lưu file báo cáo release dạng Markdown (reports/<feature-id>.md) trên đĩa', async () => {
    const mockGhRunner = vi.fn().mockResolvedValue({
      stdout: 'https://github.com/my-org/my-repo/pull/78\n',
      stderr: '',
      exitCode: 0,
    });

    const env = setupTestEnv({ mockGhRunner });

    const feat = env.featureRepo.create({
      id: 'FEAT-FILE-REP',
      name: 'Report File Verification',
      required_tasks: ['TSK-202'],
      integration_tests: [],
    });
    env.taskRepo.create({
      id: 'TSK-202',
      feature_id: 'FEAT-FILE-REP',
      title: 'Task 202',
      status: 'DONE',
    });
    env.seedQGPass('TSK-202');

    await env.featureService.createFeatureBranch(feat.id, { repo_path: tmpGitDir });
    fs.writeFileSync(path.join(tmpGitDir, 'code.ts'), 'export const code = 1;\n');
    await env.featureService.commitFeatureRelease(feat.id, { repo_path: tmpGitDir });
    await env.featureService.pushFeatureRelease(feat.id, { repo_path: tmpGitDir });

    const prResult = await env.featureService.createFeaturePr(feat.id, {
      repo_path: tmpGitDir,
    });

    // File báo cáo phải thực sự tồn tại trên đĩa
    expect(fs.existsSync(prResult.quality_report_path!)).toBe(true);
    const fileContent = fs.readFileSync(prResult.quality_report_path!, 'utf-8');
    expect(fileContent).toContain('# Feature Release Report: Report File Verification (FEAT-FILE-REP)');
    expect(fileContent).toContain('READY_FOR_REVIEW');
    expect(fileContent).toContain('Component Tasks');
    expect(fileContent).toContain('Quality Gate & Compliance');
    expect(fileContent).toContain('Review & Sign-Off Checklist');
  });

  // =========================================================================
  // Tiêu chí 3: Cập nhật trạng thái READY_FOR_REVIEW
  // =========================================================================
  it('Nghiệm thu 3: Cập nhật trạng thái release thành READY_FOR_REVIEW (chờ người duyệt)', async () => {
    const mockGhRunner = vi.fn().mockResolvedValue({
      stdout: 'https://github.com/org/repo/pull/79\n',
      stderr: '',
      exitCode: 0,
    });

    const env = setupTestEnv({ mockGhRunner });

    const feat = env.featureRepo.create({
      id: 'FEAT-REVIEW-STATE',
      name: 'Review State Feature',
      required_tasks: ['TSK-203'],
      integration_tests: [],
    });
    env.taskRepo.create({
      id: 'TSK-203',
      feature_id: 'FEAT-REVIEW-STATE',
      title: 'Task 203',
      status: 'DONE',
    });
    env.seedQGPass('TSK-203');

    await env.featureService.createFeatureBranch(feat.id, { repo_path: tmpGitDir });
    fs.writeFileSync(path.join(tmpGitDir, 'x.ts'), 'export const x = 2;\n');
    await env.featureService.commitFeatureRelease(feat.id, { repo_path: tmpGitDir });
    await env.featureService.pushFeatureRelease(feat.id, { repo_path: tmpGitDir });

    const prResult = await env.featureService.createFeaturePr(feat.id, { repo_path: tmpGitDir });

    expect(prResult.status).toBe('READY_FOR_REVIEW');
    const stored = env.releaseRepo.findByFeatureId(feat.id);
    expect(stored?.status).toBe('READY_FOR_REVIEW');
  });

  // =========================================================================
  // Tiêu chí 4: Từ chối tạo PR khi chưa commit
  // =========================================================================
  it('Nghiệm thu 4: Từ chối tạo PR khi branch chưa được commit (FEATURE_NOT_COMMITTED)', async () => {
    const env = setupTestEnv();

    const feat = env.featureRepo.create({
      id: 'FEAT-NO-COMMIT',
      name: 'No Commit Feature',
      required_tasks: ['TSK-204'],
      integration_tests: [],
    });
    env.taskRepo.create({
      id: 'TSK-204',
      feature_id: 'FEAT-NO-COMMIT',
      title: 'Task 204',
      status: 'DONE',
    });
    env.seedQGPass('TSK-204');

    await env.featureService.createFeatureBranch(feat.id, { repo_path: tmpGitDir });

    // Không commit mà gọi createFeaturePr -> Lỗi
    await expect(
      env.featureService.createFeaturePr(feat.id, { repo_path: tmpGitDir }),
    ).rejects.toMatchObject({
      code: 'FEATURE_NOT_COMMITTED',
    });
  });

  // =========================================================================
  // Tiêu chí 5: Từ chối tạo PR khi branch chưa được push
  // =========================================================================
  it('Nghiệm thu 5: Từ chối tạo PR khi branch chưa được push lên remote (FEATURE_NOT_PUSHED)', async () => {
    const env = setupTestEnv();

    const feat = env.featureRepo.create({
      id: 'FEAT-NO-PUSH',
      name: 'No Push Feature',
      required_tasks: ['TSK-205'],
      integration_tests: [],
    });
    env.taskRepo.create({
      id: 'TSK-205',
      feature_id: 'FEAT-NO-PUSH',
      title: 'Task 205',
      status: 'DONE',
    });
    env.seedQGPass('TSK-205');

    await env.featureService.createFeatureBranch(feat.id, { repo_path: tmpGitDir });
    fs.writeFileSync(path.join(tmpGitDir, 'c.ts'), 'export const c = 3;\n');
    await env.featureService.commitFeatureRelease(feat.id, { repo_path: tmpGitDir });

    // Đã commit nhưng chưa push -> Bị chặn với FEATURE_NOT_PUSHED
    await expect(
      env.featureService.createFeaturePr(feat.id, { repo_path: tmpGitDir }),
    ).rejects.toMatchObject({
      code: 'FEATURE_NOT_PUSHED',
    });
  });

  // =========================================================================
  // Tiêu chí 6: Tính lũy đẳng khi PR đã tồn tại
  // =========================================================================
  it('Nghiệm thu 6: Tái sử dụng PR URL khi PR đã tồn tại (idempotency, GH_PR_ALREADY_EXISTS)', async () => {
    const mockGhRunner = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: 'a pull request for branch "feature/FEAT-IDEMPOTENT" already exists:\nhttps://github.com/my-org/my-repo/pull/88\n',
      exitCode: 1,
    });

    const env = setupTestEnv({ mockGhRunner });

    const feat = env.featureRepo.create({
      id: 'FEAT-IDEMPOTENT',
      name: 'Idempotent PR Feature',
      required_tasks: ['TSK-206'],
      integration_tests: [],
    });
    env.taskRepo.create({
      id: 'TSK-206',
      feature_id: 'FEAT-IDEMPOTENT',
      title: 'Task 206',
      status: 'DONE',
    });
    env.seedQGPass('TSK-206');

    await env.featureService.createFeatureBranch(feat.id, { repo_path: tmpGitDir });
    fs.writeFileSync(path.join(tmpGitDir, 'idem.ts'), 'export const idem = 1;\n');
    await env.featureService.commitFeatureRelease(feat.id, { repo_path: tmpGitDir });
    await env.featureService.pushFeatureRelease(feat.id, { repo_path: tmpGitDir });

    // Gọi createFeaturePr khi PR đã tồn tại sẵn
    const prResult = await env.featureService.createFeaturePr(feat.id, {
      repo_path: tmpGitDir,
      allow_existing: true,
    });

    expect(prResult.pr_url).toBe('https://github.com/my-org/my-repo/pull/88');
    expect(prResult.pr_number).toBe(88);
    expect(prResult.status).toBe('READY_FOR_REVIEW');

    const dbRelease = env.releaseRepo.findByFeatureId(feat.id);
    expect(dbRelease?.pr_url).toBe('https://github.com/my-org/my-repo/pull/88');
  });

  // =========================================================================
  // Tiêu chí 7: Che giấu secret / token khi có lỗi GitHub CLI
  // =========================================================================
  it('Nghiệm thu 7: Che giấu token / bí mật khi có lỗi GitHub CLI (sanitizeGhOutput)', () => {
    const secretOutput =
      'fatal: authentication failed using token ghp_ABC1234567890abcdefghijklmnopqrstuvwxyza on https://user:superSecret@github.com/repo.git';

    const clean = sanitizeGhOutput(secretOutput);
    expect(clean).not.toContain('ghp_ABC1234567890abcdefghijklmnopqrstuvwxyza');
    expect(clean).not.toContain('superSecret');
    expect(clean).toContain('[REDACTED_GH_TOKEN]');
    expect(clean).toContain('[REDACTED_CREDENTIALS]');
  });

  // =========================================================================
  // Tiêu chí 8: Cơ chế retry tự động cho lỗi mạng tạm thời
  // =========================================================================
  it('Nghiệm thu 8: Cơ chế retry tự động khi gặp lỗi mạng tạm thời (GH_NETWORK_ERROR)', async () => {
    let callCount = 0;
    const mockGhRunner = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          stdout: '',
          stderr: 'error: Could not resolve host: github.com; connection timed out',
          exitCode: 1,
        });
      }
      return Promise.resolve({
        stdout: 'https://github.com/org/repo/pull/99\n',
        stderr: '',
        exitCode: 0,
      });
    });

    const env = setupTestEnv({ mockGhRunner });

    const feat = env.featureRepo.create({
      id: 'FEAT-RETRY-NET',
      name: 'Retry Net Feature',
      required_tasks: ['TSK-208'],
      integration_tests: [],
    });
    env.taskRepo.create({
      id: 'TSK-208',
      feature_id: 'FEAT-RETRY-NET',
      title: 'Task 208',
      status: 'DONE',
    });
    env.seedQGPass('TSK-208');

    await env.featureService.createFeatureBranch(feat.id, { repo_path: tmpGitDir });
    fs.writeFileSync(path.join(tmpGitDir, 'net.ts'), 'export const net = 1;\n');
    await env.featureService.commitFeatureRelease(feat.id, { repo_path: tmpGitDir });
    await env.featureService.pushFeatureRelease(feat.id, { repo_path: tmpGitDir });

    const prResult = await env.featureService.createFeaturePr(feat.id, {
      repo_path: tmpGitDir,
      max_retries: 2,
      retry_delay_ms: 10,
    });

    expect(prResult.pr_url).toBe('https://github.com/org/repo/pull/99');
    expect(callCount).toBe(2);
  });

  // =========================================================================
  // Tiêu chí 9: Báo lỗi GH_AUTH_FAILED fail fast không retry
  // =========================================================================
  it('Nghiệm thu 9: Bắt và báo lỗi GH_AUTH_FAILED fail fast không retry khi gặp lỗi đăng nhập', async () => {
    const mockGhRunner = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: 'To authenticate, please run: gh auth login',
      exitCode: 1,
    });

    const env = setupTestEnv({ mockGhRunner });

    const feat = env.featureRepo.create({
      id: 'FEAT-AUTH-ERR',
      name: 'Auth Err Feature',
      required_tasks: ['TSK-209'],
      integration_tests: [],
    });
    env.taskRepo.create({
      id: 'TSK-209',
      feature_id: 'FEAT-AUTH-ERR',
      title: 'Task 209',
      status: 'DONE',
    });
    env.seedQGPass('TSK-209');

    await env.featureService.createFeatureBranch(feat.id, { repo_path: tmpGitDir });
    fs.writeFileSync(path.join(tmpGitDir, 'auth.ts'), 'export const auth = 1;\n');
    await env.featureService.commitFeatureRelease(feat.id, { repo_path: tmpGitDir });
    await env.featureService.pushFeatureRelease(feat.id, { repo_path: tmpGitDir });

    await expect(
      env.featureService.createFeaturePr(feat.id, {
        repo_path: tmpGitDir,
        max_retries: 3,
      }),
    ).rejects.toMatchObject({
      code: 'GH_AUTH_FAILED',
    });

    expect(mockGhRunner).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // Tiêu chí 10: REST API POST /features/:id/pr và GET /features/:id/release-report
  // =========================================================================
  it('Nghiệm thu 10: REST API POST /features/:id/pr, GET /features/:id/pr, GET /features/:id/release-report', async () => {
    const mockGhRunner = vi.fn().mockResolvedValue({
      stdout: 'https://github.com/my-org/my-repo/pull/112\n',
      stderr: '',
      exitCode: 0,
    });

    const env = setupTestEnv({ mockGhRunner });
    const server = await buildServer({
      db: env.db,
      featureService: env.featureService,
    });

    const feat = env.featureRepo.create({
      id: 'FEAT-API-PR',
      name: 'API PR Feature',
      required_tasks: ['TSK-210'],
      integration_tests: [],
    });
    env.taskRepo.create({
      id: 'TSK-210',
      feature_id: 'FEAT-API-PR',
      title: 'Task 210',
      status: 'DONE',
    });
    env.seedQGPass('TSK-210');

    await env.featureService.createFeatureBranch(feat.id, { repo_path: tmpGitDir });
    fs.writeFileSync(path.join(tmpGitDir, 'api.ts'), 'export const api = 1;\n');
    await env.featureService.commitFeatureRelease(feat.id, { repo_path: tmpGitDir });
    await env.featureService.pushFeatureRelease(feat.id, { repo_path: tmpGitDir });

    // 1. POST /features/:id/pr
    const postPrRes = await server.inject({
      method: 'POST',
      url: `/features/${feat.id}/pr`,
      payload: {
        repo_path: tmpGitDir,
        title: 'feat(FEAT-API-PR): api test pr',
      },
    });

    expect(postPrRes.statusCode).toBe(201);
    const postPrJson = JSON.parse(postPrRes.body);
    expect(postPrJson.data.pr_url).toBe('https://github.com/my-org/my-repo/pull/112');
    expect(postPrJson.data.status).toBe('READY_FOR_REVIEW');

    // 2. GET /features/:id/pr
    const getPrRes = await server.inject({
      method: 'GET',
      url: `/features/${feat.id}/pr`,
    });

    expect(getPrRes.statusCode).toBe(200);
    const getPrJson = JSON.parse(getPrRes.body);
    expect(getPrJson.data.pr_url).toBe('https://github.com/my-org/my-repo/pull/112');
    expect(getPrJson.data.pr_number).toBe(112);
    expect(getPrJson.data.status).toBe('READY_FOR_REVIEW');

    // 3. GET /features/:id/release-report
    const getRepRes = await server.inject({
      method: 'GET',
      url: `/features/${feat.id}/release-report`,
    });

    expect(getRepRes.statusCode).toBe(200);
    const getRepJson = JSON.parse(getRepRes.body);
    expect(getRepJson.data.report_content).toContain('# Feature Release Report: API PR Feature (FEAT-API-PR)');
    expect(getRepJson.data.pr_url).toBe('https://github.com/my-org/my-repo/pull/112');

    await server.close();
  });
});
