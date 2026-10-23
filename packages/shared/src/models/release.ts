import { z } from 'zod';
import { TaskStatusSchema } from './task.js';
import { FeatureStatusSchema } from './feature.js';

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
