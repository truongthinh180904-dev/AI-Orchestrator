import { z } from 'zod';

/**
 * Finding severity levels for code review findings.
 * Ordered conceptually from lowest to highest impact.
 */
export const FindingSeveritySchema = z.enum([
  'info',
  'low',
  'medium',
  'high',
  'critical',
]);

export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

/**
 * Core Review Finding Schema required by QLT-004:
 * findings { severity, file, line, message }
 * with optional enriched metadata (category, rule_id, suggestion).
 */
export const ReviewFindingSchema = z.object({
  id: z.string().optional(),
  severity: FindingSeveritySchema,
  file: z.string().min(1, 'File path cannot be empty'),
  line: z.number().int().min(1, 'Line number must be a positive integer (>= 1)'),
  message: z.string().min(1, 'Message cannot be empty'),
  category: z.string().optional().nullable(),
  rule_id: z.string().optional().nullable(),
  suggestion: z.string().optional().nullable(),
});

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

/**
 * Persisted Review Finding Record in database
 */
export const ReviewFindingRecordSchema = z.object({
  id: z.string().min(1),
  task_id: z.string().nullable().default(null),
  run_id: z.string().nullable().default(null),
  severity: FindingSeveritySchema,
  file: z.string().min(1),
  line: z.number().int().min(1),
  message: z.string().min(1),
  category: z.string().nullable().default(null),
  rule_id: z.string().nullable().default(null),
  suggestion: z.string().nullable().default(null),
  created_at: z.string(),
});

export type ReviewFindingRecord = z.infer<typeof ReviewFindingRecordSchema>;

export const CreateReviewFindingRecordInputSchema = z.object({
  id: z.string().optional(),
  task_id: z.string().nullable().optional(),
  run_id: z.string().nullable().optional(),
  severity: FindingSeveritySchema,
  file: z.string().min(1),
  line: z.number().int().min(1),
  message: z.string().min(1),
  category: z.string().nullable().optional(),
  rule_id: z.string().nullable().optional(),
  suggestion: z.string().nullable().optional(),
  created_at: z.string().optional(),
});

export type CreateReviewFindingRecordInput = z.infer<typeof CreateReviewFindingRecordInputSchema>;

/**
 * Flexible input normalizer for ReviewFinding that accepts LLM output variations
 * (e.g. capitalized severity "HIGH", string line numbers "15", alternative keys like "path" or "comment").
 */
export const ReviewFindingInputSchema = z.preprocess((val) => {
  if (typeof val !== 'object' || val === null) {
    return val;
  }
  const v = val as Record<string, unknown>;

  // Normalize severity
  let severity = v['severity'];
  if (typeof severity === 'string') {
    severity = severity.toLowerCase().trim();
  }

  // Normalize file / path
  const file = v['file'] ?? v['path'] ?? v['filename'] ?? v['file_path'];

  // Normalize line number (defaults to 1 if not provided or invalid)
  let line = v['line'] ?? v['line_number'] ?? v['lineNumber'] ?? v['line_no'] ?? 1;
  if (typeof line === 'string') {
    const parsed = parseInt(line, 10);
    line = !isNaN(parsed) && parsed > 0 ? parsed : 1;
  } else if (typeof line === 'number' && (isNaN(line) || line < 1)) {
    line = 1;
  }

  // Normalize message
  const message =
    v['message'] ??
    v['description'] ??
    v['detail'] ??
    v['comment'] ??
    v['finding'] ??
    v['title'];

  return {
    ...v,
    severity,
    file,
    line,
    message,
  };
}, ReviewFindingSchema);

export type ReviewFindingInput = z.input<typeof ReviewFindingInputSchema>;

/**
 * Review Statistics Schema
 */
export const ReviewStatsSchema = z.object({
  total: z.number().int().nonnegative(),
  critical: z.number().int().nonnegative(),
  high: z.number().int().nonnegative(),
  medium: z.number().int().nonnegative(),
  low: z.number().int().nonnegative(),
  info: z.number().int().nonnegative(),
});

export type ReviewStats = z.infer<typeof ReviewStatsSchema>;

/**
 * Review Result Schema
 */
