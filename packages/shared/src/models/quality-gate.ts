import crypto from 'node:crypto';
import { z } from 'zod';
import { QualityCommandRecordSchema, type QualityCommandRecord } from '../quality/types.js';
import { ScopeDiffResultSchema, type ScopeDiffResult } from './quality-scope.js';
import { ReviewResultSchema, type ReviewResult } from './quality-review.js';
import { SecurityCheckResultSchema, type SecurityCheckResult } from './security-check.js';

/**
 * Status of the overall Quality Gate evaluation.
 */
export const QualityGateStatusSchema = z.enum(['PASSED', 'FAILED']);
export type QualityGateStatus = z.infer<typeof QualityGateStatusSchema>;

/**
 * Status of an individual Quality Gate rule evaluation.
 */
export const QualityGateRuleStatusSchema = z.enum(['PASSED', 'FAILED', 'SKIPPED', 'WARNING']);
export type QualityGateRuleStatus = z.infer<typeof QualityGateRuleStatusSchema>;

/**
 * Quality Gate Policy Schema.
 * Defines the criteria for a task or feature to pass verification.
 * Follows SKILL-testing.md:
 * 1. format/lint/typecheck exit 0
 * 2. unit test exit 0
 * 3. build exit 0 (if configured)
 * 4. no out-of-scope changed files
 * 5. no reviewer findings with severity high/critical
 * 6. no exposed secrets, pnpm audit has no high/critical vulnerabilities
 * Crucially: CLI exit code 0 / SUCCESS alone is NEVER sufficient without passing evidence.
 */
export const QualityGatePolicySchema = z.object({
  requireFormatLintTypecheck: z.boolean().default(true),
  requireTest: z.boolean().default(true),
  requireBuild: z.boolean().default(false),
  requireCleanScope: z.boolean().default(true),
  requireReviewClean: z.boolean().default(true),
  requireNoSecrets: z.boolean().default(true),
  requireAuditClean: z.boolean().default(true),
  rejectCliSuccessOnly: z.boolean().default(true),
  allowedOutOfScopeFiles: z.array(z.string()).default([]),
  maxReviewHighFindings: z.number().int().nonnegative().default(0),
  maxReviewCriticalFindings: z.number().int().nonnegative().default(0),
  maxAuditHighFindings: z.number().int().nonnegative().default(0),
  maxAuditCriticalFindings: z.number().int().nonnegative().default(0),
});

export type QualityGatePolicy = z.infer<typeof QualityGatePolicySchema>;
export type QualityGatePolicyInput = z.input<typeof QualityGatePolicySchema>;

/**
 * Single rule evaluation result.
 */
export const QualityGateRuleEvaluationSchema = z.object({
  rule_id: z.string().min(1),
  name: z.string().min(1),
  stage: z.string().min(1),
  passed: z.boolean(),
  status: QualityGateRuleStatusSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).default({}),
});

export type QualityGateRuleEvaluation = z.infer<typeof QualityGateRuleEvaluationSchema>;

/**
 * Consolidated evidence summary.
 */
export const QualityGateEvidenceSummarySchema = z.object({
  cliExitCode: z.number().nullable().default(null),
  cliStatus: z.string().nullable().default(null),
  cliSucceeded: z.boolean().default(false),
  totalCommands: z.number().int().nonnegative().default(0),
  passedCommands: z.number().int().nonnegative().default(0),
  failedCommands: z.number().int().nonnegative().default(0),
  skippedCommands: z.number().int().nonnegative().default(0),
  outOfScopeFilesCount: z.number().int().nonnegative().default(0),
  outOfScopeFiles: z.array(z.string()).default([]),
  reviewFindingsCount: z.number().int().nonnegative().default(0),
  reviewHighCount: z.number().int().nonnegative().default(0),
  reviewCriticalCount: z.number().int().nonnegative().default(0),
  secretFindingsCount: z.number().int().nonnegative().default(0),
  auditHighCriticalCount: z.number().int().nonnegative().default(0),
});

