import { VALIDATION_ERROR_CODES, type ValidationErrorItem } from './types.js';
import { FEATURE_STATUSES } from '../models/feature.js';
import { FEATURE_HEADER_ALIASES, parseIdList, type ParsedFeatureRow } from '../parser/types.js';
import { canonicalizeRow } from '../parser/mappers.js';
import { IDENTIFIER_REGEX } from './taskValidator.js';

function isParsedFeatureRow(obj: Record<string, unknown> | ParsedFeatureRow): obj is ParsedFeatureRow {
  return 'raw' in obj && typeof obj.raw === 'object' && obj.raw !== null;
}

export function validateFeatureRow(
  rowInput: Record<string, unknown> | ParsedFeatureRow,
  rowNumber = 2,
): ValidationErrorItem[] {
  const issues: ValidationErrorItem[] = [];
  const sheet = 'Features';

  let rawMap: Record<string, unknown>;
  let parsedRow: ParsedFeatureRow | null = null;

  if (isParsedFeatureRow(rowInput)) {
    parsedRow = rowInput;
    rowNumber = parsedRow.rowNumber ?? rowNumber;
    rawMap = canonicalizeRow(parsedRow.raw, FEATURE_HEADER_ALIASES);
  } else {
    rawMap = canonicalizeRow(rowInput as Record<string, unknown>, FEATURE_HEADER_ALIASES);
  }

  // 1. Feature ID
  const rawId = rawMap['id'] !== undefined ? rawMap['id'] : parsedRow?.id;
  const strId = rawId !== null && rawId !== undefined ? String(rawId).trim() : '';

  if (strId === '') {
    issues.push({
      sheet,
      row: rowNumber,
      column: 'id',
      code: VALIDATION_ERROR_CODES.REQUIRED_FIELD,
      message: "Mã feature ('id') là bắt buộc và không được để trống.",
      value: rawId,
      severity: 'error',
    });
  } else {
    if (strId.length > 100) {
      issues.push({
        sheet,
        row: rowNumber,
        column: 'id',
        code: VALIDATION_ERROR_CODES.STRING_TOO_LONG,
        message: "Mã feature ('id') không được vượt quá 100 ký tự.",
        value: strId,
        severity: 'error',
      });
    }
    if (!IDENTIFIER_REGEX.test(strId)) {
      issues.push({
        sheet,
        row: rowNumber,
        column: 'id',
        code: VALIDATION_ERROR_CODES.INVALID_IDENTIFIER_FORMAT,
        message: `Mã feature ('id') '${strId}' chứa ký tự không hợp lệ. Chỉ chấp nhận chữ cái, số, gạch ngang (-), gạch dưới (_) và chấm (.).`,
        value: strId,
        severity: 'error',
      });
    }
  }

  // 2. Name
  const rawName = rawMap['name'] !== undefined ? rawMap['name'] : parsedRow?.name;
  const strName = rawName !== null && rawName !== undefined ? String(rawName).trim() : '';

  if (strName === '') {
    issues.push({
      sheet,
      row: rowNumber,
      column: 'name',
      code: VALIDATION_ERROR_CODES.REQUIRED_FIELD,
      message: "Tên feature ('name') là bắt buộc và không được để trống.",
      value: rawName,
      severity: 'error',
    });
  } else if (strName.length > 500) {
    issues.push({
      sheet,
      row: rowNumber,
      column: 'name',
      code: VALIDATION_ERROR_CODES.STRING_TOO_LONG,
      message: "Tên feature ('name') không được vượt quá 500 ký tự.",
      value: strName,
      severity: 'error',
    });
  }

  // 3. Status
  const rawStatus = rawMap['status'] !== undefined ? rawMap['status'] : parsedRow?.status;
  if (rawStatus !== null && rawStatus !== undefined && String(rawStatus).trim() !== '') {
    const normStatus = String(rawStatus).trim().toUpperCase();
    if (!(FEATURE_STATUSES as readonly string[]).includes(normStatus)) {
      issues.push({
        sheet,
        row: rowNumber,
        column: 'status',
        code: VALIDATION_ERROR_CODES.INVALID_STATUS,
        message: `Trạng thái feature '${rawStatus}' không hợp lệ. Danh sách hợp lệ: ${FEATURE_STATUSES.join(', ')}.`,
        value: rawStatus,
        severity: 'error',
      });
    }
  }

  // 4. Required Tasks
  const rawReqTasks = rawMap['required_tasks'] !== undefined ? rawMap['required_tasks'] : parsedRow?.required_tasks;
  let reqTasksList: string[] = [];
  if (Array.isArray(rawReqTasks)) {
    reqTasksList = rawReqTasks.map((t) => String(t).trim());
  } else if (rawReqTasks !== null && rawReqTasks !== undefined && String(rawReqTasks).trim() !== '') {
    reqTasksList = parseIdList(rawReqTasks);
  }

  for (const taskId of reqTasksList) {
    if (!IDENTIFIER_REGEX.test(taskId)) {
      issues.push({
        sheet,
        row: rowNumber,
        column: 'required_tasks',
        code: VALIDATION_ERROR_CODES.INVALID_IDENTIFIER_FORMAT,
        message: `Mã task '${taskId}' trong cột 'required_tasks' chứa ký tự không hợp lệ.`,
        value: taskId,
        severity: 'error',
      });
    }
  }

  // 5. Integration Tests
  const rawTests = rawMap['integration_tests'] !== undefined ? rawMap['integration_tests'] : parsedRow?.integration_tests;
  if (Array.isArray(rawTests)) {
    for (const test of rawTests) {
      if (typeof test === 'string' && test.trim() === '') {
        issues.push({
          sheet,
          row: rowNumber,
          column: 'integration_tests',
          code: VALIDATION_ERROR_CODES.EMPTY_LIST_ITEM,
          message: "Lệnh test tích hợp ('integration_tests') không được chứa phần tử rỗng.",
          value: test,
          severity: 'error',
        });
      } else if (typeof test === 'string' && test.length > 2000) {
        issues.push({
          sheet,
          row: rowNumber,
          column: 'integration_tests',
          code: VALIDATION_ERROR_CODES.STRING_TOO_LONG,
          message: "Lệnh test tích hợp ('integration_tests') không được vượt quá 2000 ký tự.",
          value: test,
          severity: 'error',
        });
      }
    }
  }

  return issues;
}
