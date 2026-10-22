import { AppError } from '../errors.js';
import {
  VALIDATION_ERROR_CODES,
  type ValidationErrorItem,
  type ValidationOptions,
  type ValidationReport,
} from './types.js';
import { formatValidationReport } from './formatters.js';
import { validateTaskRow } from './taskValidator.js';
import { validateFeatureRow } from './featureValidator.js';
import { validateConfig } from './configValidator.js';
import {
  TASK_HEADER_ALIASES,
  FEATURE_HEADER_ALIASES,
  normalizeHeader,
  type ParsedWorkbookResult,
  type RawRow,
} from '../parser/types.js';

export class WorkbookValidationError extends AppError {
  constructor(public report: ValidationReport) {
    super('VALIDATION_FAILED', `Workbook validation failed with ${report.errorCount} error(s):\n${report.summary}`, {
      errorCount: report.errorCount,
      warningCount: report.warningCount,
      errors: report.errors,
      warnings: report.warnings,
    });
  }
}

function hasCanonicalColumn(headers: string[], aliasMap: Record<string, string>, targetCol: string): boolean {
  for (const h of headers) {
    const norm = normalizeHeader(h);
    if (aliasMap[norm] === targetCol || aliasMap[norm.replace(/\s+/g, '_')] === targetCol) {
      return true;
    }
  }
  return false;
}

export function validateWorkbook(
  workbook: ParsedWorkbookResult,
  options: ValidationOptions = {},
): ValidationReport {
  const allIssues: ValidationErrorItem[] = [];

  // 1. Check Tasks sheet presence and non-emptiness
  if (!workbook.tasks || workbook.tasks.length === 0) {
    allIssues.push({
      sheet: 'Tasks',
      row: 1,
      column: 'sheet',
      code: VALIDATION_ERROR_CODES.EMPTY_SHEET,
      message: "Sheet 'Tasks' không có dòng dữ liệu nào.",
      severity: 'error',
    });
  } else {
    for (const task of workbook.tasks) {
      const taskIssues = validateTaskRow(task);
      allIssues.push(...taskIssues);
    }
  }

  // 2. Check Features sheet
  if (workbook.features && workbook.features.length > 0) {
    for (const feature of workbook.features) {
      const featIssues = validateFeatureRow(feature);
      allIssues.push(...featIssues);
    }
  } else if (options.requireFeaturesSheet) {
    allIssues.push({
      sheet: 'Features',
      row: 1,
      column: 'sheet',
      code: VALIDATION_ERROR_CODES.MISSING_REQUIRED_SHEET,
      message: "Sheet 'Features' là bắt buộc theo tùy chọn cấu hình.",
      severity: 'error',
    });
  }

  // 3. Check Config sheet
  if (workbook.config) {
    const configIssues = validateConfig(workbook.config);
    allIssues.push(...configIssues);
  } else if (options.requireConfigSheet) {
    allIssues.push({
      sheet: 'Config',
      row: 1,
      column: 'sheet',
      code: VALIDATION_ERROR_CODES.MISSING_REQUIRED_SHEET,
      message: "Sheet 'Config' là bắt buộc theo tùy chọn cấu hình.",
      severity: 'error',
    });
  }

  // Split errors and warnings
  let errors = allIssues.filter((i) => i.severity === 'error');
  let warnings = allIssues.filter((i) => i.severity === 'warning');

  if (options.strict) {
    errors = [...errors, ...warnings.map((w) => ({ ...w, severity: 'error' as const }))];
    warnings = [];
  }

  if (options.maxErrors && errors.length > options.maxErrors) {
    errors = errors.slice(0, options.maxErrors);
  }

  const report: ValidationReport = {
    valid: errors.length === 0,
    errors,
    warnings,
    errorCount: errors.length,
    warningCount: warnings.length,
    summary: '',
  };

  report.summary = formatValidationReport(report);
  return report;
}

export interface RawWorkbookInput {
  tasks?: RawRow[];
  features?: RawRow[];
  config?: RawRow[] | Record<string, unknown>;
  headers?: Record<string, string[]>;
}