export const ReviewResultSchema = z.object({
  id: z.string().optional(),
  task_id: z.string().nullable().optional(),
  run_id: z.string().nullable().optional(),
  passed: z.boolean(),
  findings: z.array(ReviewFindingSchema),
  stats: ReviewStatsSchema,
  summary: z.string(),
  raw_output: z.string().nullable().optional(),
  reviewed_at: z.string(),
  reviewer_type: z.string().default('agy'),
});

export type ReviewResult = z.infer<typeof ReviewResultSchema>;

/**
 * Input Schema for Reviewer Service
 */
export const ReviewDiffInputSchema = z.object({
  taskId: z.string().optional(),
  runId: z.string().optional(),
  repoPath: z.string().optional(),
  diff: z.string().optional(),
  changedFiles: z.array(z.string()).optional(),
  contextFiles: z.array(z.string()).optional(),
  taskTitle: z.string().optional(),
  taskDescription: z.string().nullable().optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  scopeFiles: z.array(z.string()).optional(),
  customPrompt: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  command: z
    .object({
      exe: z.string().optional(),
      args: z.array(z.string()).optional(),
    })
    .optional(),
});

export type ReviewDiffInput = z.infer<typeof ReviewDiffInputSchema>;

/**
 * Filter schema for querying review findings in DB
 */
export const ReviewFindingFilterSchema = z.object({
  taskId: z.string().optional(),
  runId: z.string().optional(),
  severity: FindingSeveritySchema.optional(),
  file: z.string().optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
});

export type ReviewFindingFilter = z.infer<typeof ReviewFindingFilterSchema>;

/**
 * Computes statistics from an array of review findings.
 */
export function computeReviewStats(findings: ReviewFinding[]): ReviewStats {
  const stats: ReviewStats = {
    total: findings.length,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };

  for (const finding of findings) {
    if (finding.severity in stats) {
      stats[finding.severity]++;
    }
  }

  return stats;
}

/**
 * Evaluates whether review findings satisfy Quality Gate policy:
 * Rule from SKILL-testing.md: "5. không finding severity high/critical từ reviewer".
 * Returns true if there are NO findings with severity 'high' or 'critical'.
 */
export function isReviewPassing(findings: ReviewFinding[]): boolean {
  return !findings.some(
    (f) => f.severity === 'critical' || f.severity === 'high',
  );
}

/**
 * Safely extracts JSON from raw reviewer output, handling:
 * 1. Markdown code fences: ```json ... ``` or ``` ... ```
 * 2. Raw JSON arrays: [ { ... } ]
 * 3. JSON objects with `findings` or `issues` keys: { "findings": [ ... ] }
 * 4. Trailing commas or mixed conversational wrapper text.
 */
export function extractJsonFindings(rawText: string): unknown {
  if (!rawText || !rawText.trim()) {
    return [];
  }

  const trimmed = rawText.trim();

  // 1. Try markdown code block extraction
  const codeBlockMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (codeBlockMatch && codeBlockMatch[1]) {
    const candidate = codeBlockMatch[1].trim();
    try {
      return parseJsonWithCleanup(candidate);
    } catch {
      // Continue to next extraction strategies
    }
  }

  // 2. Direct JSON parse
  try {
    return parseJsonWithCleanup(trimmed);
  } catch {
    // Continue
  }

  // 3. Search for array boundaries [ ... ]
  const arrayStart = trimmed.indexOf('[');
  const arrayEnd = trimmed.lastIndexOf(']');
  if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
    const arraySubstring = trimmed.slice(arrayStart, arrayEnd + 1);
    try {
      return parseJsonWithCleanup(arraySubstring);
    } catch {
      // Continue
    }
  }

  // 4. Search for object boundaries { ... }
  const objStart = trimmed.indexOf('{');
  const objEnd = trimmed.lastIndexOf('}');
  if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
    const objSubstring = trimmed.slice(objStart, objEnd + 1);
    try {
      return parseJsonWithCleanup(objSubstring);
    } catch {
      // Continue
    }
  }

  throw new Error('Could not extract valid JSON from reviewer agent output');
}

/**
 * Cleans up common JSON quirks (trailing commas) before JSON.parse.
 */
function parseJsonWithCleanup(jsonStr: string): unknown {
  // Remove trailing commas before closing braces or brackets
  const cleaned = jsonStr
    .replace(/,\s*([}\]])/g, '$1')
    .trim();
  return JSON.parse(cleaned);
}