export type QualityGateEvidenceSummary = z.infer<typeof QualityGateEvidenceSummarySchema>;

/**
 * Evidence input provided to evaluate Quality Gate.
 */
export interface QualityGateEvidenceInput {
  cliExitCode?: number | null;
  cliStatus?: string | null;
  commandRecords?: QualityCommandRecord[];
  scopeResult?: ScopeDiffResult | null;
  reviewResult?: ReviewResult | null;
  securityResult?: SecurityCheckResult | null;
}

/**
 * Complete Quality Gate Result Schema.
 */
export const QualityGateResultSchema = z.object({
  id: z.string().min(1),
  task_id: z.string().nullable().default(null),
  run_id: z.string().nullable().default(null),
  repo_path: z.string().default('.'),
  passed: z.boolean(),
  status: QualityGateStatusSchema,
  summary: z.string(),
  policy: QualityGatePolicySchema,
  rule_evaluations: z.array(QualityGateRuleEvaluationSchema),
  evidence_summary: QualityGateEvidenceSummarySchema,
  command_records: z.array(QualityCommandRecordSchema).default([]),
  scope_result: ScopeDiffResultSchema.nullable().default(null),
  review_result: ReviewResultSchema.nullable().default(null),
  security_result: SecurityCheckResultSchema.nullable().default(null),
  duration_ms: z.number().int().nonnegative().default(0),
  evaluated_at: z.string(),
});

export type QualityGateResult = z.infer<typeof QualityGateResultSchema>;

/**
 * Options for evaluating Quality Gate.
 */
export interface EvaluateQualityGateOptions {
  id?: string;
  taskId?: string | null;
  runId?: string | null;
  repoPath?: string;
  durationMs?: number;
  evaluatedAt?: string;
}

/**
 * Evaluates Quality Gate policy against collected evidence.
 * Strict enforcement: CLI exit 0 / SUCCESS alone is NEVER sufficient.
 */
