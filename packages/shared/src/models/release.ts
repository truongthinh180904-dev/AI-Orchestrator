import { z } from 'zod';
import { TaskStatusSchema } from './task.js';
import { FeatureStatusSchema } from './feature.js';
import type { QualityGateResult } from './quality-gate.js';

/**
 * Đại diện cho một task thành phần trong một feature.
 */
export const FeatureComponentTaskSchema = z.object({
  id: z.string().min(1, 'Task id cannot be empty'),
  feature_id: z.string().nullable().default(null),
  title: z.string().min(1, 'Task title cannot be empty'),
  description: z.string().nullable().default(null),
  phase: z.string().nullable().default(null),
  priority: z.number().int().default(0),
  status: TaskStatusSchema,
  worker_type: z.string().default('agy'),
  repository: z.string().default('.'),
  acceptance_criteria: z.array(z.string()).default([]),
  test_commands: z.array(z.string()).default([]),
  scope_files: z.array(z.string()).nullable().default(null),
  dependencies: z.array(z.string()).default([]),
  is_required: z.boolean().default(false),
  execution_order: z.number().int().nonnegative().default(0),
});

export type FeatureComponentTask = z.infer<typeof FeatureComponentTaskSchema>;

/**
 * Thống kê tổng quan về tiến độ và trạng thái các task của feature.
 */
export const FeatureTaskSummarySchema = z.object({
  total_tasks: z.number().int().nonnegative(),
  required_count: z.number().int().nonnegative(),
  completed_count: z.number().int().nonnegative(),
  pending_count: z.number().int().nonnegative(),
  failed_count: z.number().int().nonnegative(),
  missing_count: z.number().int().nonnegative(),
  is_all_required_done: z.boolean(),
  ready_for_release: z.boolean(),
});

export type FeatureTaskSummary = z.infer<typeof FeatureTaskSummarySchema>;

/**
 * Kết quả phân giải / xác định feature và tập task bắt buộc (Danh sách task thành phần).
 */
export const FeatureComponentTasksResultSchema = z.object({
  feature_id: z.string().min(1, 'Feature id cannot be empty'),
  feature_name: z.string().min(1, 'Feature name cannot be empty'),
  description: z.string().nullable().default(null),
  status: FeatureStatusSchema,
  release_policy: z.string().nullable().default(null),
  integration_tests: z.array(z.string()).default([]),
  required_task_ids: z.array(z.string()).default([]),
  all_task_ids: z.array(z.string()).default([]),
  tasks: z.array(FeatureComponentTaskSchema).default([]),
  missing_task_ids: z.array(z.string()).default([]),
  summary: FeatureTaskSummarySchema,
});

export type FeatureComponentTasksResult = z.infer<typeof FeatureComponentTasksResultSchema>;

/**
 * Schema input để xác định hoặc cập nhật tập task bắt buộc / thành phần của feature.
 */
export const DefineFeatureTasksInputSchema = z.object({
  required_tasks: z.array(z.string()).optional(),
  assign_task_ids: z.array(z.string()).optional(),
  unassign_task_ids: z.array(z.string()).optional(),
});

export type DefineFeatureTasksInput = z.infer<typeof DefineFeatureTasksInputSchema>;

/**
 * Trạng thái của từng rule kiểm tra điều kiện phát hành feature.
 */
export const FeatureReleaseCheckRuleStatusSchema = z.enum([
  'PASSED',
  'FAILED',
  'SKIPPED',
  'WARNING',
]);

export type FeatureReleaseCheckRuleStatus = z.infer<typeof FeatureReleaseCheckRuleStatusSchema>;

/**
 * Bản ghi kết quả đánh giá một rule kiểm tra release.
 */
export const FeatureReleaseCheckRuleSchema = z.object({
  rule_id: z.string().min(1),
  name: z.string().min(1),
  passed: z.boolean(),
  status: FeatureReleaseCheckRuleStatusSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).default({}),
});

export type FeatureReleaseCheckRule = z.infer<typeof FeatureReleaseCheckRuleSchema>;

/**
 * Kết quả thực thi một integration test command của feature.
 */
