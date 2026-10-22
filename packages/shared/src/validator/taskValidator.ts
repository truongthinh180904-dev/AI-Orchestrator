import { VALIDATION_ERROR_CODES, type ValidationErrorItem } from './types.js';
import { TASK_STATUSES } from '../models/task.js';
import { TASK_HEADER_ALIASES, parseIdList, type ParsedTaskRow } from '../parser/types.js';
import { canonicalizeRow } from '../parser/mappers.js';

export const IDENTIFIER_REGEX = /^[A-Za-z0-9_.-]+$/;

function isIntegerNumber(val: unknown): boolean {
  if (typeof val === 'number') {
    return !Number.isNaN(val) && Number.isInteger(val);
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '') return false;
    return /^-?\d+$/.test(trimmed);
  }
  return false;
}

function parseInteger(val: unknown): number | null {
  if (typeof val === 'number' && !Number.isNaN(val) && Number.isInteger(val)) {
    return val;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (/^-?\d+$/.test(trimmed)) {
      return parseInt(trimmed, 10);
    }
  }
  return null;
}

function isParsedTaskRow(obj: Record<string, unknown> | ParsedTaskRow): obj is ParsedTaskRow {
  return 'raw' in obj && typeof obj.raw === 'object' && obj.raw !== null;
}

