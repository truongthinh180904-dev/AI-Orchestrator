import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  FeatureRepository,
  TaskRepository,
  QualityGateRepository,
  ReportRepository,
  FeatureReleaseRepository,
} from '@ai-orchestrator/db';
import {
  type FeatureComponentTasksResult,
  type FeatureComponentTask,
  type FeatureTaskSummary,
  type DefineFeatureTasksInput,
  type FeatureReleaseCheckResult,
  type FeatureReleaseCheckRule,
  type FeatureIntegrationTestRecord,
  type CheckReleaseReadinessInput,
  type CreateFeatureBranchInput,
  type CreateFeatureBranchResult,
  type FeatureBranchInfo,
  type CommitFeatureReleaseInput,
  type CommitFeatureReleaseResult,
  type PushFeatureReleaseInput,
  type PushFeatureReleaseResult,
  type ConfirmRemoteBranchInput,
  type ConfirmRemoteBranchResult,
  type CreateFeaturePrInput,
  type CreateFeaturePrResult,
  type FeatureReleaseReportResult,
  type FeatureRelease,
  FeatureComponentTasksResultSchema,
  DefineFeatureTasksInputSchema,
  FeatureReleasePolicyOptionsSchema,
  FeatureReleaseCheckResultSchema,
  CheckReleaseReadinessInputSchema,
  CreateFeatureBranchInputSchema,
  CreateFeatureBranchResultSchema,
  FeatureBranchInfoSchema,
  CommitFeatureReleaseInputSchema,
  CommitFeatureReleaseResultSchema,
  PushFeatureReleaseInputSchema,
  PushFeatureReleaseResultSchema,
  ConfirmRemoteBranchInputSchema,
  ConfirmRemoteBranchResultSchema,
  CreateFeaturePrInputSchema,
  CreateFeaturePrResultSchema,
  FeatureReleaseReportResultSchema,
  formatFeatureReleaseCheckMarkdownReport,
  generateFeatureReleaseReportMarkdown,
  parseCommandLine,
  validateGitBranchName,
  gitBranchExists,
  gitCreateBranch,
  gitCommit,
  gitPush,
  gitConfirmRemoteBranch,
  gitGetCurrentBranch,
  runGitCommand,
  ghPrCreate,
  formatConventionalCommit,
  validateConventionalCommit,
  AppError,
  logger as defaultLogger,
  type Logger,
} from '@ai-orchestrator/shared';
import { ProcessAdapter } from '../adapters/process-adapter.js';