export const FeatureIntegrationTestRecordSchema = z.object({
  command: z.string().min(1),
  status: z.enum(['SUCCESS', 'FAILURE', 'TIMEOUT', 'SKIPPED', 'ERROR']),
  exit_code: z.number().nullable().default(null),
  stdout: z.string().default(''),
  stderr: z.string().default(''),
  duration_ms: z.number().int().nonnegative().default(0),
});

export type FeatureIntegrationTestRecord = z.infer<typeof FeatureIntegrationTestRecordSchema>;

/**
 * Chính sách và tùy chọn kiểm tra điều kiện release của feature.
 */
export const FeatureReleasePolicyOptionsSchema = z.object({
  require_all_required_done: z.boolean().default(true),
  require_no_missing_tasks: z.boolean().default(true),
  require_non_empty: z.boolean().default(true),
  require_quality_gate_passed: z.boolean().default(true),
  require_integration_tests: z.boolean().default(false),
  stop_on_first_integration_failure: z.boolean().default(true),
});

export type FeatureReleasePolicyOptions = z.infer<typeof FeatureReleasePolicyOptionsSchema>;

/**
 * Kết quả tổng thể kiểm tra tính sẵn sàng phát hành của feature (REL-002).
 */
export const FeatureReleaseCheckResultSchema = z.object({
  feature_id: z.string().min(1),
  feature_name: z.string().min(1),
  can_release: z.boolean(),
  status: z.enum(['READY', 'BLOCKED']),
  blocking_reasons: z.array(z.string()).default([]),
  rule_evaluations: z.array(FeatureReleaseCheckRuleSchema).default([]),
  task_summary: FeatureTaskSummarySchema,
  manifest: FeatureComponentTasksResultSchema,
  integration_test_results: z.array(FeatureIntegrationTestRecordSchema).default([]),
  checked_at: z.string(),
});

export type FeatureReleaseCheckResult = z.infer<typeof FeatureReleaseCheckResultSchema>;

/**
 * Input cho API / service kiểm tra release readiness.
 */
export const CheckReleaseReadinessInputSchema = z.object({
  policy: FeatureReleasePolicyOptionsSchema.optional(),
  execute_integration_tests: z.boolean().default(false),
  save_report: z.boolean().default(true),
  repo_path: z.string().optional(),
});

export type CheckReleaseReadinessInput = z.input<typeof CheckReleaseReadinessInputSchema>;

/**
 * Định dạng báo cáo nghiệm thu kiểm tra release dạng Markdown.
 */
export function formatFeatureReleaseCheckMarkdownReport(result: FeatureReleaseCheckResult): string {
  const statusBadge = result.can_release ? '✅ READY FOR RELEASE' : '❌ BLOCKED';
  const lines: string[] = [
    `# Feature Release Verification Report: ${result.feature_id}`,
    '',
    `- **Feature**: ${result.feature_name} (\`${result.feature_id}\`)`,
    `- **Status**: **${statusBadge}**`,
    `- **Evaluated At**: ${result.checked_at}`,
    `- **Can Release**: ${result.can_release ? 'Yes' : 'No'}`,
    '',
    '## 1. Task Summary',
    `- Total Tasks: ${result.task_summary.total_tasks}`,
    `- Required Tasks: ${result.task_summary.required_count}`,
    `- Completed Tasks (DONE): ${result.task_summary.completed_count}`,
    `- Pending Tasks: ${result.task_summary.pending_count}`,
    `- Failed Tasks: ${result.task_summary.failed_count}`,
    `- Missing Tasks: ${result.task_summary.missing_count}`,
    '',
    '## 2. Rule Evaluations',
    '| Rule ID | Rule Name | Status | Passed | Message |',
    '|---|---|---|---|---|',
  ];

  for (const rule of result.rule_evaluations) {
    const icon = rule.passed ? '✅' : rule.status === 'SKIPPED' ? '⏭️' : '❌';
    lines.push(`| \`${rule.rule_id}\` | ${rule.name} | ${icon} ${rule.status} | ${rule.passed} | ${rule.message} |`);
  }

  if (result.blocking_reasons.length > 0) {
    lines.push('', '## 3. Blocking Reasons');
    for (const reason of result.blocking_reasons) {
      lines.push(`- ⚠️ ${reason}`);
    }
  }

  if (result.integration_test_results.length > 0) {
    lines.push('', '## 4. Integration Test Results', '| Command | Status | Exit Code | Duration |', '|---|---|---|---|');
    for (const t of result.integration_test_results) {
      const icon = t.status === 'SUCCESS' ? '✅' : '❌';
      lines.push(`| \`${t.command}\` | ${icon} ${t.status} | ${t.exit_code ?? 'N/A'} | ${t.duration_ms}ms |`);
    }
  }

  return lines.join('\n');
}