/**
 * Validates and normalizes raw findings output into strongly-typed ReviewFinding[].
 * Accepts an array directly or an object `{ findings: [...] }` or `{ issues: [...] }`.
 */
export function validateReviewFindings(raw: unknown): ReviewFinding[] {
  let items: unknown[];

  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === 'object' && raw !== null) {
    const record = raw as Record<string, unknown>;
    if (Array.isArray(record['findings'])) {
      items = record['findings'];
    } else if (Array.isArray(record['issues'])) {
      items = record['issues'];
    } else if (Array.isArray(record['results'])) {
      items = record['results'];
    } else {
      // Single finding object
      items = [record];
    }
  } else {
    throw new Error('Review findings must be a JSON array or object containing a findings list');
  }

  return items.map((item, index) => {
    try {
      return ReviewFindingInputSchema.parse(item);
    } catch (err) {
      throw new Error(
        `Finding at index ${index} violates schema: ${(err as Error).message}`,
        { cause: err },
      );
    }
  });
}

/**
 * Builds the reviewer prompt instructing AGY to review code diff and report findings.
 */
export function buildReviewerPrompt(options: {
  diff?: string;
  changedFiles?: string[];
  task?: {
    id?: string;
    title?: string;
    description?: string | null;
    acceptance_criteria?: string[];
    scope_files?: string[];
  };
  customInstructions?: string;
}): string {
  const parts: string[] = [];

  parts.push(
    `You are the AI Code Reviewer Agent. Your goal is to review code changes and report defects, bugs, security vulnerabilities, or acceptance criteria violations.`,
  );

  if (options.task) {
    parts.push(`\nTASK INFORMATION:`);
    if (options.task.id) parts.push(`Task ID: ${options.task.id}`);
    if (options.task.title) parts.push(`Title: ${options.task.title}`);
    if (options.task.description) parts.push(`Description: ${options.task.description}`);
    if (options.task.acceptance_criteria && options.task.acceptance_criteria.length > 0) {
      parts.push(`Acceptance Criteria:`);
      for (const ac of options.task.acceptance_criteria) {
        parts.push(`- ${ac}`);
      }
    }
    if (options.task.scope_files && options.task.scope_files.length > 0) {
      parts.push(`Allowed Scope Files:`);
      for (const sf of options.task.scope_files) {
        parts.push(`- ${sf}`);
      }
    }
  }

  if (options.changedFiles && options.changedFiles.length > 0) {
    parts.push(`\nCHANGED FILES:`);
    for (const f of options.changedFiles) {
      parts.push(`- ${f}`);
    }
  }

  if (options.diff) {
    parts.push(`\nGIT DIFF:`);
    parts.push(`\`\`\`diff\n${options.diff}\n\`\`\``);
  }

  if (options.customInstructions) {
    parts.push(`\nCUSTOM INSTRUCTIONS:\n${options.customInstructions}`);
  }

  parts.push(`
CRITICAL REVIEW CONSTRAINTS:
1. Severity MUST be one of: "critical" | "high" | "medium" | "low" | "info".
   - "critical": System-breaking bugs, crash loops, severe security vulnerabilities, data corruption.
   - "high": Broken acceptance criteria, business logic errors, unhandled edge cases causing failures.
   - "medium": Code quality violations, potential performance degradation, missing non-critical validations.
   - "low": Minor style issues, redundant code, missing comments.
   - "info": General observations or suggestions for future improvement.
2. Every finding MUST contain { severity, file, line, message }.
   - file: path of the affected file.
   - line: line number (integer >= 1).
   - message: concise description of the finding.
3. OUTPUT FORMAT: Respond ONLY with a valid JSON array of findings or an empty array [] if no issues exist.
Do NOT include explanations or text outside the JSON block.

Example JSON output:
[
  {
    "severity": "high",
    "file": "src/services/order.ts",
    "line": 42,
    "message": "Missing null check when accessing customer account, causing potential runtime exception",
    "category": "correctness",
    "suggestion": "Add if (!customer) throw new AppError('CUSTOMER_NOT_FOUND', ...)"
  }
]
If code is clean and passes all criteria, output:
[]
`);

  return parts.join('\n');
}
