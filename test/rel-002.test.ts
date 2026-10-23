import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
  createDatabase,
  runMigrations,
  FeatureRepository,
  TaskRepository,
  QualityGateRepository,
  ReportRepository,
} from '../packages/db/src/index.js';
import { FeatureReleaseService } from '../apps/orchestrator/src/services/feature-release-service.js';
import { FeatureService } from '../apps/orchestrator/src/services/feature-service.js';
import { ProcessAdapter, type ProcessHandle } from '../apps/orchestrator/src/adapters/process-adapter.js';
import { buildServer } from '../apps/orchestrator/src/server.js';
import {
  type ProcessExitResult,
  QualityGatePolicySchema,
  QualityGateEvidenceSummarySchema,
} from '../packages/shared/src/index.js';

describe('REL-002: Kiểm tra feature đủ task + integration test (Thiếu task → chặn)', () => {
  function createMockProcessAdapter(exitCode = 0, stdout = 'PASS', stderr = '') {
    const adapter = new ProcessAdapter();
    vi.spyOn(adapter, 'spawn').mockImplementation((commandInput: unknown) => {
      const emitter = new EventEmitter() as unknown as ProcessHandle;
      Object.assign(emitter, {
        pid: 99999,
        child: { exitCode, signalCode: null } as unknown as ChildProcess,
        command: commandInput,
        startedAt: new Date(),
        isRunning: () => false,
        getExitResult: () => ({ exitCode, signal: null, durationMs: 25 }),
        waitForExit: async (): Promise<ProcessExitResult> => {
          emitter.emit('stdout', Buffer.from(stdout));
          if (stderr) emitter.emit('stderr', Buffer.from(stderr));
          return { exitCode, signal: null, durationMs: 25 };
        },
        kill: () => true,
        terminate: async () => ({ exitCode, signal: null, durationMs: 25 }),
      });
      return emitter;
    });
    return adapter;
  }

  function setupTestEnv(mockExitCode = 0, mockStdout = 'PASS', mockStderr = '') {
    const db = createDatabase(':memory:');
    runMigrations(db);

    const featureRepo = new FeatureRepository(db);
    const taskRepo = new TaskRepository(db);
    const qgRepo = new QualityGateRepository(db);
    const reportRepo = new ReportRepository(db);

    const processAdapter = createMockProcessAdapter(mockExitCode, mockStdout, mockStderr);
    const releaseService = new FeatureReleaseService(db, {
      processAdapter,
    });
    const featureService = new FeatureService(db, { releaseService });

    return {
      db,
      featureRepo,
      taskRepo,
      qgRepo,
      reportRepo,
      processAdapter,
      releaseService,
      featureService,
    };
  }

  function seedQualityGatePass(qgRepo: QualityGateRepository, taskId: string) {
    return qgRepo.create({
      id: `qg-pass-${taskId}`,
      task_id: taskId,
      run_id: null,
      repo_path: '.',
      passed: true,
      status: 'PASSED',
      summary: `Quality gate passed for ${taskId}`,
      policy: QualityGatePolicySchema.parse({}),
      rule_evaluations: [
        {
          rule_id: 'TEST_VERIFICATION',
          name: 'Unit Tests',
          stage: 'test',
          passed: true,
          status: 'PASSED',
          message: 'All unit tests passed',
          details: {},
        },
      ],
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
      duration_ms: 15,
      evaluated_at: new Date().toISOString(),
    });
  }

  function seedQualityGateFail(qgRepo: QualityGateRepository, taskId: string) {
    return qgRepo.create({
      id: `qg-fail-${taskId}`,
      task_id: taskId,
      run_id: null,
      repo_path: '.',
      passed: false,
      status: 'FAILED',
      summary: `Quality gate failed for ${taskId}: Unit test failed`,
      policy: QualityGatePolicySchema.parse({}),
      rule_evaluations: [
        {
          rule_id: 'TEST_VERIFICATION',
          name: 'Unit Tests',
          stage: 'test',
          passed: false,
          status: 'FAILED',
          message: 'Test command failed with exit code 1',
          details: {},
        },
      ],
      evidence_summary: QualityGateEvidenceSummarySchema.parse({
        cliExitCode: 1,
        cliStatus: 'FAILURE',
        cliSucceeded: false,
        totalCommands: 1,
        failedCommands: 1,
      }),
      command_records: [],
      scope_result: null,
      review_result: null,
      security_result: null,
      duration_ms: 20,
      evaluated_at: new Date().toISOString(),
    });
  }

  it('Nghiệm thu 1: Thiếu task bắt buộc trong DB -> Chặn phát hành (status BLOCKED, ném lỗi khi assert)', async () => {
    const { featureRepo, taskRepo, qgRepo, releaseService } = setupTestEnv();

    featureRepo.create({
      id: 'FEAT-MISSING-1',
      name: 'Feature with Missing Tasks',
      required_tasks: ['TASK-EXISTS', 'TASK-MISSING-IN-DB'],
    });

    taskRepo.create({
      id: 'TASK-EXISTS',
      feature_id: 'FEAT-MISSING-1',
      title: 'Valid task',
      status: 'DONE',
    });
    seedQualityGatePass(qgRepo, 'TASK-EXISTS');

    const check = await releaseService.checkReleaseReadiness('FEAT-MISSING-1');

    expect(check.can_release).toBe(false);
    expect(check.status).toBe('BLOCKED');
    expect(check.blocking_reasons).toHaveLength(1);
    expect(check.blocking_reasons[0]).toContain('TASK-MISSING-IN-DB');

    const rule = check.rule_evaluations.find((r) => r.rule_id === 'NO_MISSING_TASKS');
    expect(rule?.passed).toBe(false);
    expect(rule?.status).toBe('FAILED');

    await expect(releaseService.assertCanRelease('FEAT-MISSING-1')).rejects.toMatchObject({
      code: 'FEATURE_RELEASE_BLOCKED',
    });
  });

  it('Nghiệm thu 2: Task bắt buộc chưa đạt trạng thái DONE -> Chặn phát hành', async () => {
    const { featureRepo, taskRepo, qgRepo, releaseService } = setupTestEnv();

    featureRepo.create({
      id: 'FEAT-NOT-DONE',
      name: 'Feature with Pending Tasks',
      required_tasks: ['TASK-COMPLETED', 'TASK-STILL-TODO'],
    });

    taskRepo.create({
      id: 'TASK-COMPLETED',
      feature_id: 'FEAT-NOT-DONE',
      title: 'Completed task',
      status: 'DONE',
    });
    seedQualityGatePass(qgRepo, 'TASK-COMPLETED');

    taskRepo.create({
      id: 'TASK-STILL-TODO',
      feature_id: 'FEAT-NOT-DONE',
      title: 'Pending task',
      status: 'TODO',
    });

    const check = await releaseService.checkReleaseReadiness('FEAT-NOT-DONE');

    expect(check.can_release).toBe(false);
    expect(check.status).toBe('BLOCKED');
    expect(check.blocking_reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('TASK-STILL-TODO')]),
    );

    const rule = check.rule_evaluations.find((r) => r.rule_id === 'REQUIRED_TASKS_COMPLETED');
    expect(rule?.passed).toBe(false);
    expect(rule?.status).toBe('FAILED');

    await expect(releaseService.assertCanRelease('FEAT-NOT-DONE')).rejects.toMatchObject({
      code: 'FEATURE_RELEASE_BLOCKED',
    });
  });

  it('Nghiệm thu 3: Task bắt buộc chưa có Quality Gate PASS -> Chặn phát hành (QLT-007)', async () => {
    const { featureRepo, taskRepo, qgRepo, releaseService } = setupTestEnv();

    featureRepo.create({
      id: 'FEAT-QG-BLOCKED',
      name: 'Feature with Failing Quality Gate',
      required_tasks: ['TASK-QG-FAIL'],
    });

    taskRepo.create({
      id: 'TASK-QG-FAIL',
      feature_id: 'FEAT-QG-BLOCKED',
      title: 'Task marked DONE but failed Quality Gate',
      status: 'DONE',
    });
    seedQualityGateFail(qgRepo, 'TASK-QG-FAIL');

    const check = await releaseService.checkReleaseReadiness('FEAT-QG-BLOCKED');

    expect(check.can_release).toBe(false);
    expect(check.status).toBe('BLOCKED');
    expect(check.blocking_reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('TASK-QG-FAIL')]),
    );

    const rule = check.rule_evaluations.find((r) => r.rule_id === 'QUALITY_GATE_COMPLIANCE');
    expect(rule?.passed).toBe(false);
    expect(rule?.status).toBe('FAILED');

    await expect(releaseService.assertCanRelease('FEAT-QG-BLOCKED')).rejects.toMatchObject({
      code: 'FEATURE_RELEASE_BLOCKED',
    });
  });

  it('Nghiệm thu 4: Integration test của feature thất bại -> Chặn phát hành', async () => {
    const { featureRepo, taskRepo, qgRepo, releaseService } = setupTestEnv(
      1,
      '',
      'Integration test failed: expected 200 got 500',
    );

    featureRepo.create({
      id: 'FEAT-INT-FAIL',
      name: 'Feature with failing integration test',
      required_tasks: ['TASK-INT-1'],
      integration_tests: ['pnpm test:feature-integration'],
    });

    taskRepo.create({
      id: 'TASK-INT-1',
      feature_id: 'FEAT-INT-FAIL',
      title: 'Task 1',
      status: 'DONE',
    });
    seedQualityGatePass(qgRepo, 'TASK-INT-1');

    const check = await releaseService.checkReleaseReadiness('FEAT-INT-FAIL', {
      execute_integration_tests: true,
    });

    expect(check.can_release).toBe(false);
    expect(check.status).toBe('BLOCKED');
    expect(check.integration_test_results).toHaveLength(1);
    expect(check.integration_test_results[0]?.status).toBe('FAILURE');
    expect(check.integration_test_results[0]?.exit_code).toBe(1);

    const rule = check.rule_evaluations.find((r) => r.rule_id === 'INTEGRATION_TESTS_PASSED');
    expect(rule?.passed).toBe(false);
    expect(rule?.status).toBe('FAILED');

    await expect(
      releaseService.assertCanRelease('FEAT-INT-FAIL', { execute_integration_tests: true }),
    ).rejects.toMatchObject({
      code: 'FEATURE_RELEASE_BLOCKED',
    });
  });

  it('Nghiệm thu 5: Feature rỗng không có task -> Chặn phát hành', async () => {
    const { featureRepo, releaseService } = setupTestEnv();

    featureRepo.create({
      id: 'FEAT-ZERO-TASKS',
      name: 'Feature without any tasks',
      required_tasks: [],
    });

    const check = await releaseService.checkReleaseReadiness('FEAT-ZERO-TASKS');

    expect(check.can_release).toBe(false);
    expect(check.status).toBe('BLOCKED');

    const rule = check.rule_evaluations.find((r) => r.rule_id === 'NON_EMPTY_FEATURE');
    expect(rule?.passed).toBe(false);
    expect(rule?.status).toBe('FAILED');

    await expect(releaseService.assertCanRelease('FEAT-ZERO-TASKS')).rejects.toMatchObject({
      code: 'FEATURE_RELEASE_BLOCKED',
    });
  });

  it('Nghiệm thu 6: Đủ mọi task bắt buộc DONE + Quality Gate PASS + Integration test PASS -> READY FOR RELEASE', async () => {
    const { featureRepo, taskRepo, qgRepo, releaseService } = setupTestEnv(
      0,
      'All 15 integration tests passed in 450ms',
    );

    featureRepo.create({
      id: 'FEAT-PERFECT',
      name: 'Fully Validated Feature',
      required_tasks: ['TASK-P1', 'TASK-P2'],
      integration_tests: ['pnpm test:perf', 'pnpm test:security'],
    });

    taskRepo.create({
      id: 'TASK-P1',
      feature_id: 'FEAT-PERFECT',
      title: 'Perfect Task 1',
      status: 'DONE',
    });
    seedQualityGatePass(qgRepo, 'TASK-P1');

    taskRepo.create({
      id: 'TASK-P2',
      feature_id: 'FEAT-PERFECT',
      title: 'Perfect Task 2',
      status: 'DONE',
    });
    seedQualityGatePass(qgRepo, 'TASK-P2');

    const check = await releaseService.checkReleaseReadiness('FEAT-PERFECT', {
      execute_integration_tests: true,
    });

    expect(check.can_release).toBe(true);
    expect(check.status).toBe('READY');
    expect(check.blocking_reasons).toHaveLength(0);
    expect(check.rule_evaluations.every((r) => r.passed)).toBe(true);
    expect(check.integration_test_results).toHaveLength(2);
    expect(check.integration_test_results.every((r) => r.status === 'SUCCESS')).toBe(true);

    const assertResult = await releaseService.assertCanRelease('FEAT-PERFECT', {
      execute_integration_tests: true,
    });
    expect(assertResult.can_release).toBe(true);
  });

  it('Nghiệm thu 7: Lưu vết báo cáo vào bảng reports trong SQLite (kind: feature_release_check)', async () => {
    const { featureRepo, taskRepo, qgRepo, reportRepo, releaseService } = setupTestEnv(
      0,
      'Integration ok',
    );

    featureRepo.create({
      id: 'FEAT-AUDIT',
      name: 'Audited Feature',
      required_tasks: ['TASK-AUDIT'],
      integration_tests: ['pnpm test:audit'],
    });

    taskRepo.create({
      id: 'TASK-AUDIT',
      feature_id: 'FEAT-AUDIT',
      title: 'Audited Task',
      status: 'DONE',
    });
    seedQualityGatePass(qgRepo, 'TASK-AUDIT');

    await releaseService.checkReleaseReadiness('FEAT-AUDIT', {
      execute_integration_tests: true,
      save_report: true,
    });

    const releaseReports = reportRepo.findByKind('feature_release_check');
    expect(releaseReports.length).toBeGreaterThan(0);
    expect(releaseReports[0]?.content).toContain('FEAT-AUDIT');
    expect(releaseReports[0]?.content).toContain('READY FOR RELEASE');

    const intReports = reportRepo.findByKind('feature_integration_test');
    expect(intReports.length).toBeGreaterThan(0);
    expect(intReports[0]?.content).toContain('FEAT-AUDIT');
  });

  it('Nghiệm thu 8: REST API endpoints kiểm tra release readiness và chạy integration test', async () => {
    const { db, featureRepo, taskRepo, qgRepo, featureService } = setupTestEnv(
      0,
      'API integration passed',
    );

    featureRepo.create({
      id: 'FEAT-API-TEST',
      name: 'API Ready Feature',
      required_tasks: ['TASK-API-1'],
      integration_tests: ['pnpm test:api'],
    });

    taskRepo.create({
      id: 'TASK-API-1',
      feature_id: 'FEAT-API-TEST',
      title: 'API task',
      status: 'DONE',
    });
    seedQualityGatePass(qgRepo, 'TASK-API-1');

    const server = await buildServer({ db, featureService });

    // 1. GET /features/:id/release-check
    const getRes = await server.inject({
      method: 'GET',
      url: '/features/FEAT-API-TEST/release-check',
    });
    expect(getRes.statusCode).toBe(200);
    const body1 = JSON.parse(getRes.payload);
    expect(body1.data.feature_id).toBe('FEAT-API-TEST');
    expect(body1.data.can_release).toBe(true);
    expect(body1.data.status).toBe('READY');

    // 2. POST /features/:id/release-check với execute_integration_tests
    const postRes = await server.inject({
      method: 'POST',
      url: '/features/FEAT-API-TEST/release-check',
      payload: {
        execute_integration_tests: true,
      },
    });
    expect(postRes.statusCode).toBe(200);
    const body2 = JSON.parse(postRes.payload);
    expect(body2.data.can_release).toBe(true);
    expect(body2.data.integration_test_results).toHaveLength(1);

    // 3. POST /features/:id/integration-tests
    const testRes = await server.inject({
      method: 'POST',
      url: '/features/FEAT-API-TEST/integration-tests',
      payload: {},
    });
    expect(testRes.statusCode).toBe(200);
    const body3 = JSON.parse(testRes.payload);
    expect(body3.data.passed).toBe(true);
    expect(body3.data.records).toHaveLength(1);

    // 4. POST /features/:id/release-check với assert: true khi feature bị chặn -> trả về 422
    featureRepo.create({
      id: 'FEAT-API-FAIL',
      name: 'API Failing Feature',
      required_tasks: ['GHOST-TASK'],
    });

    const blockedRes = await server.inject({
      method: 'POST',
      url: '/features/FEAT-API-FAIL/release-check',
      payload: {
        assert: true,
      },
    });
    expect(blockedRes.statusCode).toBe(422);
    const body4 = JSON.parse(blockedRes.payload);
    expect(body4.error.code).toBe('FEATURE_RELEASE_BLOCKED');
  });
});
