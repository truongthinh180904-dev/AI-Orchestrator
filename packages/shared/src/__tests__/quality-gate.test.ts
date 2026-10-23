import { describe, expect, it } from 'vitest';
import {
  evaluateQualityGate,
  formatQualityGateMarkdownReport,
  QualityGatePolicySchema,
  type QualityCommandRecord,
  type ScopeDiffResult,
  type ReviewResult,
  type SecurityCheckResult,
} from '../index.js';

describe('Quality Gate Policy & Evaluation (QLT-007)', () => {
  const dummyPassedCommand: QualityCommandRecord = {
    id: 'cmd-test-1',
    task_id: 'TASK-1',
    run_id: 'run-1',
    stage: 'test',
    command_id: 'test',
    name: 'Vitest Unit Test',
    command: 'pnpm test',
    exe: 'pnpm',
    args: ['test'],
    cwd: '.',
    exit_code: 0,
    signal: null,
    status: 'SUCCESS',
    stdout: 'Tests passed',
    stderr: '',
    duration_ms: 120,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  const dummyLintCommand: QualityCommandRecord = {
    id: 'cmd-lint-1',
    task_id: 'TASK-1',
    run_id: 'run-1',
    stage: 'lint',
    command_id: 'lint',
    name: 'ESLint',
    command: 'pnpm lint',
    exe: 'pnpm',
    args: ['lint'],
    cwd: '.',
    exit_code: 0,
    signal: null,
    status: 'SUCCESS',
    stdout: 'No lint errors',
    stderr: '',
    duration_ms: 80,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  const dummyCleanScope: ScopeDiffResult = {
    taskId: 'TASK-1',
    repoPath: '.',
    scopeFiles: ['src/services/quality-gate.ts'],
    changedFiles: ['src/services/quality-gate.ts'],
    inScopeFiles: ['src/services/quality-gate.ts'],
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
    rawDiff: 'diff --git a/file b/file',
  };

  const dummyCleanReview: ReviewResult = {
    id: 'rev-1',
    task_id: 'TASK-1',
    run_id: 'run-1',
    passed: true,
    findings: [
      {
        severity: 'info',
        file: 'src/services/quality-gate.ts',
        line: 10,
        message: 'Consider adding jsdoc',
      },
    ],
    stats: { total: 1, info: 1, low: 0, medium: 0, high: 0, critical: 0 },
    summary: 'Code looks clean',
    reviewed_at: new Date().toISOString(),
    reviewer_type: 'agy',
  };

  const dummyCleanSecurity: SecurityCheckResult = {
    id: 'sec-1',
    task_id: 'TASK-1',
    run_id: 'run-1',
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
      duration_ms: 200,
      vulnerabilities: [],
      counts: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
      highOrCriticalCount: 0,
      summary: 'No vulnerabilities',
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
      files_scanned: 10,
      summary: 'No secrets detected',
    },
    summary: 'Security check clean',
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: 300,
  };

  it('1. QualityGatePolicySchema parses defaults correctly', () => {
    const policy = QualityGatePolicySchema.parse({});
    expect(policy.requireFormatLintTypecheck).toBe(true);
    expect(policy.requireTest).toBe(true);
    expect(policy.requireBuild).toBe(false);
    expect(policy.requireCleanScope).toBe(true);
    expect(policy.requireReviewClean).toBe(true);
    expect(policy.requireNoSecrets).toBe(true);
    expect(policy.requireAuditClean).toBe(true);
    expect(policy.rejectCliSuccessOnly).toBe(true);
  });

  it('2. "Không PASS chỉ vì CLI báo SUCCESS": Fails when CLI exits 0 but no verification evidence was gathered', () => {
    const result = evaluateQualityGate(
      { rejectCliSuccessOnly: true },
      {
        cliExitCode: 0,
        cliStatus: 'SUCCESS',
        commandRecords: [],
        scopeResult: null,
        reviewResult: null,
        securityResult: null,
      },
    );

    expect(result.passed).toBe(false);
    expect(result.status).toBe('FAILED');
    expect(result.summary).toContain('Không PASS chỉ vì CLI báo SUCCESS');
    const evidenceRule = result.rule_evaluations.find((r) => r.rule_id === 'VERIFICATION_EVIDENCE_EXISTS');
    expect(evidenceRule?.passed).toBe(false);
  });

  it('3. Fails when a test command fails with non-zero exit code, even if CLI reported SUCCESS', () => {
    const failedTestCommand: QualityCommandRecord = {
      ...dummyPassedCommand,
      id: 'cmd-failed',
      exit_code: 1,
      status: 'FAILURE',
      stderr: 'Test failed: expected 2 to equal 3',
    };

    const result = evaluateQualityGate(
      {},
      {
        cliExitCode: 0,
        cliStatus: 'SUCCESS',
        commandRecords: [dummyLintCommand, failedTestCommand],
        scopeResult: dummyCleanScope,
        reviewResult: dummyCleanReview,
        securityResult: dummyCleanSecurity,
      },
    );

    expect(result.passed).toBe(false);
    expect(result.status).toBe('FAILED');
    const testRule = result.rule_evaluations.find((r) => r.rule_id === 'COMMAND_TEST');
    expect(testRule?.passed).toBe(false);
    expect(testRule?.message).toContain('failed');
  });

  it('4. Fails when out-of-scope files are detected in git diff', () => {
    const dirtyScope: ScopeDiffResult = {
      ...dummyCleanScope,
      outOfScopeFiles: ['secret/config.json', 'unrelated/script.sh'],
      isScopeClean: false,
    };

    const result = evaluateQualityGate(
      {},
      {
        cliExitCode: 0,
        cliStatus: 'SUCCESS',
        commandRecords: [dummyLintCommand, dummyPassedCommand],
        scopeResult: dirtyScope,
        reviewResult: dummyCleanReview,
        securityResult: dummyCleanSecurity,
      },
    );

    expect(result.passed).toBe(false);
    const scopeRule = result.rule_evaluations.find((r) => r.rule_id === 'SCOPE_COMPLIANCE');
    expect(scopeRule?.passed).toBe(false);
    expect(scopeRule?.message).toContain('secret/config.json');
  });

  it('5. Allows out-of-scope files if explicitly allowed by policy', () => {
    const dirtyScope: ScopeDiffResult = {
      ...dummyCleanScope,
      outOfScopeFiles: ['reports/TASK-1.md'],
      isScopeClean: false,
    };

    const result = evaluateQualityGate(
      { allowedOutOfScopeFiles: ['reports/TASK-1.md'] },
      {
        cliExitCode: 0,
        cliStatus: 'SUCCESS',
        commandRecords: [dummyLintCommand, dummyPassedCommand],
        scopeResult: dirtyScope,
        reviewResult: dummyCleanReview,
        securityResult: dummyCleanSecurity,
      },
    );

    const scopeRule = result.rule_evaluations.find((r) => r.rule_id === 'SCOPE_COMPLIANCE');
    expect(scopeRule?.passed).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('6. Fails when Reviewer Agent reports critical or high severity findings', () => {
    const severeReview: ReviewResult = {
      ...dummyCleanReview,
      passed: false,
      findings: [
        {
          severity: 'critical',
          file: 'src/auth.ts',
          line: 42,
          message: 'Hardcoded bypass condition detected',
        },
      ],
      stats: { total: 1, info: 0, low: 0, medium: 0, high: 0, critical: 1 },
    };

    const result = evaluateQualityGate(
      {},
      {
        cliExitCode: 0,
        cliStatus: 'SUCCESS',
        commandRecords: [dummyLintCommand, dummyPassedCommand],
        scopeResult: dummyCleanScope,
        reviewResult: severeReview,
        securityResult: dummyCleanSecurity,
      },
    );

    expect(result.passed).toBe(false);
    const reviewRule = result.rule_evaluations.find((r) => r.rule_id === 'REVIEW_FINDINGS');
    expect(reviewRule?.passed).toBe(false);
    expect(reviewRule?.message).toContain('1 critical');
  });

  it('7. Fails when Secret Scanner finds unmasked secrets', () => {
    const secretInfectedSecurity: SecurityCheckResult = {
      ...dummyCleanSecurity,
      passed: false,
      secret_passed: false,
      secret_findings_count: 1,
      secrets: {
        ...dummyCleanSecurity.secrets,
        passed: false,
        findings: [
          {
            rule_id: 'aws-access-key',
            description: 'AWS Access Key ID',
            file: 'src/aws.ts',
            line: 5,
            match_preview: 'AKIA1234****',
          },
        ],
        total_findings: 1,
        summary: '1 secret found',
      },
    };

    const result = evaluateQualityGate(
      {},
      {
        cliExitCode: 0,
        cliStatus: 'SUCCESS',
        commandRecords: [dummyLintCommand, dummyPassedCommand],
        scopeResult: dummyCleanScope,
        reviewResult: dummyCleanReview,
        securityResult: secretInfectedSecurity,
      },
    );

    expect(result.passed).toBe(false);
    const secRule = result.rule_evaluations.find((r) => r.rule_id === 'SECURITY_SECRETS');
    expect(secRule?.passed).toBe(false);
    expect(secRule?.message).toContain('potential unmasked credential');
  });

  it('8. Fails when dependency audit reports high or critical vulnerabilities', () => {
    const vulnSecurity: SecurityCheckResult = {
      ...dummyCleanSecurity,
      passed: false,
      audit_passed: false,
      audit_high_critical_count: 3,
      audit: {
        ...dummyCleanSecurity.audit,
        passed: false,
        counts: { info: 0, low: 0, moderate: 0, high: 2, critical: 1, total: 3 },
        highOrCriticalCount: 3,
      },
    };

    const result = evaluateQualityGate(
      {},
      {
        cliExitCode: 0,
        cliStatus: 'SUCCESS',
        commandRecords: [dummyLintCommand, dummyPassedCommand],
        scopeResult: dummyCleanScope,
        reviewResult: dummyCleanReview,
        securityResult: vulnSecurity,
      },
    );

    expect(result.passed).toBe(false);
    const auditRule = result.rule_evaluations.find((r) => r.rule_id === 'SECURITY_AUDIT');
    expect(auditRule?.passed).toBe(false);
    expect(auditRule?.message).toContain('3 high/critical');
  });

  it('9. PASSES with genuine evidence when all commands exit 0 and all checks pass', () => {
    const result = evaluateQualityGate(
      {},
      {
        cliExitCode: 0,
        cliStatus: 'SUCCESS',
        commandRecords: [dummyLintCommand, dummyPassedCommand],
        scopeResult: dummyCleanScope,
        reviewResult: dummyCleanReview,
        securityResult: dummyCleanSecurity,
      },
      { taskId: 'TASK-1', runId: 'run-1' },
    );

    expect(result.passed).toBe(true);
    expect(result.status).toBe('PASSED');
    expect(result.summary).toContain('Quality Gate PASSED');
    expect(result.evidence_summary.passedCommands).toBe(2);
    expect(result.evidence_summary.failedCommands).toBe(0);
    expect(result.evidence_summary.outOfScopeFilesCount).toBe(0);
    expect(result.evidence_summary.secretFindingsCount).toBe(0);
  });

  it('10. formatQualityGateMarkdownReport produces formatted markdown report with alerts and tables', () => {
    const result = evaluateQualityGate(
      {},
      {
        cliExitCode: 0,
        cliStatus: 'SUCCESS',
        commandRecords: [dummyLintCommand, dummyPassedCommand],
        scopeResult: dummyCleanScope,
        reviewResult: dummyCleanReview,
        securityResult: dummyCleanSecurity,
      },
      { taskId: 'TASK-1', runId: 'run-1' },
    );

    const markdown = formatQualityGateMarkdownReport(result);
    expect(markdown).toContain('# Quality Gate Evaluation Report');
    expect(markdown).toContain('TASK-1');
    expect(markdown).toContain('PASSED');
    expect(markdown).toContain('| Stage | Command | Exit Code | Status | Duration |');
    expect(markdown).toContain('`pnpm test`');
    expect(markdown).toContain('Multidimensional Evidence Breakdown');
  });
});