export function validateTaskRow(
  rowInput: Record<string, unknown> | ParsedTaskRow,
  rowNumber = 2,
): ValidationErrorItem[] {
  const issues: ValidationErrorItem[] = [];
  const sheet = 'Tasks';

  let rawMap: Record<string, unknown>;
  let parsedRow: ParsedTaskRow | null = null;

  if (isParsedTaskRow(rowInput)) {
    parsedRow = rowInput;
    rowNumber = parsedRow.rowNumber ?? rowNumber;
    rawMap = canonicalizeRow(parsedRow.raw, TASK_HEADER_ALIASES);
  } else {
    rawMap = canonicalizeRow(rowInput as Record<string, unknown>, TASK_HEADER_ALIASES);
  }

  // 1. Task ID
  const rawId = rawMap['id'] !== undefined ? rawMap['id'] : parsedRow?.id;
  const strId = rawId !== null && rawId !== undefined ? String(rawId).trim() : '';

  if (strId === '') {
    issues.push({
      sheet,
      row: rowNumber,
      column: 'id',
      code: VALIDATION_ERROR_CODES.REQUIRED_FIELD,
      message: "Mã task ('id') là bắt buộc và không được để trống.",
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
        message: "Mã task ('id') không được vượt quá 100 ký tự.",
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
        message: `Mã task ('id') '${strId}' chứa ký tự không hợp lệ. Chỉ chấp nhận chữ cái, số, gạch ngang (-), gạch dưới (_) và chấm (.).`,
        value: strId,
        severity: 'error',
      });
    }
  }

  // 2. Title
  const rawTitle = rawMap['title'] !== undefined ? rawMap['title'] : parsedRow?.title;
  const strTitle = rawTitle !== null && rawTitle !== undefined ? String(rawTitle).trim() : '';

  if (strTitle === '') {
    issues.push({
      sheet,
      row: rowNumber,
      column: 'title',
      code: VALIDATION_ERROR_CODES.REQUIRED_FIELD,
      message: "Tiêu đề task ('title') là bắt buộc và không được để trống.",
      value: rawTitle,
      severity: 'error',
    });
  } else if (strTitle.length > 500) {
    issues.push({
      sheet,
      row: rowNumber,
      column: 'title',
      code: VALIDATION_ERROR_CODES.STRING_TOO_LONG,
      message: "Tiêu đề task ('title') không được vượt quá 500 ký tự.",
      value: strTitle,
      severity: 'error',
    });
  }

  // 3. Feature ID (optional)
  const rawFeatureId = rawMap['feature_id'] !== undefined ? rawMap['feature_id'] : parsedRow?.feature_id;
  if (rawFeatureId !== null && rawFeatureId !== undefined && String(rawFeatureId).trim() !== '') {
    const strFeatureId = String(rawFeatureId).trim();
    if (strFeatureId.length > 100) {
      issues.push({
        sheet,
        row: rowNumber,
        column: 'feature_id',
        code: VALIDATION_ERROR_CODES.STRING_TOO_LONG,
        message: "Mã feature ('feature_id') không được vượt quá 100 ký tự.",
        value: strFeatureId,
        severity: 'error',
      });
    }
    if (!IDENTIFIER_REGEX.test(strFeatureId)) {
      issues.push({
        sheet,
        row: rowNumber,
        column: 'feature_id',
        code: VALIDATION_ERROR_CODES.INVALID_IDENTIFIER_FORMAT,
        message: `Mã feature ('feature_id') '${strFeatureId}' chứa ký tự không hợp lệ.`,
        value: strFeatureId,
        severity: 'error',
      });
    }
  }

  // 4. Status (optional, default TODO, but if given must be valid)
  const rawStatus = rawMap['status'] !== undefined ? rawMap['status'] : parsedRow?.status;
  if (rawStatus !== null && rawStatus !== undefined && String(rawStatus).trim() !== '') {
    const normStatus = String(rawStatus).trim().toUpperCase();
    if (!(TASK_STATUSES as readonly string[]).includes(normStatus)) {
      issues.push({
        sheet,
        row: rowNumber,
        column: 'status',
        code: VALIDATION_ERROR_CODES.INVALID_STATUS,
        message: `Trạng thái task '${rawStatus}' không hợp lệ. Danh sách trạng thái hợp lệ: ${TASK_STATUSES.join(', ')}.`,
        value: rawStatus,
        severity: 'error',
      });
    }
  }

  // 5. Priority (optional, default 0, integer)
  const rawPriority = rawMap['priority'] !== undefined ? rawMap['priority'] : parsedRow?.priority;
  if (rawPriority !== null && rawPriority !== undefined && String(rawPriority).trim() !== '') {
    if (!isIntegerNumber(rawPriority)) {
      issues.push({
        sheet,
        row: rowNumber,
        column: 'priority',
        code: VALIDATION_ERROR_CODES.INVALID_INTEGER,
        message: `Độ ưu tiên ('priority') phải là số nguyên hợp lệ, nhận được: '${rawPriority}'.`,
        value: rawPriority,
        severity: 'error',
      });
    } else {
      const p = parseInteger(rawPriority);
      if (p !== null && (p < -10000 || p > 10000)) {
        issues.push({
          sheet,
          row: rowNumber,
          column: 'priority',
          code: VALIDATION_ERROR_CODES.VALUE_OUT_OF_RANGE,
          message: `Độ ưu tiên ('priority') phải nằm trong khoảng từ -10000 đến 10000, nhận được: ${p}.`,
          value: p,
          severity: 'error',
        });
      }
    }
  }

  // 6. Max Attempts (optional, default 3, integer >= 1)
  const rawMaxAttempts = rawMap['max_attempts'] !== undefined ? rawMap['max_attempts'] : parsedRow?.max_attempts;
  if (rawMaxAttempts !== null && rawMaxAttempts !== undefined && String(rawMaxAttempts).trim() !== '') {
    if (!isIntegerNumber(rawMaxAttempts)) {
      issues.push({
        sheet,
        row: rowNumber,
        column: 'max_attempts',
        code: VALIDATION_ERROR_CODES.INVALID_INTEGER,
        message: `Số lần thử tối đa ('max_attempts') phải là số nguyên, nhận được: '${rawMaxAttempts}'.`,
        value: rawMaxAttempts,
        severity: 'error',
      });
    } else {
      const ma = parseInteger(rawMaxAttempts);
      if (ma !== null && ma < 1) {
        issues.push({
          sheet,
          row: rowNumber,
          column: 'max_attempts',
          code: VALIDATION_ERROR_CODES.VALUE_OUT_OF_RANGE,
          message: `Số lần thử tối đa ('max_attempts') phải >= 1, nhận được: ${ma}.`,
          value: ma,
          severity: 'error',
        });
      } else if (ma !== null && ma > 100) {
        issues.push({
          sheet,
          row: rowNumber,
          column: 'max_attempts',
          code: VALIDATION_ERROR_CODES.VALUE_OUT_OF_RANGE,
          message: `Số lần thử tối đa ('max_attempts') không được vượt quá 100, nhận được: ${ma}.`,
          value: ma,
          severity: 'error',
        });
      }
    }
  }

  // 7. Timeout Minutes (optional, default 30, integer >= 1)
  const rawTimeout = rawMap['timeout_minutes'] !== undefined ? rawMap['timeout_minutes'] : parsedRow?.timeout_minutes;
  if (rawTimeout !== null && rawTimeout !== undefined && String(rawTimeout).trim() !== '') {
    if (!isIntegerNumber(rawTimeout)) {
      issues.push({
        sheet,
        row: rowNumber,
        column: 'timeout_minutes',
        code: VALIDATION_ERROR_CODES.INVALID_INTEGER,
        message: `Thời gian chạy tối đa ('timeout_minutes') phải là số nguyên, nhận được: '${rawTimeout}'.`,
        value: rawTimeout,
        severity: 'error',
      });
    } else {
      const tm = parseInteger(rawTimeout);
      if (tm !== null && tm < 1) {
        issues.push({
          sheet,
          row: rowNumber,
          column: 'timeout_minutes',
          code: VALIDATION_ERROR_CODES.VALUE_OUT_OF_RANGE,
          message: `Thời gian chạy tối đa ('timeout_minutes') phải >= 1 phút, nhận được: ${tm}.`,
          value: tm,
          severity: 'error',
        });
      } else if (tm !== null && tm > 10080) {
        issues.push({
          sheet,
          row: rowNumber,
          column: 'timeout_minutes',
          code: VALIDATION_ERROR_CODES.VALUE_OUT_OF_RANGE,
          message: `Thời gian chạy tối đa ('timeout_minutes') không được vượt quá 10080 phút (7 ngày), nhận được: ${tm}.`,
          value: tm,
          severity: 'error',
        });
      }
    }
  }

  // 8. Dependencies
  const rawDeps = rawMap['dependencies'] !== undefined ? rawMap['dependencies'] : parsedRow?.dependencies;
  let depsList: string[] = [];
  if (Array.isArray(rawDeps)) {
    depsList = rawDeps.map((d) => String(d).trim());
  } else if (rawDeps !== null && rawDeps !== undefined && String(rawDeps).trim() !== '') {
    depsList = parseIdList(rawDeps);
  }

  for (const dep of depsList) {
    if (strId !== '' && dep === strId) {
      issues.push({
        sheet,
        row: rowNumber,
        column: 'dependencies',
        code: VALIDATION_ERROR_CODES.SELF_DEPENDENCY,
        message: `Task '${strId}' không thể phụ thuộc vào chính nó.`,
        value: dep,
        severity: 'error',
      });
    } else if (!IDENTIFIER_REGEX.test(dep)) {
      issues.push({
        sheet,
        row: rowNumber,
        column: 'dependencies',
        code: VALIDATION_ERROR_CODES.INVALID_IDENTIFIER_FORMAT,
        message: `Mã dependency '${dep}' trong cột 'dependencies' chứa ký tự không hợp lệ.`,
        value: dep,
        severity: 'error',
      });
    }
  }

  // 9. Acceptance Criteria
  const rawAc = rawMap['acceptance_criteria'] !== undefined ? rawMap['acceptance_criteria'] : parsedRow?.acceptance_criteria;
  if (Array.isArray(rawAc)) {
    for (const item of rawAc) {
      if (typeof item === 'string' && item.trim() === '') {
        issues.push({
          sheet,
          row: rowNumber,
          column: 'acceptance_criteria',
          code: VALIDATION_ERROR_CODES.EMPTY_LIST_ITEM,
          message: "Tiêu chí nghiệm thu ('acceptance_criteria') không được chứa phần tử rỗng.",
          value: item,
          severity: 'error',
        });
      } else if (typeof item === 'string' && item.length > 2000) {
        issues.push({
          sheet,
          row: rowNumber,
          column: 'acceptance_criteria',
          code: VALIDATION_ERROR_CODES.STRING_TOO_LONG,
          message: "Tiêu chí nghiệm thu ('acceptance_criteria') từng mục không được vượt quá 2000 ký tự.",
          value: item,
          severity: 'error',
        });
      }
    }
  }

  // 10. Test Commands
  const rawTc = rawMap['test_commands'] !== undefined ? rawMap['test_commands'] : parsedRow?.test_commands;
  if (Array.isArray(rawTc)) {
    for (const item of rawTc) {
      if (typeof item === 'string' && item.trim() === '') {
        issues.push({
          sheet,
          row: rowNumber,
          column: 'test_commands',
          code: VALIDATION_ERROR_CODES.EMPTY_LIST_ITEM,
          message: "Lệnh kiểm thử ('test_commands') không được chứa phần tử rỗng.",
          value: item,
          severity: 'error',
        });
      } else if (typeof item === 'string' && item.length > 2000) {
        issues.push({
          sheet,
          row: rowNumber,
          column: 'test_commands',
          code: VALIDATION_ERROR_CODES.STRING_TOO_LONG,
          message: "Lệnh kiểm thử ('test_commands') từng dòng không được vượt quá 2000 ký tự.",
          value: item,
          severity: 'error',
        });
      }
    }
  }

  // 11. Worker Type
  const rawWorker = rawMap['worker_type'] !== undefined ? rawMap['worker_type'] : parsedRow?.worker_type;
  if (rawWorker !== null && rawWorker !== undefined && String(rawWorker).trim() !== '') {
    const strWorker = String(rawWorker).trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(strWorker)) {
      issues.push({
        sheet,
        row: rowNumber,
        column: 'worker_type',
        code: VALIDATION_ERROR_CODES.INVALID_WORKER_TYPE,
        message: `Loại worker ('worker_type') '${strWorker}' không hợp lệ. Chỉ chấp nhận chữ cái, số, gạch ngang, gạch dưới.`,
        value: strWorker,
        severity: 'error',
      });
    } else if (strWorker.length > 50) {
      issues.push({
        sheet,
        row: rowNumber,
        column: 'worker_type',
        code: VALIDATION_ERROR_CODES.STRING_TOO_LONG,
        message: "Loại worker ('worker_type') không được vượt quá 50 ký tự.",
        value: strWorker,
        severity: 'error',
      });
    }
  }

  // 12. Repository
  const rawRepo = rawMap['repository'] !== undefined ? rawMap['repository'] : parsedRow?.repository;
  if (rawRepo !== null && rawRepo !== undefined && String(rawRepo).trim() !== '') {
    const strRepo = String(rawRepo);
    if (strRepo.includes('\0')) {
      issues.push({
        sheet,
        row: rowNumber,
        column: 'repository',
        code: VALIDATION_ERROR_CODES.INVALID_REPOSITORY,
        message: "Đường dẫn repository không được chứa ký tự null byte.",
        value: strRepo,
        severity: 'error',
      });
    } else if (strRepo.length > 500) {
      issues.push({
        sheet,
        row: rowNumber,
        column: 'repository',
        code: VALIDATION_ERROR_CODES.STRING_TOO_LONG,
        message: "Đường dẫn repository không được vượt quá 500 ký tự.",
        value: strRepo,
        severity: 'error',
      });
    }
  }

  return issues;
}
