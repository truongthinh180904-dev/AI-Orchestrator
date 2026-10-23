import crypto from 'node:crypto';
import { z } from 'zod';

/**
 * Vulnerability severity levels reported by pnpm/npm audit.
 */
export const AUDIT_SEVERITY_LEVELS = ['info', 'low', 'moderate', 'high', 'critical'] as const;
export type AuditVulnerabilitySeverity = (typeof AUDIT_SEVERITY_LEVELS)[number];

export const AuditVulnerabilitySeveritySchema = z.enum([
  'info',
  'low',
  'moderate',
  'high',
  'critical',
]);

/**
 * Individual vulnerability advisory parsed from audit.
 */
export const AuditVulnerabilitySchema = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string().min(1, 'Advisory title cannot be empty'),
  module_name: z.string().min(1, 'Module name cannot be empty'),
  severity: AuditVulnerabilitySeveritySchema,
  vulnerable_versions: z.string().optional(),
  patched_versions: z.string().optional(),
  cwe: z.union([z.string(), z.array(z.string())]).optional(),
  url: z.string().optional(),
  paths: z.array(z.string()).default([]),
});

export type AuditVulnerability = z.infer<typeof AuditVulnerabilitySchema>;

/**
 * Aggregated advisory counts by severity.
 */
export const AuditCountsSchema = z.object({
  info: z.number().int().nonnegative().default(0),
  low: z.number().int().nonnegative().default(0),
  moderate: z.number().int().nonnegative().default(0),
  high: z.number().int().nonnegative().default(0),
  critical: z.number().int().nonnegative().default(0),
  total: z.number().int().nonnegative().default(0),
});

export type AuditCounts = z.infer<typeof AuditCountsSchema>;

/**
 * Full result of a dependency audit execution.
 */
export const AuditResultSchema = z.object({
  passed: z.boolean(),
  command: z.string().default('pnpm audit --json'),
  exit_code: z.number().nullable().default(null),
  stdout: z.string().default(''),
  stderr: z.string().default(''),
  duration_ms: z.number().int().nonnegative().default(0),
  vulnerabilities: z.array(AuditVulnerabilitySchema).default([]),
  counts: AuditCountsSchema,
  highOrCriticalCount: z.number().int().nonnegative().default(0),
  summary: z.string().default(''),
});

export type AuditResult = z.infer<typeof AuditResultSchema>;

/**
 * Secret finding discovered during secret scanning (via gitleaks or built-in scanner).
 */
export const SecretFindingSchema = z.object({
  id: z.string().optional(),
  rule_id: z.string().min(1, 'Rule ID is required'),
  description: z.string().min(1, 'Description is required'),
  file: z.string().min(1, 'File path is required'),
  line: z.number().int().positive().default(1),
  // Masked preview of the secret (e.g. AKIA************1234) — NEVER plaintext secret
  match_preview: z.string().min(1, 'Match preview is required'),
  secret_hash: z.string().optional(),
  commit: z.string().optional(),
  author: z.string().optional(),
  date: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export type SecretFinding = z.infer<typeof SecretFindingSchema>;

/**
 * Result of secret scanning execution.
 */
export const SecretScanResultSchema = z.object({
  passed: z.boolean(),
  scanner: z.enum(['gitleaks', 'builtin', 'both']),
  command: z.string().optional(),
  exit_code: z.number().nullable().optional().default(null),
  stdout: z.string().optional().default(''),
  stderr: z.string().optional().default(''),
  duration_ms: z.number().int().nonnegative().default(0),
  findings: z.array(SecretFindingSchema).default([]),
  total_findings: z.number().int().nonnegative().default(0),
  files_scanned: z.number().int().nonnegative().default(0),
  summary: z.string().default(''),
});

export type SecretScanResult = z.infer<typeof SecretScanResultSchema>;

/**
 * Comprehensive Security Check result combining dependency audit + secret scan.
 */
export const SecurityCheckResultSchema = z.object({
  id: z.string().min(1),
  task_id: z.string().nullable().default(null),
  run_id: z.string().nullable().default(null),
  repo_path: z.string().min(1),
  passed: z.boolean(),
  audit_passed: z.boolean(),
  secret_passed: z.boolean(),
  audit_high_critical_count: z.number().int().nonnegative().default(0),
  secret_findings_count: z.number().int().nonnegative().default(0),
  audit: AuditResultSchema,
  secrets: SecretScanResultSchema,
  summary: z.string().default(''),
  started_at: z.string(),
  finished_at: z.string(),
  duration_ms: z.number().int().nonnegative().default(0),
});

export type SecurityCheckResult = z.infer<typeof SecurityCheckResultSchema>;

/**
 * Database record for security check.
 */
export const SecurityCheckRecordSchema = z.object({
  id: z.string().min(1),
  task_id: z.string().nullable().default(null),
  run_id: z.string().nullable().default(null),
  repo_path: z.string().min(1),
  passed: z.boolean(),
  audit_passed: z.boolean(),
  secret_passed: z.boolean(),
  audit_high_critical_count: z.number().int().nonnegative().default(0),
  secret_findings_count: z.number().int().nonnegative().default(0),
  audit_summary: z.string().default('{}'),
  secret_summary: z.string().default('{}'),
  raw_details: z.string().default('{}'),
  duration_ms: z.number().int().nonnegative().default(0),
  created_at: z.string(),
});

export type SecurityCheckRecord = z.infer<typeof SecurityCheckRecordSchema>;

/**
 * Input for saving security check in database repository.
 */
export const CreateSecurityCheckRecordInputSchema = z.object({
  id: z.string().min(1).optional(),
  task_id: z.string().nullable().optional().default(null),
  run_id: z.string().nullable().optional().default(null),
  repo_path: z.string().min(1),
  passed: z.boolean(),
  audit_passed: z.boolean(),
  secret_passed: z.boolean(),
  audit_high_critical_count: z.number().int().nonnegative().default(0),
  secret_findings_count: z.number().int().nonnegative().default(0),
  audit_summary: z.string().optional().default('{}'),
  secret_summary: z.string().optional().default('{}'),
  raw_details: z.string().optional().default('{}'),
  duration_ms: z.number().int().nonnegative().default(0),
  created_at: z.string().optional(),
});

export type CreateSecurityCheckRecordInput = z.input<typeof CreateSecurityCheckRecordInputSchema>;
export type CreateSecurityCheckRecordData = z.output<typeof CreateSecurityCheckRecordInputSchema>;

/**
 * Filter schema for querying security checks.
 */
export const SecurityCheckFilterSchema = z.object({
  task_id: z.string().optional(),
  run_id: z.string().optional(),
  passed: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
});

export type SecurityCheckFilter = z.infer<typeof SecurityCheckFilterSchema>;

/**
 * Masks a secret string to ensure no secret is exposed in logs or DB per rule 3 of AGENTS.md.
 * Keeps at most 3 characters at start and end, replacing everything else with asterisks.
 */
export function maskSecret(secret: string, prefixLen = 3, suffixLen = 3): string {
  if (!secret) return '[REDACTED]';
  const clean = secret.trim();
  if (clean.length <= prefixLen + suffixLen + 2) {
    return '***[REDACTED]***';
  }
  const prefix = clean.slice(0, prefixLen);
  const suffix = clean.slice(-suffixLen);
  const stars = '*'.repeat(Math.max(6, Math.min(16, clean.length - (prefixLen + suffixLen))));
  return `${prefix}${stars}${suffix}`;
}

/**
 * Generates a SHA-256 hash of a secret for indexing and deduplication without exposing plaintext.
 */
export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret.trim()).digest('hex');
}
