import { z } from 'zod';
import type { QualityCommandRecord } from '../quality/types.js';
import type { ReviewFinding } from './quality-review.js';
import { isReviewPassing } from './quality-review.js';

export const RepairLoopStatusSchema = z.enum([
  'RUNNING',
  'PASSED',
  'FAILED',
  'CANCELLED',
  'STOPPED',
]);

export type RepairLoopStatus = z.infer<typeof RepairLoopStatusSchema>;

export const RepairIterationStatusSchema = z.enum([
  'IN_PROGRESS',
  'PASSED',
  'FAILED',
  'SKIPPED',
]);

export type RepairIterationStatus = z.infer<typeof RepairIterationStatusSchema>;

export const CommandFailureSnippetSchema = z.object({
  command_id: z.string(),
  stage: z.string(),
  command: z.string(),
  exit_code: z.number().nullable().default(null),
  status: z.string(),
  error_snippet: z.string().default(''),
});

export type CommandFailureSnippet = z.infer<typeof CommandFailureSnippetSchema>;

export const ReviewFindingSnippetSchema = z.object({
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
  file: z.string(),
  line: z.number().nullable().default(null),
  message: z.string(),
  suggestion: z.string().nullable().default(null),
});

export type ReviewFindingSnippet = z.infer<typeof ReviewFindingSnippetSchema>;

export const RepairFeedbackSchema = z.object({
  command_failures: z.array(CommandFailureSnippetSchema).default([]),
  review_findings: z.array(ReviewFindingSnippetSchema).default([]),
  summary: z.string().default(''),
});

export type RepairFeedback = z.infer<typeof RepairFeedbackSchema>;

export const RepairIterationRecordSchema = z.object({
  id: z.string().min(1),
  repair_loop_id: z.string().min(1),
  iteration_number: z.number().int().min(1),
  run_id: z.string().nullable().default(null),
  status: RepairIterationStatusSchema,
  passed: z.boolean(),
  command_failures_count: z.number().int().nonnegative().default(0),
  review_findings_count: z.number().int().nonnegative().default(0),
  prompt: z.string().default(''),
  feedback: RepairFeedbackSchema,
  duration_ms: z.number().int().nonnegative().default(0),
  created_at: z.string(),
});

export type RepairIterationRecord = z.infer<typeof RepairIterationRecordSchema>;

export const RepairLoopRecordSchema = z.object({
  id: z.string().min(1),
  task_id: z.string().min(1),
  run_id: z.string().nullable().default(null),
  max_iterations: z.number().int().positive().default(3),
  current_iteration: z.number().int().nonnegative().default(0),
  status: RepairLoopStatusSchema,
  passed: z.boolean().default(false),
  final_reason: z.string().nullable().default(null),
  feedback_summary: z.string().nullable().default(null),
  created_at: z.string(),
  finished_at: z.string().nullable().default(null),
  iterations: z.array(RepairIterationRecordSchema).optional(),
});

export type RepairLoopRecord = z.infer<typeof RepairLoopRecordSchema>;

export const CreateRepairLoopInputSchema = z.object({
  id: z.string().optional(),
  task_id: z.string().min(1, 'task_id is required'),
  run_id: z.string().nullable().optional(),
  max_iterations: z.number().int().positive().default(3),
  feedback_summary: z.string().nullable().optional(),
});

export type CreateRepairLoopInput = z.input<typeof CreateRepairLoopInputSchema>;
export type CreateRepairLoopData = z.output<typeof CreateRepairLoopInputSchema>;

export const CreateRepairIterationInputSchema = z.object({
  id: z.string().optional(),
  repair_loop_id: z.string().min(1, 'repair_loop_id is required'),
  iteration_number: z.number().int().positive('iteration_number must be >= 1'),
  run_id: z.string().nullable().optional(),
  status: RepairIterationStatusSchema.default('IN_PROGRESS'),
  passed: z.boolean().default(false),
  command_failures_count: z.number().int().nonnegative().default(0),
  review_findings_count: z.number().int().nonnegative().default(0),
  prompt: z.string().optional().default(''),
  feedback: RepairFeedbackSchema.optional().default({ command_failures: [], review_findings: [], summary: '' }),
  duration_ms: z.number().int().nonnegative().default(0),
  created_at: z.string().optional(),
});

export type CreateRepairIterationInput = z.input<typeof CreateRepairIterationInputSchema>;
export type CreateRepairIterationData = z.output<typeof CreateRepairIterationInputSchema>;

/**
 * Extracts relevant error output from a failed QualityCommandRecord.
 */
export function extractCommandFailureSnippet(record: QualityCommandRecord, maxChars = 2000): string {
  const text = (record.stderr || record.stdout || '').trim();
  if (!text) {
    return `Command exited with code ${record.exit_code ?? 'null'} and status ${record.status}`;
  }
  if (text.length <= maxChars) {
    return text;
  }
  // Keep the trailing output as failure details usually appear at the end
  return `... (truncated) ...\n` + text.slice(text.length - maxChars);
}

