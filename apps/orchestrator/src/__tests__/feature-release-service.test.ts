import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createDatabase,
  runMigrations,
  FeatureRepository,
  TaskRepository,
  QualityGateRepository,
  ReportRepository,
} from '@ai-orchestrator/db';
import { FeatureReleaseService } from '../services/feature-release-service.js';
import {
  AppError,
  QualityGatePolicySchema,
  QualityGateEvidenceSummarySchema,
  type ProcessExitResult,
} from '@ai-orchestrator/shared';
import { ProcessAdapter, type ProcessHandle } from '../adapters/process-adapter.js';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

describe('FeatureReleaseService', () => {
  let db: Database.Database;
  let featureRepo: FeatureRepository;
  let taskRepo: TaskRepository;
  let releaseService: FeatureReleaseService;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    featureRepo = new FeatureRepository(db);
    taskRepo = new TaskRepository(db);
    releaseService = new FeatureReleaseService(db);
  });

  afterEach(() => {
    db.close();
  });

  it('Xác định feature và tập task bắt buộc: sắp xếp topo, phân định is_required', () => {
    featureRepo.create({
      id: 'FEAT-001',
      name: 'User Management',
      required_tasks: ['TASK-A', 'TASK-B'],
      integration_tests: ['pnpm test:user'],
    });

    // TASK-A -> TASK-B (TASK-B phụ thuộc TASK-A)
    taskRepo.create({
      id: 'TASK-A',
      feature_id: 'FEAT-001',
      title: 'Database migration',
      status: 'DONE',
      priority: 5,
    });

    taskRepo.create({
      id: 'TASK-B',
      feature_id: 'FEAT-001',
      title: 'User API service',
      status: 'DONE',
      dependencies: ['TASK-A'],
      priority: 10,
    });

    taskRepo.create({
      id: 'TASK-C',
      feature_id: 'FEAT-001',
      title: 'Optional user avatar widget',
      status: 'DONE',
      priority: 1,
    });

    const manifest = releaseService.getComponentTasks('FEAT-001');

    expect(manifest.feature_id).toBe('FEAT-001');
    expect(manifest.feature_name).toBe('User Management');
    expect(manifest.tasks).toHaveLength(3);

    // Kiểm tra thứ tự thực thi: TASK-A phải trước TASK-B do TASK-B phụ thuộc TASK-A
    const taskA = manifest.tasks.find((t) => t.id === 'TASK-A')!;
    const taskB = manifest.tasks.find((t) => t.id === 'TASK-B')!;
    const taskC = manifest.tasks.find((t) => t.id === 'TASK-C')!;

    expect(taskA.execution_order).toBeLessThan(taskB.execution_order);
    expect(taskA.is_required).toBe(true);
    expect(taskB.is_required).toBe(true);
    expect(taskC.is_required).toBe(false);

    expect(manifest.summary.total_tasks).toBe(3);
    expect(manifest.summary.required_count).toBe(2);
    expect(manifest.summary.completed_count).toBe(3);
    expect(manifest.summary.missing_count).toBe(0);
    expect(manifest.summary.is_all_required_done).toBe(true);
    expect(manifest.summary.ready_for_release).toBe(true);
  });

  it('Phát hiện task bị thiếu trong missing_task_ids khi khai báo required_tasks không tồn tại', () => {
    featureRepo.create({
      id: 'FEAT-MISSING',
      name: 'Feature with missing tasks',
      required_tasks: ['EXISTS-1', 'GHOST-TASK-999'],
    });

    taskRepo.create({
      id: 'EXISTS-1',
      feature_id: 'FEAT-MISSING',
      title: 'Existing task',
      status: 'DONE',
    });

    const manifest = releaseService.getComponentTasks('FEAT-MISSING');

    expect(manifest.missing_task_ids).toEqual(['GHOST-TASK-999']);
    expect(manifest.summary.missing_count).toBe(1);
    expect(manifest.summary.required_count).toBe(2);
    expect(manifest.summary.is_all_required_done).toBe(false);
    expect(manifest.summary.ready_for_release).toBe(false);
  });

  it('Chặn ready_for_release nếu có task bắt buộc chưa DONE (ví dụ: IN_PROGRESS hoặc FAILED)', () => {
    featureRepo.create({
      id: 'FEAT-PENDING',
      name: 'Pending feature',
      required_tasks: ['REQ-1', 'REQ-2'],
    });

    taskRepo.create({
      id: 'REQ-1',
      feature_id: 'FEAT-PENDING',
      title: 'First task',
      status: 'DONE',
    });

    taskRepo.create({
      id: 'REQ-2',
      feature_id: 'FEAT-PENDING',
      title: 'Second task',
      status: 'RUNNING',
    });

    const manifest = releaseService.getComponentTasks('FEAT-PENDING');

    expect(manifest.summary.completed_count).toBe(1);
    expect(manifest.summary.pending_count).toBe(1);
    expect(manifest.summary.is_all_required_done).toBe(false);
    expect(manifest.summary.ready_for_release).toBe(false);
  });

  it('defineFeatureTasks cập nhật required_tasks và gán task thành công', () => {
    featureRepo.create({
      id: 'FEAT-UPDATE',
      name: 'Updatable feature',
      required_tasks: ['TASK-INIT'],
    });

    taskRepo.create({ id: 'TASK-INIT', title: 'Init', status: 'DONE' });
    taskRepo.create({ id: 'TASK-NEW', title: 'New task', status: 'DONE' });

    const updated = releaseService.defineFeatureTasks('FEAT-UPDATE', {
      required_tasks: ['TASK-INIT', 'TASK-NEW'],
      assign_task_ids: ['TASK-NEW'],
    });

    expect(updated.required_task_ids).toEqual(['TASK-INIT', 'TASK-NEW']);
    expect(updated.summary.total_tasks).toBe(2);
    expect(updated.summary.required_count).toBe(2);
    expect(updated.summary.is_all_required_done).toBe(true);
    expect(updated.summary.ready_for_release).toBe(true);

    const taskNew = taskRepo.findById('TASK-NEW');
    expect(taskNew?.feature_id).toBe('FEAT-UPDATE');
  });

  it('Ném AppError(FEATURE_NOT_FOUND) khi feature không tồn tại', () => {
    expect(() => releaseService.getComponentTasks('NOT-FOUND')).toThrowError(AppError);
    expect(() => releaseService.defineFeatureTasks('NOT-FOUND', {})).toThrowError(AppError);
  });

  describe('REL-002: Kiểm tra feature đủ task + integration test (Thiếu task -> Chặn)', () => {
    let qgRepo: QualityGateRepository;
    let reportRepo: ReportRepository;

    beforeEach(() => {
      qgRepo = new QualityGateRepository(db);
      reportRepo = new ReportRepository(db);
    });

    function seedQGPass(taskId: string) {
      return qgRepo.create({
        id: `qg-pass-${taskId}`,
        task_id: taskId,
        run_id: null,
        repo_path: '.',
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
        duration_ms: 10,
        evaluated_at: new Date().toISOString(),
      });
    }

    function seedQGFail(taskId: string) {
      return qgRepo.create({
        id: `qg-fail-${taskId}`,
        task_id: taskId,
        run_id: null,
        repo_path: '.',
        passed: false,
        status: 'FAILED',
        summary: 'Lint failed with exit code 1',
        policy: QualityGatePolicySchema.parse({}),
        rule_evaluations: [],
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
        duration_ms: 10,
        evaluated_at: new Date().toISOString(),
      });
    }

    function createMockProcessAdapter(exitCode = 0, stdout = 'PASS', stderr = '') {
      const adapter = new ProcessAdapter();
      vi.spyOn(adapter, 'spawn').mockImplementation((commandInput: unknown) => {
        const emitter = new EventEmitter() as unknown as ProcessHandle;
        Object.assign(emitter, {
          pid: 12345,
          child: { exitCode, signalCode: null } as unknown as ChildProcess,
          command: commandInput,
          startedAt: new Date(),
          isRunning: () => false,
          getExitResult: () => ({ exitCode, signal: null, durationMs: 50 }),
          waitForExit: async (): Promise<ProcessExitResult> => {
            emitter.emit('stdout', Buffer.from(stdout));
            if (stderr) emitter.emit('stderr', Buffer.from(stderr));
            return { exitCode, signal: null, durationMs: 50 };
          },
          kill: () => true,
          terminate: async () => ({ exitCode, signal: null, durationMs: 50 }),
        });
        return emitter;
      });
      return adapter;
    }

    it('Tiêu chí nghiệm thu 1: Thiếu task bắt buộc trong DB -> CHẶN release', async () => {
      featureRepo.create({
        id: 'FEAT-MISSING-TASK',
        name: 'Missing Task Feature',
        required_tasks: ['TASK-EXISTS', 'TASK-NONEXISTENT'],
      });

      taskRepo.create({
        id: 'TASK-EXISTS',
        feature_id: 'FEAT-MISSING-TASK',
        title: 'Existing task',
        status: 'DONE',
      });
      seedQGPass('TASK-EXISTS');

      const check = await releaseService.checkReleaseReadiness('FEAT-MISSING-TASK');

      expect(check.can_release).toBe(false);
      expect(check.status).toBe('BLOCKED');
      expect(check.blocking_reasons).toEqual(
        expect.arrayContaining([expect.stringContaining('TASK-NONEXISTENT')]),
      );
      const missingRule = check.rule_evaluations.find((r) => r.rule_id === 'NO_MISSING_TASKS');
      expect(missingRule?.passed).toBe(false);
      expect(missingRule?.status).toBe('FAILED');

      await expect(releaseService.assertCanRelease('FEAT-MISSING-TASK')).rejects.toThrowError(
        AppError,
      );
    });

    it('Tiêu chí nghiệm thu 2: Task bắt buộc chưa ở trạng thái DONE -> CHẶN release', async () => {
      featureRepo.create({
        id: 'FEAT-INCOMPLETE',
        name: 'Incomplete Feature',
        required_tasks: ['TASK-DONE', 'TASK-RUNNING'],
      });

      taskRepo.create({
        id: 'TASK-DONE',
        feature_id: 'FEAT-INCOMPLETE',
        title: 'Done task',
        status: 'DONE',
      });

      taskRepo.create({
        id: 'TASK-RUNNING',
        feature_id: 'FEAT-INCOMPLETE',
        title: 'Running task',
        status: 'RUNNING',
      });

      const check = await releaseService.checkReleaseReadiness('FEAT-INCOMPLETE');

      expect(check.can_release).toBe(false);
      expect(check.status).toBe('BLOCKED');
      expect(check.blocking_reasons).toEqual(
        expect.arrayContaining([expect.stringContaining('TASK-RUNNING')]),
      );
      const reqRule = check.rule_evaluations.find((r) => r.rule_id === 'REQUIRED_TASKS_COMPLETED');
      expect(reqRule?.passed).toBe(false);
      expect(reqRule?.status).toBe('FAILED');

      await expect(releaseService.assertCanRelease('FEAT-INCOMPLETE')).rejects.toThrowError(
        AppError,
      );
    });

    it('Tiêu chí nghiệm thu 3: Task bắt buộc chưa vượt qua Quality Gate (QLT-007) -> CHẶN release', async () => {
      featureRepo.create({
        id: 'FEAT-QG-FAIL',
        name: 'Quality Gate Fail Feature',
        required_tasks: ['TASK-NO-QG', 'TASK-QG-FAILED'],
      });

      taskRepo.create({
        id: 'TASK-NO-QG',
        feature_id: 'FEAT-QG-FAIL',
        title: 'Task with no QG',
        status: 'DONE',
      });

      taskRepo.create({
        id: 'TASK-QG-FAILED',
        feature_id: 'FEAT-QG-FAIL',
        title: 'Task with failed QG',
        status: 'DONE',
      });

      seedQGFail('TASK-QG-FAILED');

      const check = await releaseService.checkReleaseReadiness('FEAT-QG-FAIL');

      expect(check.can_release).toBe(false);
      expect(check.status).toBe('BLOCKED');
      const qgRule = check.rule_evaluations.find((r) => r.rule_id === 'QUALITY_GATE_COMPLIANCE');
      expect(qgRule?.passed).toBe(false);
      expect(qgRule?.status).toBe('FAILED');
      expect(check.blocking_reasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining('TASK-NO-QG'),
          expect.stringContaining('TASK-QG-FAILED'),
        ]),
      );

      await expect(releaseService.assertCanRelease('FEAT-QG-FAIL')).rejects.toThrowError(AppError);
    });

    it('Tiêu chí nghiệm thu 4: Integration test của feature thất bại -> CHẶN release', async () => {
      const mockAdapter = createMockProcessAdapter(1, '', 'Integration test suite failed');
      const customReleaseService = new FeatureReleaseService(db, {
        processAdapter: mockAdapter,
      });

      featureRepo.create({
        id: 'FEAT-INTEGRATION-FAIL',
        name: 'Integration Test Failing Feature',
        required_tasks: ['TASK-OK'],
        integration_tests: ['pnpm test:e2e'],
      });

      taskRepo.create({
        id: 'TASK-OK',
        feature_id: 'FEAT-INTEGRATION-FAIL',
        title: 'Completed task',
        status: 'DONE',
      });

      seedQGPass('TASK-OK');

      const check = await customReleaseService.checkReleaseReadiness('FEAT-INTEGRATION-FAIL', {
        execute_integration_tests: true,
      });

      expect(check.can_release).toBe(false);
      expect(check.status).toBe('BLOCKED');
      expect(check.integration_test_results).toHaveLength(1);
      expect(check.integration_test_results[0]?.status).toBe('FAILURE');
      expect(check.integration_test_results[0]?.exit_code).toBe(1);

      const integrationRule = check.rule_evaluations.find(
        (r) => r.rule_id === 'INTEGRATION_TESTS_PASSED',
      );
      expect(integrationRule?.passed).toBe(false);
      expect(integrationRule?.status).toBe('FAILED');

      await expect(
        customReleaseService.assertCanRelease('FEAT-INTEGRATION-FAIL', {
          execute_integration_tests: true,
        }),
      ).rejects.toThrowError(AppError);
    });

    it('Tiêu chí nghiệm thu 5: Feature rỗng không có task -> CHẶN release', async () => {
      featureRepo.create({
        id: 'FEAT-EMPTY',
        name: 'Empty Feature',
        required_tasks: [],
      });

      const check = await releaseService.checkReleaseReadiness('FEAT-EMPTY');

      expect(check.can_release).toBe(false);
      expect(check.status).toBe('BLOCKED');
      const emptyRule = check.rule_evaluations.find((r) => r.rule_id === 'NON_EMPTY_FEATURE');
      expect(emptyRule?.passed).toBe(false);
      expect(emptyRule?.status).toBe('FAILED');
    });

    it('Tiêu chí nghiệm thu 6: Đủ task bắt buộc DONE + Quality Gate PASS + Integration test PASS -> SẴN SÀNG RELEASE', async () => {
      const mockAdapter = createMockProcessAdapter(0, 'Integration tests passed! 10 passed, 0 failed', '');
      const customReleaseService = new FeatureReleaseService(db, {
        processAdapter: mockAdapter,
      });

      featureRepo.create({
        id: 'FEAT-READY-100',
        name: 'Ready Feature 100%',
        required_tasks: ['TASK-A1', 'TASK-A2'],
        integration_tests: ['pnpm test:integration'],
      });

      taskRepo.create({
        id: 'TASK-A1',
        feature_id: 'FEAT-READY-100',
        title: 'Task A1',
        status: 'DONE',
      });

      taskRepo.create({
        id: 'TASK-A2',
        feature_id: 'FEAT-READY-100',
        title: 'Task A2',
        status: 'DONE',
      });

      seedQGPass('TASK-A1');
      seedQGPass('TASK-A2');

      const check = await customReleaseService.checkReleaseReadiness('FEAT-READY-100', {
        execute_integration_tests: true,
      });

      expect(check.can_release).toBe(true);
      expect(check.status).toBe('READY');
      expect(check.blocking_reasons).toHaveLength(0);
      expect(check.rule_evaluations.every((r) => r.passed)).toBe(true);

      const assertResult = await customReleaseService.assertCanRelease('FEAT-READY-100', {
        execute_integration_tests: true,
      });
      expect(assertResult.can_release).toBe(true);
    });

    it('Tiêu chí nghiệm thu 7: Lưu vết báo cáo vào bảng reports trong SQLite', async () => {
      const mockAdapter = createMockProcessAdapter(0, 'Tests ok', '');
      const customReleaseService = new FeatureReleaseService(db, {
        processAdapter: mockAdapter,
      });

      featureRepo.create({
        id: 'FEAT-REPORT-CHECK',
        name: 'Report Feature',
        required_tasks: ['TASK-REP'],
        integration_tests: ['pnpm test'],
      });

      taskRepo.create({
        id: 'TASK-REP',
        feature_id: 'FEAT-REPORT-CHECK',
        title: 'Report task',
        status: 'DONE',
      });

      seedQGPass('TASK-REP');

      await customReleaseService.checkReleaseReadiness('FEAT-REPORT-CHECK', {
        execute_integration_tests: true,
        save_report: true,
      });

      const reports = reportRepo.findByKind('feature_release_check');
      expect(reports.length).toBeGreaterThan(0);
      expect(reports[0]?.content).toContain('FEAT-REPORT-CHECK');
      expect(reports[0]?.content).toContain('READY FOR RELEASE');

      const integrationReports = reportRepo.findByKind('feature_integration_test');
      expect(integrationReports.length).toBeGreaterThan(0);
      expect(integrationReports[0]?.content).toContain('FEAT-REPORT-CHECK');
    });
  });
});
