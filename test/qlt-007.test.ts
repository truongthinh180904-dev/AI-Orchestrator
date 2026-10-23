import { describe, expect, it } from 'vitest';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  RunRepository,
  ReportRepository,
  QualityGateRepository,
} from '../packages/db/src/index.js';
import type {
  QualityCommandRecord,
  ScopeDiffResult,
  ReviewResult,
  SecurityCheckResult,
} from '../packages/shared/src/index.js';
import { QualityGateService } from '../apps/orchestrator/src/services/quality-gate-service.js';
import { buildServer } from '../apps/orchestrator/src/server.js';

describe('QLT-007: Quality Gate tổng hợp PASS/FAIL theo policy + bằng chứng — Không PASS chỉ vì CLI báo SUCCESS', () => {
  function setupTestEnv() {
    const db = createDatabase(':memory:');
    runMigrations(db);

    const taskRepo = new TaskRepository(db);
    const runRepo = new RunRepository(db);
    const reportRepo = new ReportRepository(db);
    const qualityGateRepo = new QualityGateRepository(db);

    const now = new Date().toISOString();
    taskRepo.create({
      id: 'TASK-QLT7-TEST',
      title: 'Implement Core Security & Validation Module',
      acceptance_criteria: [
        'Format/lint/typecheck exit code 0',
        'Unit tests pass',
        'No out of scope file changes',
        'No critical or high review findings',
        'No secrets or high/critical audit vulnerabilities',
      ],
      test_commands: ['pnpm test'],
      status: 'VERIFYING',
      created_at: now,
      updated_at: now,
    });

    const run = runRepo.create({
      task_id: 'TASK-QLT7-TEST',
      attempt: 1,
      status: 'SUCCESS',
      exit_code: 0,
      started_at: now,
      finished_at: now,
    });

    const qualityGateService = new QualityGateService({
      db,
    });

    return { db, taskRepo, runRepo, reportRepo, qualityGateRepo, run, qualityGateService };
  }

  const cleanTestCommand: QualityCommandRecord = {
    id: 'cmd-test-ok',
    task_id: 'TASK-QLT7-TEST',
    run_id: 'run-qlt7',
    stage: 'test',
    command_id: 'test',
    name: 'Vitest Unit Tests',
    command: 'pnpm test',
    exe: 'pnpm',
    args: ['test'],
    cwd: '.',
    exit_code: 0,
    signal: null,
    status: 'SUCCESS',
    stdout: '✓ 12 tests passed',
    stderr: '',
    duration_ms: 150,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  const cleanLintCommand: QualityCommandRecord = {
    id: 'cmd-lint-ok',
    task_id: 'TASK-QLT7-TEST',
    run_id: 'run-qlt7',
    stage: 'lint',
    command_id: 'lint',
    name: 'ESLint Code Check',
    command: 'pnpm lint',
    exe: 'pnpm',
    args: ['lint'],
    cwd: '.',
    exit_code: 0,
    signal: null,
    status: 'SUCCESS',
    stdout: 'Lint clean, 0 warnings',
    stderr: '',
    duration_ms: 90,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  const cleanScope: ScopeDiffResult = {
    taskId: 'TASK-QLT7-TEST',
    repoPath: '.',
    scopeFiles: ['packages/shared/src/models/quality-gate.ts'],
    changedFiles: ['packages/shared/src/models/quality-gate.ts'],
    inScopeFiles: ['packages/shared/src/models/quality-gate.ts'],
    outOfScopeFiles: [],
    isScopeClean: true,
    stats: {
      totalChanged: 1,
      inScopeCount: 1,
      outOfScopeCount: 0,
      additions: 10,
      deletions: 2,
    },
    fileDiffs: [],
    rawDiff: 'diff --git ...',
  };

  const cleanReview: ReviewResult = {
    id: 'rev-ok',
    task_id: 'TASK-QLT7-TEST',
    run_id: 'run-qlt7',
    passed: true,
    findings: [],
    stats: { total: 0, info: 0, low: 0, medium: 0, high: 0, critical: 0 },
    summary: 'Code passes all quality and architectural guidelines',
    reviewed_at: new Date().toISOString(),
    reviewer_type: 'agy',
  };

  const cleanSecurity: SecurityCheckResult = {
    id: 'sec-ok',
    task_id: 'TASK-QLT7-TEST',
    run_id: 'run-qlt7',
    repo_path: '.',
    passed: true,
    audit_passed: true,
    secret_passed: true,
    audit_high_critical_count: 0,
    secret_findings_count: 0,
    audit: {
      passed: true,
      command: 'pnpm audit --json',
      exit_code: 0,
      stdout: '{}',
      stderr: '',
      duration_ms: 120,
      vulnerabilities: [],
      counts: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
      highOrCriticalCount: 0,
      summary: 'No vulnerabilities detected',
    },
    secrets: {
      passed: true,
      scanner: 'builtin',
      exit_code: 0,
      stdout: '',
      stderr: '',
      duration_ms: 50,
      findings: [],
      total_findings: 0,
      files_scanned: 15,
      summary: '0 secrets found',
    },
    summary: 'All security checks passed',
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: 220,
  };

  it('Nghiệm thu 1: "Không PASS chỉ vì CLI báo SUCCESS" — CLI exit code 0 nhưng lệnh test kiểm định thất bại', async () => {
    const { taskRepo, run, qualityGateService } = setupTestEnv();

    const failedTestCommand: QualityCommandRecord = {
      ...cleanTestCommand,
      id: 'cmd-test-fail',
      exit_code: 1,
      status: 'FAILURE',
      stderr: 'FAIL test/auth.test.ts: AssertionError: expected false to be true',
      duration_ms: 130,
    };

    // CLI reported exit 0 / SUCCESS
    const { result, task } = await qualityGateService.verifyAndTransitionTask('TASK-QLT7-TEST', {
      runId: run.id,
      evidenceOverrides: {
        cliExitCode: 0,
        cliStatus: 'SUCCESS',
        commandRecords: [cleanLintCommand, failedTestCommand],
        scopeResult: cleanScope,
        reviewResult: cleanReview,
        securityResult: cleanSecurity,
      },
    });

    // Quality gate MUST FAIL!
    expect(result.passed).toBe(false);
    expect(result.status).toBe('FAILED');
    expect(result.summary).toContain('Không PASS chỉ vì CLI báo SUCCESS');
    expect(result.summary).toContain('Unit Test Commands');

    // Task must transition to FAILED (NOT DONE)
    expect(task.status).toBe('FAILED');
    const dbTask = taskRepo.findById('TASK-QLT7-TEST');
    expect(dbTask?.status).toBe('FAILED');
  });

  it('Nghiệm thu 2: "Không PASS chỉ vì CLI báo SUCCESS" — CLI exit code 0 nhưng phát hiện file ngoài phạm vi (QLT-003)', async () => {
    const { taskRepo, run, qualityGateService } = setupTestEnv();

    const dirtyScope: ScopeDiffResult = {
      ...cleanScope,
      outOfScopeFiles: ['unrelated/config.json'],
      isScopeClean: false,
      stats: {
        totalChanged: 2,
        inScopeCount: 1,
        outOfScopeCount: 1,
        additions: 5,
        deletions: 1,
      },
    };

    const { result, task } = await qualityGateService.verifyAndTransitionTask('TASK-QLT7-TEST', {
      runId: run.id,
      evidenceOverrides: {
        cliExitCode: 0,
        cliStatus: 'SUCCESS',
        commandRecords: [cleanLintCommand, cleanTestCommand],
        scopeResult: dirtyScope,
        reviewResult: cleanReview,
        securityResult: cleanSecurity,
      },
    });

    expect(result.passed).toBe(false);
    expect(result.status).toBe('FAILED');
    expect(task.status).toBe('FAILED');
    expect(taskRepo.findById('TASK-QLT7-TEST')?.status).toBe('FAILED');

    const scopeRule = result.rule_evaluations.find((r) => r.rule_id === 'SCOPE_COMPLIANCE');
    expect(scopeRule?.passed).toBe(false);
    expect(scopeRule?.message).toContain('unrelated/config.json');
  });

  it('Nghiệm thu 3: "Không PASS chỉ vì CLI báo SUCCESS" — CLI exit code 0 nhưng Reviewer Agent (QLT-004) phát hiện lỗi high/critical', async () => {
    const { taskRepo, run, qualityGateService } = setupTestEnv();

    const findingReview: ReviewResult = {
      ...cleanReview,
      passed: false,
      findings: [
        {
          severity: 'critical',
          file: 'packages/shared/src/models/quality-gate.ts',
          line: 25,
          message: 'Potential memory exhaustion in recursive evaluation',
        },
      ],
      stats: { total: 1, info: 0, low: 0, medium: 0, high: 0, critical: 1 },
    };

    const { result, task } = await qualityGateService.verifyAndTransitionTask('TASK-QLT7-TEST', {
      runId: run.id,
      evidenceOverrides: {
        cliExitCode: 0,
        cliStatus: 'SUCCESS',
        commandRecords: [cleanLintCommand, cleanTestCommand],
        scopeResult: cleanScope,
        reviewResult: findingReview,
        securityResult: cleanSecurity,
      },
    });

    expect(result.passed).toBe(false);
    expect(result.status).toBe('FAILED');
    expect(task.status).toBe('FAILED');
    expect(taskRepo.findById('TASK-QLT7-TEST')?.status).toBe('FAILED');

    const reviewRule = result.rule_evaluations.find((r) => r.rule_id === 'REVIEW_FINDINGS');
    expect(reviewRule?.passed).toBe(false);
    expect(reviewRule?.message).toContain('1 critical');
  });

  it('Nghiệm thu 4: "Không PASS chỉ vì CLI báo SUCCESS" — CLI exit code 0 nhưng phát hiện secret hoặc lỗ hổng audit (QLT-005)', async () => {
    const { taskRepo, run, qualityGateService } = setupTestEnv();

    const contaminatedSecurity: SecurityCheckResult = {
      ...cleanSecurity,
      passed: false,
      secret_passed: false,
      secret_findings_count: 1,
      secrets: {
        ...cleanSecurity.secrets,
        passed: false,
        findings: [
          {
            rule_id: 'generic-api-key',
            description: 'API Key',
            file: 'packages/shared/src/models/quality-gate.ts',
            line: 12,
            match_preview: 'sk-ant-api03-****',
          },
        ],
        total_findings: 1,
        files_scanned: 1,
        summary: '1 secret found',
      },
    };

    const { result, task } = await qualityGateService.verifyAndTransitionTask('TASK-QLT7-TEST', {
      runId: run.id,
      evidenceOverrides: {
        cliExitCode: 0,
        cliStatus: 'SUCCESS',
        commandRecords: [cleanLintCommand, cleanTestCommand],
        scopeResult: cleanScope,
        reviewResult: cleanReview,
        securityResult: contaminatedSecurity,
      },
    });

    expect(result.passed).toBe(false);
    expect(result.status).toBe('FAILED');
    expect(task.status).toBe('FAILED');
    expect(taskRepo.findById('TASK-QLT7-TEST')?.status).toBe('FAILED');

    const secretRule = result.rule_evaluations.find((r) => r.rule_id === 'SECURITY_SECRETS');
    expect(secretRule?.passed).toBe(false);
    expect(secretRule?.message).toContain('potential unmasked credential');
  });

  it('Nghiệm thu 5: "Không PASS chỉ vì CLI báo SUCCESS" — CLI exit code 0 nhưng không có bằng chứng kiểm định nào được thực thi', async () => {
    const { taskRepo, run, qualityGateService } = setupTestEnv();

    const { result, task } = await qualityGateService.verifyAndTransitionTask('TASK-QLT7-TEST', {
      runId: run.id,
      evidenceOverrides: {
        cliExitCode: 0,
        cliStatus: 'SUCCESS',
        commandRecords: [],
        scopeResult: null,
        reviewResult: null,
        securityResult: null,
      },
    });

    expect(result.passed).toBe(false);
    expect(result.status).toBe('FAILED');
    expect(result.summary).toContain('Không PASS chỉ vì CLI báo SUCCESS');
    expect(task.status).toBe('FAILED');
    expect(taskRepo.findById('TASK-QLT7-TEST')?.status).toBe('FAILED');

    const evidenceRule = result.rule_evaluations.find((r) => r.rule_id === 'VERIFICATION_EVIDENCE_EXISTS');
    expect(evidenceRule?.passed).toBe(false);
  });

  it('Nghiệm thu 6: Đạt Quality Gate PASS khi mọi lệnh kiểm tra exit 0 và toàn bộ tiêu chuẩn được đáp ứng -> Task chuyển sang DONE', async () => {
    const { taskRepo, run, qualityGateService } = setupTestEnv();

    const { result, task } = await qualityGateService.verifyAndTransitionTask('TASK-QLT7-TEST', {
      runId: run.id,
      evidenceOverrides: {
        cliExitCode: 0,
        cliStatus: 'SUCCESS',
        commandRecords: [cleanLintCommand, cleanTestCommand],
        scopeResult: cleanScope,
        reviewResult: cleanReview,
        securityResult: cleanSecurity,
      },
    });

    expect(result.passed).toBe(true);
    expect(result.status).toBe('PASSED');
    expect(result.summary).toContain('Quality Gate PASSED');
    expect(task.status).toBe('DONE');

    const inDb = taskRepo.findById('TASK-QLT7-TEST');
    expect(inDb?.status).toBe('DONE');
  });

  it('Nghiệm thu 7: Lưu vết toàn diện vào SQLite (quality_gate_evaluations và bảng reports)', async () => {
    const { qualityGateRepo, reportRepo, run, qualityGateService } = setupTestEnv();

    const { result } = await qualityGateService.verifyAndTransitionTask('TASK-QLT7-TEST', {
      runId: run.id,
      evidenceOverrides: {
        cliExitCode: 0,
        cliStatus: 'SUCCESS',
        commandRecords: [cleanLintCommand, cleanTestCommand],
        scopeResult: cleanScope,
        reviewResult: cleanReview,
        securityResult: cleanSecurity,
      },
    });

    // Check evaluation in quality_gate_evaluations
    const record = qualityGateRepo.getById(result.id);
    expect(record).not.toBeNull();
    expect(record?.passed).toBe(true);
    expect(record?.command_records).toHaveLength(2);
    expect(record?.command_records[0]?.command).toBe('pnpm lint');
    expect(record?.command_records[1]?.command).toBe('pnpm test');

    // Check audit report in reports table
    const reports = reportRepo.findByRunId(run.id);
    const qgReport = reports.find((r: { kind: string }) => r.kind === 'quality_gate');
    expect(qgReport).toBeDefined();
    expect(qgReport?.content).toContain('# Quality Gate Evaluation Report');
    expect(qgReport?.content).toContain('Quality Gate Verdict');
    expect(qgReport?.content).toContain('`pnpm test`');
  });

  it('Nghiệm thu 8: REST API endpoints kiểm thử Quality Gate và kích hoạt xác thực cho task', async () => {
    const { db, qualityGateService } = setupTestEnv();

    const server = await buildServer({
      db,
      qualityGateService,
    });

    try {
      // 8.1. POST /api/quality/gate/evaluate
      const evalResponse = await server.inject({
        method: 'POST',
        url: '/api/quality/gate/evaluate',
        payload: {
          taskId: 'TASK-QLT7-TEST',
          skipCommands: true,
          skipScope: true,
          skipReview: true,
          skipSecurity: true,
        },
      });

      expect(evalResponse.statusCode).toBe(200);
      const evalBody = evalResponse.json();
      expect(evalBody.data).toBeDefined();
      expect(evalBody.data.id).toBeDefined();
      const evaluationId = evalBody.data.id;

      // 8.2. GET /api/quality/gate/:id
      const getResponse = await server.inject({
        method: 'GET',
        url: `/api/quality/gate/${evaluationId}`,
      });
      expect(getResponse.statusCode).toBe(200);
      expect(getResponse.json().data.id).toBe(evaluationId);

      // 8.3. GET /api/quality/gate/tasks/:id/latest
      const latestResponse = await server.inject({
        method: 'GET',
        url: '/api/quality/gate/tasks/TASK-QLT7-TEST/latest',
      });
      expect(latestResponse.statusCode).toBe(200);
      expect(latestResponse.json().data.id).toBe(evaluationId);

      // 8.4. GET /api/quality/gate/tasks/:id/history
      const historyResponse = await server.inject({
        method: 'GET',
        url: '/api/quality/gate/tasks/TASK-QLT7-TEST/history',
      });
      expect(historyResponse.statusCode).toBe(200);
      expect(historyResponse.json().data).toBeInstanceOf(Array);
      expect(historyResponse.json().data.length).toBeGreaterThanOrEqual(1);

      // 8.5. GET /api/quality/gate/:id trả về 404 cho id không tồn tại
      const notFoundResponse = await server.inject({
        method: 'GET',
        url: '/api/quality/gate/non-existent-gate-id',
      });
      expect(notFoundResponse.statusCode).toBe(404);
      expect(notFoundResponse.json().error.code).toBe('QUALITY_GATE_NOT_FOUND');

      // 8.6. POST /api/tasks/:id/verify
      const verifyResponse = await server.inject({
        method: 'POST',
        url: '/api/tasks/TASK-QLT7-TEST/verify',
        payload: {
          skipCommands: true,
          skipScope: true,
          skipReview: true,
          skipSecurity: true,
          autoTransition: false,
        },
      });
      expect(verifyResponse.statusCode).toBe(200);
      expect(verifyResponse.json().data.result).toBeDefined();
    } finally {
      await server.close();
    }
  });
});
