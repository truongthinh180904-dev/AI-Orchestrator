import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  VALIDATION_ERROR_CODES,
  validateTaskRow,
  validateFeatureRow,
  validateConfig,
  validateWorkbook,
  validateRawWorkbook,
  assertValidWorkbook,
  formatValidationError,
  formatValidationReport,
  parseAndValidateWorkbook,
  WorkbookValidationError,
  type ParsedWorkbookResult,
} from '../packages/shared/src/index.js';

describe('TSK-003 Acceptance Tests: Validate dữ liệu, báo lỗi theo (sheet, dòng, cột)', () => {
  it('Nghiệm thu 1: Báo lỗi chính xác theo tọa độ (sheet, dòng, cột)', () => {
    const rawTaskRow = {
      id: '',
      title: 'Valid task title',
      status: 'INVALID_STATUS',
      max_attempts: -1,
    };

    const issues = validateTaskRow(rawTaskRow, 4);

    expect(issues.length).toBeGreaterThanOrEqual(3);

    // Kiểm tra lỗi 1: sheet Tasks, dòng 4, cột id
    const idIssue = issues.find((i) => i.column === 'id');
    expect(idIssue).toBeDefined();
    expect(idIssue).toMatchObject({
      sheet: 'Tasks',
      row: 4,
      column: 'id',
      code: VALIDATION_ERROR_CODES.REQUIRED_FIELD,
      severity: 'error',
    });

    // Kiểm tra lỗi 2: sheet Tasks, dòng 4, cột status
    const statusIssue = issues.find((i) => i.column === 'status');
    expect(statusIssue).toBeDefined();
    expect(statusIssue).toMatchObject({
      sheet: 'Tasks',
      row: 4,
      column: 'status',
      code: VALIDATION_ERROR_CODES.INVALID_STATUS,
      value: 'INVALID_STATUS',
    });

    // Kiểm tra lỗi 3: sheet Tasks, dòng 4, cột max_attempts
    const attemptsIssue = issues.find((i) => i.column === 'max_attempts');
    expect(attemptsIssue).toBeDefined();
    expect(attemptsIssue).toMatchObject({
      sheet: 'Tasks',
      row: 4,
      column: 'max_attempts',
      code: VALIDATION_ERROR_CODES.VALUE_OUT_OF_RANGE,
    });

    // Kiểm tra chuỗi format hiển thị đầy đủ (sheet, dòng, cột)
    const formatted = formatValidationError(idIssue!);
    expect(formatted).toContain("[Tasks: dòng 4, cột 'id']");
    expect(formatted).toContain('(REQUIRED_FIELD)');

    // Kiểm tra formatValidationReport cho danh sách lỗi
    const reportSummary = formatValidationReport({
      valid: false,
      errors: issues,
      warnings: [],
      errorCount: issues.length,
      warningCount: 0,
      summary: '',
    });
    expect(reportSummary).toContain(`Phát hiện ${issues.length} lỗi và 0 cảnh báo:`);
    expect(reportSummary).toContain("[Tasks: dòng 4, cột 'id']");
  });

  it('Nghiệm thu 2: Test từng loại lỗi cấu trúc Sheet & Header (MISSING_REQUIRED_SHEET, EMPTY_SHEET, MISSING_REQUIRED_COLUMN)', () => {
    // 2.1 Missing sheet
    const missingSheetReport = validateRawWorkbook({});
    expect(missingSheetReport.valid).toBe(false);
    expect(missingSheetReport.errors[0]).toMatchObject({
      sheet: 'Tasks',
      row: 1,
      column: 'sheet',
      code: VALIDATION_ERROR_CODES.MISSING_REQUIRED_SHEET,
    });

    // 2.2 Empty sheet
    const emptySheetReport = validateRawWorkbook({ tasks: [] });
    expect(emptySheetReport.valid).toBe(false);
    expect(emptySheetReport.errors[0]).toMatchObject({
      sheet: 'Tasks',
      row: 1,
      column: 'sheet',
      code: VALIDATION_ERROR_CODES.EMPTY_SHEET,
    });

    // 2.3 Missing required columns in headers
    const missingColsReport = validateRawWorkbook({
      tasks: [{ rowNumber: 2, data: { description: 'Only description' } }],
      headers: { Tasks: ['description'] },
    });
    expect(missingColsReport.valid).toBe(false);
    expect(missingColsReport.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sheet: 'Tasks', row: 1, column: 'id', code: VALIDATION_ERROR_CODES.MISSING_REQUIRED_COLUMN }),
        expect.objectContaining({ sheet: 'Tasks', row: 1, column: 'title', code: VALIDATION_ERROR_CODES.MISSING_REQUIRED_COLUMN }),
      ]),
    );
  });

  it('Nghiệm thu 3: Test từng loại lỗi trường bắt buộc & định dạng ID (REQUIRED_FIELD, INVALID_IDENTIFIER_FORMAT, STRING_TOO_LONG)', () => {
    // 3.1 Tasks: Thiếu id, id chứa khoảng trắng/ký tự cấm, id quá dài
    const taskErrors = validateTaskRow(
      {
        id: 'TASK WITH SPACE!',
        title: 'X'.repeat(501),
        feature_id: 'BAD FEAT ID#',
      },
      2,
    );
    expect(taskErrors.some((e) => e.column === 'id' && e.code === VALIDATION_ERROR_CODES.INVALID_IDENTIFIER_FORMAT)).toBe(true);
    expect(taskErrors.some((e) => e.column === 'title' && e.code === VALIDATION_ERROR_CODES.STRING_TOO_LONG)).toBe(true);
    expect(taskErrors.some((e) => e.column === 'feature_id' && e.code === VALIDATION_ERROR_CODES.INVALID_IDENTIFIER_FORMAT)).toBe(true);

    // 3.2 Features: Thiếu id, thiếu name
    const featErrors = validateFeatureRow({ id: '', name: '' }, 3);
    expect(featErrors.some((e) => e.column === 'id' && e.code === VALIDATION_ERROR_CODES.REQUIRED_FIELD)).toBe(true);
    expect(featErrors.some((e) => e.column === 'name' && e.code === VALIDATION_ERROR_CODES.REQUIRED_FIELD)).toBe(true);
  });

  it('Nghiệm thu 4: Test từng loại lỗi trạng thái enum (INVALID_STATUS)', () => {
    // Task status không hợp lệ
    const taskStatusErr = validateTaskRow({ id: 'T1', title: 'Task 1', status: 'NOT_A_STATUS' }, 5);
    expect(taskStatusErr[0]).toMatchObject({
      sheet: 'Tasks',
      row: 5,
      column: 'status',
      code: VALIDATION_ERROR_CODES.INVALID_STATUS,
      value: 'NOT_A_STATUS',
    });

    // Feature status không hợp lệ
    const featStatusErr = validateFeatureRow({ id: 'F1', name: 'Feat 1', status: 'NON_EXISTENT' }, 2);
    expect(featStatusErr[0]).toMatchObject({
      sheet: 'Features',
      row: 2,
      column: 'status',
      code: VALIDATION_ERROR_CODES.INVALID_STATUS,
      value: 'NON_EXISTENT',
    });
  });

  it('Nghiệm thu 5: Test từng loại lỗi số và giới hạn (INVALID_INTEGER, VALUE_OUT_OF_RANGE)', () => {
    // Priority: chữ, số thập phân, ngoài giới hạn
    expect(validateTaskRow({ id: 'T1', title: 'Task', priority: 'abc' }, 2)[0]?.code).toBe(
      VALIDATION_ERROR_CODES.INVALID_INTEGER,
    );
    expect(validateTaskRow({ id: 'T1', title: 'Task', priority: 1.5 }, 2)[0]?.code).toBe(
      VALIDATION_ERROR_CODES.INVALID_INTEGER,
    );
    expect(validateTaskRow({ id: 'T1', title: 'Task', priority: 99999 }, 2)[0]?.code).toBe(
      VALIDATION_ERROR_CODES.VALUE_OUT_OF_RANGE,
    );

    // Max attempts: chữ, số <= 0, > 100
    expect(validateTaskRow({ id: 'T1', title: 'Task', max_attempts: 'three' }, 2)[0]?.code).toBe(
      VALIDATION_ERROR_CODES.INVALID_INTEGER,
    );
    expect(validateTaskRow({ id: 'T1', title: 'Task', max_attempts: 0 }, 2)[0]?.code).toBe(
      VALIDATION_ERROR_CODES.VALUE_OUT_OF_RANGE,
    );
    expect(validateTaskRow({ id: 'T1', title: 'Task', max_attempts: 200 }, 2)[0]?.code).toBe(
      VALIDATION_ERROR_CODES.VALUE_OUT_OF_RANGE,
    );

    // Timeout minutes: chữ, số <= 0, > 10080
    expect(validateTaskRow({ id: 'T1', title: 'Task', timeout_minutes: 'forever' }, 2)[0]?.code).toBe(
      VALIDATION_ERROR_CODES.INVALID_INTEGER,
    );
    expect(validateTaskRow({ id: 'T1', title: 'Task', timeout_minutes: -5 }, 2)[0]?.code).toBe(
      VALIDATION_ERROR_CODES.VALUE_OUT_OF_RANGE,
    );
    expect(validateTaskRow({ id: 'T1', title: 'Task', timeout_minutes: 50000 }, 2)[0]?.code).toBe(
      VALIDATION_ERROR_CODES.VALUE_OUT_OF_RANGE,
    );

    // Config concurrency & timeout
    const cfgErr = validateConfig({ max_concurrency: -1, timeout_minutes: 0 }, 2);
    expect(cfgErr.some((e) => e.column === 'max_concurrency' && e.code === VALIDATION_ERROR_CODES.VALUE_OUT_OF_RANGE)).toBe(true);
    expect(cfgErr.some((e) => e.column === 'timeout_minutes' && e.code === VALIDATION_ERROR_CODES.VALUE_OUT_OF_RANGE)).toBe(true);
  });

  it('Nghiệm thu 6: Test từng loại lỗi quan hệ & danh sách (SELF_DEPENDENCY, EMPTY_LIST_ITEM)', () => {
    // Tự phụ thuộc
    const selfDepIssues = validateTaskRow(
      { id: 'TSK-001', title: 'Title', dependencies: ['TSK-001'] },
      3,
    );
    expect(selfDepIssues[0]).toMatchObject({
      sheet: 'Tasks',
      row: 3,
      column: 'dependencies',
      code: VALIDATION_ERROR_CODES.SELF_DEPENDENCY,
    });

    // Phần tử danh sách rỗng
    const listIssues = validateTaskRow(
      {
        id: 'TSK-002',
        title: 'Title',
        acceptance_criteria: ['Criterion 1', '   '],
        test_commands: ['pnpm test', ''],
      },
      4,
    );
    expect(listIssues.some((e) => e.column === 'acceptance_criteria' && e.code === VALIDATION_ERROR_CODES.EMPTY_LIST_ITEM)).toBe(true);
    expect(listIssues.some((e) => e.column === 'test_commands' && e.code === VALIDATION_ERROR_CODES.EMPTY_LIST_ITEM)).toBe(true);
  });

  it('Nghiệm thu 7: Tích hợp assertValidWorkbook & parseAndValidateWorkbook với dữ liệu thực', async () => {
    // 7.1 Kiểm thử file mẫu chuẩn: fixtures/sample-tasks.xlsx hoàn toàn hợp lệ
    const sampleExcel = path.resolve(process.cwd(), 'fixtures/sample-tasks.xlsx');
    const { parsed, report } = await parseAndValidateWorkbook(sampleExcel);

    expect(report.valid).toBe(true);
    expect(report.errorCount).toBe(0);
    expect(parsed.tasks.length).toBeGreaterThan(0);
    const directReport = validateWorkbook(parsed);
    expect(directReport.valid).toBe(true);
    expect(() => assertValidWorkbook(parsed)).not.toThrow();

    // 7.2 Kiểm thử ném WorkbookValidationError khi dữ liệu có lỗi
    const invalidWb: ParsedWorkbookResult = {
      tasks: [
        {
          id: '',
          feature_id: null,
          title: '',
          description: null,
          phase: null,
          worker_type: 'agy',
          repository: '.',
          acceptance_criteria: [],
          test_commands: [],
          priority: 0,
          max_attempts: 3,
          timeout_minutes: 30,
          dependencies: [],
          status: 'TODO',
          rowNumber: 2,
          raw: {},
        },
      ],
      features: [],
      config: {
        repository: '.',
        agy_bin: 'agy',
        agy_args: '',
        verify_commands: [],
        max_attempts: 3,
        timeout_minutes: 30,
        max_concurrency: 1,
        settings: {},
        raw: {},
      },
      sourceType: 'excel',
    };

    expect(() => assertValidWorkbook(invalidWb)).toThrowError(WorkbookValidationError);
  });
});