/**
 * Compiles a structured RepairFeedback object from QualityRunner command records and Reviewer findings.
 */
export function compileRepairFeedback(options: {
  commandRecords?: QualityCommandRecord[];
  reviewFindings?: ReviewFinding[];
  customSummary?: string;
}): RepairFeedback {
  const { commandRecords = [], reviewFindings = [], customSummary } = options;

  const failedCommands: CommandFailureSnippet[] = commandRecords
    .filter((rec) => rec.status !== 'SUCCESS' || (rec.exit_code !== null && rec.exit_code !== 0))
    .map((rec) => ({
      command_id: rec.command_id,
      stage: rec.stage,
      command: rec.command,
      exit_code: rec.exit_code,
      status: rec.status,
      error_snippet: extractCommandFailureSnippet(rec),
    }));

  const findingsSnippets: ReviewFindingSnippet[] = reviewFindings.map((f) => ({
    severity: f.severity,
    file: f.file,
    line: f.line ?? null,
    message: f.message,
    suggestion: f.suggestion ?? null,
  }));

  const summaryParts: string[] = [];
  if (customSummary) {
    summaryParts.push(customSummary);
  }
  if (failedCommands.length > 0) {
    summaryParts.push(`${failedCommands.length} verification command(s) failed`);
  }
  if (findingsSnippets.length > 0) {
    const highCrit = findingsSnippets.filter((f) => f.severity === 'critical' || f.severity === 'high').length;
    summaryParts.push(`${findingsSnippets.length} review finding(s) (${highCrit} high/critical)`);
  }

  return {
    command_failures: failedCommands,
    review_findings: findingsSnippets,
    summary: summaryParts.join(' | ') || 'No failures reported',
  };
}

/**
 * Evaluates whether an iteration passed both verification command checks and code review standards.
 */
export function isRepairIterationPassed(options: {
  commandRecords?: QualityCommandRecord[];
  reviewFindings?: ReviewFinding[];
}): boolean {
  const { commandRecords = [], reviewFindings = [] } = options;

  // 1. All commands must succeed (exit 0 and status SUCCESS)
  const allCommandsPassed = commandRecords.every(
    (rec) => rec.status === 'SUCCESS' && (rec.exit_code === 0 || rec.exit_code === null),
  );
  if (!allCommandsPassed) {
    return false;
  }

  // 2. Review findings must not contain high or critical issues (SKILL-testing rule)
  const reviewPassed = isReviewPassing(reviewFindings);
  if (!reviewPassed) {
    return false;
  }

  return true;
}

/**
 * Constructs a structured repair prompt guiding the AI worker to resolve verification and review failures.
 */
export function buildRepairPrompt(params: {
  taskId: string;
  taskTitle?: string;
  taskDescription?: string;
  acceptanceCriteria?: string[];
  feedback: RepairFeedback;
  iteration: number;
  maxIterations: number;
}): string {
  const {
    taskId,
    taskTitle = taskId,
    taskDescription = '',
    acceptanceCriteria = [],
    feedback,
    iteration,
    maxIterations,
  } = params;

  const lines: string[] = [
    `# REPAIR REQUEST (Iteration ${iteration} of ${maxIterations})`,
    '',
    `Task ID: ${taskId}`,
    `Title: ${taskTitle}`,
  ];

  if (taskDescription) {
    lines.push(`Description: ${taskDescription}`);
  }

  if (acceptanceCriteria.length > 0) {
    lines.push('', '## Acceptance Criteria:');
    for (const c of acceptanceCriteria) {
      lines.push(`- ${c}`);
    }
  }

  lines.push('', `## Quality Failures to Fix (Attempt ${iteration}/${maxIterations}):`);

  if (feedback.command_failures.length > 0) {
    lines.push('', '### Command Failures:');
    for (const cmd of feedback.command_failures) {
      lines.push(`- **Stage [${cmd.stage}]**: \`${cmd.command}\` (exit code: ${cmd.exit_code ?? 'unknown'}, status: ${cmd.status})`);
      lines.push('  ```text');
      lines.push(`  ${cmd.error_snippet.replace(/\n/g, '\n  ')}`);
      lines.push('  ```');
    }
  }

  if (feedback.review_findings.length > 0) {
    lines.push('', '### Code Review Findings:');
    for (const finding of feedback.review_findings) {
      const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      lines.push(`- **[${finding.severity.toUpperCase()}]** at \`${location}\`: ${finding.message}`);
      if (finding.suggestion) {
        lines.push(`  *Suggestion*: ${finding.suggestion}`);
      }
    }
  }

  lines.push(
    '',
    '## Instructions:',
    '1. Focus strictly on fixing the command failures and review findings listed above.',
    '2. Preserve existing working functionality and do not introduce unrelated changes.',
    '3. Ensure all tests, linter, typecheck, and formatting checks pass completely.',
  );

  return lines.join('\n');
}
