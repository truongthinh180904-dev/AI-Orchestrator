import { VALIDATION_ERROR_CODES, type ValidationErrorItem } from './types.js';
import type { ParsedConfig } from '../parser/types.js';

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

function isParsedConfig(obj: Record<string, unknown> | ParsedConfig): obj is ParsedConfig {
  return 'raw' in obj && typeof obj.raw === 'object' && obj.raw !== null;
}

export function validateConfig(
  configInput: Record<string, unknown> | ParsedConfig,
  rowNumber = 2,
): ValidationErrorItem[] {
  const issues: ValidationErrorItem[] = [];
  const sheet = 'Config';

  let rawMap: Record<string, unknown>;
  let parsedConfig: ParsedConfig | null = null;

  if (isParsedConfig(configInput)) {
    parsedConfig = configInput;
    rawMap = parsedConfig.raw;
  } else {
    rawMap = configInput as Record<string, unknown>;
  }

  // max_attempts
  const rawMaxAttempts = rawMap['max_attempts'] !== undefined ? rawMap['max_attempts'] : parsedConfig?.max_attempts;
  if (rawMaxAttempts !== null && rawMaxAttempts !== undefined && String(rawMaxAttempts).trim() !== '') {
    if (!isIntegerNumber(rawMaxAttempts)) {
      issues.push({
        sheet,
        row: rowNumber,
        column: 'max_attempts',
        code: VALIDATION_ERROR_CODES.INVALID_INTEGER,
        message: `Cấu hình 'max_attempts' phải là số nguyên, nhận được: '${rawMaxAttempts}'.`,
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
          message: `Cấu hình 'max_attempts' phải >= 1, nhận được: ${ma}.`,
          value: ma,
          severity: 'error',
        });
      } else if (ma !== null && ma > 100) {
        issues.push({
          sheet,
          row: rowNumber,
          column: 'max_attempts',
          code: VALIDATION_ERROR_CODES.VALUE_OUT_OF_RANGE,
          message: `Cấu hình 'max_attempts' không được vượt quá 100, nhận được: ${ma}.`,
          value: ma,
          severity: 'error',
        });
      }
    }
  }

  // timeout_minutes
  const rawTimeout = rawMap['timeout_minutes'] !== undefined ? rawMap['timeout_minutes'] : parsedConfig?.timeout_minutes;
  if (rawTimeout !== null && rawTimeout !== undefined && String(rawTimeout).trim() !== '') {
    if (!isIntegerNumber(rawTimeout)) {
      issues.push({
        sheet,
        row: rowNumber,
        column: 'timeout_minutes',
        code: VALIDATION_ERROR_CODES.INVALID_INTEGER,
        message: `Cấu hình 'timeout_minutes' phải là số nguyên, nhận được: '${rawTimeout}'.`,
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
          message: `Cấu hình 'timeout_minutes' phải >= 1, nhận được: ${tm}.`,
          value: tm,
          severity: 'error',
        });
      } else if (tm !== null && tm > 10080) {
        issues.push({
          sheet,
          row: rowNumber,
          column: 'timeout_minutes',
          code: VALIDATION_ERROR_CODES.VALUE_OUT_OF_RANGE,
          message: `Cấu hình 'timeout_minutes' không được vượt quá 10080, nhận được: ${tm}.`,
          value: tm,
          severity: 'error',
        });
      }
    }
  }

  // max_concurrency
  const rawConcurrency = rawMap['max_concurrency'] !== undefined ? rawMap['max_concurrency'] : parsedConfig?.max_concurrency;
  if (rawConcurrency !== null && rawConcurrency !== undefined && String(rawConcurrency).trim() !== '') {
    if (!isIntegerNumber(rawConcurrency)) {
      issues.push({
        sheet,
        row: rowNumber,
        column: 'max_concurrency',
        code: VALIDATION_ERROR_CODES.INVALID_INTEGER,
        message: `Cấu hình 'max_concurrency' phải là số nguyên, nhận được: '${rawConcurrency}'.`,
        value: rawConcurrency,
        severity: 'error',
      });
    } else {
      const mc = parseInteger(rawConcurrency);
      if (mc !== null && mc < 1) {
        issues.push({
          sheet,
          row: rowNumber,
          column: 'max_concurrency',
          code: VALIDATION_ERROR_CODES.VALUE_OUT_OF_RANGE,
          message: `Cấu hình 'max_concurrency' phải >= 1, nhận được: ${mc}.`,
          value: mc,
          severity: 'error',
        });
      } else if (mc !== null && mc > 100) {
        issues.push({
          sheet,
          row: rowNumber,
          column: 'max_concurrency',
          code: VALIDATION_ERROR_CODES.VALUE_OUT_OF_RANGE,
          message: `Cấu hình 'max_concurrency' không được vượt quá 100, nhận được: ${mc}.`,
          value: mc,
          severity: 'error',
        });
      }
    }
  }

  // agy_bin
  const rawBin = rawMap['agy_bin'] !== undefined ? rawMap['agy_bin'] : parsedConfig?.agy_bin;
  if (rawBin !== null && rawBin !== undefined && String(rawBin).trim() !== '') {
    const strBin = String(rawBin).trim();
    if (/\s/.test(strBin)) {
      issues.push({
        sheet,
        row: rowNumber,
        column: 'agy_bin',
        code: VALIDATION_ERROR_CODES.INVALID_EXECUTABLE,
        message: `Tên executable 'agy_bin' không được chứa khoảng trắng, nhận được: '${strBin}'.`,
        value: strBin,
        severity: 'error',
      });
    }
  }

  // repository
  const rawRepo = rawMap['repository'] !== undefined ? rawMap['repository'] : parsedConfig?.repository;
  if (rawRepo !== null && rawRepo !== undefined && String(rawRepo).trim() !== '') {
    const strRepo = String(rawRepo);
    if (strRepo.includes('\0')) {
      issues.push({
        sheet,
        row: rowNumber,
        column: 'repository',
        code: VALIDATION_ERROR_CODES.INVALID_REPOSITORY,
        message: "Cấu hình 'repository' không được chứa ký tự null byte.",
        value: strRepo,
        severity: 'error',
      });
    }
  }

  return issues;
}
