import { z } from 'zod';
import { TaskStatusSchema, type TaskStatus } from '../models/task.js';
import { FeatureStatusSchema, type FeatureStatus } from '../models/feature.js';

export const SHEET_NAMES = {
  TASKS: 'Tasks',
  FEATURES: 'Features',
  CONFIG: 'Config',
} as const;

export type SheetName = (typeof SHEET_NAMES)[keyof typeof SHEET_NAMES];

export interface RawRow {
  rowNumber: number;
  data: Record<string, unknown>;
}

export interface ParsedTaskRow {
  id: string;
  feature_id: string | null;
  title: string;
  description: string | null;
  phase: string | null;
  worker_type: string;
  repository: string;
  acceptance_criteria: string[];
  test_commands: string[];
  priority: number;
  max_attempts: number;
  timeout_minutes: number;
  dependencies: string[];
  status: TaskStatus;
  rowNumber: number;
  raw: Record<string, unknown>;
}

export interface ParsedFeatureRow {
  id: string;
  name: string;
  description: string | null;
  required_tasks: string[];
  integration_tests: string[];
  release_policy: string | null;
  status: FeatureStatus;
  rowNumber: number;
  raw: Record<string, unknown>;
}

export interface ParsedConfig {
  repository: string;
  agy_bin: string;
  agy_args: string;
  verify_commands: string[];
  max_attempts: number;
  timeout_minutes: number;
  max_concurrency: number;
  settings: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface ParsedWorkbookResult {
  tasks: ParsedTaskRow[];
  features: ParsedFeatureRow[];
  config: ParsedConfig;
  sourceType: 'excel' | 'csv';
}

export const ParsedTaskRowSchema = z.object({
  id: z.string().min(1, 'Task id is required'),
  feature_id: z.string().nullable().default(null),
  title: z.string().min(1, 'Task title is required'),
  description: z.string().nullable().default(null),
  phase: z.string().nullable().default(null),
  worker_type: z.string().min(1).default('agy'),
  repository: z.string().min(1).default('.'),
  acceptance_criteria: z.array(z.string()).default([]),
  test_commands: z.array(z.string()).default([]),
  priority: z.number().int().default(0),
  max_attempts: z.number().int().min(1).default(3),
  timeout_minutes: z.number().int().min(1).default(30),
  dependencies: z.array(z.string()).default([]),
  status: TaskStatusSchema.default('TODO'),
  rowNumber: z.number().int().min(1),
  raw: z.record(z.string(), z.unknown()),
});

export const ParsedFeatureRowSchema = z.object({
  id: z.string().min(1, 'Feature id is required'),
  name: z.string().min(1, 'Feature name is required'),
  description: z.string().nullable().default(null),
  required_tasks: z.array(z.string()).default([]),
  integration_tests: z.array(z.string()).default([]),
  release_policy: z.string().nullable().default(null),
  status: FeatureStatusSchema.default('TODO'),
  rowNumber: z.number().int().min(1),
  raw: z.record(z.string(), z.unknown()),
});

export const ParsedConfigSchema = z.object({
  repository: z.string().default('.'),
  agy_bin: z.string().default('agy'),
  agy_args: z.string().default('-p'),
  verify_commands: z.array(z.string()).default([]),
  max_attempts: z.number().int().min(1).default(3),
  timeout_minutes: z.number().int().min(1).default(30),
  max_concurrency: z.number().int().min(1).default(1),
  settings: z.record(z.string(), z.unknown()).default({}),
  raw: z.record(z.string(), z.unknown()).default({}),
});

export const ParsedWorkbookResultSchema = z.object({
  tasks: z.array(ParsedTaskRowSchema),
  features: z.array(ParsedFeatureRowSchema),
  config: ParsedConfigSchema,
  sourceType: z.enum(['excel', 'csv']),
});

/**
 * Header alias dictionary for matching columns across different naming conventions
 */
export const TASK_HEADER_ALIASES: Record<string, string> = {
  id: 'id',
  task_id: 'id',
  taskid: 'id',
  'task id': 'id',
  'mã task': 'id',
  matask: 'id',

  feature_id: 'feature_id',
  featureid: 'feature_id',
  'feature id': 'feature_id',
  feature: 'feature_id',
  'mã feature': 'feature_id',

  title: 'title',
  name: 'title',
  'task title': 'title',
  'task name': 'title',
  'tiêu đề': 'title',
  tên: 'title',

  description: 'description',
  desc: 'description',
  'mô tả': 'description',
  mota: 'description',

  phase: 'phase',
  stage: 'phase',
  'giai đoạn': 'phase',
  giaidoan: 'phase',

  worker_type: 'worker_type',
  worker: 'worker_type',
  'worker type': 'worker_type',
  'loại worker': 'worker_type',

  repository: 'repository',
  repo: 'repository',
  'kho mã nguồn': 'repository',

  acceptance_criteria: 'acceptance_criteria',
  acceptance: 'acceptance_criteria',
  'acceptance criteria': 'acceptance_criteria',
  'nghiệm thu': 'acceptance_criteria',
  nghiem_thu: 'acceptance_criteria',
  'tiêu chí': 'acceptance_criteria',

  test_commands: 'test_commands',
  test_command: 'test_commands',
  'test commands': 'test_commands',
  tests: 'test_commands',
  'lệnh test': 'test_commands',
  lenh_test: 'test_commands',

  priority: 'priority',
  'độ ưu tiên': 'priority',
  douutien: 'priority',

  max_attempts: 'max_attempts',
  maxattempts: 'max_attempts',
  'max attempts': 'max_attempts',
  'số lần thử': 'max_attempts',

  timeout_minutes: 'timeout_minutes',
  timeout: 'timeout_minutes',
  'timeout minutes': 'timeout_minutes',
  'thời gian chờ': 'timeout_minutes',

  dependencies: 'dependencies',
  depends_on: 'dependencies',
  dep: 'dependencies',
  deps: 'dependencies',
  'phụ thuộc': 'dependencies',
  phuthuoc: 'dependencies',

  status: 'status',
  'trạng thái': 'status',
  trangthai: 'status',
};

export const FEATURE_HEADER_ALIASES: Record<string, string> = {
  id: 'id',
  feature_id: 'id',
  featureid: 'id',
  'feature id': 'id',
  'mã feature': 'id',

  name: 'name',
  title: 'name',
  'feature name': 'name',
  'tiêu đề': 'name',
  tên: 'name',

  description: 'description',
  desc: 'description',
  'mô tả': 'description',

  required_tasks: 'required_tasks',
  tasks: 'required_tasks',
  'required tasks': 'required_tasks',
  'danh sách task': 'required_tasks',

  integration_tests: 'integration_tests',
  tests: 'integration_tests',
  'integration tests': 'integration_tests',
  'lệnh test': 'integration_tests',

  release_policy: 'release_policy',
  policy: 'release_policy',
  'release policy': 'release_policy',
  'chính sách release': 'release_policy',

  status: 'status',
  'trạng thái': 'status',
};

export const CONFIG_HEADER_ALIASES: Record<string, string> = {
  key: 'key',
  setting: 'key',
  name: 'key',
  parameter: 'key',
  'tham số': 'key',
  khóa: 'key',

  value: 'value',
  val: 'value',
  'giá trị': 'value',
};

export function normalizeHeader(rawHeader: string): string {
  return rawHeader.trim().toLowerCase().replace(/[\t_]+/g, ' ').replace(/\s+/g, ' ');
}

export function extractCellValue(cellValue: unknown): unknown {
  if (cellValue === null || cellValue === undefined) {
    return null;
  }
  if (typeof cellValue === 'object') {
    if ('richText' in cellValue && Array.isArray((cellValue as { richText: unknown[] }).richText)) {
      return (cellValue as { richText: Array<{ text?: string }> }).richText
        .map((part) => part.text ?? '')
        .join('');
    }
    if ('formula' in cellValue) {
      const formulaObj = cellValue as { formula: string; result?: unknown };
      return formulaObj.result !== undefined ? extractCellValue(formulaObj.result) : null;
    }
    if ('text' in cellValue && 'hyperlink' in cellValue) {
      return (cellValue as { text: unknown }).text;
    }
    if (cellValue instanceof Date) {
      return cellValue.toISOString();
    }
    if ('error' in cellValue) {
      return null;
    }
  }
  return cellValue;
}

export function parseString(val: unknown, fallback: string | null = null): string | null {
  if (val === null || val === undefined) return fallback;
  const str = String(val).trim();
  return str === '' ? fallback : str;
}

export function parseNumber(val: unknown, fallback: number): number {
  if (typeof val === 'number' && !Number.isNaN(val)) return Math.floor(val);
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '') return fallback;
    const num = Number(trimmed);
    if (!Number.isNaN(num)) return Math.floor(num);
  }
  return fallback;
}

export function parseIdList(val: unknown): string[] {
  if (val === null || val === undefined) return [];
  if (Array.isArray(val)) {
    return val.map((v) => String(v).trim()).filter(Boolean);
  }
  const str = String(val).trim();
  if (!str) return [];
  return str
    .split(/[\r\n,;]+/)
    .map((item) => item.replace(/^[-*•\s]+/, '').trim())
    .filter(Boolean);
}

export function parseMultilineList(val: unknown): string[] {
  if (val === null || val === undefined) return [];
  if (Array.isArray(val)) {
    return val.map((v) => String(v).trim()).filter(Boolean);
  }
  const str = String(val).trim();
  if (!str) return [];
  // Split by newlines or semicolons
  return str
    .split(/[\r\n;]+/)
    .map((item) => item.replace(/^[-*•\s]+/, '').trim())
    .filter(Boolean);
}
