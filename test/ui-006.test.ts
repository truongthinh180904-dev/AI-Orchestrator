/**
 * Acceptance test for UI-006: Test report + review findings — Hiển thị bằng chứng
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { buildServer } from '../apps/orchestrator/src/server.js';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  FeatureRepository,
  RunRepository,
  QualityGateRepository,
  QualityCheckRepository,
  ReviewFindingRepository,
} from '../packages/db/src/index.js';
import { QualityConfigService } from '../apps/orchestrator/src/services/quality-config-service.js';
import { QualityRunner } from '../apps/orchestrator/src/services/quality-runner.js';
import { ScopeDiffService } from '../apps/orchestrator/src/services/scope-diff-service.js';
import { ReviewerService } from '../apps/orchestrator/src/services/reviewer-service.js';
import { SecurityCheckService } from '../apps/orchestrator/src/services/security-check-service.js';
import { QualityGateService } from '../apps/orchestrator/src/services/quality-gate-service.js';
import { ApiClient } from '../apps/dashboard/src/lib/api.js';
import {
  evaluateQualityGate,
  formatQualityGateMarkdownReport,
  type QualityGateResult,
  type QualityCommandRecord,
  type ReviewFindingRecord,
} from '../packages/shared/src/index.js';

describe('UI-006 Acceptance: Test report + review findings — Hiển thị bằng chứng', () => {
  let db: Database.Database;
  let server: FastifyInstance;
  let orchestratorUrl: string;
  let api: ApiClient;

  let taskRepo: TaskRepository;
  let featureRepo: FeatureRepository;
  let runRepo: RunRepository;
  let qualityGateRepo: QualityGateRepository;
  let qualityCheckRepo: QualityCheckRepository;
  let reviewFindingRepo: ReviewFindingRepository;

  let qualityConfigService: QualityConfigService;
  let qualityRunner: QualityRunner;
  let scopeDiffService: ScopeDiffService;
  let reviewerService: ReviewerService;
  let securityCheckService: SecurityCheckService;
  let qualityGateService: QualityGateService;

  const now = new Date().toISOString();

  const createSampleCommandRecord = (overrides: Partial<QualityCommandRecord>): QualityCommandRecord => ({
    id: overrides.id ?? 'cmd-rec-1',
    task_id: overrides.task_id ?? 'TSK-UI-EVIDENCE-1',
    run_id: overrides.run_id ?? 'run-ui-001',
    stage: overrides.stage ?? 'test',
    command_id: overrides.command_id ?? 'cmd-1',
    name: overrides.name ?? 'Unit tests',
    command: overrides.command ?? 'pnpm test',
    exe: overrides.exe ?? 'pnpm',
    args: overrides.args ?? ['test'],
    cwd: overrides.cwd ?? '.',
    exit_code: overrides.exit_code ?? 0,
    signal: null,
    status: overrides.status ?? 'SUCCESS',
    stdout: overrides.stdout ?? 'PASS',
    stderr: overrides.stderr ?? '',
    duration_ms: overrides.duration_ms ?? 250,
    started_at: overrides.started_at ?? now,
    finished_at: overrides.finished_at ?? now,
    created_at: overrides.created_at ?? now,
  });

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);

    taskRepo = new TaskRepository(db);
    featureRepo = new FeatureRepository(db);
    runRepo = new RunRepository(db);
    qualityGateRepo = new QualityGateRepository(db);
    qualityCheckRepo = new QualityCheckRepository(db);
    reviewFindingRepo = new ReviewFindingRepository(db);

    qualityConfigService = new QualityConfigService({ db });
    qualityRunner = new QualityRunner({ db, qualityConfigService });
    scopeDiffService = new ScopeDiffService({ db });
    reviewerService = new ReviewerService({ db });
    securityCheckService = new SecurityCheckService({ db });

    qualityGateService = new QualityGateService({
      db,
      qualityRunner,
      scopeDiffService,
      reviewerService,
      securityCheckService,
    });

    // Seed feature
    featureRepo.create({
      id: 'FEAT-EVIDENCE',
      name: 'Quality Gate Dashboard Evidence Feature',
      description: 'Feature for UI-006 test report and review findings',
      required_tasks: ['TSK-UI-EVIDENCE-1', 'TSK-UI-EVIDENCE-2'],
      integration_tests: ['pnpm test'],
      status: 'IN_PROGRESS',
    });

    // Seed task 1: Successful task
    taskRepo.create({
      id: 'TSK-UI-EVIDENCE-1',
      feature_id: 'FEAT-EVIDENCE',
      title: 'Valid task with clean verification',
      description: 'Task with passing tests and clean review',
      phase: 'UI',
      worker_type: 'agy',
      repository: '.',
      scope_files: ['src/services/user.ts'],
      acceptance_criteria: ['Check test execution report and zero findings'],
      test_commands: ['pnpm test'],
      priority: 1,
      max_attempts: 3,
      timeout_minutes: 30,
      status: 'VERIFYING',
      attempts: 1,
      dependencies: [],
    });

    // Seed task 2: Failed task (CLI exit 0 but verification fails)
    taskRepo.create({
      id: 'TSK-UI-EVIDENCE-2',
      feature_id: 'FEAT-EVIDENCE',
      title: 'Task with CLI SUCCESS but failed verification',
      description: 'Demonstrates CLI exit 0 distinction rule',
      phase: 'UI',
      worker_type: 'agy',
      repository: '.',
      scope_files: ['src/services/order.ts'],
      acceptance_criteria: ['Verification evidence fails despite CLI exit 0'],
      test_commands: ['pnpm test'],
      priority: 2,
      max_attempts: 3,
      timeout_minutes: 30,
      status: 'VERIFYING',
      attempts: 1,
      dependencies: [],
    });

    // Seed run for task 1
    runRepo.create({
      id: 'run-ui-001',
      task_id: 'TSK-UI-EVIDENCE-1',
      attempt: 1,
      status: 'SUCCESS',
      exit_code: 0,
      branch: 'dev',
    });

    // Seed run for task 2
    runRepo.create({
      id: 'run-ui-002',
      task_id: 'TSK-UI-EVIDENCE-2',
      attempt: 1,
      status: 'SUCCESS',
      exit_code: 0,
      branch: 'dev',
    });

    // Build and start orchestrator server
    server = await buildServer({
      db,
      qualityConfigService,
      qualityRunner,
      scopeDiffService,
      reviewerService,
      securityCheckService,
      qualityGateService,
    });

    await server.listen({ port: 0, host: '127.0.0.1' });
    const address = server.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 3000;
    orchestratorUrl = `http://127.0.0.1:${port}`;

    api = new ApiClient({ baseUrl: orchestratorUrl });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) {
      await server.close();
    }
    if (db) {
      db.close();
    }
  });

  it('Nghiệm thu 1: Hiển thị bằng chứng — Lấy kết quả Quality Gate PASSED đầy đủ qua API client', async () => {
    const cmd1 = createSampleCommandRecord({
      id: 'cmd-pass-1',
      command_id: 'lint-1',
      name: 'Lint check',
      command: 'pnpm lint',
      stage: 'lint',
      exit_code: 0,
      duration_ms: 310,
      stdout: '0 errors, 0 warnings',
      status: 'SUCCESS',
    });

    const cmd2 = createSampleCommandRecord({
      id: 'cmd-pass-2',
      command_id: 'test-1',
      name: 'Unit tests',
      command: 'pnpm test',
      stage: 'test',
      exit_code: 0,
      duration_ms: 820,
      stdout: 'PASS test/unit.test.ts (10 passed)',
      status: 'SUCCESS',
    });

    // Generate passing evaluation
    const passEvidence = evaluateQualityGate(
      {
        requireFormatLintTypecheck: true,
        requireTest: true,
        requireCleanScope: false,
        requireReviewClean: false,
        requireNoSecrets: false,
        requireAuditClean: false,
        rejectCliSuccessOnly: true,
      },
      {
        cliExitCode: 0,
        cliStatus: 'SUCCESS',
        commandRecords: [cmd1, cmd2],
        scopeResult: null,
        reviewResult: null,
        securityResult: null,
      },
      {
        taskId: 'TSK-UI-EVIDENCE-1',
        runId: 'run-ui-001',
        durationMs: 1150,
      },
    );

    qualityGateRepo.create(passEvidence);

    // Call API via dashboard client
    const latest: QualityGateResult = await api.getTaskQualityGateLatest('TSK-UI-EVIDENCE-1');

    expect(latest.id).toBe(passEvidence.id);
    expect(latest.task_id).toBe('TSK-UI-EVIDENCE-1');
    expect(latest.run_id).toBe('run-ui-001');
    expect(latest.passed).toBe(true);
    expect(latest.status).toBe('PASSED');
    expect(latest.summary).toContain('Quality Gate PASSED');
    expect(latest.duration_ms).toBe(1150);

    // Verify rules evidence
    expect(latest.rule_evaluations.length).toBeGreaterThan(0);
    const evidenceRule = latest.rule_evaluations.find(
      (r) => r.rule_id === 'VERIFICATION_EVIDENCE_EXISTS',
    );
    expect(evidenceRule?.passed).toBe(true);
    expect(evidenceRule?.status).toBe('PASSED');

    const testRule = latest.rule_evaluations.find((r) => r.rule_id === 'COMMAND_TEST');
    expect(testRule?.passed).toBe(true);
    expect(testRule?.status).toBe('PASSED');

    // Verify summary evidence
    expect(latest.evidence_summary.passedCommands).toBe(2);
    expect(latest.evidence_summary.failedCommands).toBe(0);
    expect(latest.evidence_summary.outOfScopeFilesCount).toBe(0);
    expect(latest.evidence_summary.reviewFindingsCount).toBe(0);
  });

  it('Nghiệm thu 2: Hiển thị bằng chứng — Truy xuất danh sách lệnh kiểm thử (Quality Records) kèm log stdout/stderr qua API client', async () => {
    // Record commands in database via qualityCheckRepo
    const cmd1 = createSampleCommandRecord({
      id: 'rec-cmd-01',
      command_id: 'lint-rec',
      name: 'ESLint execution',
      command: 'pnpm lint',
      stage: 'lint',
      exit_code: 0,
      duration_ms: 250,
      stdout: 'Lint clean, code formatted.',
      status: 'SUCCESS',
    });

    const cmd2 = createSampleCommandRecord({
      id: 'rec-cmd-02',
      command_id: 'test-rec',
      name: 'Vitest execution',
      command: 'pnpm test',
      stage: 'test',
      exit_code: 0,
      duration_ms: 450,
      stdout: 'PASS test/services.test.ts',
      status: 'SUCCESS',
    });

    qualityCheckRepo.create(cmd1);
    qualityCheckRepo.create(cmd2);

    // Retrieve via API client
    const taskRecords = await api.getTaskQualityRecords('TSK-UI-EVIDENCE-1');
    expect(taskRecords).toHaveLength(2);
    expect(taskRecords.map((r) => r.command)).toContain('pnpm lint');
    expect(taskRecords.map((r) => r.command)).toContain('pnpm test');

    const runRecords = await api.getRunQualityRecords('run-ui-001');
    expect(runRecords).toHaveLength(2);
    expect(runRecords[0]?.stdout).toContain('Lint clean');
  });

  it('Nghiệm thu 3: Hiển thị bằng chứng — Truy xuất Review Findings (QLT-004) với mức độ nghiêm trọng, file:line và gợi ý', async () => {
    // Save review findings into SQLite
    reviewFindingRepo.create({
      id: 'finding-acc-1',
      task_id: 'TSK-UI-EVIDENCE-1',
      run_id: 'run-ui-001',
      severity: 'high',
      file: 'src/services/user.ts',
      line: 45,
      message: 'Unvalidated input parameter may cause prototype pollution.',
      category: 'security',
      rule_id: 'SEC-PROTO-01',
      suggestion: 'Use Object.create(null) or validate key against allowed list.',
      created_at: new Date().toISOString(),
    });

    reviewFindingRepo.create({
      id: 'finding-acc-2',
      task_id: 'TSK-UI-EVIDENCE-1',
      run_id: 'run-ui-001',
      severity: 'low',
      file: 'src/services/user.ts',
      line: 88,
      message: 'Unused local variable detected.',
      category: 'style',
      rule_id: 'STYLE-UNUSED',
      suggestion: 'Remove unused variable or prefix with underscore.',
      created_at: new Date().toISOString(),
    });

    // Call API via client
    const taskFindings: ReviewFindingRecord[] = await api.getTaskReviewFindings('TSK-UI-EVIDENCE-1');
    expect(taskFindings).toHaveLength(2);

    const highFinding = taskFindings.find((f) => f.severity === 'high');
    expect(highFinding).toBeDefined();
    expect(highFinding?.file).toBe('src/services/user.ts');
    expect(highFinding?.line).toBe(45);
    expect(highFinding?.message).toContain('prototype pollution');
    expect(highFinding?.suggestion).toContain('Object.create(null)');

    const runFindings: ReviewFindingRecord[] = await api.getRunReviewFindings('run-ui-001');
    expect(runFindings).toHaveLength(2);
  });

  it('Nghiệm thu 4: Hiển thị bằng chứng — Bằng chứng "Không PASS chỉ vì CLI báo SUCCESS"', async () => {
    const failedCmd = createSampleCommandRecord({
      id: 'cmd-fail-1',
      task_id: 'TSK-UI-EVIDENCE-2',
      run_id: 'run-ui-002',
      command_id: 'order-test',
      name: 'Order Tests',
      command: 'vitest run test/order.test.ts',
      stage: 'test',
      exit_code: 1, // Test command failed!
      duration_ms: 400,
      stdout: 'FAIL test/order.test.ts',
      stderr: 'AssertionError: expected 200 to be 201',
      status: 'FAILURE',
    });

    // CLI reported SUCCESS (exit code 0), but verification test command failed (exit code 1)
    const failEvidence = evaluateQualityGate(
      {
        requireFormatLintTypecheck: true,
        requireTest: true,
        rejectCliSuccessOnly: true,
      },
      {
        cliExitCode: 0,
        cliStatus: 'SUCCESS', // CLI reported SUCCESS
        commandRecords: [failedCmd],
      },
      {
        taskId: 'TSK-UI-EVIDENCE-2',
        runId: 'run-ui-002',
        durationMs: 780,
      },
    );

    qualityGateRepo.create(failEvidence);

    // Retrieve via API
    const evalResult = await api.getTaskQualityGateLatest('TSK-UI-EVIDENCE-2');

    expect(evalResult.passed).toBe(false);
    expect(evalResult.status).toBe('FAILED');
    expect(evalResult.summary).toContain('Không PASS chỉ vì CLI báo SUCCESS');

    // Rule COMMAND_TEST must be FAILED
    const testRule = evalResult.rule_evaluations.find((r) => r.rule_id === 'COMMAND_TEST');
    expect(testRule?.passed).toBe(false);
    expect(testRule?.status).toBe('FAILED');
    expect(testRule?.message).toContain('(exit 1)');

    expect(evalResult.evidence_summary.cliSucceeded).toBe(true);
    expect(evalResult.evidence_summary.failedCommands).toBe(1);
  });

  it('Nghiệm thu 5: Hiển thị bằng chứng — Kích hoạt xác thực Quality Gate qua API client verifyTask', async () => {
    const sampleEval = evaluateQualityGate(
      {
        requireTest: true,
        rejectCliSuccessOnly: true,
      },
      {
        cliExitCode: 0,
        cliStatus: 'SUCCESS',
        commandRecords: [createSampleCommandRecord({})],
      },
      {
        taskId: 'TSK-UI-EVIDENCE-1',
        runId: 'run-ui-001',
      },
    );

    // Mock verifyAndTransitionTask on service to return predictable verified outcome
    vi.spyOn(qualityGateService, 'verifyAndTransitionTask').mockResolvedValue({
      result: sampleEval,
      task: {
        ...taskRepo.findById('TSK-UI-EVIDENCE-1')!,
        status: 'DONE',
      },
    });

    // Calling verifyTask should evaluate and return full Quality Gate evidence
    const verifyResult = await api.verifyTask('TSK-UI-EVIDENCE-1', {
      runId: 'run-ui-001',
      autoTransition: true,
    });

    expect(verifyResult).toBeDefined();
    expect(verifyResult.task.id).toBe('TSK-UI-EVIDENCE-1');
    expect(verifyResult.task.status).toBe('DONE');
    expect(verifyResult.result).toBeDefined();
    expect(verifyResult.result.id).toBeDefined();
    expect(verifyResult.result.rule_evaluations).toBeInstanceOf(Array);
    expect(verifyResult.result.evidence_summary).toBeDefined();
  });

  it('Nghiệm thu 6: Hiển thị bằng chứng — Sinh báo cáo kiểm toán Markdown định dạng chuẩn (formatQualityGateMarkdownReport)', async () => {
    const testEval = evaluateQualityGate(
      {
        requireTest: true,
        rejectCliSuccessOnly: true,
      },
      {
        cliExitCode: 0,
        cliStatus: 'SUCCESS',
        commandRecords: [
          createSampleCommandRecord({
            command: 'pnpm test',
            stage: 'test',
            exit_code: 0,
            status: 'SUCCESS',
          }),
        ],
      },
      {
        taskId: 'TSK-UI-EVIDENCE-1',
      },
    );

    const markdownReport = formatQualityGateMarkdownReport(testEval);

    expect(markdownReport).toContain('# Quality Gate Evaluation Report');
    expect(markdownReport).toContain('TSK-UI-EVIDENCE-1');
    expect(markdownReport).toContain('| Rule ID | Rule Name | Stage | Status | Details |');
    expect(markdownReport).toContain('VERIFICATION_EVIDENCE_EXISTS');
    expect(markdownReport).toContain('COMMAND_TEST');
    expect(markdownReport).toContain('Executive Summary');
  });
});