export function validateRawWorkbook(
  rawInput: RawWorkbookInput,
  options: ValidationOptions = {},
): ValidationReport {
  const allIssues: ValidationErrorItem[] = [];

  // 1. Check Tasks sheet
  if (!rawInput.tasks) {
    allIssues.push({
      sheet: 'Tasks',
      row: 1,
      column: 'sheet',
      code: VALIDATION_ERROR_CODES.MISSING_REQUIRED_SHEET,
      message: "Thiếu sheet bắt buộc 'Tasks'.",
      severity: 'error',
    });
  } else {
    // Check headers if available
    const taskHeaders = rawInput.headers?.['Tasks'] ?? rawInput.headers?.['tasks'];
    if (taskHeaders && taskHeaders.length > 0) {
      if (!hasCanonicalColumn(taskHeaders, TASK_HEADER_ALIASES, 'id')) {
        allIssues.push({
          sheet: 'Tasks',
          row: 1,
          column: 'id',
          code: VALIDATION_ERROR_CODES.MISSING_REQUIRED_COLUMN,
          message: "Sheet 'Tasks' thiếu cột tiêu đề bắt buộc 'id' (Mã task).",
          severity: 'error',
        });
      }
      if (!hasCanonicalColumn(taskHeaders, TASK_HEADER_ALIASES, 'title')) {
        allIssues.push({
          sheet: 'Tasks',
          row: 1,
          column: 'title',
          code: VALIDATION_ERROR_CODES.MISSING_REQUIRED_COLUMN,
          message: "Sheet 'Tasks' thiếu cột tiêu đề bắt buộc 'title' (Tiêu đề).",
          severity: 'error',
        });
      }
    }

    if (rawInput.tasks.length === 0) {
      allIssues.push({
        sheet: 'Tasks',
        row: 1,
        column: 'sheet',
        code: VALIDATION_ERROR_CODES.EMPTY_SHEET,
        message: "Sheet 'Tasks' không có dòng dữ liệu nào.",
        severity: 'error',
      });
    } else {
      for (const row of rawInput.tasks) {
        const issues = validateTaskRow(row.data, row.rowNumber);
        allIssues.push(...issues);
      }
    }
  }

  // 2. Check Features sheet
  if (rawInput.features) {
    const featHeaders = rawInput.headers?.['Features'] ?? rawInput.headers?.['features'];
    if (featHeaders && featHeaders.length > 0) {
      if (!hasCanonicalColumn(featHeaders, FEATURE_HEADER_ALIASES, 'id')) {
        allIssues.push({
          sheet: 'Features',
          row: 1,
          column: 'id',
          code: VALIDATION_ERROR_CODES.MISSING_REQUIRED_COLUMN,
          message: "Sheet 'Features' thiếu cột tiêu đề bắt buộc 'id' (Mã feature).",
          severity: 'error',
        });
      }
      if (!hasCanonicalColumn(featHeaders, FEATURE_HEADER_ALIASES, 'name')) {
        allIssues.push({
          sheet: 'Features',
          row: 1,
          column: 'name',
          code: VALIDATION_ERROR_CODES.MISSING_REQUIRED_COLUMN,
          message: "Sheet 'Features' thiếu cột tiêu đề bắt buộc 'name' (Tên feature).",
          severity: 'error',
        });
      }
    }

    for (const row of rawInput.features) {
      const issues = validateFeatureRow(row.data, row.rowNumber);
      allIssues.push(...issues);
    }
  } else if (options.requireFeaturesSheet) {
    allIssues.push({
      sheet: 'Features',
      row: 1,
      column: 'sheet',
      code: VALIDATION_ERROR_CODES.MISSING_REQUIRED_SHEET,
      message: "Thiếu sheet bắt buộc 'Features'.",
      severity: 'error',
    });
  }

  // 3. Check Config sheet
  if (rawInput.config) {
    if (Array.isArray(rawInput.config)) {
      for (const row of rawInput.config) {
        const issues = validateConfig(row.data, row.rowNumber);
        allIssues.push(...issues);
      }
    } else {
      const issues = validateConfig(rawInput.config);
      allIssues.push(...issues);
    }
  } else if (options.requireConfigSheet) {
    allIssues.push({
      sheet: 'Config',
      row: 1,
      column: 'sheet',
      code: VALIDATION_ERROR_CODES.MISSING_REQUIRED_SHEET,
      message: "Thiếu sheet bắt buộc 'Config'.",
      severity: 'error',
    });
  }

  let errors = allIssues.filter((i) => i.severity === 'error');
  let warnings = allIssues.filter((i) => i.severity === 'warning');

  if (options.strict) {
    errors = [...errors, ...warnings.map((w) => ({ ...w, severity: 'error' as const }))];
    warnings = [];
  }

  if (options.maxErrors && errors.length > options.maxErrors) {
    errors = errors.slice(0, options.maxErrors);
  }

  const report: ValidationReport = {
    valid: errors.length === 0,
    errors,
    warnings,
    errorCount: errors.length,
    warningCount: warnings.length,
    summary: '',
  };

  report.summary = formatValidationReport(report);
  return report;
}

export function assertValidWorkbook(
  workbook: ParsedWorkbookResult,
  options: ValidationOptions = {},
): ValidationReport {
  const report = validateWorkbook(workbook, options);
  if (!report.valid) {
    throw new WorkbookValidationError(report);
  }
  return report;
}
