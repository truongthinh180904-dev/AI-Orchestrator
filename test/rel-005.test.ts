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
  QualityGatePolicySchema,
  QualityGateEvidenceSummarySchema,
  gitPush,
  gitLsRemote,
  sanitizeGitOutput,
} from '../packages/shared/src/index.js';

describe('REL-005: Push, xử lý lỗi Git, xác nhận remote branch', () => {
  let tmpGitDir: string;
  let tmpRemoteDir: string;

  beforeEach(() => {
    // 1. Tạo bare remote repository (đóng vai trò remote origin chuẩn cho kiểm thử)
    tmpRemoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel005-remote-bare-'));
    execSync('git init --bare', { cwd: tmpRemoteDir, stdio: 'ignore' });

    // 2. Tạo local working repository
    tmpGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel005-local-repo-'));
    execSync('git init -b main', { cwd: tmpGitDir, stdio: 'ignore' });
    execSync('git config user.email "orchestrator@ai.local"', { cwd: tmpGitDir, stdio: 'ignore' });
    execSync('git config user.name "AI Orchestrator"', { cwd: tmpGitDir, stdio: 'ignore' });

    fs.writeFileSync(path.join(tmpGitDir, 'README.md'), '# AI Orchestrator REL-005 Test\n');
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
      releaseRepo,
      releaseService,
      featureService,
      seedQGPass,
    };
  }

  // =========================================================================
  // Tiêu chí 1: git ls-remote thấy branch trên remote repo
  // =========================================================================
  it('Nghiệm thu 1: git ls-remote thấy branch trên remote sau khi push', async () => {
    const env = setupTestEnv();

    // 1. Tạo feature và task hợp lệ
    const feat = env.featureRepo.create({
      id: 'FEAT-PUSH-1',
      name: 'Push Remote Verification',
      required_tasks: ['TSK-101'],
      integration_tests: [],
    });
    env.taskRepo.create({
      id: 'TSK-101',
      feature_id: 'FEAT-PUSH-1',
      title: 'Task 101 for push',
      status: 'DONE',
    });
    env.seedQGPass('TSK-101');

    // 2. Tạo feature branch an toàn (REL-003)
    const branchResult = await env.featureService.createFeatureBranch(feat.id, {
      repo_path: tmpGitDir,
      base_branch: 'main',
    });
    expect(branchResult.branch).toBe('feature/FEAT-PUSH-1');

    // 3. Commit feature release (REL-004)
    fs.writeFileSync(path.join(tmpGitDir, 'module.ts'), 'export const pushFeature = true;\n');
    const commitResult = await env.featureService.commitFeatureRelease(feat.id, {
      repo_path: tmpGitDir,
      message: 'feat(FEAT-PUSH-1): add module and release',
    });
    expect(commitResult.commit_sha).toBeDefined();

    // 4. Trước khi push: git ls-remote KHÔNG thấy branch trên remote
    const beforePush = await gitLsRemote(tmpGitDir, {
      remote: 'origin',
      branch: 'feature/FEAT-PUSH-1',
    });
    expect(beforePush.branchFound).toBe(false);
    expect(beforePush.commitSha).toBeNull();

    // 5. Thực hiện pushFeatureRelease (REL-005)
    const pushResult = await env.featureService.pushFeatureRelease(feat.id, {
      repo_path: tmpGitDir,
      remote: 'origin',
    });

    expect(pushResult.status).toBe('PUSHED');
    expect(pushResult.confirmed_remote).toBe(true);
    expect(pushResult.remote_ref).toBe('refs/heads/feature/FEAT-PUSH-1');
    expect(pushResult.commit_sha).toBe(commitResult.commit_sha);

    // 6. TIÊU CHÍ NGHIỆM THU: git ls-remote THẤY branch trên remote
    const afterPush = await gitLsRemote(tmpGitDir, {
      remote: 'origin',
      branch: 'feature/FEAT-PUSH-1',
    });
    expect(afterPush.branchFound).toBe(true);
    expect(afterPush.commitSha).toBe(commitResult.commit_sha);
    expect(afterPush.ref).toBe('refs/heads/feature/FEAT-PUSH-1');

    // Kiểm tra trực tiếp bằng lệnh git CLI độc lập
    const rawLsRemote = execSync(`git ls-remote --heads origin feature/FEAT-PUSH-1`, {
      cwd: tmpGitDir,
      encoding: 'utf-8',
    });
    expect(rawLsRemote).toContain(commitResult.commit_sha);
    expect(rawLsRemote).toContain('refs/heads/feature/FEAT-PUSH-1');
  });

  // =========================================================================
  // Tiêu chí 2: Cập nhật trạng thái PUSHED và metadata trong SQLite DB
  // =========================================================================
  it('Nghiệm thu 2: Lưu trạng thái PUSHED và metadata remote vào SQLite DB', async () => {
    const env = setupTestEnv();

    const feat = env.featureRepo.create({
      id: 'FEAT-DB-PUSH',
      name: 'DB Push Record Verification',
      required_tasks: ['TSK-102'],
      integration_tests: [],
    });
    env.taskRepo.create({
      id: 'TSK-102',
      feature_id: 'FEAT-DB-PUSH',
      title: 'Task for DB push record',
      status: 'DONE',
    });
    env.seedQGPass('TSK-102');

    await env.featureService.createFeatureBranch(feat.id, { repo_path: tmpGitDir });
    fs.writeFileSync(path.join(tmpGitDir, 'feat.js'), '// feat code\n');
    const commitRes = await env.featureService.commitFeatureRelease(feat.id, {
      repo_path: tmpGitDir,
      message: 'feat(FEAT-DB-PUSH): ready to push',
    });

    const pushResult = await env.featureService.pushFeatureRelease(feat.id, {
      repo_path: tmpGitDir,
      remote: 'origin',
    });

    // Kiểm tra bản ghi release trong database
    const dbRelease = env.releaseRepo.findByFeatureId(feat.id);
    expect(dbRelease).toBeDefined();
    expect(dbRelease?.status).toBe('PUSHED');
    expect(dbRelease?.commit_sha).toBe(commitRes.commit_sha);

    const meta = dbRelease?.metadata as Record<string, unknown>;
    expect(meta.remote).toBe('origin');
    expect(meta.remote_ref).toBe('refs/heads/feature/FEAT-DB-PUSH');
    expect(meta.remote_commit_sha).toBe(commitRes.commit_sha);
    expect(meta.confirmed_remote).toBe(true);
    expect(meta.pushed_at).toBe(pushResult.pushed_at);
  });

  // =========================================================================
  // Tiêu chí 3: Cấm push trực tiếp lên nhánh chính (main/master)
  // =========================================================================
  it('Nghiệm thu 3: Từ chối push trực tiếp lên main/master với FORBIDDEN_PUSH_BRANCH', async () => {
    await expect(
      gitPush(tmpGitDir, {
        branch: 'main',
        remote: 'origin',
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN_PUSH_BRANCH',
    });

    await expect(
      gitPush(tmpGitDir, {
        branch: 'master',
        remote: 'origin',
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN_PUSH_BRANCH',
    });
  });

  // =========================================================================
  // Tiêu chí 4: Từ chối push khi feature release chưa được commit
  // =========================================================================
  it('Nghiệm thu 4: Từ chối push khi feature release chưa commit với FEATURE_NOT_COMMITTED', async () => {
    const env = setupTestEnv();

    const feat = env.featureRepo.create({
      id: 'FEAT-NO-COMMIT',
      name: 'Uncommitted Feature',
      required_tasks: ['TSK-103'],
      integration_tests: [],
    });
    env.taskRepo.create({
      id: 'TSK-103',
      feature_id: 'FEAT-NO-COMMIT',
      title: 'Task 103',
      status: 'DONE',
    });
    env.seedQGPass('TSK-103');

    // Chỉ tạo branch, chưa gọi commitFeatureRelease (commit_sha trong DB là commit base, nhưng status vẫn BRANCH_CREATED)
    // Giả lập release record chưa có commit_sha
    await env.featureService.createFeatureBranch(feat.id, { repo_path: tmpGitDir });
    const release = env.releaseRepo.findByFeatureId(feat.id)!;
    env.releaseRepo.update(release.id, { commit_sha: null, status: 'BRANCH_CREATED' });

    await expect(
      env.featureService.pushFeatureRelease(feat.id, {
        repo_path: tmpGitDir,
        remote: 'origin',
      }),
    ).rejects.toMatchObject({
      code: 'FEATURE_NOT_COMMITTED',
    });
  });

  // =========================================================================
  // Tiêu chí 5: Xử lý lỗi Git: remote không tồn tại
  // =========================================================================
  it('Nghiệm thu 5: Bắt và báo lỗi GIT_REMOTE_NOT_FOUND khi remote không tồn tại', async () => {
    const env = setupTestEnv();

    const feat = env.featureRepo.create({
      id: 'FEAT-BAD-REMOTE',
      name: 'Bad Remote Feature',
      required_tasks: ['TSK-104'],
      integration_tests: [],
    });
    env.taskRepo.create({
      id: 'TSK-104',
      feature_id: 'FEAT-BAD-REMOTE',
      title: 'Task 104',
      status: 'DONE',
    });
    env.seedQGPass('TSK-104');

    await env.featureService.createFeatureBranch(feat.id, { repo_path: tmpGitDir });
    fs.writeFileSync(path.join(tmpGitDir, 'bad.txt'), 'content');
    await env.featureService.commitFeatureRelease(feat.id, {
      repo_path: tmpGitDir,
      message: 'feat(FEAT-BAD-REMOTE): test commit',
    });

    await expect(
      env.featureService.pushFeatureRelease(feat.id, {
        repo_path: tmpGitDir,
        remote: 'non-existent-remote-abc',
      }),
    ).rejects.toMatchObject({
      code: 'GIT_REMOTE_NOT_FOUND',
    });
  });

  // =========================================================================
  // Tiêu chí 6: Che giấu token / bí mật khi gặp lỗi Git auth
  // =========================================================================
  it('Nghiệm thu 6: Lỗi auth che giấu credentials và token không rò rỉ ra ngoài', () => {
    const rawError = 'fatal: unable to access "https://ghp_secretToken1234567890abcdefghijklmnop@github.com/org/repo.git": HTTP 401';
    const sanitized = sanitizeGitOutput(rawError);

    expect(sanitized).not.toContain('ghp_secretToken1234567890abcdefghijklmnop');
    expect(sanitized).toContain('[REDACTED_CREDENTIALS]@');
  });

  // =========================================================================
  // Tiêu chí 7: Cơ chế tự động retry khi gặp lỗi mạng tạm thời
  // =========================================================================
  it('Nghiệm thu 7: Tự động retry khi gặp lỗi mạng tạm thời và đẩy thành công', async () => {
    // Tạo branch và commit
    execSync('git checkout -b feature/auto-retry-test', { cwd: tmpGitDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpGitDir, 'retry.txt'), 'retry content');
    execSync('git add . && git commit -m "feat(retry): test auto retry"', {
      cwd: tmpGitDir,
      stdio: 'ignore',
    });
    const localSha = execSync('git rev-parse HEAD', { cwd: tmpGitDir }).toString().trim();

    let attempts = 0;
    const retryLog: number[] = [];

    const customRunner = async (args: string[], cwd: string) => {
      attempts++;
      if (attempts === 1) {
        // Lần đầu giả lập rớt mạng
        return {
          stdout: '',
          stderr: 'fatal: Could not resolve host: github.com (temporary network failure)',
          exitCode: 128,
        };
      }
      // Lần 2 thực thi lệnh git thật
      return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
        try {
          const out = execSync(`git ${args.join(' ')}`, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
          resolve({ stdout: out, stderr: '', exitCode: 0 });
        } catch (err: unknown) {
          const e = err as { stdout?: string; stderr?: string; status?: number };
          resolve({ stdout: e.stdout ?? '', stderr: e.stderr ?? String(err), exitCode: e.status ?? 1 });
        }
      });
    };

    const result = await gitPush(tmpGitDir, {
      branch: 'feature/auto-retry-test',
      remote: 'origin',
      maxRetries: 2,
      retryDelayMs: 30,
      runCommand: customRunner,
      onRetry: (attempt) => retryLog.push(attempt),
    });

    expect(attempts).toBe(2);
    expect(retryLog).toEqual([1]);
    expect(result.commitSha).toBe(localSha);
    expect(result.confirmedRemote).toBe(true);
  });

  // =========================================================================
  // Tiêu chí 8: REST API POST /features/:id/push và GET /features/:id/remote-status
  // =========================================================================
  it('Nghiệm thu 8: REST API POST /features/:id/push và GET /features/:id/remote-status hoạt động chính xác', async () => {
    const env = setupTestEnv();
    const server = await buildServer({ db: env.db, logger: false });

    const feat = env.featureRepo.create({
      id: 'FEAT-API-PUSH',
      name: 'API Push Feature',
      required_tasks: ['TSK-105'],
      integration_tests: [],
    });
    env.taskRepo.create({
      id: 'TSK-105',
      feature_id: 'FEAT-API-PUSH',
      title: 'Task 105 for API push',
      status: 'DONE',
    });
    env.seedQGPass('TSK-105');

    // 1. Tạo branch qua API
    const branchRes = await server.inject({
      method: 'POST',
      url: `/features/${feat.id}/branch`,
      payload: { repo_path: tmpGitDir },
    });
    expect(branchRes.statusCode).toBe(201);

    // 2. Commit qua API
    fs.writeFileSync(path.join(tmpGitDir, 'api-file.txt'), 'API file\n');
    const commitRes = await server.inject({
      method: 'POST',
      url: `/features/${feat.id}/commit`,
      payload: {
        repo_path: tmpGitDir,
        message: 'feat(FEAT-API-PUSH): api release commit',
      },
    });
    expect(commitRes.statusCode).toBe(201);
    const commitSha = JSON.parse(commitRes.body).data.commit_sha;

    // 3. Push qua API POST /features/:id/push
    const pushRes = await server.inject({
      method: 'POST',
      url: `/features/${feat.id}/push`,
      payload: {
        repo_path: tmpGitDir,
        remote: 'origin',
      },
    });
    expect(pushRes.statusCode).toBe(200);
    const pushData = JSON.parse(pushRes.body).data;
    expect(pushData.status).toBe('PUSHED');
    expect(pushData.confirmed_remote).toBe(true);
    expect(pushData.commit_sha).toBe(commitSha);

    // 4. Kiểm tra remote status qua GET /features/:id/remote-status
    const statusRes = await server.inject({
      method: 'GET',
      url: `/features/${feat.id}/remote-status?repo_path=${encodeURIComponent(tmpGitDir)}&remote=origin`,
    });
    expect(statusRes.statusCode).toBe(200);
    const statusData = JSON.parse(statusRes.body).data;
    expect(statusData.confirmed).toBe(true);
    expect(statusData.commit_sha).toBe(commitSha);
    expect(statusData.remote_ref).toBe('refs/heads/feature/FEAT-API-PUSH');

    // 5. Kiểm tra trực tiếp bằng git ls-remote CLI
    const lsRemoteCheck = execSync(`git ls-remote --heads origin feature/FEAT-API-PUSH`, {
      cwd: tmpGitDir,
      encoding: 'utf-8',
    });
    expect(lsRemoteCheck).toContain(commitSha);

    await server.close();
  });
});