export function evaluateQualityGate(
  policyInput: QualityGatePolicyInput | undefined,
  evidence: QualityGateEvidenceInput,
  options: EvaluateQualityGateOptions = {},
): QualityGateResult {
  const policy = QualityGatePolicySchema.parse(policyInput ?? {});
  const evaluatedAt = options.evaluatedAt ?? new Date().toISOString();
  const ruleEvaluations: QualityGateRuleEvaluation[] = [];

  const cliExitCode = evidence.cliExitCode ?? null;
  const cliStatus = evidence.cliStatus ?? null;
  const cliSucceeded = cliExitCode === 0 || cliStatus === 'SUCCESS';

  const commands = evidence.commandRecords ?? [];
  const scopeResult = evidence.scopeResult ?? null;
  const reviewResult = evidence.reviewResult ?? null;
  const securityResult = evidence.securityResult ?? null;

  // 1. Evidence Existence & CLI Distinction Rule ("Không PASS chỉ vì CLI báo SUCCESS")
  const totalEvidenceCount =
    commands.length +
    (scopeResult ? 1 : 0) +
    (reviewResult ? 1 : 0) +
    (securityResult ? 1 : 0);

  if (policy.rejectCliSuccessOnly && cliSucceeded && totalEvidenceCount === 0) {
    ruleEvaluations.push({
      rule_id: 'VERIFICATION_EVIDENCE_EXISTS',
      name: 'Verification Evidence Presence',
      stage: 'evidence',
      passed: false,
      status: 'FAILED',
      message:
        'CLI process reported exit code 0 / SUCCESS, but no verification commands or Quality Gate checks were executed. Acceptance criteria requires real verification evidence.',
      details: {
        cliExitCode,
        cliStatus,
        totalEvidenceCount: 0,
      },
    });
  } else if (totalEvidenceCount > 0) {
    ruleEvaluations.push({
      rule_id: 'VERIFICATION_EVIDENCE_EXISTS',
      name: 'Verification Evidence Presence',
      stage: 'evidence',
      passed: true,
      status: 'PASSED',
      message: `Verified presence of ${totalEvidenceCount} verification evidence source(s).`,
      details: {
        commandsCount: commands.length,
        hasScopeDiff: Boolean(scopeResult),
        hasReview: Boolean(reviewResult),
        hasSecurity: Boolean(securityResult),
      },
    });
  }

  // 2. format/lint/typecheck commands (exit code 0)
  if (policy.requireFormatLintTypecheck) {
    const codeQualityCommands = commands.filter((c) =>
      ['format', 'lint', 'typecheck'].includes(c.stage),
    );

    if (codeQualityCommands.length === 0) {
      ruleEvaluations.push({
        rule_id: 'COMMAND_LINT_FORMAT_TYPECHECK',
        name: 'Lint / Format / Typecheck Commands',
        stage: 'code_quality',
        passed: true,
        status: 'WARNING',
        message: 'No format/lint/typecheck commands were configured in the pipeline.',
        details: { count: 0 },
      });
    } else {
      const failed = codeQualityCommands.filter(
        (c) => c.status !== 'SUCCESS' || c.exit_code !== 0,
      );
      if (failed.length > 0) {
        ruleEvaluations.push({
          rule_id: 'COMMAND_LINT_FORMAT_TYPECHECK',
          name: 'Lint / Format / Typecheck Commands',
          stage: 'code_quality',
          passed: false,
          status: 'FAILED',
          message: `${failed.length} format/lint/typecheck command(s) failed with non-zero exit code: ${failed.map((f) => `${f.name} (exit ${f.exit_code})`).join(', ')}`,
          details: {
            total: codeQualityCommands.length,
            failedCount: failed.length,
            failedCommands: failed.map((f) => ({
              id: f.command_id,
              name: f.name,
              stage: f.stage,
              exit_code: f.exit_code,
              status: f.status,
            })),
          },
        });
      } else {
        ruleEvaluations.push({
          rule_id: 'COMMAND_LINT_FORMAT_TYPECHECK',
          name: 'Lint / Format / Typecheck Commands',
          stage: 'code_quality',
          passed: true,
          status: 'PASSED',
          message: `All ${codeQualityCommands.length} format/lint/typecheck command(s) passed with exit code 0.`,
          details: {
            total: codeQualityCommands.length,
            commands: codeQualityCommands.map((c) => ({
              id: c.command_id,
              name: c.name,
              stage: c.stage,
              exit_code: c.exit_code,
            })),
          },
        });
      }
    }
  }

  // 3. unit test commands (exit code 0)
  if (policy.requireTest) {
    const testCommands = commands.filter((c) => c.stage === 'test');

    if (testCommands.length === 0) {
      ruleEvaluations.push({
        rule_id: 'COMMAND_TEST',
        name: 'Unit Test Commands',
        stage: 'test',
        passed: false,
        status: 'FAILED',
        message: 'Unit test verification is required by policy, but no test command was executed.',
        details: { count: 0 },
      });
    } else {
      const failedTests = testCommands.filter((c) => c.status !== 'SUCCESS' || c.exit_code !== 0);
      if (failedTests.length > 0) {
        ruleEvaluations.push({
          rule_id: 'COMMAND_TEST',
          name: 'Unit Test Commands',
          stage: 'test',
          passed: false,
          status: 'FAILED',
          message: `${failedTests.length} test command(s) failed: ${failedTests.map((t) => `${t.name} (exit ${t.exit_code})`).join(', ')}`,
          details: {
            total: testCommands.length,
            failedCount: failedTests.length,
            failedTests: failedTests.map((t) => ({
              id: t.command_id,
              name: t.name,
              exit_code: t.exit_code,
              status: t.status,
            })),
          },
        });
      } else {
        ruleEvaluations.push({
          rule_id: 'COMMAND_TEST',
          name: 'Unit Test Commands',
          stage: 'test',
          passed: true,
          status: 'PASSED',
          message: `All ${testCommands.length} test command(s) passed with exit code 0.`,
          details: {
            total: testCommands.length,
            tests: testCommands.map((t) => ({
              id: t.command_id,
              name: t.name,
              exit_code: t.exit_code,
            })),
          },
        });
      }
    }
  }

  // 4. build command (exit code 0, if configured or required)
  const buildCommands = commands.filter((c) => c.stage === 'build');
  if (policy.requireBuild || buildCommands.length > 0) {
    if (buildCommands.length === 0 && policy.requireBuild) {
      ruleEvaluations.push({
        rule_id: 'COMMAND_BUILD',
        name: 'Build Command',
        stage: 'build',
        passed: false,
        status: 'FAILED',
        message: 'Build verification is required by policy, but no build command was executed.',
        details: { count: 0 },
      });
    } else if (buildCommands.length > 0) {
      const failedBuild = buildCommands.filter((c) => c.status !== 'SUCCESS' || c.exit_code !== 0);
      if (failedBuild.length > 0) {
        ruleEvaluations.push({
          rule_id: 'COMMAND_BUILD',
          name: 'Build Command',
          stage: 'build',
          passed: false,
          status: 'FAILED',
          message: `${failedBuild.length} build command(s) failed: ${failedBuild.map((b) => `${b.name} (exit ${b.exit_code})`).join(', ')}`,
          details: {
            failedCount: failedBuild.length,
            commands: failedBuild.map((b) => ({
              id: b.command_id,
              name: b.name,
              exit_code: b.exit_code,
            })),
          },
        });
      } else {
        ruleEvaluations.push({
          rule_id: 'COMMAND_BUILD',
          name: 'Build Command',
          stage: 'build',
          passed: true,
          status: 'PASSED',
          message: `All ${buildCommands.length} build command(s) succeeded with exit code 0.`,
          details: { total: buildCommands.length },
        });
      }
    }
  }

  // 5. Scope compliance (no out-of-scope files)
  let unallowedOutOfScopeFiles: string[] = [];
  if (scopeResult) {
    const allowed = new Set(policy.allowedOutOfScopeFiles);
    unallowedOutOfScopeFiles = scopeResult.outOfScopeFiles.filter((f) => !allowed.has(f));

    if (policy.requireCleanScope && unallowedOutOfScopeFiles.length > 0) {
      ruleEvaluations.push({
        rule_id: 'SCOPE_COMPLIANCE',
        name: 'Task Scope Compliance',
        stage: 'scope',
        passed: false,
        status: 'FAILED',
        message: `Task modified ${unallowedOutOfScopeFiles.length} file(s) outside declared scope: ${unallowedOutOfScopeFiles.join(', ')}`,
        details: {
          outOfScopeFiles: unallowedOutOfScopeFiles,
          totalChanged: scopeResult.changedFiles.length,
          scopeFiles: scopeResult.scopeFiles,
        },
      });
    } else {
      ruleEvaluations.push({
        rule_id: 'SCOPE_COMPLIANCE',
        name: 'Task Scope Compliance',
        stage: 'scope',
        passed: true,
        status: 'PASSED',
        message: 'All modified files are strictly within declared task scope.',
        details: {
          totalChanged: scopeResult.changedFiles.length,
          scopeClean: scopeResult.isScopeClean,
        },
      });
    }
  } else if (policy.requireCleanScope) {
    ruleEvaluations.push({
      rule_id: 'SCOPE_COMPLIANCE',
      name: 'Task Scope Compliance',
      stage: 'scope',
      passed: true,
      status: 'SKIPPED',
      message: 'Scope diff was not provided; scope compliance skipped.',
      details: {},
    });
  }

  // 6. Reviewer findings (no high or critical findings)
  let reviewHighCount = 0;
  let reviewCriticalCount = 0;
  let totalReviewFindings = 0;
  if (reviewResult) {
    totalReviewFindings = reviewResult.findings.length;
    reviewHighCount = reviewResult.findings.filter((f) => f.severity === 'high').length;
    reviewCriticalCount = reviewResult.findings.filter((f) => f.severity === 'critical').length;

    const exceedsHigh = reviewHighCount > policy.maxReviewHighFindings;
    const exceedsCritical = reviewCriticalCount > policy.maxReviewCriticalFindings;

    if (policy.requireReviewClean && (exceedsHigh || exceedsCritical)) {
      ruleEvaluations.push({
        rule_id: 'REVIEW_FINDINGS',
        name: 'Reviewer Agent Code Quality',
        stage: 'review',
        passed: false,
        status: 'FAILED',
        message: `Reviewer agent reported severe issues: ${reviewCriticalCount} critical and ${reviewHighCount} high severity findings.`,
        details: {
          criticalCount: reviewCriticalCount,
          highCount: reviewHighCount,
          maxAllowedCritical: policy.maxReviewCriticalFindings,
          maxAllowedHigh: policy.maxReviewHighFindings,
          findings: reviewResult.findings.filter(
            (f) => f.severity === 'high' || f.severity === 'critical',
          ),
        },
      });
    } else {
      ruleEvaluations.push({
        rule_id: 'REVIEW_FINDINGS',
        name: 'Reviewer Agent Code Quality',
        stage: 'review',
        passed: true,
        status: 'PASSED',
        message: `Code review passed with 0 critical and 0 high severity findings (total findings: ${totalReviewFindings}).`,
        details: {
          totalFindings: totalReviewFindings,
          stats: reviewResult.stats,
        },
      });
    }
  } else if (policy.requireReviewClean) {
    ruleEvaluations.push({
      rule_id: 'REVIEW_FINDINGS',
      name: 'Reviewer Agent Code Quality',
      stage: 'review',
      passed: true,
      status: 'SKIPPED',
      message: 'Code review was not provided; review rule skipped.',
      details: {},
    });
  }

  // 7. Security: Secrets & Dependency Audit
  let secretFindingsCount = 0;
  let auditHighCriticalCount = 0;
  if (securityResult) {
    secretFindingsCount = securityResult.secrets.findings.length;
    auditHighCriticalCount = securityResult.audit.highOrCriticalCount;

    // Secret rule
    if (policy.requireNoSecrets && secretFindingsCount > 0) {
      ruleEvaluations.push({
        rule_id: 'SECURITY_SECRETS',
        name: 'Security Secrets Scanner',
        stage: 'security',
        passed: false,
        status: 'FAILED',
        message: `Secret scanner found ${secretFindingsCount} potential unmasked credential(s) or private key(s).`,
        details: {
          findingsCount: secretFindingsCount,
          rules: securityResult.secrets.findings.map((s) => s.rule_id),
        },
      });
    } else if (policy.requireNoSecrets) {
      ruleEvaluations.push({
        rule_id: 'SECURITY_SECRETS',
        name: 'Security Secrets Scanner',
        stage: 'security',
        passed: true,
        status: 'PASSED',
        message: 'No exposed credentials or secrets detected.',
        details: {
          filesScanned: securityResult.secrets.files_scanned,
        },
      });
    }

    // Audit rule
    const auditExceeds =
      (securityResult.audit.counts.critical ?? 0) > policy.maxAuditCriticalFindings ||
      (securityResult.audit.counts.high ?? 0) > policy.maxAuditHighFindings;

    if (policy.requireAuditClean && auditExceeds) {
      ruleEvaluations.push({
        rule_id: 'SECURITY_AUDIT',
        name: 'Dependency Vulnerability Audit',
        stage: 'security',
        passed: false,
        status: 'FAILED',
        message: `Dependency audit detected ${auditHighCriticalCount} high/critical vulnerabilities.`,
        details: {
          highOrCriticalCount: auditHighCriticalCount,
          counts: securityResult.audit.counts,
        },
      });
    } else if (policy.requireAuditClean) {
      ruleEvaluations.push({
        rule_id: 'SECURITY_AUDIT',
        name: 'Dependency Vulnerability Audit',
        stage: 'security',
        passed: true,
        status: 'PASSED',
        message: `Dependency audit clean: no unacceptable vulnerabilities (high/critical: ${auditHighCriticalCount}).`,
        details: {
          counts: securityResult.audit.counts,
        },
      });
    }
  } else {
    if (policy.requireNoSecrets) {
      ruleEvaluations.push({
        rule_id: 'SECURITY_SECRETS',
        name: 'Security Secrets Scanner',
        stage: 'security',
        passed: true,
        status: 'SKIPPED',
        message: 'Security check was not provided; secret scanning skipped.',
        details: {},
      });
    }
    if (policy.requireAuditClean) {
      ruleEvaluations.push({
        rule_id: 'SECURITY_AUDIT',
        name: 'Dependency Vulnerability Audit',
        stage: 'security',
        passed: true,
        status: 'SKIPPED',
        message: 'Security check was not provided; audit check skipped.',
        details: {},
      });
    }
  }

  // Calculate Overall Passed
  const activeEvaluations = ruleEvaluations.filter(
    (r) => r.status !== 'SKIPPED' && r.status !== 'WARNING',
  );
  const passed =
    activeEvaluations.length > 0 && activeEvaluations.every((r) => r.passed);
  const status: QualityGateStatus = passed ? 'PASSED' : 'FAILED';

  // Build Summary
  const failedRules = ruleEvaluations.filter((r) => !r.passed);
  let summary: string;
  if (passed) {
    summary = `Quality Gate PASSED: All ${activeEvaluations.length} evaluation rule(s) satisfied with verified evidence.`;
  } else if (cliSucceeded && failedRules.length > 0) {
    summary = `Quality Gate FAILED ("Không PASS chỉ vì CLI báo SUCCESS"): CLI reported exit 0 / SUCCESS, but ${failedRules.length} verification rule(s) failed: ${failedRules.map((f) => `${f.name} (${f.message})`).join('; ')}`;
  } else {
    summary = `Quality Gate FAILED: ${failedRules.length} rule(s) failed: ${failedRules.map((f) => `${f.name} (${f.message})`).join('; ')}`;
  }

  const passedCommands = commands.filter(
    (c) => c.status === 'SUCCESS' && c.exit_code === 0,
  ).length;
  const failedCommands = commands.filter(
    (c) => c.status !== 'SUCCESS' || (c.exit_code !== null && c.exit_code !== 0),
  ).length;
  const skippedCommands = commands.filter((c) => c.status === 'SKIPPED').length;

  const evidenceSummary: QualityGateEvidenceSummary = {
    cliExitCode,
    cliStatus,
    cliSucceeded,
    totalCommands: commands.length,
    passedCommands,
    failedCommands,
    skippedCommands,
    outOfScopeFilesCount: unallowedOutOfScopeFiles.length,
    outOfScopeFiles: unallowedOutOfScopeFiles,
    reviewFindingsCount: totalReviewFindings,
    reviewHighCount,
    reviewCriticalCount,
    secretFindingsCount,
    auditHighCriticalCount,
  };

  return {
    id: options.id ?? crypto.randomUUID(),
    task_id: options.taskId ?? null,
    run_id: options.runId ?? null,
    repo_path: options.repoPath ?? '.',
    passed,
    status,
    summary,
    policy,
    rule_evaluations: ruleEvaluations,
    evidence_summary: evidenceSummary,
    command_records: commands,
    scope_result: scopeResult,
    review_result: reviewResult,
    security_result: securityResult,
    duration_ms: options.durationMs ?? 0,
    evaluated_at: evaluatedAt,
  };
}

