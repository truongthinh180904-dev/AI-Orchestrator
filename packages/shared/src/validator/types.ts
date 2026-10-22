import { z } from 'zod';

export const VALIDATION_ERROR_CODES = {
  REQUIRED_FIELD: 'REQUIRED_FIELD',
  INVALID_IDENTIFIER_FORMAT: 'INVALID_IDENTIFIER_FORMAT',
  INVALID_STATUS: 'INVALID_STATUS',
  INVALID_NUMBER: 'INVALID_NUMBER',
  INVALID_INTEGER: 'INVALID_INTEGER',
  VALUE_OUT_OF_RANGE: 'VALUE_OUT_OF_RANGE',
  STRING_TOO_LONG: 'STRING_TOO_LONG',
  EMPTY_LIST_ITEM: 'EMPTY_LIST_ITEM',
  SELF_DEPENDENCY: 'SELF_DEPENDENCY',
  INVALID_WORKER_TYPE: 'INVALID_WORKER_TYPE',
  INVALID_REPOSITORY: 'INVALID_REPOSITORY',
  INVALID_EXECUTABLE: 'INVALID_EXECUTABLE',
  MISSING_REQUIRED_SHEET: 'MISSING_REQUIRED_SHEET',
  EMPTY_SHEET: 'EMPTY_SHEET',
  MISSING_REQUIRED_COLUMN: 'MISSING_REQUIRED_COLUMN',
  UNKNOWN_COLUMN: 'UNKNOWN_COLUMN',
  INVALID_FORMAT: 'INVALID_FORMAT',
  DUPLICATE_TASK_ID: 'DUPLICATE_TASK_ID',
  DUPLICATE_FEATURE_ID: 'DUPLICATE_FEATURE_ID',
  MISSING_DEPENDENCY: 'MISSING_DEPENDENCY',
  NON_EXISTENT_DEPENDENCY: 'NON_EXISTENT_DEPENDENCY',
  MISSING_FEATURE: 'MISSING_FEATURE',
  MISSING_REQUIRED_TASK: 'MISSING_REQUIRED_TASK',
  CIRCULAR_DEPENDENCY: 'CIRCULAR_DEPENDENCY',
  CYCLE_DETECTED: 'CYCLE_DETECTED',
} as const;

export type ValidationErrorCode = (typeof VALIDATION_ERROR_CODES)[keyof typeof VALIDATION_ERROR_CODES];

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationErrorItem {
  sheet: string;
  row: number;
  column: string;
  code: ValidationErrorCode | string;
  message: string;
  value?: unknown;
  severity: ValidationSeverity;
}

export interface ValidationReport {
  valid: boolean;
  errors: ValidationErrorItem[];
  warnings: ValidationErrorItem[];
  errorCount: number;
  warningCount: number;
  summary: string;
}

export interface ValidationOptions {
  strict?: boolean;
  allowUnknownColumns?: boolean;
  maxErrors?: number;
  requireFeaturesSheet?: boolean;
  requireConfigSheet?: boolean;
  existingTaskIds?: Iterable<string>;
  existingFeatureIds?: Iterable<string>;
  checkExistingDuplicates?: boolean;
  checkCycles?: boolean;
  cycleAlgorithm?: 'dfs' | 'kahn';
  existingDependencies?: Iterable<{ taskId: string; dependsOnId: string }>;
}

export const ValidationErrorItemSchema = z.object({
  sheet: z.string().min(1),
  row: z.number().int().min(1),
  column: z.string().min(1),
  code: z.string().min(1),
  message: z.string().min(1),
  value: z.unknown().optional(),
  severity: z.enum(['error', 'warning']),
});

export const ValidationReportSchema = z.object({
  valid: z.boolean(),
  errors: z.array(ValidationErrorItemSchema),
  warnings: z.array(ValidationErrorItemSchema),
  errorCount: z.number().int().min(0),
  warningCount: z.number().int().min(0),
  summary: z.string(),
});
