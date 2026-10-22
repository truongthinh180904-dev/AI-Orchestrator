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
  WorkbookValidationError,
  type ValidationErrorItem,
  type ParsedWorkbookResult,
} from '../index.js';
import { parseImportFile } from '../parser/index.js';

describe('Validator Module (TSK-003)', () => {
  describe('Formatters', () => {
    it('formats a single validation error with sheet, row, and column', () => {
      const item: ValidationErrorItem = {
        sheet: 'Tasks',
        row: 5,
        column: 'title',
        code: VALIDATION_ERROR_CODES.REQUIRED_FIELD,
        message: "Tiêu đề task ('title') là bắt buộc và không được để trống.",
        value: '',
        severity: 'error',
      };

      const formatted = formatValidationError(item);
      expect(formatted).toContain("[Tasks: dòng 5, cột 'title']");
      expect(formatted).toContain('(REQUIRED_FIELD)');
      expect(formatted).toContain("Tiêu đề task ('title') là bắt buộc");
    });

    it('formats a validation report with errors and warnings', () => {
      const report = {
        valid: false,
        errors: [
          {
            sheet: 'Tasks',
            row: 2,
            column: 'id',
            code: VALIDATION_ERROR_CODES.REQUIRED_FIELD,
            message: 'Task id is required',
            severity: 'error' as const,
          },
        ],
        warnings: [
          {
            sheet: 'Config',
            row: 2,
            column: 'setting',
            code: VALIDATION_ERROR_CODES.UNKNOWN_COLUMN,
            message: 'Unknown column',
            severity: 'warning' as const,
          },
        ],
        errorCount: 1,
        warningCount: 1,
        summary: '',
      };

      const summary = formatValidationReport(report);
      expect(summary).toContain('Phát hiện 1 lỗi và 1 cảnh báo:');
      expect(summary).toContain("[Tasks: dòng 2, cột 'id']");
      expect(summary).toContain("[Config: dòng 2, cột 'setting']");
    });
  });

  describe('validateTaskRow — Kiểm tra từng loại lỗi của Task', () => {
    it('Lỗi 1: REQUIRED_FIELD khi thiếu hoặc để trống id', () => {
      const issues = validateTaskRow({ id: '', title: 'Valid title' }, 3);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        sheet: 'Tasks',
        row: 3,
        column: 'id',
        code: VALIDATION_ERROR_CODES.REQUIRED_FIELD,
        severity: 'error',
      });
    });

    it('Lỗi 2: STRING_TOO_LONG khi id vượt quá 100 ký tự', () => {
      const longId = 'A'.repeat(101);
      const issues = validateTaskRow({ id: longId, title: 'Valid title' }, 2);
      expect(issues.some((i) => i.code === VALIDATION_ERROR_CODES.STRING_TOO_LONG && i.column === 'id')).toBe(true);
    });

    it('Lỗi 3: INVALID_IDENTIFIER_FORMAT khi id chứa ký tự không hợp lệ (khoảng trắng, ký tự đặc biệt)', () => {
      const issues1 = validateTaskRow({ id: 'TASK 001', title: 'Valid title' }, 2);
      expect(issues1[0]).toMatchObject({
        sheet: 'Tasks',
        row: 2,
        column: 'id',
        code: VALIDATION_ERROR_CODES.INVALID_IDENTIFIER_FORMAT,
      });

      const issues2 = validateTaskRow({ id: 'TASK#001@X', title: 'Valid title' }, 4);
      expect(issues2[0]).toMatchObject({
        sheet: 'Tasks',
        row: 4,
        column: 'id',
        code: VALIDATION_ERROR_CODES.INVALID_IDENTIFIER_FORMAT,
      });
    });

    it('Lỗi 4: REQUIRED_FIELD khi thiếu hoặc để trống title', () => {
      const issues = validateTaskRow({ id: 'TSK-001', title: '   ' }, 5);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        sheet: 'Tasks',
        row: 5,
        column: 'title',
        code: VALIDATION_ERROR_CODES.REQUIRED_FIELD,
      });
    });

    it('Lỗi 5: STRING_TOO_LONG khi title vượt quá 500 ký tự', () => {
      const longTitle = 'B'.repeat(501);
      const issues = validateTaskRow({ id: 'TSK-001', title: longTitle }, 2);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        sheet: 'Tasks',
        row: 2,
        column: 'title',
        code: VALIDATION_ERROR_CODES.STRING_TOO_LONG,
      });
    });

    it('Lỗi 6: INVALID_IDENTIFIER_FORMAT khi feature_id chứa ký tự không hợp lệ', () => {
      const issues = validateTaskRow({ id: 'TSK-001', title: 'Title', feature_id: 'FEAT 01' }, 2);
      expect(issues.some((i) => i.code === VALIDATION_ERROR_CODES.INVALID_IDENTIFIER_FORMAT && i.column === 'feature_id')).toBe(true);
    });

    it('Lỗi 7: INVALID_STATUS khi status không thuộc danh sách TaskStatus', () => {
      const issues = validateTaskRow({ id: 'TSK-001', title: 'Title', status: 'IN_PROGRESS_INVALID' }, 6);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        sheet: 'Tasks',
        row: 6,
        column: 'status',
        code: VALIDATION_ERROR_CODES.INVALID_STATUS,
        value: 'IN_PROGRESS_INVALID',
      });
    });

    it('Chấp nhận status hợp lệ bất kể hoa thường (TODO, Ready, done)', () => {
      expect(validateTaskRow({ id: 'TSK-001', title: 'Title', status: 'TODO' })).toHaveLength(0);
      expect(validateTaskRow({ id: 'TSK-002', title: 'Title', status: 'ready' })).toHaveLength(0);
      expect(validateTaskRow({ id: 'TSK-003', title: 'Title', status: 'DONE' })).toHaveLength(0);
    });

    it('Lỗi 8: INVALID_INTEGER khi priority không phải số nguyên', () => {
      const issues1 = validateTaskRow({ id: 'TSK-001', title: 'Title', priority: 'high' }, 7);
      expect(issues1[0]).toMatchObject({
        sheet: 'Tasks',
        row: 7,
        column: 'priority',
        code: VALIDATION_ERROR_CODES.INVALID_INTEGER,
      });

      const issues2 = validateTaskRow({ id: 'TSK-002', title: 'Title', priority: 3.14 }, 8);
      expect(issues2[0]).toMatchObject({
        sheet: 'Tasks',
        row: 8,
        column: 'priority',
        code: VALIDATION_ERROR_CODES.INVALID_INTEGER,
      });
    });

    it('Lỗi 9: VALUE_OUT_OF_RANGE khi priority nằm ngoài khoảng cho phép', () => {
      const issues = validateTaskRow({ id: 'TSK-001', title: 'Title', priority: 99999 }, 2);
      expect(issues[0]).toMatchObject({
        sheet: 'Tasks',
        row: 2,
        column: 'priority',
        code: VALIDATION_ERROR_CODES.VALUE_OUT_OF_RANGE,
      });
    });

    it('Lỗi 10: INVALID_INTEGER và VALUE_OUT_OF_RANGE cho max_attempts', () => {
      const notInt = validateTaskRow({ id: 'TSK-001', title: 'Title', max_attempts: 'three' }, 9);
      expect(notInt[0]).toMatchObject({
        sheet: 'Tasks',
        row: 9,
        column: 'max_attempts',
        code: VALIDATION_ERROR_CODES.INVALID_INTEGER,
      });

      const zero = validateTaskRow({ id: 'TSK-001', title: 'Title', max_attempts: 0 }, 10);
      expect(zero[0]).toMatchObject({
        sheet: 'Tasks',
        row: 10,
        column: 'max_attempts',
        code: VALIDATION_ERROR_CODES.VALUE_OUT_OF_RANGE,
      });

      const tooHigh = validateTaskRow({ id: 'TSK-001', title: 'Title', max_attempts: 101 }, 11);
      expect(tooHigh[0]).toMatchObject({
        sheet: 'Tasks',
        row: 11,
        column: 'max_attempts',
        code: VALIDATION_ERROR_CODES.VALUE_OUT_OF_RANGE,
      });
    });

    it('Lỗi 11: INVALID_INTEGER và VALUE_OUT_OF_RANGE cho timeout_minutes', () => {
      const notInt = validateTaskRow({ id: 'TSK-001', title: 'Title', timeout_minutes: 'abc' }, 12);
      expect(notInt[0]).toMatchObject({
        sheet: 'Tasks',
        row: 12,
        column: 'timeout_minutes',
        code: VALIDATION_ERROR_CODES.INVALID_INTEGER,
      });

      const negative = validateTaskRow({ id: 'TSK-001', title: 'Title', timeout_minutes: -10 }, 13);
      expect(negative[0]).toMatchObject({
        sheet: 'Tasks',
        row: 13,
        column: 'timeout_minutes',
        code: VALIDATION_ERROR_CODES.VALUE_OUT_OF_RANGE,
      });

      const tooLong = validateTaskRow({ id: 'TSK-001', title: 'Title', timeout_minutes: 20000 }, 14);
      expect(tooLong[0]).toMatchObject({
        sheet: 'Tasks',
        row: 14,
        column: 'timeout_minutes',
        code: VALIDATION_ERROR_CODES.VALUE_OUT_OF_RANGE,
      });
    });

    it('Lỗi 12: SELF_DEPENDENCY khi task tự phụ thuộc vào chính nó', () => {
      const issues = validateTaskRow(
        { id: 'TSK-005', title: 'Title', dependencies: ['TSK-001', 'TSK-005'] },
        15,
      );
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        sheet: 'Tasks',
        row: 15,
        column: 'dependencies',
        code: VALIDATION_ERROR_CODES.SELF_DEPENDENCY,
        value: 'TSK-005',
      });
    });

    it('Lỗi 13: INVALID_IDENTIFIER_FORMAT trong danh sách dependencies', () => {
      const issues = validateTaskRow(
        { id: 'TSK-005', title: 'Title', dependencies: ['VALID-1', 'INVALID ID!'] },
        16,
      );
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        sheet: 'Tasks',
        row: 16,
        column: 'dependencies',
        code: VALIDATION_ERROR_CODES.INVALID_IDENTIFIER_FORMAT,
        value: 'INVALID ID!',
      });
    });

    it('Lỗi 14: EMPTY_LIST_ITEM trong acceptance_criteria và test_commands', () => {
      const issuesAc = validateTaskRow(
        { id: 'TSK-001', title: 'Title', acceptance_criteria: ['Pass test', '   '] },
        17,
      );
      expect(issuesAc.some((i) => i.code === VALIDATION_ERROR_CODES.EMPTY_LIST_ITEM && i.column === 'acceptance_criteria')).toBe(true);

      const issuesTc = validateTaskRow(
        { id: 'TSK-001', title: 'Title', test_commands: ['pnpm test', ''] },
        18,
      );
      expect(issuesTc.some((i) => i.code === VALIDATION_ERROR_CODES.EMPTY_LIST_ITEM && i.column === 'test_commands')).toBe(true);
    });

    it('Lỗi 15: INVALID_WORKER_TYPE và INVALID_REPOSITORY', () => {
      const issuesWorker = validateTaskRow(
        { id: 'TSK-001', title: 'Title', worker_type: 'custom worker with spaces' },
        19,
      );
      expect(issuesWorker[0]).toMatchObject({
        sheet: 'Tasks',
        row: 19,
        column: 'worker_type',
        code: VALIDATION_ERROR_CODES.INVALID_WORKER_TYPE,
      });

      const issuesRepo = validateTaskRow(
        { id: 'TSK-001', title: 'Title', repository: 'path/with/\0/null' },
        20,
      );
      expect(issuesRepo[0]).toMatchObject({
        sheet: 'Tasks',
        row: 20,
        column: 'repository',
        code: VALIDATION_ERROR_CODES.INVALID_REPOSITORY,
      });
    });

    it('Nhận diện bí danh tiếng Việt (Mã task, Tiêu đề, Độ ưu tiên, Trạng thái)', () => {
      const issues = validateTaskRow(
        {
          'Mã task': '',
          'Tiêu đề': '',
          'Độ ưu tiên': 'không phải số',
          'Trạng thái': 'LỖI',
        },
        21,
      );
      expect(issues).toHaveLength(4);
      expect(issues.some((i) => i.column === 'id' && i.code === VALIDATION_ERROR_CODES.REQUIRED_FIELD)).toBe(true);
      expect(issues.some((i) => i.column === 'title' && i.code === VALIDATION_ERROR_CODES.REQUIRED_FIELD)).toBe(true);
      expect(issues.some((i) => i.column === 'priority' && i.code === VALIDATION_ERROR_CODES.INVALID_INTEGER)).toBe(true);
      expect(issues.some((i) => i.column === 'status' && i.code === VALIDATION_ERROR_CODES.INVALID_STATUS)).toBe(true);
    });

    it('Trả về mảng rỗng khi dòng Task hoàn toàn hợp lệ', () => {
      const validTask: Record<string, unknown> = {
        id: 'TSK-100',
        feature_id: 'FEAT-1',
        title: 'Xây dựng tính năng đăng nhập',
        description: 'Chi tiết mô tả task',
        phase: 'GĐ 1',
        worker_type: 'agy',
        repository: '.',
        acceptance_criteria: ['Nghiệm thu tiêu chí 1', 'Nghiệm thu tiêu chí 2'],
        test_commands: ['pnpm test'],
        priority: 10,
        max_attempts: 3,
        timeout_minutes: 30,
        dependencies: ['TSK-099'],
        status: 'READY',
      };
      const issues = validateTaskRow(validTask, 2);
      expect(issues).toHaveLength(0);
    });
  });

  describe('validateFeatureRow — Kiểm tra từng loại lỗi của Feature', () => {
    it('Lỗi 1: REQUIRED_FIELD khi thiếu hoặc để trống id', () => {
      const issues = validateFeatureRow({ id: '', name: 'Feature A' }, 2);
      expect(issues[0]).toMatchObject({
        sheet: 'Features',
        row: 2,
        column: 'id',
        code: VALIDATION_ERROR_CODES.REQUIRED_FIELD,
      });
    });

    it('Lỗi 2: INVALID_IDENTIFIER_FORMAT khi id chứa ký tự không hợp lệ', () => {
      const issues = validateFeatureRow({ id: 'FEAT 01', name: 'Feature A' }, 3);
      expect(issues[0]).toMatchObject({
        sheet: 'Features',
        row: 3,
        column: 'id',
        code: VALIDATION_ERROR_CODES.INVALID_IDENTIFIER_FORMAT,
      });
    });

    it('Lỗi 3: REQUIRED_FIELD khi thiếu name', () => {
      const issues = validateFeatureRow({ id: 'FEAT-01', name: '' }, 4);
      expect(issues[0]).toMatchObject({
        sheet: 'Features',
        row: 4,
        column: 'name',
        code: VALIDATION_ERROR_CODES.REQUIRED_FIELD,
      });
    });

    it('Lỗi 4: INVALID_STATUS khi trạng thái feature không hợp lệ', () => {
      const issues = validateFeatureRow({ id: 'FEAT-01', name: 'Feature A', status: 'VERIFYING' }, 5);
      expect(issues[0]).toMatchObject({
        sheet: 'Features',
        row: 5,
        column: 'status',
        code: VALIDATION_ERROR_CODES.INVALID_STATUS,
        value: 'VERIFYING',
      });
    });

    it('Lỗi 5: INVALID_IDENTIFIER_FORMAT trong required_tasks', () => {
      const issues = validateFeatureRow(
        { id: 'FEAT-01', name: 'Feature A', required_tasks: ['VALID-1', 'INVALID ID!'] },
        6,
      );
      expect(issues[0]).toMatchObject({
        sheet: 'Features',
        row: 6,
        column: 'required_tasks',
        code: VALIDATION_ERROR_CODES.INVALID_IDENTIFIER_FORMAT,
      });
    });

    it('Lỗi 6: EMPTY_LIST_ITEM trong integration_tests', () => {
      const issues = validateFeatureRow(
        { id: 'FEAT-01', name: 'Feature A', integration_tests: ['pnpm test', '   '] },
        7,
      );
      expect(issues[0]).toMatchObject({
        sheet: 'Features',
        row: 7,
        column: 'integration_tests',
        code: VALIDATION_ERROR_CODES.EMPTY_LIST_ITEM,
      });
    });

    it('Trả về mảng rỗng khi Feature hoàn toàn hợp lệ', () => {
      const issues = validateFeatureRow({
        id: 'FEAT-001',
        name: 'Authentication module',
        required_tasks: ['TSK-001', 'TSK-002'],
        integration_tests: ['pnpm test:auth'],
        status: 'IN_PROGRESS',
      });
      expect(issues).toHaveLength(0);
    });
  });

  describe('validateConfig — Kiểm tra lỗi Config', () => {
    it('Lỗi khi max_attempts không phải số hoặc <= 0', () => {
      const issues1 = validateConfig({ max_attempts: 'abc' }, 2);
      expect(issues1[0]).toMatchObject({
        sheet: 'Config',
        row: 2,
        column: 'max_attempts',
        code: VALIDATION_ERROR_CODES.INVALID_INTEGER,
      });

      const issues2 = validateConfig({ max_attempts: 0 }, 2);
      expect(issues2[0]).toMatchObject({
        sheet: 'Config',
        row: 2,
        column: 'max_attempts',
        code: VALIDATION_ERROR_CODES.VALUE_OUT_OF_RANGE,
      });
    });

    it('Lỗi khi timeout_minutes <= 0 hoặc max_concurrency <= 0', () => {
      const issuesTm = validateConfig({ timeout_minutes: -1 }, 2);
      expect(issuesTm[0]).toMatchObject({
        sheet: 'Config',
        row: 2,
        column: 'timeout_minutes',
        code: VALIDATION_ERROR_CODES.VALUE_OUT_OF_RANGE,
      });

      const issuesMc = validateConfig({ max_concurrency: 0 }, 2);
      expect(issuesMc[0]).toMatchObject({
        sheet: 'Config',
        row: 2,
        column: 'max_concurrency',
        code: VALIDATION_ERROR_CODES.VALUE_OUT_OF_RANGE,
      });
    });

    it('Lỗi khi agy_bin chứa khoảng trắng', () => {
      const issues = validateConfig({ agy_bin: 'agy CLI path' }, 2);
      expect(issues[0]).toMatchObject({
        sheet: 'Config',
        row: 2,
        column: 'agy_bin',
        code: VALIDATION_ERROR_CODES.INVALID_EXECUTABLE,
      });
    });

    it('Trả về mảng rỗng khi Config hợp lệ', () => {
      const issues = validateConfig({
        repository: '.',
        agy_bin: 'agy',
        max_attempts: 3,
        timeout_minutes: 30,
        max_concurrency: 1,
      });
      expect(issues).toHaveLength(0);
    });
  });

  describe('validateWorkbook & validateRawWorkbook — Lỗi cấu trúc Sheet', () => {
    it('Lỗi MISSING_REQUIRED_SHEET khi thiếu sheet Tasks', () => {
      const report = validateRawWorkbook({
        features: [{ rowNumber: 2, data: { id: 'F1', name: 'Feat 1' } }],
      });
      expect(report.valid).toBe(false);
      expect(report.errors[0]).toMatchObject({
        sheet: 'Tasks',
        row: 1,
        column: 'sheet',
        code: VALIDATION_ERROR_CODES.MISSING_REQUIRED_SHEET,
      });
    });

    it('Lỗi EMPTY_SHEET khi sheet Tasks không có dòng dữ liệu nào', () => {
      const report = validateRawWorkbook({
        tasks: [],
      });
      expect(report.valid).toBe(false);
      expect(report.errors[0]).toMatchObject({
        sheet: 'Tasks',
        row: 1,
        column: 'sheet',
        code: VALIDATION_ERROR_CODES.EMPTY_SHEET,
      });
    });

    it('Lỗi MISSING_REQUIRED_COLUMN khi sheet Tasks thiếu cột id hoặc title trong tiêu đề', () => {
      const report = validateRawWorkbook({
        tasks: [{ rowNumber: 2, data: { description: 'Only description' } }],
        headers: {
          Tasks: ['description', 'priority'],
        },
      });
      expect(report.valid).toBe(false);
      expect(report.errors.some((e) => e.code === VALIDATION_ERROR_CODES.MISSING_REQUIRED_COLUMN && e.column === 'id')).toBe(true);
      expect(report.errors.some((e) => e.code === VALIDATION_ERROR_CODES.MISSING_REQUIRED_COLUMN && e.column === 'title')).toBe(true);
    });

    it('Gom tất cả lỗi từ nhiều sheet, dòng, cột vào một báo cáo duy nhất', () => {
      const mockWorkbook: ParsedWorkbookResult = {
        tasks: [
          {
            id: '', // Lỗi 1
            feature_id: null,
            title: 'Task 1',
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
            raw: { id: '', title: 'Task 1' },
          },
          {
            id: 'TSK-002',
            feature_id: null,
            title: '', // Lỗi 2
            description: null,
            phase: null,
            worker_type: 'agy',
            repository: '.',
            acceptance_criteria: [],
            test_commands: [],
            priority: 0,
            max_attempts: 3,
            timeout_minutes: 30,
            dependencies: ['TSK-002'], // Lỗi 3 (self-dep)
            status: 'TODO',
            rowNumber: 3,
            raw: { id: 'TSK-002', title: '', dependencies: 'TSK-002' },
          },
        ],
        features: [
          {
            id: 'FEAT 99', // Lỗi 4 (invalid id)
            name: 'Feature with bad ID',
            description: null,
            required_tasks: [],
            integration_tests: [],
            release_policy: null,
            status: 'TODO',
            rowNumber: 2,
            raw: { id: 'FEAT 99', name: 'Feature with bad ID' },
          },
        ],
        config: {
          repository: '.',
          agy_bin: 'agy',
          agy_args: '-p',
          verify_commands: [],
          max_attempts: 3,
          timeout_minutes: 30,
          max_concurrency: 0, // Lỗi 5 (concurrency 0)
          settings: {},
          raw: { max_concurrency: 0 },
        },
        sourceType: 'excel',
      };

      const report = validateWorkbook(mockWorkbook);
      expect(report.valid).toBe(false);
      expect(report.errorCount).toBe(5);

      // Kiểm tra vị trí (sheet, dòng, cột) từng lỗi
      expect(report.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sheet: 'Tasks', row: 2, column: 'id', code: VALIDATION_ERROR_CODES.REQUIRED_FIELD }),
          expect.objectContaining({ sheet: 'Tasks', row: 3, column: 'title', code: VALIDATION_ERROR_CODES.REQUIRED_FIELD }),
          expect.objectContaining({ sheet: 'Tasks', row: 3, column: 'dependencies', code: VALIDATION_ERROR_CODES.SELF_DEPENDENCY }),
          expect.objectContaining({ sheet: 'Features', row: 2, column: 'id', code: VALIDATION_ERROR_CODES.INVALID_IDENTIFIER_FORMAT }),
          expect.objectContaining({ sheet: 'Config', row: 2, column: 'max_concurrency', code: VALIDATION_ERROR_CODES.VALUE_OUT_OF_RANGE }),
        ]),
      );
    });

    it('assertValidWorkbook ném WorkbookValidationError khi có lỗi', () => {
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
            raw: { id: '', title: '' },
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

    it('Validate thành công dữ liệu file mẫu Excel hợp lệ (fixtures/sample-tasks.xlsx)', async () => {
      const samplePath = path.resolve(process.cwd(), 'fixtures/sample-tasks.xlsx');
      const parsed = await parseImportFile(samplePath);
      const report = validateWorkbook(parsed, { existingTaskIds: ['FND-003'] });

      expect(report.valid).toBe(true);
      expect(report.errorCount).toBe(0);
      expect(report.errors).toHaveLength(0);
    });
  });

  describe('TSK-004: Quan hệ thực thể — Phát hiện trùng task_id, dependency không tồn tại', () => {
    it('Phát hiện trùng task_id trong cùng sheet Tasks', () => {
      const report = validateRawWorkbook({
        tasks: [
          { rowNumber: 2, data: { id: 'TSK-001', title: 'Task 1' } },
          { rowNumber: 3, data: { id: 'TSK-002', title: 'Task 2' } },
          { rowNumber: 4, data: { id: 'TSK-001', title: 'Task 1 duplicate' } },
        ],
      });

      expect(report.valid).toBe(false);
      const dupError = report.errors.find((e) => e.code === VALIDATION_ERROR_CODES.DUPLICATE_TASK_ID);
      expect(dupError).toBeDefined();
      expect(dupError).toMatchObject({
        sheet: 'Tasks',
        row: 4,
        column: 'id',
        code: VALIDATION_ERROR_CODES.DUPLICATE_TASK_ID,
        value: 'TSK-001',
      });
      expect(dupError?.message).toContain('dòng 2');
    });

    it('Phát hiện trùng task_id với task đã có trong existingTaskIds', () => {
      const report = validateRawWorkbook(
        {
          tasks: [{ rowNumber: 2, data: { id: 'TSK-EXISTING', title: 'New Task with existing id' } }],
        },
        { existingTaskIds: ['TSK-EXISTING'] },
      );

      expect(report.valid).toBe(false);
      const dupError = report.errors.find((e) => e.code === VALIDATION_ERROR_CODES.DUPLICATE_TASK_ID);
      expect(dupError).toBeDefined();
      expect(dupError).toMatchObject({
        sheet: 'Tasks',
        row: 2,
        column: 'id',
        code: VALIDATION_ERROR_CODES.DUPLICATE_TASK_ID,
        value: 'TSK-EXISTING',
      });
    });

    it('Phát hiện trùng feature_id trong sheet Features và với existingFeatureIds', () => {
      const report = validateRawWorkbook(
        {
          tasks: [{ rowNumber: 2, data: { id: 'TSK-001', title: 'Task 1' } }],
          features: [
            { rowNumber: 2, data: { id: 'FEAT-01', name: 'Feature 1' } },
            { rowNumber: 3, data: { id: 'FEAT-01', name: 'Feature 1 Duplicate' } },
            { rowNumber: 4, data: { id: 'FEAT-OLD', name: 'Feature Old' } },
          ],
        },
        { existingFeatureIds: ['FEAT-OLD'] },
      );

      expect(report.valid).toBe(false);
      const dupErrors = report.errors.filter((e) => e.code === VALIDATION_ERROR_CODES.DUPLICATE_FEATURE_ID);
      expect(dupErrors).toHaveLength(2);
      expect(dupErrors[0]).toMatchObject({
        sheet: 'Features',
        row: 3,
        column: 'id',
        value: 'FEAT-01',
      });
      expect(dupErrors[1]).toMatchObject({
        sheet: 'Features',
        row: 4,
        column: 'id',
        value: 'FEAT-OLD',
      });
    });

    it('Phát hiện dependency không tồn tại trong workbook', () => {
      const report = validateRawWorkbook({
        tasks: [
          { rowNumber: 2, data: { id: 'TSK-001', title: 'Task 1' } },
          { rowNumber: 3, data: { id: 'TSK-002', title: 'Task 2', dependencies: 'TSK-001, GHOST-TASK' } },
        ],
      });

      expect(report.valid).toBe(false);
      const depError = report.errors.find((e) => e.code === VALIDATION_ERROR_CODES.NON_EXISTENT_DEPENDENCY);
      expect(depError).toBeDefined();
      expect(depError).toMatchObject({
        sheet: 'Tasks',
        row: 3,
        column: 'dependencies',
        code: VALIDATION_ERROR_CODES.NON_EXISTENT_DEPENDENCY,
        value: 'GHOST-TASK',
      });
    });

    it('Cho phép dependency hợp lệ trong cùng workbook hoặc trong existingTaskIds', () => {
      const report = validateRawWorkbook(
        {
          tasks: [
            { rowNumber: 2, data: { id: 'TSK-001', title: 'Task 1' } },
            { rowNumber: 3, data: { id: 'TSK-002', title: 'Task 2', dependencies: 'TSK-001, TSK-IN-DB' } },
          ],
        },
        { existingTaskIds: ['TSK-IN-DB'] },
      );

      expect(report.valid).toBe(true);
      expect(report.errorCount).toBe(0);
    });

    it('Phát hiện tham chiếu feature_id và required_tasks không tồn tại', () => {
      const report = validateRawWorkbook({
        tasks: [
          { rowNumber: 2, data: { id: 'TSK-001', title: 'Task 1', feature_id: 'NON-EXISTENT-FEAT' } },
        ],
        features: [
          { rowNumber: 2, data: { id: 'FEAT-001', name: 'Feat 1', required_tasks: 'NON-EXISTENT-TASK' } },
        ],
      });

      expect(report.valid).toBe(false);
      const featError = report.errors.find((e) => e.code === VALIDATION_ERROR_CODES.MISSING_FEATURE);
      expect(featError).toBeDefined();
      expect(featError).toMatchObject({
        sheet: 'Tasks',
        row: 2,
        column: 'feature_id',
        value: 'NON-EXISTENT-FEAT',
      });

      const reqTaskError = report.errors.find((e) => e.code === VALIDATION_ERROR_CODES.MISSING_REQUIRED_TASK);
      expect(reqTaskError).toBeDefined();
      expect(reqTaskError).toMatchObject({
        sheet: 'Features',
        row: 2,
        column: 'required_tasks',
        value: 'NON-EXISTENT-TASK',
      });
    });

    it('assertValidWorkbook ném WorkbookValidationError và từ chối dữ liệu trùng ID hoặc thiếu dependency', () => {
      const invalidWorkbook: ParsedWorkbookResult = {
        tasks: [
          {
            id: 'TSK-DUP',
            feature_id: null,
            title: 'Task 1',
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
            raw: { id: 'TSK-DUP', title: 'Task 1' },
          },
          {
            id: 'TSK-DUP',
            feature_id: null,
            title: 'Task 2',
            description: null,
            phase: null,
            worker_type: 'agy',
            repository: '.',
            acceptance_criteria: [],
            test_commands: [],
            priority: 0,
            max_attempts: 3,
            timeout_minutes: 30,
            dependencies: ['TSK-NON-EXISTENT'],
            status: 'TODO',
            rowNumber: 3,
            raw: { id: 'TSK-DUP', title: 'Task 2', dependencies: 'TSK-NON-EXISTENT' },
          },
        ],
        features: [],
        config: {
          repository: '.',
          agy_bin: 'agy',
          agy_args: '-p',
          verify_commands: [],
          max_attempts: 3,
          timeout_minutes: 30,
          max_concurrency: 1,
          settings: {},
          raw: {},
        },
        sourceType: 'excel',
      };

      expect(() => assertValidWorkbook(invalidWorkbook)).toThrowError(WorkbookValidationError);
    });

    it('Phát hiện chu trình phụ thuộc trong Workbook và từ chối với CIRCULAR_DEPENDENCY', () => {
      const workbookWithCycle: ParsedWorkbookResult = {
        tasks: [
          {
            id: 'TASK-A',
            feature_id: null,
            title: 'Task A',
            description: null,
            phase: null,
            worker_type: 'agy',
            repository: '.',
            acceptance_criteria: [],
            test_commands: [],
            priority: 0,
            max_attempts: 3,
            timeout_minutes: 30,
            dependencies: ['TASK-B'],
            status: 'TODO',
            rowNumber: 2,
            raw: {},
          },
          {
            id: 'TASK-B',
            feature_id: null,
            title: 'Task B',
            description: null,
            phase: null,
            worker_type: 'agy',
            repository: '.',
            acceptance_criteria: [],
            test_commands: [],
            priority: 0,
            max_attempts: 3,
            timeout_minutes: 30,
            dependencies: ['TASK-A'],
            status: 'TODO',
            rowNumber: 3,
            raw: {},
          },
        ],
        features: [],
        config: {
          repository: '.',
          agy_bin: 'agy',
          agy_args: '-p',
          verify_commands: [],
          max_attempts: 3,
          timeout_minutes: 30,
          max_concurrency: 1,
          settings: {},
          raw: {},
        },
        sourceType: 'excel',
      };

      const report = validateWorkbook(workbookWithCycle);
      expect(report.valid).toBe(false);

      const cycleErrors = report.errors.filter(
        (e) => e.code === VALIDATION_ERROR_CODES.CIRCULAR_DEPENDENCY,
      );
      expect(cycleErrors.length).toBeGreaterThan(0);
      expect(cycleErrors[0]?.sheet).toBe('Tasks');
      expect(cycleErrors[0]?.column).toBe('dependencies');
      expect(cycleErrors[0]?.message).toContain('TASK-A -> TASK-B -> TASK-A');

      expect(() => assertValidWorkbook(workbookWithCycle)).toThrowError(WorkbookValidationError);
    });
  });
});