/**
 * Formats a QualityGateResult into GitHub-flavored Markdown for reports and audit storage.
 */
export function formatQualityGateMarkdownReport(result: QualityGateResult): string {
  const verdictBanner = result.passed
    ? '> [!NOTE]\n> **Quality Gate Verdict**: **PASSED** — All verification policies satisfied with genuine evidence.'
    : '> [!WARNING]\n> **Quality Gate Verdict**: **FAILED** — Did not pass Quality Gate policy.\n> *"Không PASS chỉ vì CLI báo SUCCESS"*';

  const lines: string[] = [
    `# Quality Gate Evaluation Report`,
    ``,
    `**Evaluation ID**: \`${result.id}\`  `,
    `**Task ID**: \`${result.task_id ?? 'N/A'}\`  `,
    `**Run ID**: \`${result.run_id ?? 'N/A'}\`  `,
    `**Evaluated At**: \`${result.evaluated_at}\`  `,
    `**Status**: **\`${result.status}\`**  `,
    `**Duration**: \`${result.duration_ms} ms\`  `,
    ``,
    verdictBanner,
    ``,
    `## 1. Executive Summary`,
    ``,
    `${result.summary}`,
    ``,
    `## 2. Policy & Rule Evaluations`,
    ``,
    `| Rule ID | Rule Name | Stage | Status | Details |`,
    `|---|---|---|---|---|`,
  ];

  for (const rule of result.rule_evaluations) {
    const statusIcon =
      rule.status === 'PASSED'
        ? '✅ PASSED'
        : rule.status === 'FAILED'
          ? '❌ FAILED'
          : rule.status === 'WARNING'
            ? '⚠️ WARNING'
            : '⏭️ SKIPPED';
    lines.push(
      `| \`${rule.rule_id}\` | ${rule.name} | \`${rule.stage}\` | ${statusIcon} | ${rule.message} |`,
    );
  }

  lines.push(``);
  lines.push(`## 3. Verification Commands Evidence`);
  lines.push(``);

  if (result.command_records.length === 0) {
    lines.push(`*No verification commands executed.*`);
  } else {
    lines.push(`| Stage | Command | Exit Code | Status | Duration |`);
    lines.push(`|---|---|---|---|---|`);
    for (const cmd of result.command_records) {
      const exitDisplay = cmd.exit_code !== null ? String(cmd.exit_code) : 'N/A';
      lines.push(
        `| \`${cmd.stage}\` | \`${cmd.command}\` | \`${exitDisplay}\` | \`${cmd.status}\` | ${cmd.duration_ms}ms |`,
      );
    }
  }

  lines.push(``);
  lines.push(`## 4. Multidimensional Evidence Breakdown`);
  lines.push(``);
  lines.push(`- **CLI Succeeded**: \`${result.evidence_summary.cliSucceeded}\` (Exit code: \`${result.evidence_summary.cliExitCode ?? 'null'}\`, Status: \`${result.evidence_summary.cliStatus ?? 'null'}\`)`);
  lines.push(`- **Total Commands**: \`${result.evidence_summary.totalCommands}\` (Passed: \`${result.evidence_summary.passedCommands}\`, Failed: \`${result.evidence_summary.failedCommands}\`)`);
  lines.push(`- **Out of Scope Files**: \`${result.evidence_summary.outOfScopeFilesCount}\`${result.evidence_summary.outOfScopeFiles.length > 0 ? ` (${result.evidence_summary.outOfScopeFiles.join(', ')})` : ''}`);
  lines.push(`- **Review Findings**: \`${result.evidence_summary.reviewFindingsCount}\` (Critical: \`${result.evidence_summary.reviewCriticalCount}\`, High: \`${result.evidence_summary.reviewHighCount}\`)`);
  lines.push(`- **Secret Findings**: \`${result.evidence_summary.secretFindingsCount}\``);
  lines.push(`- **Dependency Audit High/Critical**: \`${result.evidence_summary.auditHighCriticalCount}\``);

  return lines.join('\n');
}