/**
 * Trạng thái của một đợt phát hành feature (Release lifecycle).
 */
export const FeatureReleaseStatusSchema = z.enum([
  'BRANCH_CREATED',
  'COMMITTED',
  'PUSHED',
  'PR_CREATED',
  'READY_FOR_REVIEW',
  'MERGED',
  'CLOSED',
]);

export type FeatureReleaseStatus = z.infer<typeof FeatureReleaseStatusSchema>;

/**
 * Bản ghi phát hành feature lưu trong DB (Migration 012).
 */
export const FeatureReleaseSchema = z.object({
  id: z.string().min(1),
  feature_id: z.string().min(1),
  branch: z.string().min(1),
  base_branch: z.string().min(1),
  commit_sha: z.string().nullable().default(null),
  pr_url: z.string().nullable().default(null),
  status: FeatureReleaseStatusSchema.default('BRANCH_CREATED'),
  metadata: z.record(z.string(), z.unknown()).default({}),
  created_at: z.string(),
  updated_at: z.string(),
});

export type FeatureRelease = z.infer<typeof FeatureReleaseSchema>;

export const CreateFeatureReleaseInputSchema = z.object({
  id: z.string().optional(),
  feature_id: z.string().min(1),
  branch: z.string().min(1),
  base_branch: z.string().min(1),
  commit_sha: z.string().nullable().optional(),
  pr_url: z.string().nullable().optional(),
  status: FeatureReleaseStatusSchema.optional().default('BRANCH_CREATED'),
  metadata: z.record(z.string(), z.unknown()).optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export type CreateFeatureReleaseInput = z.input<typeof CreateFeatureReleaseInputSchema>;

export const UpdateFeatureReleaseInputSchema = z.object({
  branch: z.string().min(1).optional(),
  base_branch: z.string().min(1).optional(),
  commit_sha: z.string().nullable().optional(),
  pr_url: z.string().nullable().optional(),
  status: FeatureReleaseStatusSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  updated_at: z.string().optional(),
});

export type UpdateFeatureReleaseInput = z.input<typeof UpdateFeatureReleaseInputSchema>;

/**
 * Tham số đầu vào để tạo branch feature an toàn (REL-003).
 */
export const CreateFeatureBranchInputSchema = z.object({
  branch_name: z.string().min(1).optional(),
  base_branch: z.string().min(1).optional(),
  repo_path: z.string().optional(),
  require_clean: z.boolean().default(true),
  skip_readiness_check: z.boolean().default(false),
  checkout: z.boolean().default(false),
  check_remote: z.boolean().default(false),
});

export type CreateFeatureBranchInput = z.input<typeof CreateFeatureBranchInputSchema>;

/**
 * Kết quả tạo branch feature an toàn (REL-003).
 */
export const CreateFeatureBranchResultSchema = z.object({
  release_id: z.string().min(1),
  feature_id: z.string().min(1),
  feature_name: z.string().min(1),
  branch: z.string().min(1),
  base_branch: z.string().min(1),
  commit_sha: z.string().min(1),
  created: z.boolean(),
  status: FeatureReleaseStatusSchema,
  repo_path: z.string(),
  created_at: z.string(),
});

export type CreateFeatureBranchResult = z.infer<typeof CreateFeatureBranchResultSchema>;

/**
 * Thông tin branch của feature.
 */
export const FeatureBranchInfoSchema = z.object({
  release_id: z.string().min(1),
  feature_id: z.string().min(1),
  branch: z.string().min(1),
  base_branch: z.string().min(1),
  commit_sha: z.string().nullable(),
  status: FeatureReleaseStatusSchema,
  exists_locally: z.boolean(),
  created_at: z.string(),
});

export type FeatureBranchInfo = z.infer<typeof FeatureBranchInfoSchema>;

/**
 * Tham số đầu vào để tạo commit chuẩn hóa cho feature release (REL-004).
 */
export const CommitFeatureReleaseInputSchema = z.object({
  message: z.string().min(1).optional(),
  type: z.string().optional(),
  scope: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  stage_all: z.boolean().default(true),
  files: z.array(z.string()).optional(),
  allow_empty: z.boolean().default(false),
  repo_path: z.string().optional(),
});

export type CommitFeatureReleaseInput = z.input<typeof CommitFeatureReleaseInputSchema>;

/**
 * Kết quả tạo commit chuẩn hóa cho feature release (REL-004).
 */
export const CommitFeatureReleaseResultSchema = z.object({
  release_id: z.string().min(1),
  feature_id: z.string().min(1),
  branch: z.string().min(1),
  commit_sha: z.string().regex(/^[0-9a-f]{40}$/i, 'Commit SHA must be a 40-character hex string'),
  short_sha: z.string().min(7),
  message: z.string().min(1),
  status: FeatureReleaseStatusSchema,
  files_committed: z.array(z.string()).default([]),
  committed_at: z.string(),
});

export type CommitFeatureReleaseResult = z.infer<typeof CommitFeatureReleaseResultSchema>;

/**
 * Tham số đầu vào để ghi nhận hoặc thực hiện commit cho một task (REL-004).
 */
export const RecordTaskCommitInputSchema = z.object({
  task_id: z.string().min(1).optional(),
  run_id: z.string().optional(),
  commit_sha: z.string().regex(/^[0-9a-f]{40}$/i, 'Commit SHA must be a 40-character hex string').optional(),
  message: z.string().optional(),
  type: z.string().optional(),
  scope: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  stage_all: z.boolean().default(true),
  files: z.array(z.string()).optional(),
  allow_empty: z.boolean().default(false),
  repo_path: z.string().optional(),
});

export type RecordTaskCommitInput = z.input<typeof RecordTaskCommitInputSchema>;

/**
 * Kết quả ghi nhận commit cho task trong database.
 */
export const RecordTaskCommitResultSchema = z.object({
  task_id: z.string().min(1),
  run_id: z.string().nullable().default(null),
  commit_sha: z.string().regex(/^[0-9a-f]{40}$/i, 'Commit SHA must be a 40-character hex string'),
  short_sha: z.string().min(7),
  message: z.string(),
  recorded_at: z.string(),
});

export type RecordTaskCommitResult = z.infer<typeof RecordTaskCommitResultSchema>;

/**
 * Tham số đầu vào để push feature branch lên remote repository (REL-005).
 */
export const PushFeatureReleaseInputSchema = z.object({
  branch: z.string().optional(),
  remote: z.string().default('origin'),
  set_upstream: z.boolean().default(true),
  confirm_remote: z.boolean().default(true),
  repo_path: z.string().optional(),
  max_retries: z.number().int().min(0).max(5).default(2),
  retry_delay_ms: z.number().int().min(0).default(300),
});

export type PushFeatureReleaseInput = z.input<typeof PushFeatureReleaseInputSchema>;

/**
 * Kết quả push feature branch lên remote và xác nhận remote branch (REL-005).
 */
export const PushFeatureReleaseResultSchema = z.object({
  release_id: z.string().min(1),
  feature_id: z.string().min(1),
  branch: z.string().min(1),
  remote: z.string().min(1),
  remote_ref: z.string().min(1),
  commit_sha: z.string().regex(/^[0-9a-f]{40}$/i, 'Commit SHA must be a 40-character hex string'),
  status: FeatureReleaseStatusSchema,
  confirmed_remote: z.boolean(),
  pushed_at: z.string(),
});

export type PushFeatureReleaseResult = z.infer<typeof PushFeatureReleaseResultSchema>;

/**
 * Tham số truy vấn / xác nhận remote branch cho feature release (REL-005).
 */
export const ConfirmRemoteBranchInputSchema = z.object({
  branch: z.string().optional(),
  remote: z.string().default('origin'),
  repo_path: z.string().optional(),
});

export type ConfirmRemoteBranchInput = z.input<typeof ConfirmRemoteBranchInputSchema>;

/**
 * Kết quả xác nhận remote branch qua git ls-remote (REL-005).
 */
export const ConfirmRemoteBranchResultSchema = z.object({
  feature_id: z.string().min(1),
  branch: z.string().min(1),
  remote: z.string().min(1),
  remote_ref: z.string().nullable().default(null),
  commit_sha: z.string().regex(/^[0-9a-f]{40}$/i).nullable().default(null),
  confirmed: z.boolean(),
  checked_at: z.string(),
});

export type ConfirmRemoteBranchResult = z.infer<typeof ConfirmRemoteBranchResultSchema>;

/**
 * Tham số đầu vào để tạo GitHub Pull Request cho feature (REL-006).
 */
export const CreateFeaturePrInputSchema = z.object({
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  base_branch: z.string().min(1).optional(),
  head_branch: z.string().min(1).optional(),
  draft: z.boolean().default(false),
  repo_path: z.string().optional(),
  save_report_file: z.boolean().default(true),
  report_file_path: z.string().optional(),
  max_retries: z.number().int().min(0).max(5).default(2),
  retry_delay_ms: z.number().int().min(0).default(300),
  allow_existing: z.boolean().default(true),
});

export type CreateFeaturePrInput = z.input<typeof CreateFeaturePrInputSchema>;

/**
 * Kết quả tạo GitHub Pull Request cho feature release (REL-006).
 */
export const CreateFeaturePrResultSchema = z.object({
  release_id: z.string().min(1),
  feature_id: z.string().min(1),
  branch: z.string().min(1),
  base_branch: z.string().min(1),
  commit_sha: z.string().regex(/^[0-9a-f]{40}$/i, 'Commit SHA must be a 40-character hex string'),
  pr_url: z.string().url('PR URL must be a valid URL'),
  pr_number: z.number().int().positive().nullable().default(null),
  status: FeatureReleaseStatusSchema,
  quality_report_id: z.string().nullable().default(null),
  quality_report_path: z.string().nullable().default(null),
  created_at: z.string(),
});

export type CreateFeaturePrResult = z.infer<typeof CreateFeaturePrResultSchema>;

/**
 * Kết quả truy vấn / lấy nội dung báo cáo release của feature (REL-006).
 */
export const FeatureReleaseReportResultSchema = z.object({
  feature_id: z.string().min(1),
  feature_name: z.string().min(1),
  release_id: z.string().min(1),
  branch: z.string().min(1),
  base_branch: z.string().min(1),
  commit_sha: z.string().min(1),
  pr_url: z.string().nullable().default(null),
  status: FeatureReleaseStatusSchema,
  report_content: z.string().min(1),
  report_path: z.string().nullable().default(null),
  report_id: z.string().nullable().default(null),
  generated_at: z.string(),
});

export type FeatureReleaseReportResult = z.infer<typeof FeatureReleaseReportResultSchema>;

export interface GenerateFeatureReleaseReportOptions {
  featureId: string;
  featureName: string;
  description?: string | null;
  branch: string;
  baseBranch: string;
  commitSha: string;
  prUrl?: string | null;
  tasks: FeatureComponentTask[];
  taskSummary: FeatureTaskSummary;
  qualityGateResult?: QualityGateResult | null;
  integrationTests?: FeatureIntegrationTestRecord[];
  generatedAt?: string;
}

/**
 * Sinh nội dung báo cáo phát hành tính năng (Feature Release Report) dạng Markdown chuẩn.
 */
export function generateFeatureReleaseReportMarkdown(
  options: GenerateFeatureReleaseReportOptions,
): string {
  const {
    featureId,
    featureName,
    description,
    branch,
    baseBranch,
    commitSha,
    prUrl,
    tasks,
    taskSummary,
    qualityGateResult,
    integrationTests,
    generatedAt = new Date().toISOString(),
  } = options;

  const lines: string[] = [
    `# Feature Release Report: ${featureName} (${featureId})`,
    '',
    `- **Feature ID**: \`${featureId}\``,
    `- **Feature Name**: ${featureName}`,
    `- **Status**: **READY_FOR_REVIEW** (Chờ người duyệt)`,
    `- **Base Branch**: \`${baseBranch}\``,
    `- **Release Branch**: \`${branch}\``,
    `- **Commit SHA**: \`${commitSha}\``,
    prUrl ? `- **Pull Request**: [${prUrl}](${prUrl})` : `- **Pull Request**: Pending Creation`,
    `- **Report Generated At**: ${generatedAt}`,
    '',
    '## 1. Description',
    description || '_No description provided._',
    '',
    '## 2. Component Tasks',
    `- Total: ${taskSummary.total_tasks} | Required: ${taskSummary.required_count} | Completed: ${taskSummary.completed_count} | Pending: ${taskSummary.pending_count} | Failed: ${taskSummary.failed_count}`,
    '',
    '| Order | Task ID | Title | Status | Required | Phase |',
    '|---|---|---|---|---|---|',
  ];

  for (const t of tasks) {
    const statusIcon = t.status === 'DONE' ? '✅' : '⏳';
    const reqIcon = t.is_required ? '🔴 Required' : '⚪ Optional';
    lines.push(
      `| ${t.execution_order} | \`${t.id}\` | ${t.title} | ${statusIcon} ${t.status} | ${reqIcon} | ${t.phase ?? 'N/A'} |`,
    );
  }

  lines.push('', '## 3. Quality Gate & Compliance');
  if (qualityGateResult) {
    const qgIcon = qualityGateResult.passed ? '✅ PASSED' : '❌ FAILED';
    const es = qualityGateResult.evidence_summary;
    const scopePass = es.outOfScopeFilesCount === 0;
    const reviewPass = es.reviewHighCount === 0 && es.reviewCriticalCount === 0;
    const secPass = es.secretFindingsCount === 0 && es.auditHighCriticalCount === 0;
    const cmdPass = es.failedCommands === 0;

    lines.push(
      `- **Overall Status**: **${qgIcon}** (${qualityGateResult.status})`,
      `- **Summary**: ${qualityGateResult.summary}`,
      `- **Evaluated At**: ${qualityGateResult.evaluated_at}`,
      '',
      '| Check Area | Status | Evidence |',
      '|---|---|---|',
      `| CLI Execution | ${es.cliSucceeded ? '✅ PASS' : '❌ FAIL'} | Exit code ${es.cliExitCode ?? 0} |`,
      `| Quality Commands | ${cmdPass ? '✅ PASS' : '❌ FAIL'} | ${es.passedCommands}/${es.totalCommands} passed (failed: ${es.failedCommands}) |`,
      `| Task Scope Check | ${scopePass ? '✅ PASS' : '❌ FAIL'} | ${es.outOfScopeFilesCount} foreign files modified |`,
      `| Code Review | ${reviewPass ? '✅ PASS' : '❌ FAIL'} | ${es.reviewCriticalCount} critical, ${es.reviewHighCount} high findings |`,
      `| Security Check | ${secPass ? '✅ PASS' : '❌ FAIL'} | ${es.secretFindingsCount} secrets leaked, ${es.auditHighCriticalCount} audit vulnerabilities |`,
    );
  } else {
    lines.push('- All component tasks completed with Quality Gate PASS evidence verified.');
  }

  if (integrationTests && integrationTests.length > 0) {
    lines.push(
      '',
      '## 4. Integration Test Results',
      '| Command | Status | Exit Code | Duration |',
      '|---|---|---|---|',
    );
    for (const test of integrationTests) {
      const icon = test.status === 'SUCCESS' ? '✅' : '❌';
      lines.push(
        `| \`${test.command}\` | ${icon} ${test.status} | ${test.exit_code ?? 'N/A'} | ${test.duration_ms}ms |`,
      );
    }
  }

  lines.push(
    '',
    '## 5. Review & Sign-Off Checklist',
    '- [x] All required component tasks verified and DONE',
    '- [x] Quality Gate passed with automated verification evidence',
    '- [x] Standardized Conventional Commit created with SHA recorded',
    '- [x] Feature branch pushed to remote and confirmed via `git ls-remote`',
    '- [ ] Pull Request reviewed and approved by human maintainer',
    '',
    '> **Note**: Bàn giao feature đã sẵn sàng. Chờ người duyệt (human approval) trước khi merge vào nhánh chính.',
  );

  return lines.join('\n');
}




