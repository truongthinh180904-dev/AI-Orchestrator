/**
 * Acceptance test for UI-008: Trang release/PR — Hiện branch, SHA, PR URL
 * Dependencies: REL-006
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { buildServer } from '../apps/orchestrator/src/server.js';
import {
  createDatabase,
  runMigrations,
  FeatureRepository,
  FeatureReleaseRepository,
  TaskRepository,
} from '../packages/db/src/index.js';
import { ApiClient } from '../apps/dashboard/src/lib/api.js';

describe('UI-008 Acceptance: Trang release/PR — Hiện branch, SHA, PR URL', () => {
  let db: Database.Database;
  let server: FastifyInstance;
  let orchestratorUrl: string;
  let api: ApiClient;

  let featureRepo: FeatureRepository;
  let releaseRepo: FeatureReleaseRepository;
  let taskRepo: TaskRepository;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);

    featureRepo = new FeatureRepository(db);
    releaseRepo = new FeatureReleaseRepository(db);
    taskRepo = new TaskRepository(db);

    server = await buildServer({ db, logger: false });
    const address = await server.listen({ port: 0, host: '127.0.0.1' });
    orchestratorUrl = address;

    api = new ApiClient({
      baseUrl: orchestratorUrl,
    });
  });

  afterEach(async () => {
    if (server) {
      await server.close();
    }
    if (db) {
      db.close();
    }
  });

  it('Nghiệm thu 1: API GET /api/releases trả về danh sách release chứa branch, SHA và PR URL', async () => {
    // 1. Tạo feature
    featureRepo.create({
      id: 'FEAT-RELEASE-01',
      name: 'Authentication Module',
      description: 'Đăng nhập bảo mật',
      required_tasks: ['TSK-01'],
      integration_tests: [],
      release_policy: 'standard',
    });

    taskRepo.create({
      id: 'TSK-01',
      feature_id: 'FEAT-RELEASE-01',
      title: 'Setup auth schema',
      status: 'DONE',
    });

    // 2. Tạo bản ghi release trong database
    const fullCommitSha = '4a5b6c7d8e9f0123456789abcdef0123456789ab';
    const prUrl = 'https://github.com/my-org/ai-orchestrator/pull/42';
    const release = releaseRepo.create({
      feature_id: 'FEAT-RELEASE-01',
      branch: 'feature/FEAT-RELEASE-01',
      base_branch: 'main',
      commit_sha: fullCommitSha,
      pr_url: prUrl,
      status: 'READY_FOR_REVIEW',
      metadata: { pr_number: 42, quality_report_path: 'reports/FEAT-RELEASE-01.md' },
    });

    // 3. Gọi qua ApiClient getReleases
    const releases = await api.getReleases();
    expect(releases).toHaveLength(1);
    const item = releases[0]!;

    // Tiêu chí nghiệm thu: Hiện branch, SHA, PR URL
    expect(item.id).toBe(release.id);
    expect(item.feature_id).toBe('FEAT-RELEASE-01');
    expect(item.branch).toBe('feature/FEAT-RELEASE-01');
    expect(item.base_branch).toBe('main');
    expect(item.commit_sha).toBe(fullCommitSha);
    expect(item.pr_url).toBe(prUrl);
    expect(item.status).toBe('READY_FOR_REVIEW');
    expect(item.metadata?.pr_number).toBe(42);
  });

  it('Nghiệm thu 2: API GET /api/releases hỗ trợ bộ lọc theo feature_id và status', async () => {
    featureRepo.create({
      id: 'FEAT-A',
      name: 'Feature A',
      required_tasks: [],
    });
    featureRepo.create({
      id: 'FEAT-B',
      name: 'Feature B',
      required_tasks: [],
    });

    releaseRepo.create({
      feature_id: 'FEAT-A',
      branch: 'feature/FEAT-A',
      base_branch: 'main',
      commit_sha: '1'.repeat(40),
      pr_url: 'https://github.com/org/repo/pull/1',
      status: 'READY_FOR_REVIEW',
    });

    releaseRepo.create({
      feature_id: 'FEAT-B',
      branch: 'feature/FEAT-B',
      base_branch: 'main',
      commit_sha: '2'.repeat(40),
      pr_url: null,
      status: 'PUSHED',
    });

    // Lọc theo feature_id
    const featAReleases = await api.getReleases({ feature_id: 'FEAT-A' });
    expect(featAReleases).toHaveLength(1);
    expect(featAReleases[0]?.feature_id).toBe('FEAT-A');

    // Lọc theo status
    const pushedReleases = await api.getReleases({ status: 'PUSHED' });
    expect(pushedReleases).toHaveLength(1);
    expect(pushedReleases[0]?.feature_id).toBe('FEAT-B');
    expect(pushedReleases[0]?.status).toBe('PUSHED');

    // Lọc không khớp
    const emptyReleases = await api.getReleases({ status: 'MERGED' });
    expect(emptyReleases).toHaveLength(0);
  });

  it('Nghiệm thu 3: API GET /api/features/:id/pr trả về chi tiết branch, SHA, PR URL', async () => {
    featureRepo.create({
      id: 'FEAT-PR-TEST',
      name: 'PR Query Test',
      required_tasks: [],
    });

    const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4';
    const prUrl = 'https://github.com/org/repo/pull/88';

    releaseRepo.create({
      feature_id: 'FEAT-PR-TEST',
      branch: 'feature/FEAT-PR-TEST',
      base_branch: 'dev',
      commit_sha: sha,
      pr_url: prUrl,
      status: 'PR_CREATED',
      metadata: { pr_number: 88 },
    });

    const prInfo = await api.getFeaturePr('FEAT-PR-TEST');
    expect(prInfo.feature_id).toBe('FEAT-PR-TEST');
    expect(prInfo.branch).toBe('feature/FEAT-PR-TEST');
    expect(prInfo.base_branch).toBe('dev');
    expect(prInfo.commit_sha).toBe(sha);
    expect(prInfo.pr_url).toBe(prUrl);
    expect(prInfo.pr_number).toBe(88);
    expect(prInfo.status).toBe('PR_CREATED');
  });

  it('Nghiệm thu 4: API GET /api/features/:id/release-report trả về nội dung báo cáo phát hành', async () => {
    featureRepo.create({
      id: 'FEAT-REP-TEST',
      name: 'Report Test',
      required_tasks: ['TSK-REP'],
    });

    taskRepo.create({
      id: 'TSK-REP',
      feature_id: 'FEAT-REP-TEST',
      title: 'Do task',
      status: 'DONE',
    });

    releaseRepo.create({
      feature_id: 'FEAT-REP-TEST',
      branch: 'feature/FEAT-REP-TEST',
      base_branch: 'main',
      commit_sha: 'c'.repeat(40),
      pr_url: 'https://github.com/org/repo/pull/12',
      status: 'READY_FOR_REVIEW',
    });

    const report = await api.getFeatureReleaseReport('FEAT-REP-TEST');
    expect(report.feature_id).toBe('FEAT-REP-TEST');
    expect(report.branch).toBe('feature/FEAT-REP-TEST');
    expect(report.commit_sha).toBe('c'.repeat(40));
    expect(report.pr_url).toBe('https://github.com/org/repo/pull/12');
    expect(report.report_content).toContain('# Feature Release Report: Report Test (FEAT-REP-TEST)');
  });
});