export interface FeatureReleaseServiceOptions {
  logger?: Logger;
  qualityGateRepo?: QualityGateRepository;
  reportRepo?: ReportRepository;
  releaseRepo?: FeatureReleaseRepository;
  processAdapter?: ProcessAdapter;
  ghRunner?: (
    args: string[],
    cwd: string,
    env?: Record<string, string>,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/**
 * Service quản lý vòng đời phát hành tính năng (Feature Release - REL-*).
 * Chịu trách nhiệm xác định feature, tập task bắt buộc, điều kiện nghiệm thu và điều phối bàn giao.
 */
export class FeatureReleaseService {
  private readonly featureRepo: FeatureRepository;
  private readonly taskRepo: TaskRepository;
  private readonly qualityGateRepo: QualityGateRepository;
  private readonly reportRepo: ReportRepository;
  private readonly releaseRepo: FeatureReleaseRepository;
  private readonly processAdapter: ProcessAdapter;
  private readonly logger: Logger;
  private readonly ghRunner?: (
    args: string[],
    cwd: string,
    env?: Record<string, string>,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

  constructor(
    private readonly db: Database.Database,
    options?: FeatureReleaseServiceOptions,
  ) {
    this.featureRepo = new FeatureRepository(db);
    this.taskRepo = new TaskRepository(db);
    this.qualityGateRepo = options?.qualityGateRepo ?? new QualityGateRepository(db);
    this.reportRepo = options?.reportRepo ?? new ReportRepository(db);
    this.releaseRepo = options?.releaseRepo ?? new FeatureReleaseRepository(db);
    this.processAdapter = options?.processAdapter ?? new ProcessAdapter();
    this.logger = options?.logger ?? defaultLogger;
    this.ghRunner = options?.ghRunner;
  }

  /**
   * Xác định feature và tập task bắt buộc (Danh sách task thành phần).
   * Nghiệm thu REL-001: Trả về danh sách task thành phần có cấu trúc,
   * phân định rõ task bắt buộc, phát hiện task thiếu, và tính toán thứ tự thực thi topo.
   */
  getComponentTasks(featureId: string): FeatureComponentTasksResult {
    const { feature, tasks } = this.featureRepo.getComponentTasks(featureId);

    // 1. Phát hiện các task bắt buộc được khai báo nhưng chưa tồn tại trong DB
    const foundTaskIds = new Set(tasks.map((t) => t.id));
    const missingTaskIds = feature.required_tasks.filter((reqId) => !foundTaskIds.has(reqId));

    // 2. Tính toán thứ tự thực thi topo theo đồ thị phụ thuộc
    const allTaskIds = tasks.map((t) => t.id);
    let executionOrderIds: string[];
    try {
      executionOrderIds = this.taskRepo.getExecutionOrder(allTaskIds);
    } catch {
      // Fallback nếu có cycle hoặc lỗi topo
      executionOrderIds = allTaskIds;
    }

    const orderMap = new Map<string, number>();
    executionOrderIds.forEach((id, idx) => {
      orderMap.set(id, idx + 1);
    });

    // 3. Phân định từng task thành phần
    const hasExplicitRequiredList = feature.required_tasks.length > 0;
    const componentTasks: FeatureComponentTask[] = tasks.map((t) => {
      // Nếu feature có danh sách required_tasks rõ ràng: chỉ các task trong danh sách mới là bắt buộc.
      // Nếu feature không có required_tasks: mặc định tất cả task gán cho feature đều là bắt buộc.
      const isRequired = hasExplicitRequiredList
        ? feature.required_tasks.includes(t.id)
        : true;

      const order = orderMap.get(t.id) ?? 0;

      return {
        id: t.id,
        feature_id: t.feature_id,
        title: t.title,
        description: t.description ?? null,
        phase: t.phase ?? null,
        priority: t.priority ?? 0,
        status: t.status,
        worker_type: t.worker_type ?? 'agy',
        repository: t.repository ?? '.',
        acceptance_criteria: t.acceptance_criteria ?? [],
        test_commands: t.test_commands ?? [],
        scope_files: t.scope_files ?? null,
        dependencies: t.dependencies ?? [],
        is_required: isRequired,
        execution_order: order,
      };
    });

    // 4. Sắp xếp danh sách task thành phần: thứ tự topo ASC -> priority DESC -> id ASC
    componentTasks.sort((a, b) => {
      if (a.execution_order !== b.execution_order) {
        return a.execution_order - b.execution_order;
      }
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return a.id.localeCompare(b.id);
    });

    // 5. Thống kê tổng quan
    const requiredTasks = componentTasks.filter((t) => t.is_required);
    const completedTasks = componentTasks.filter((t) => t.status === 'DONE');
    const pendingTasks = componentTasks.filter((t) =>
      ['TODO', 'READY', 'RUNNING', 'VERIFYING'].includes(t.status),
    );
    const failedTasks = componentTasks.filter((t) =>
      ['FAILED', 'BLOCKED', 'CANCELLED'].includes(t.status),
    );

    const requiredCount = requiredTasks.length + missingTaskIds.length;
    const isAllRequiredDone =
      missingTaskIds.length === 0 &&
      requiredCount > 0 &&
      requiredTasks.every((t) => t.status === 'DONE');
    const readyForRelease = isAllRequiredDone;

    const summary: FeatureTaskSummary = {
      total_tasks: componentTasks.length,
      required_count: requiredCount,
      completed_count: completedTasks.length,
      pending_count: pendingTasks.length,
      failed_count: failedTasks.length,
      missing_count: missingTaskIds.length,
      is_all_required_done: isAllRequiredDone,
      ready_for_release: readyForRelease,
    };

    const result: FeatureComponentTasksResult = {
      feature_id: feature.id,
      feature_name: feature.name,
      description: feature.description ?? null,
      status: feature.status,
      release_policy: feature.release_policy ?? null,
      integration_tests: feature.integration_tests ?? [],
      required_task_ids: feature.required_tasks ?? [],
      all_task_ids: componentTasks.map((t) => t.id),
      tasks: componentTasks,
      missing_task_ids: missingTaskIds,
      summary,
    };

    this.logger.info(`Resolved component tasks for feature '${featureId}'`, {
      featureId,
      totalTasks: summary.total_tasks,
      requiredCount: summary.required_count,
      completedCount: summary.completed_count,
      missingCount: summary.missing_count,
      readyForRelease: summary.ready_for_release,
    });

    return FeatureComponentTasksResultSchema.parse(result);
  }

  /**
   * Định nghĩa hoặc cập nhật tập task bắt buộc và các task thành phần của feature.
   */
  defineFeatureTasks(
    featureId: string,
    input: DefineFeatureTasksInput,
  ): FeatureComponentTasksResult {
    const validated = DefineFeatureTasksInputSchema.parse(input);

    const feature = this.featureRepo.findById(featureId);
    if (!feature) {
      throw new AppError('FEATURE_NOT_FOUND', `Feature with id '${featureId}' not found`, {
        featureId,
      });
    }

    const tx = this.db.transaction(() => {
      if (validated.required_tasks !== undefined) {
        this.featureRepo.setRequiredTasks(featureId, validated.required_tasks);
      }

      if (validated.assign_task_ids && validated.assign_task_ids.length > 0) {
        this.featureRepo.assignTasks(featureId, validated.assign_task_ids);
      }

      if (validated.unassign_task_ids && validated.unassign_task_ids.length > 0) {
        this.featureRepo.unassignTasks(featureId, validated.unassign_task_ids);
      }
    });

    tx();

    return this.getComponentTasks(featureId);
  }

  /**
   * Chạy các lệnh kiểm thử tích hợp (integration tests) được khai báo trên feature.
   */
  async runIntegrationTests(
    featureId: string,
    options?: { repoPath?: string; timeoutMs?: number; saveReport?: boolean },
  ): Promise<FeatureIntegrationTestRecord[]> {
    const manifest = this.getComponentTasks(featureId);
    const testCommands = manifest.integration_tests;
    const records: FeatureIntegrationTestRecord[] = [];
    const cwd = options?.repoPath ?? '.';
    const defaultTimeoutMs = options?.timeoutMs ?? 120_000;

    for (const cmdStr of testCommands) {
      const startTime = Date.now();
      let stdout = '';
      let stderr = '';
      let exitCode: number | null = null;
      let status: 'SUCCESS' | 'FAILURE' | 'TIMEOUT' | 'ERROR';
      let timedOut = false;
      let timeoutTimer: NodeJS.Timeout | null = null;

      try {
        const parsed = parseCommandLine(cmdStr);
        const handle = this.processAdapter.spawn({
          exe: parsed.exe,
          args: parsed.args,
          cwd,
        });

        handle.on('stdout', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });

        handle.on('stderr', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });

        if (defaultTimeoutMs > 0) {
          timeoutTimer = setTimeout(async () => {
            timedOut = true;
            try {
              await handle.terminate({ gracePeriodMs: 1500 });
            } catch {
              handle.kill('SIGKILL');
            }
          }, defaultTimeoutMs);
        }

        const exitResult = await handle.waitForExit();
        exitCode = exitResult.exitCode;

        if (timedOut) {
          status = 'TIMEOUT';
        } else if (exitCode === 0) {
          status = 'SUCCESS';
        } else {
          status = 'FAILURE';
        }
      } catch (err) {
        if (timedOut) {
          status = 'TIMEOUT';
        } else {
          status = 'ERROR';
          const errMsg = err instanceof Error ? err.message : String(err);
          stderr += (stderr ? '\n' : '') + `Execution error: ${errMsg}`;
        }
      } finally {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
      }

      const durationMs = Math.max(0, Date.now() - startTime);
      records.push({
        command: cmdStr,
        status,
        exit_code: exitCode,
        stdout,
        stderr,
        duration_ms: durationMs,
      });
    }

    if (options?.saveReport !== false && this.reportRepo && records.length > 0) {
      try {
        const now = new Date().toISOString();
        this.reportRepo.create({
          id: crypto.randomUUID(),
          run_id: null,
          kind: 'feature_integration_test',
          content: JSON.stringify(
            {
              feature_id: featureId,
              records,
              passed: records.every((r) => r.status === 'SUCCESS'),
              executed_at: now,
            },
            null,
            2,
          ),
          created_at: now,
        });
      } catch (err) {
        this.logger.warn(`Failed to save integration test report: ${(err as Error).message}`, {
          featureId,
        });
      }
    }

    return records;
  }

  /**
   * Kiểm tra điều kiện release của feature: đủ task bắt buộc, Quality Gate pass, integration test pass.
   * Nghiệm thu REL-002: Thiếu task hoặc kiểm thử thất bại -> CHẶN.
   */
  async checkReleaseReadiness(
    featureId: string,
    options?: CheckReleaseReadinessInput,
  ): Promise<FeatureReleaseCheckResult> {
    const input = CheckReleaseReadinessInputSchema.parse(options ?? {});
    const policy = FeatureReleasePolicyOptionsSchema.parse(input.policy ?? {});
    const manifest = this.getComponentTasks(featureId);

    const blockingReasons: string[] = [];
    const ruleEvaluations: FeatureReleaseCheckRule[] = [];

    // Rule 1: Non-Empty Feature
    const totalComponentTasks = manifest.all_task_ids.length + manifest.missing_task_ids.length;
    if (policy.require_non_empty && totalComponentTasks === 0) {
      const msg = `Feature '${featureId}' has no component tasks`;
      blockingReasons.push(msg);
      ruleEvaluations.push({
        rule_id: 'NON_EMPTY_FEATURE',
        name: 'Non-Empty Feature',
        passed: false,
        status: 'FAILED',
        message: msg,
        details: {},
      });
    } else {
      ruleEvaluations.push({
        rule_id: 'NON_EMPTY_FEATURE',
        name: 'Non-Empty Feature',
        passed: true,
        status: 'PASSED',
        message: `Feature contains ${manifest.all_task_ids.length} component task(s)`,
        details: { total_tasks: manifest.all_task_ids.length },
      });
    }

    // Rule 2: No Missing Tasks (Thiếu task -> Chặn)
    if (policy.require_no_missing_tasks && manifest.missing_task_ids.length > 0) {
      for (const missingId of manifest.missing_task_ids) {
        blockingReasons.push(`Missing required task '${missingId}' not found in database`);
      }
      ruleEvaluations.push({
        rule_id: 'NO_MISSING_TASKS',
        name: 'No Missing Tasks',
        passed: false,
        status: 'FAILED',
        message: `Feature has ${manifest.missing_task_ids.length} missing required task(s): ${manifest.missing_task_ids.join(', ')}`,
        details: { missing_task_ids: manifest.missing_task_ids },
      });
    } else {
      ruleEvaluations.push({
        rule_id: 'NO_MISSING_TASKS',
        name: 'No Missing Tasks',
        passed: true,
        status: 'PASSED',
        message: 'All required tasks exist in database',
        details: {},
      });
    }

    // Rule 3: Required Tasks Completed (Chưa xong task bắt buộc -> Chặn)
    const requiredTasks = manifest.tasks.filter((t) => t.is_required);
    if (policy.require_all_required_done) {
      const incompleteTasks = requiredTasks.filter((t) => t.status !== 'DONE');
      if (incompleteTasks.length > 0) {
        for (const t of incompleteTasks) {
          blockingReasons.push(`Required task '${t.id}' is not completed (current status: '${t.status}')`);
        }
        ruleEvaluations.push({
          rule_id: 'REQUIRED_TASKS_COMPLETED',
          name: 'Required Tasks Completed',
          passed: false,
          status: 'FAILED',
          message: `${incompleteTasks.length} required task(s) are not in DONE status`,
          details: { incomplete_tasks: incompleteTasks.map((t) => ({ id: t.id, status: t.status })) },
        });
      } else {
        ruleEvaluations.push({
          rule_id: 'REQUIRED_TASKS_COMPLETED',
          name: 'Required Tasks Completed',
          passed: true,
          status: 'PASSED',
          message: `All ${requiredTasks.length} required task(s) are completed (DONE)`,
          details: { completed_count: requiredTasks.length },
        });
      }
    } else {
      ruleEvaluations.push({
        rule_id: 'REQUIRED_TASKS_COMPLETED',
        name: 'Required Tasks Completed',
        passed: true,
        status: 'SKIPPED',
        message: 'Required tasks completion check is skipped by policy',
        details: {},
      });
    }

    // Rule 4: Quality Gate Compliance (QLT-007)
    if (policy.require_quality_gate_passed) {
      let qgPassed = true;
      const failedQualityGates: Array<{ task_id: string; reason: string }> = [];

      for (const t of requiredTasks) {
        const latestGate = this.qualityGateRepo.findLatestByTaskId(t.id);
        if (!latestGate) {
          const reason = `Task '${t.id}' does not have a Quality Gate verification record`;
          blockingReasons.push(reason);
          failedQualityGates.push({ task_id: t.id, reason });
          qgPassed = false;
        } else if (!latestGate.passed || latestGate.status !== 'PASSED') {
          const reason = `Task '${t.id}' failed Quality Gate evaluation (${latestGate.status}: ${latestGate.summary})`;
          blockingReasons.push(reason);
          failedQualityGates.push({ task_id: t.id, reason });
          qgPassed = false;
        }
      }

      if (!qgPassed) {
        ruleEvaluations.push({
          rule_id: 'QUALITY_GATE_COMPLIANCE',
          name: 'Quality Gate Compliance',
          passed: false,
          status: 'FAILED',
          message: `${failedQualityGates.length} required task(s) failed or lack Quality Gate verification`,
          details: { failed_quality_gates: failedQualityGates },
        });
      } else {
        ruleEvaluations.push({
          rule_id: 'QUALITY_GATE_COMPLIANCE',
          name: 'Quality Gate Compliance',
          passed: true,
          status: 'PASSED',
          message: `All ${requiredTasks.length} required task(s) passed Quality Gate verification`,
          details: {},
        });
      }
    } else {
      ruleEvaluations.push({
        rule_id: 'QUALITY_GATE_COMPLIANCE',
        name: 'Quality Gate Compliance',
        passed: true,
        status: 'SKIPPED',
        message: 'Quality Gate compliance check is disabled by policy',
        details: {},
      });
    }

    // Rule 5: Integration Tests Passed
    let integrationRecords: FeatureIntegrationTestRecord[] = [];
    if (manifest.integration_tests.length === 0) {
      if (policy.require_integration_tests) {
        const msg = `Feature '${featureId}' requires integration tests, but none are defined`;
        blockingReasons.push(msg);
        ruleEvaluations.push({
          rule_id: 'INTEGRATION_TESTS_PASSED',
          name: 'Integration Tests Passed',
          passed: false,
          status: 'FAILED',
          message: msg,
          details: {},
        });
      } else {
        ruleEvaluations.push({
          rule_id: 'INTEGRATION_TESTS_PASSED',
          name: 'Integration Tests Passed',
          passed: true,
          status: 'SKIPPED',
          message: 'No integration tests configured for this feature',
          details: {},
        });
      }
    } else {
      // Feature has integration tests
      if (input.execute_integration_tests) {
        integrationRecords = await this.runIntegrationTests(featureId, {
          repoPath: input.repo_path,
        });

        const failedTests = integrationRecords.filter((r) => r.status !== 'SUCCESS');
        if (failedTests.length > 0) {
          for (const f of failedTests) {
            blockingReasons.push(
              `Integration test failed: '${f.command}' (status: ${f.status}, exit code: ${f.exit_code ?? 'null'})`,
            );
          }
          ruleEvaluations.push({
            rule_id: 'INTEGRATION_TESTS_PASSED',
            name: 'Integration Tests Passed',
            passed: false,
            status: 'FAILED',
            message: `${failedTests.length} of ${integrationRecords.length} integration test(s) failed`,
            details: { failed_tests: failedTests },
          });
        } else {
          ruleEvaluations.push({
            rule_id: 'INTEGRATION_TESTS_PASSED',
            name: 'Integration Tests Passed',
            passed: true,
            status: 'PASSED',
            message: `All ${integrationRecords.length} integration test(s) passed successfully`,
            details: { total_tests: integrationRecords.length },
          });
        }
      } else {
        // Not executed
        if (policy.require_integration_tests) {
          const msg = `Integration tests are configured (${manifest.integration_tests.length}) but execution was not performed`;
          blockingReasons.push(msg);
          ruleEvaluations.push({
            rule_id: 'INTEGRATION_TESTS_PASSED',
            name: 'Integration Tests Passed',
            passed: false,
            status: 'FAILED',
            message: msg,
            details: { configured_tests: manifest.integration_tests },
          });
        } else {
          ruleEvaluations.push({
            rule_id: 'INTEGRATION_TESTS_PASSED',
            name: 'Integration Tests Passed',
            passed: true,
            status: 'WARNING',
            message: `${manifest.integration_tests.length} integration test(s) configured; run with execute_integration_tests=true to verify`,
            details: { configured_tests: manifest.integration_tests },
          });
        }
      }
    }

    const canRelease = blockingReasons.length === 0;
    const status: 'READY' | 'BLOCKED' = canRelease ? 'READY' : 'BLOCKED';
    const checkedAt = new Date().toISOString();

    const result: FeatureReleaseCheckResult = {
      feature_id: manifest.feature_id,
      feature_name: manifest.feature_name,
      can_release: canRelease,
      status,
      blocking_reasons: blockingReasons,
      rule_evaluations: ruleEvaluations,
      task_summary: manifest.summary,
      manifest,
      integration_test_results: integrationRecords,
      checked_at: checkedAt,
    };

    if (input.save_report !== false && this.reportRepo) {
      try {
        const reportContent = formatFeatureReleaseCheckMarkdownReport(result);
        this.reportRepo.create({
          id: crypto.randomUUID(),
          run_id: null,
          kind: 'feature_release_check',
          content: reportContent,
          created_at: checkedAt,
        });
      } catch (err) {
        this.logger.warn(`Failed to save feature release check report: ${(err as Error).message}`, {
          featureId,
        });
      }
    }

    this.logger.info(`Release check completed for feature '${featureId}': ${status}`, {
      featureId,
      canRelease,
      status,
      blockingCount: blockingReasons.length,
    });

    return FeatureReleaseCheckResultSchema.parse(result);
  }

  /**
   * Khẳng định tính sẵn sàng phát hành của feature.
   * Nếu điều kiện release không đạt -> ném AppError('FEATURE_RELEASE_BLOCKED') kèm lý do cụ thể.
   */
  async assertCanRelease(
    featureId: string,
    options?: CheckReleaseReadinessInput,
  ): Promise<FeatureReleaseCheckResult> {
    const result = await this.checkReleaseReadiness(featureId, options);
    if (!result.can_release) {
      throw new AppError(
        'FEATURE_RELEASE_BLOCKED',
        `Feature '${featureId}' cannot be released: ${result.blocking_reasons.join('; ')}`,
        {
          featureId,
          blocking_reasons: result.blocking_reasons,
          checkResult: result,
        },
      );
    }
    return result;
  }

  /**
   * Tạo branch feature an toàn (không ghi đè) - REL-003.
   * Tiêu chí nghiệm thu: Branch trùng → lỗi (AppError 'BRANCH_ALREADY_EXISTS').
   *
   * Quy tắc an toàn (SKILL-git-release.md):
   * - Branch format: feature/<feature-id> (hoặc branch_name hợp lệ).
   * - Branch đã tồn tại (ở Git hoặc DB) -> lỗi, không ghi đè.
   * - Trước khi tạo branch: git status --porcelain phải rỗng (require_clean).
   * - Lưu vết vào bảng feature_releases trong DB.
   */
  async createFeatureBranch(
    featureId: string,
    options?: CreateFeatureBranchInput,
  ): Promise<CreateFeatureBranchResult> {
    const feature = this.featureRepo.findById(featureId);
    if (!feature) {
      throw new AppError('FEATURE_NOT_FOUND', `Feature '${featureId}' not found`, { featureId });
    }

    const input = CreateFeatureBranchInputSchema.parse(options ?? {});
    const repoPath = path.resolve(input.repo_path ?? '.');

    // 1. Kiểm tra tính sẵn sàng phát hành (trừ khi skip_readiness_check = true)
    if (!input.skip_readiness_check) {
      await this.assertCanRelease(featureId, { repo_path: repoPath });
    }

    // 2. Xác định branch name: mặc định 'feature/<feature-id>' theo SKILL-git-release.md
    const branchName = input.branch_name ?? `feature/${featureId}`;
    validateGitBranchName(branchName);

    // 3. Kiểm tra DB xem branch đã được đăng ký chưa
    const existingReleaseByBranch = this.releaseRepo.findByBranch(branchName);
    if (existingReleaseByBranch) {
      throw new AppError(
        'BRANCH_ALREADY_EXISTS',
        `Feature branch '${branchName}' already exists in database (release ID: ${existingReleaseByBranch.id}). Overwriting is strictly prohibited.`,
        {
          featureId,
          branch: branchName,
          releaseId: existingReleaseByBranch.id,
        },
      );
    }

    // 4. Gọi gitCreateBranch: kiểm tra repo sạch, kiểm tra branch Git đã tồn tại (Branch trùng -> lỗi),
    // tạo branch an toàn chỉ định base branch mà không ghi đè.
    const gitResult = await gitCreateBranch(repoPath, {
      branchName,
      baseBranch: input.base_branch,
      requireClean: input.require_clean,
      checkout: input.checkout,
      checkRemote: input.check_remote,
    });

    // 5. Lưu thông tin release vào database (feature_releases)
    const releaseId = crypto.randomUUID();
    const releaseRecord = this.releaseRepo.create({
      id: releaseId,
      feature_id: featureId,
      branch: branchName,
      base_branch: gitResult.baseBranch,
      commit_sha: gitResult.commitSha,
      status: 'BRANCH_CREATED',
      metadata: {
        repo_path: repoPath,
        created_via: 'FeatureReleaseService.createFeatureBranch',
      },
    });

    this.logger.info(`Feature branch created safely for '${featureId}': ${branchName}`, {
      featureId,
      branch: branchName,
      baseBranch: gitResult.baseBranch,
      commitSha: gitResult.commitSha,
      releaseId: releaseRecord.id,
    });

    return CreateFeatureBranchResultSchema.parse({
      release_id: releaseRecord.id,
      feature_id: feature.id,
      feature_name: feature.name,
      branch: branchName,
      base_branch: gitResult.baseBranch,
      commit_sha: gitResult.commitSha,
      created: true,
      status: 'BRANCH_CREATED',
      repo_path: repoPath,
      created_at: releaseRecord.created_at,
    });
  }

  /**
   * Lấy thông tin branch phát hành của feature.
   */
  async getFeatureBranchInfo(
    featureId: string,
    repoPath?: string,
  ): Promise<FeatureBranchInfo | null> {
    const feature = this.featureRepo.findById(featureId);
    if (!feature) {
      throw new AppError('FEATURE_NOT_FOUND', `Feature '${featureId}' not found`, { featureId });
    }

    const release = this.releaseRepo.findByFeatureId(featureId);
    if (!release) {
      return null;
    }

    const resolvedRepo = path.resolve(repoPath ?? '.');
    let existsLocally: boolean;
    try {
      existsLocally = await gitBranchExists(resolvedRepo, release.branch);
    } catch {
      existsLocally = false;
    }

    return FeatureBranchInfoSchema.parse({
      release_id: release.id,
      feature_id: featureId,
      branch: release.branch,
      base_branch: release.base_branch,
      commit_sha: release.commit_sha,
      status: release.status,
      exists_locally: existsLocally,
      created_at: release.created_at,
    });
  }

  /**
   * Tạo commit chuẩn hóa (Conventional Commits) cho feature release và lưu SHA vào DB (REL-004).
   */
  async commitFeatureRelease(
    featureId: string,
    input?: CommitFeatureReleaseInput,
  ): Promise<CommitFeatureReleaseResult> {
    const validatedInput = CommitFeatureReleaseInputSchema.parse(input ?? {});

    const feature = this.featureRepo.findById(featureId);
    if (!feature) {
      throw new AppError('FEATURE_NOT_FOUND', `Feature '${featureId}' not found`, { featureId });
    }

    const release = this.releaseRepo.findByFeatureId(featureId);
    if (!release) {
      throw new AppError(
        'FEATURE_BRANCH_NOT_FOUND',
        `No release branch found for feature '${featureId}'. Call createFeatureBranch first.`,
        { featureId },
      );
    }

    // Resolve commit message:
    let message: string;
    if (validatedInput.message && validatedInput.message.trim().length > 0) {
      message = validatedInput.message.trim();
      validateConventionalCommit(message);
    } else {
      const type = (validatedInput.type || 'feat') as
        | 'feat'
        | 'fix'
        | 'docs'
        | 'style'
        | 'refactor'
        | 'perf'
        | 'test'
        | 'build'
        | 'ci'
        | 'chore'
        | 'revert';
      const scope = validatedInput.scope || featureId;
      const subject = validatedInput.subject || `release feature ${feature.name}`;
      message = formatConventionalCommit({
        type,
        scope,
        subject,
        body: validatedInput.body,
      });
      validateConventionalCommit(message);
    }

    const repoPath = path.resolve(validatedInput.repo_path ?? '.');

    // Đảm bảo commit được thực hiện trên release branch
    const currentBranch = await gitGetCurrentBranch(repoPath);
    if (currentBranch !== release.branch) {
      const { stderr: coErr, exitCode: coCode } = await runGitCommand(
        ['checkout', release.branch],
        repoPath,
      );
      if (coCode !== 0) {
        throw new AppError(
          'GIT_COMMAND_FAILED',
          `Failed to checkout release branch '${release.branch}' before commit: ${coErr.trim()}`,
          { repoPath, branch: release.branch, stderr: coErr },
        );
      }
    }

    // Run git commit
    const gitResult = await gitCommit(repoPath, {
      message,
      files: validatedInput.files,
      stageAll: validatedInput.stage_all,
      allowEmpty: validatedInput.allow_empty,
      validateMessage: true,
    });

    // Update feature release in SQLite DB
    const updatedRelease = this.releaseRepo.update(release.id, {
      commit_sha: gitResult.commitSha,
      status: 'COMMITTED',
      metadata: {
        ...release.metadata,
        last_commit_message: message,
        last_committed_at: gitResult.createdAt,
        last_commit_files: gitResult.filesCommitted,
        last_commit_branch: gitResult.branch,
      },
    });

    this.logger.info(`Feature release committed and SHA saved in DB for '${featureId}'`, {
      featureId,
      releaseId: release.id,
      branch: release.branch,
      commitSha: gitResult.commitSha,
      shortSha: gitResult.shortSha,
      message,
      status: 'COMMITTED',
    });

    return CommitFeatureReleaseResultSchema.parse({
      release_id: updatedRelease.id,
      feature_id: featureId,
      branch: updatedRelease.branch,
      commit_sha: gitResult.commitSha,
      short_sha: gitResult.shortSha,
      message,
      status: 'COMMITTED',
      files_committed: gitResult.filesCommitted,
      committed_at: gitResult.createdAt,
    });
  }

  /**
   * Lấy thông tin bản ghi release của feature từ DB.
   */
  getFeatureRelease(featureId: string): FeatureRelease | null {
    const feature = this.featureRepo.findById(featureId);
    if (!feature) {
      throw new AppError('FEATURE_NOT_FOUND', `Feature '${featureId}' not found`, { featureId });
    }
    return this.releaseRepo.findByFeatureId(featureId);
  }

  /**
   * Push feature branch lên remote repository và xác nhận remote branch qua git ls-remote (REL-005).
   */
  async pushFeatureRelease(
    featureId: string,
    input?: PushFeatureReleaseInput,
  ): Promise<PushFeatureReleaseResult> {
    const validatedInput = PushFeatureReleaseInputSchema.parse(input ?? {});

    const feature = this.featureRepo.findById(featureId);
    if (!feature) {
      throw new AppError('FEATURE_NOT_FOUND', `Feature '${featureId}' not found`, { featureId });
    }

    const release = this.releaseRepo.findByFeatureId(featureId);
    if (!release) {
      throw new AppError(
        'FEATURE_BRANCH_NOT_FOUND',
        `No release branch found for feature '${featureId}'. Call createFeatureBranch first.`,
        { featureId },
      );
    }

    // Phải có commit trước khi push
    if (!release.commit_sha) {
      throw new AppError(
        'FEATURE_NOT_COMMITTED',
        `Feature release branch '${release.branch}' has not been committed yet. Call commitFeatureRelease first.`,
        { featureId, branch: release.branch },
      );
    }

    const branch = validatedInput.branch || release.branch;
    const repoPath = path.resolve(
      validatedInput.repo_path || (release.metadata?.repo_path as string) || '.',
    );

    // Thực hiện git push kèm xác nhận remote branch qua git ls-remote
    const pushResult = await gitPush(repoPath, {
      branch,
      remote: validatedInput.remote,
      setUpstream: validatedInput.set_upstream,
      confirm: validatedInput.confirm_remote,
      maxRetries: validatedInput.max_retries,
      retryDelayMs: validatedInput.retry_delay_ms,
    });

    // Cập nhật trạng thái 'PUSHED' trong SQLite database
    const updatedRelease = this.releaseRepo.update(release.id, {
      status: 'PUSHED',
      metadata: {
        ...release.metadata,
        remote: pushResult.remote,
        remote_ref: pushResult.remoteRef,
        remote_commit_sha: pushResult.commitSha,
        pushed_at: pushResult.pushedAt,
        confirmed_remote: pushResult.confirmedRemote,
      },
    });

    this.logger.info(`Feature release pushed and remote confirmed for '${featureId}'`, {
      featureId,
      releaseId: release.id,
      branch,
      remote: pushResult.remote,
      remoteRef: pushResult.remoteRef,
      commitSha: pushResult.commitSha,
      status: 'PUSHED',
    });

    return PushFeatureReleaseResultSchema.parse({
      release_id: updatedRelease.id,
      feature_id: featureId,
      branch: pushResult.branch,
      remote: pushResult.remote,
      remote_ref: pushResult.remoteRef,
      commit_sha: pushResult.commitSha || release.commit_sha,
      status: 'PUSHED',
      confirmed_remote: pushResult.confirmedRemote,
      pushed_at: pushResult.pushedAt,
    });
  }

  /**
   * Xác nhận remote branch cho feature qua git ls-remote (REL-005).
   */
  async confirmRemoteBranch(
    featureId: string,
    input?: ConfirmRemoteBranchInput,
  ): Promise<ConfirmRemoteBranchResult> {
    const validatedInput = ConfirmRemoteBranchInputSchema.parse(input ?? {});

    const feature = this.featureRepo.findById(featureId);
    if (!feature) {
      throw new AppError('FEATURE_NOT_FOUND', `Feature '${featureId}' not found`, { featureId });
    }

    const release = this.releaseRepo.findByFeatureId(featureId);
    if (!release) {
      throw new AppError(
        'FEATURE_BRANCH_NOT_FOUND',
        `No release branch found for feature '${featureId}'. Call createFeatureBranch first.`,
        { featureId },
      );
    }

    const branch = validatedInput.branch || release.branch;
    const repoPath = path.resolve(
      validatedInput.repo_path || (release.metadata?.repo_path as string) || '.',
    );
    const remote = validatedInput.remote || 'origin';

    const check = await gitConfirmRemoteBranch(repoPath, branch, remote);

    return ConfirmRemoteBranchResultSchema.parse({
      feature_id: featureId,
      branch,
      remote,
      remote_ref: check.ref,
      commit_sha: check.commitSha,
      confirmed: check.exists,
      checked_at: new Date().toISOString(),
    });
  }

  /**
   * Tạo GitHub Pull Request (`gh pr create`) và sinh báo cáo phát hành release (REL-006).
   * Tiêu chí nghiệm thu: Lưu URL, SHA, quality report; chuyển trạng thái READY_FOR_REVIEW (chờ người duyệt).
   */
  async createFeaturePr(
    featureId: string,
    input?: CreateFeaturePrInput,
  ): Promise<CreateFeaturePrResult> {
    const validatedInput = CreateFeaturePrInputSchema.parse(input ?? {});

    const feature = this.featureRepo.findById(featureId);
    if (!feature) {
      throw new AppError('FEATURE_NOT_FOUND', `Feature '${featureId}' not found`, { featureId });
    }

    const release = this.releaseRepo.findByFeatureId(featureId);
    if (!release) {
      throw new AppError(
        'FEATURE_BRANCH_NOT_FOUND',
        `No release record found for feature '${featureId}'. Call createFeatureBranch first.`,
        { featureId },
      );
    }

    // Kiểm tra commit SHA
    if (release.status === 'BRANCH_CREATED' || !release.commit_sha) {
      throw new AppError(
        'FEATURE_NOT_COMMITTED',
        `Feature release for '${featureId}' has not been committed yet. Call commitFeatureRelease first.`,
        { featureId, releaseId: release.id, branch: release.branch },
      );
    }

    // Kiểm tra trạng thái đã được push lên remote
    const isPushed =
      release.status === 'PUSHED' ||
      release.status === 'PR_CREATED' ||
      release.status === 'READY_FOR_REVIEW' ||
      Boolean(release.metadata?.pushed_at);

    if (!isPushed) {
      throw new AppError(
        'FEATURE_NOT_PUSHED',
        `Branch '${release.branch}' must be pushed to remote before creating a pull request. Call pushFeatureRelease first. Current status: '${release.status}'.`,
        { featureId, releaseId: release.id, branch: release.branch, status: release.status },
      );
    }

    const repoPath = path.resolve(
      validatedInput.repo_path || (release.metadata?.repo_path as string) || '.',
    );
    const baseBranch = validatedInput.base_branch || release.base_branch || 'main';
    const headBranch = validatedInput.head_branch || release.branch;
    const title =
      validatedInput.title || `feat(${featureId}): release feature ${feature.name}`;

    // Lấy thông tin tasks và Quality Gate để tổng hợp báo cáo phát hành
    const manifest = this.getComponentTasks(featureId);

    let latestQg = null;
    for (const task of manifest.tasks) {
      const qg = this.qualityGateRepo.findLatestByTaskId(task.id);
      if (qg && (!latestQg || new Date(qg.evaluated_at) > new Date(latestQg.evaluated_at))) {
        latestQg = qg;
      }
    }

    // Sinh nội dung báo cáo release dạng Markdown chuẩn
    const reportContent =
      validatedInput.body !== undefined
        ? validatedInput.body
        : generateFeatureReleaseReportMarkdown({
            featureId,
            featureName: feature.name,
            description: feature.description,
            branch: release.branch,
            baseBranch,
            commitSha: release.commit_sha,
            prUrl: release.pr_url,
            tasks: manifest.tasks,
            taskSummary: manifest.summary,
            qualityGateResult: latestQg,
          });

    // 1. Lưu báo cáo vào file trên đĩa (mặc định reports/<featureId>.md theo SKILL-git-release.md)
    let reportFilePath: string | null = null;
    if (validatedInput.save_report_file) {
      const relPath = validatedInput.report_file_path || `reports/${featureId}.md`;
      reportFilePath = path.isAbsolute(relPath) ? relPath : path.join(repoPath, relPath);
      try {
        fs.mkdirSync(path.dirname(reportFilePath), { recursive: true });
        fs.writeFileSync(reportFilePath, reportContent, 'utf-8');
      } catch (err) {
        this.logger.warn(`Failed to write release report file to ${reportFilePath}: ${String(err)}`, {
          featureId,
          reportFilePath,
        });
      }
    }

    // 2. Lưu báo cáo vào bảng `reports` trong SQLite DB (kind: 'feature_release')
    const reportRecord = this.reportRepo.create({
      kind: 'feature_release',
      content: reportContent,
      run_id: null,
    });

    // 3. Thực thi tạo GitHub PR qua `gh pr create`
    const ghResult = await ghPrCreate({
      base: baseBranch,
      head: headBranch,
      title,
      bodyFile: reportFilePath ?? undefined,
      body: reportFilePath ? undefined : reportContent,
      draft: validatedInput.draft,
      repoPath,
      maxRetries: validatedInput.max_retries,
      retryDelayMs: validatedInput.retry_delay_ms,
      allowExisting: validatedInput.allow_existing,
      runCommand: this.ghRunner,
    });

    // 4. Lưu URL, SHA, quality report và cập nhật trạng thái READY_FOR_REVIEW vào DB
    const updatedRelease = this.releaseRepo.update(release.id, {
      commit_sha: release.commit_sha,
      pr_url: ghResult.prUrl,
      status: 'READY_FOR_REVIEW',
      metadata: {
        ...release.metadata,
        pr_url: ghResult.prUrl,
        pr_number: ghResult.prNumber,
        pr_title: title,
        base_branch: baseBranch,
        head_branch: headBranch,
        quality_report_id: reportRecord.id,
        quality_report_path: reportFilePath,
        pr_created_at: ghResult.createdAt,
      },
    });

    this.logger.info(
      `Pull Request created and feature ready for review: '${featureId}' (${ghResult.prUrl})`,
      {
        featureId,
        releaseId: release.id,
        branch: headBranch,
        baseBranch,
        commitSha: release.commit_sha,
        prUrl: ghResult.prUrl,
        prNumber: ghResult.prNumber,
        qualityReportId: reportRecord.id,
        status: 'READY_FOR_REVIEW',
      },
    );

    return CreateFeaturePrResultSchema.parse({
      release_id: updatedRelease.id,
      feature_id: featureId,
      branch: headBranch,
      base_branch: baseBranch,
      commit_sha: release.commit_sha,
      pr_url: ghResult.prUrl,
      pr_number: ghResult.prNumber,
      status: 'READY_FOR_REVIEW',
      quality_report_id: reportRecord.id,
      quality_report_path: reportFilePath,
      created_at: ghResult.createdAt,
    });
  }

  /**
   * Truy vấn và lấy nội dung báo cáo phát hành của feature (REL-006).
   */
  async getFeatureReleaseReport(featureId: string): Promise<FeatureReleaseReportResult> {
    const feature = this.featureRepo.findById(featureId);
    if (!feature) {
      throw new AppError('FEATURE_NOT_FOUND', `Feature '${featureId}' not found`, { featureId });
    }

    const release = this.releaseRepo.findByFeatureId(featureId);
    if (!release) {
      throw new AppError(
        'RELEASE_NOT_FOUND',
        `No release record found for feature '${featureId}'`,
        { featureId },
      );
    }

    let reportContent: string | null = null;
    const reportId = (release.metadata?.quality_report_id as string) || null;
    const reportPath = (release.metadata?.quality_report_path as string) || null;

    if (reportId) {
      const dbReport = this.reportRepo.getById(reportId);
      if (dbReport) {
        reportContent = dbReport.content;
      }
    }

    if (!reportContent && reportPath && fs.existsSync(reportPath)) {
      try {
        reportContent = fs.readFileSync(reportPath, 'utf-8');
      } catch {
        reportContent = null;
      }
    }

    if (!reportContent) {
      // Tự động sinh báo cáo nếu chưa có sẵn
      const manifest = this.getComponentTasks(featureId);
      let latestQg = null;
      for (const task of manifest.tasks) {
        const qg = this.qualityGateRepo.findLatestByTaskId(task.id);
        if (qg && (!latestQg || new Date(qg.evaluated_at) > new Date(latestQg.evaluated_at))) {
          latestQg = qg;
        }
      }

      reportContent = generateFeatureReleaseReportMarkdown({
        featureId,
        featureName: feature.name,
        description: feature.description,
        branch: release.branch,
        baseBranch: release.base_branch,
        commitSha: release.commit_sha || 'N/A',
        prUrl: release.pr_url,
        tasks: manifest.tasks,
        taskSummary: manifest.summary,
        qualityGateResult: latestQg,
      });
    }

    return FeatureReleaseReportResultSchema.parse({
      feature_id: featureId,
      feature_name: feature.name,
      release_id: release.id,
      branch: release.branch,
      base_branch: release.base_branch,
      commit_sha: release.commit_sha || '',
      pr_url: release.pr_url,
      status: release.status,
      report_content: reportContent,
      report_path: reportPath,
      report_id: reportId,
      generated_at: new Date().toISOString(),
    });
  }
}
