import { describe, it, expect } from 'vitest';
import {
  VALIDATION_ERROR_CODES,
  validateRawWorkbook,
  assertValidWorkbook,
  WorkbookValidationError,
  type ParsedWorkbookResult,
} from '../packages/shared/src/index.js';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
} from '../packages/db/src/index.js';

describe('TSK-004 Acceptance Tests: Phát hiện trùng task_id, dependency không tồn tại — Từ chối dữ liệu sai', () => {
  describe('Nghiệm thu 1: Phát hiện trùng task_id trong sheet Tasks và từ chối dữ liệu sai', () => {
    it('Phát hiện dòng trùng task_id và báo lỗi tọa độ (Tasks, dòng X, id) kèm dòng đã xuất hiện', () => {
      const rawInput = {
        tasks: [
          { rowNumber: 2, data: { id: 'TSK-001', title: 'Task khởi đầu' } },
          { rowNumber: 3, data: { id: 'TSK-002', title: 'Task thứ hai' } },
          { rowNumber: 4, data: { id: 'TSK-001', title: 'Task bị trùng mã TSK-001' } },
        ],
      };

      const report = validateRawWorkbook(rawInput);

      expect(report.valid).toBe(false);
      expect(report.errorCount).toBeGreaterThanOrEqual(1);

      const dupIssue = report.errors.find(
        (e) => e.code === VALIDATION_ERROR_CODES.DUPLICATE_TASK_ID && e.row === 4,
      );
      expect(dupIssue).toBeDefined();
      expect(dupIssue).toMatchObject({
        sheet: 'Tasks',
        row: 4,
        column: 'id',
        code: VALIDATION_ERROR_CODES.DUPLICATE_TASK_ID,
        value: 'TSK-001',
      });
      expect(dupIssue?.message).toContain('dòng 2');
    });

    it('assertValidWorkbook ném WorkbookValidationError và từ chối dữ liệu khi có task_id trùng lặp', () => {
      const workbookWithDup: ParsedWorkbookResult = {
        tasks: [
          {
            id: 'TSK-ALPHA',
            feature_id: null,
            title: 'Alpha One',
            description: null,
            phase: 'GĐ 1',
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
            raw: { id: 'TSK-ALPHA', title: 'Alpha One' },
          },
          {
            id: 'TSK-ALPHA',
            feature_id: null,
            title: 'Alpha Two Duplicate',
            description: null,
            phase: 'GĐ 1',
            worker_type: 'agy',
            repository: '.',
            acceptance_criteria: [],
            test_commands: [],
            priority: 0,
            max_attempts: 3,
            timeout_minutes: 30,
            dependencies: [],
            status: 'TODO',
            rowNumber: 3,
            raw: { id: 'TSK-ALPHA', title: 'Alpha Two Duplicate' },
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

      expect(() => assertValidWorkbook(workbookWithDup)).toThrowError(WorkbookValidationError);
    });
  });

  describe('Nghiệm thu 2: Phát hiện trùng task_id với task đã có trong DB / existingTaskIds và từ chối', () => {
    it('Báo lỗi DUPLICATE_TASK_ID khi task_id trùng với ID đã lưu trong hệ thống', () => {
      const report = validateRawWorkbook(
        {
          tasks: [
            { rowNumber: 2, data: { id: 'TSK-EXISTING-IN-DB', title: 'Task trùng lặp với hệ thống' } },
            { rowNumber: 3, data: { id: 'TSK-FRESH-NEW', title: 'Task mới hoàn toàn' } },
          ],
        },
        { existingTaskIds: ['TSK-EXISTING-IN-DB'] },
      );

      expect(report.valid).toBe(false);
      const dupIssue = report.errors.find(
        (e) => e.code === VALIDATION_ERROR_CODES.DUPLICATE_TASK_ID && e.value === 'TSK-EXISTING-IN-DB',
      );
      expect(dupIssue).toBeDefined();
      expect(dupIssue).toMatchObject({
        sheet: 'Tasks',
        row: 2,
        column: 'id',
        code: VALIDATION_ERROR_CODES.DUPLICATE_TASK_ID,
      });
      expect(dupIssue?.message).toContain('đã tồn tại trong cơ sở dữ liệu/hệ thống');
    });
  });

  describe('Nghiệm thu 3: Phát hiện trùng feature_id và từ chối', () => {
    it('Phát hiện trùng feature_id trong sheet Features và với existingFeatureIds', () => {
      const report = validateRawWorkbook(
        {
          tasks: [{ rowNumber: 2, data: { id: 'TSK-001', title: 'Task 1' } }],
          features: [
            { rowNumber: 2, data: { id: 'FEAT-CORE', name: 'Feature Core' } },
            { rowNumber: 3, data: { id: 'FEAT-CORE', name: 'Feature Core Duplicate' } },
            { rowNumber: 4, data: { id: 'FEAT-DB', name: 'Feature already in DB' } },
          ],
        },
        { existingFeatureIds: ['FEAT-DB'] },
      );

      expect(report.valid).toBe(false);
      const dupIssues = report.errors.filter(
        (e) => e.code === VALIDATION_ERROR_CODES.DUPLICATE_FEATURE_ID,
      );
      expect(dupIssues).toHaveLength(2);

      // Trùng trong batch (dòng 3)
      expect(dupIssues.some((e) => e.row === 3 && e.value === 'FEAT-CORE')).toBe(true);
      // Trùng với existing (dòng 4)
      expect(dupIssues.some((e) => e.row === 4 && e.value === 'FEAT-DB')).toBe(true);
    });
  });

  describe('Nghiệm thu 4: Phát hiện dependency không tồn tại và từ chối dữ liệu sai', () => {
    it('Phát hiện dependency không tồn tại và báo lỗi tọa độ (Tasks, dòng X, dependencies)', () => {
      const report = validateRawWorkbook({
        tasks: [
          { rowNumber: 2, data: { id: 'TSK-100', title: 'Task 100' } },
          {
            rowNumber: 3,
            data: {
              id: 'TSK-200',
              title: 'Task 200',
              dependencies: 'TSK-100, TSK-GHOST-1, TSK-GHOST-2',
            },
          },
        ],
      });

      expect(report.valid).toBe(false);
      const missingDeps = report.errors.filter(
        (e) => e.code === VALIDATION_ERROR_CODES.NON_EXISTENT_DEPENDENCY && e.row === 3,
      );

      expect(missingDeps).toHaveLength(2);
      expect(missingDeps.map((m) => m.value)).toEqual(['TSK-GHOST-1', 'TSK-GHOST-2']);
      expect(missingDeps[0]?.column).toBe('dependencies');
      expect(missingDeps[0]?.message).toContain('không tồn tại');
    });

    it('assertValidWorkbook ném WorkbookValidationError và từ chối workbook có dependency không tồn tại', () => {
      const invalidWb: ParsedWorkbookResult = {
        tasks: [
          {
            id: 'TSK-A',
            feature_id: null,
            title: 'Task A',
            description: null,
            phase: 'GĐ 1',
            worker_type: 'agy',
            repository: '.',
            acceptance_criteria: [],
            test_commands: [],
            priority: 0,
            max_attempts: 3,
            timeout_minutes: 30,
            dependencies: ['NON-EXISTENT-PARENT'],
            status: 'TODO',
            rowNumber: 2,
            raw: { id: 'TSK-A', title: 'Task A', dependencies: 'NON-EXISTENT-PARENT' },
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

      expect(() => assertValidWorkbook(invalidWb)).toThrowError(WorkbookValidationError);
    });
  });

  describe('Nghiệm thu 5: Chấp nhận dữ liệu đúng khi dependency tồn tại trong workbook hoặc trong hệ thống', () => {
    it('Workbook hợp lệ khi các task phụ thuộc lẫn nhau nội bộ và phụ thuộc task đã có trong DB', () => {
      const report = validateRawWorkbook(
        {
          tasks: [
            { rowNumber: 2, data: { id: 'TSK-001', title: 'Task 1', dependencies: 'FND-001' } },
            { rowNumber: 3, data: { id: 'TSK-002', title: 'Task 2', dependencies: 'TSK-001' } },
            { rowNumber: 4, data: { id: 'TSK-003', title: 'Task 3', dependencies: 'TSK-001, TSK-002' } },
          ],
        },
        { existingTaskIds: ['FND-001'] },
      );

      expect(report.valid).toBe(true);
      expect(report.errorCount).toBe(0);
      expect(report.errors).toHaveLength(0);
    });
  });

  describe('Nghiệm thu 6: Phát hiện tham chiếu feature_id và required_tasks không tồn tại', () => {
    it('Phát hiện task tham chiếu feature_id không tồn tại', () => {
      const report = validateRawWorkbook({
        tasks: [
          { rowNumber: 2, data: { id: 'TSK-001', title: 'Task 1', feature_id: 'FEAT-GHOST' } },
        ],
        features: [{ rowNumber: 2, data: { id: 'FEAT-VALID', name: 'Valid Feature' } }],
      });

      expect(report.valid).toBe(false);
      const featError = report.errors.find((e) => e.code === VALIDATION_ERROR_CODES.MISSING_FEATURE);
      expect(featError).toBeDefined();
      expect(featError).toMatchObject({
        sheet: 'Tasks',
        row: 2,
        column: 'feature_id',
        value: 'FEAT-GHOST',
      });
    });

    it('Phát hiện feature yêu cầu required_tasks không tồn tại', () => {
      const report = validateRawWorkbook({
        tasks: [{ rowNumber: 2, data: { id: 'TSK-001', title: 'Task 1' } }],
        features: [
          {
            rowNumber: 2,
            data: { id: 'FEAT-001', name: 'Feature 1', required_tasks: 'TSK-001, TSK-GHOST' },
          },
        ],
      });

      expect(report.valid).toBe(false);
      const reqTaskError = report.errors.find(
        (e) => e.code === VALIDATION_ERROR_CODES.MISSING_REQUIRED_TASK,
      );
      expect(reqTaskError).toBeDefined();
      expect(reqTaskError).toMatchObject({
        sheet: 'Features',
        row: 2,
        column: 'required_tasks',
        value: 'TSK-GHOST',
      });
    });
  });

  describe('Nghiệm thu 7: TaskRepository từ chối tạo task trùng id hoặc dependency không tồn tại (Transaction rollback)', () => {
    it('TaskRepository.create từ chối tạo task trùng id với TASK_ALREADY_EXISTS', () => {
      const db = createDatabase(':memory:');
      runMigrations(db);
      const taskRepo = new TaskRepository(db);

      taskRepo.create({ id: 'TASK-FIRST', title: 'First Task' });

      expect(() =>
        taskRepo.create({ id: 'TASK-FIRST', title: 'Second Task with duplicate id' }),
      ).toThrowError(expect.objectContaining({ code: 'TASK_ALREADY_EXISTS' }));
    });

    it('TaskRepository.create từ chối tạo task có dependency không tồn tại với FOREIGN_KEY_VIOLATION', () => {
      const db = createDatabase(':memory:');
      runMigrations(db);
      const taskRepo = new TaskRepository(db);

      expect(() =>
        taskRepo.create({
          id: 'TASK-ORPHAN',
          title: 'Orphan Task',
          dependencies: ['NON-EXISTENT-DEP'],
        }),
      ).toThrowError(expect.objectContaining({ code: 'FOREIGN_KEY_VIOLATION' }));

      expect(taskRepo.exists('TASK-ORPHAN')).toBe(false);
    });

    it('TaskRepository.addDependency từ chối thêm dependency đến task không tồn tại', () => {
      const db = createDatabase(':memory:');
      runMigrations(db);
      const taskRepo = new TaskRepository(db);

      taskRepo.create({ id: 'TASK-A', title: 'Task A' });

      expect(() => taskRepo.addDependency('TASK-A', 'TASK-NON-EXISTENT')).toThrowError(
        expect.objectContaining({ code: 'FOREIGN_KEY_VIOLATION' }),
      );
    });

    it('TaskRepository.createMany rollback toàn bộ khi batch chứa task_id trùng lặp nội bộ', () => {
      const db = createDatabase(':memory:');
      runMigrations(db);
      const taskRepo = new TaskRepository(db);

      expect(() =>
        taskRepo.createMany([
          { id: 'T-BATCH-1', title: 'Task 1' },
          { id: 'T-BATCH-1', title: 'Task 1 Duplicate' },
        ]),
      ).toThrowError(expect.objectContaining({ code: 'DUPLICATE_TASK_ID' }));

      // Đảm bảo không có task nào được lưu vào DB (atomic rollback)
      expect(taskRepo.exists('T-BATCH-1')).toBe(false);
      expect(taskRepo.count()).toBe(0);
    });

    it('TaskRepository.createMany rollback toàn bộ khi có task trùng lặp với DB', () => {
      const db = createDatabase(':memory:');
      runMigrations(db);
      const taskRepo = new TaskRepository(db);

      taskRepo.create({ id: 'ALREADY-IN-DB', title: 'Existing Task' });

      expect(() =>
        taskRepo.createMany([
          { id: 'NEW-TASK-X', title: 'New task X' },
          { id: 'ALREADY-IN-DB', title: 'Collision' },
        ]),
      ).toThrowError(expect.objectContaining({ code: 'TASK_ALREADY_EXISTS' }));

      // NEW-TASK-X không được thêm vào DB
      expect(taskRepo.exists('NEW-TASK-X')).toBe(false);
      expect(taskRepo.count()).toBe(1);
    });

    it('TaskRepository.createMany rollback toàn bộ khi có dependency không tồn tại', () => {
      const db = createDatabase(':memory:');
      runMigrations(db);
      const taskRepo = new TaskRepository(db);

      expect(() =>
        taskRepo.createMany([
          { id: 'TASK-ONE', title: 'Task 1' },
          { id: 'TASK-TWO', title: 'Task 2', dependencies: ['MISSING-PARENT-TASK'] },
        ]),
      ).toThrowError(expect.objectContaining({ code: 'FOREIGN_KEY_VIOLATION' }));

      // Không có task nào được tạo
      expect(taskRepo.exists('TASK-ONE')).toBe(false);
      expect(taskRepo.exists('TASK-TWO')).toBe(false);
      expect(taskRepo.count()).toBe(0);
    });

    it('TaskRepository.createMany tạo thành công batch khi các task phụ thuộc nội bộ lẫn nhau', () => {
      const db = createDatabase(':memory:');
      runMigrations(db);
      const taskRepo = new TaskRepository(db);

      const created = taskRepo.createMany([
        { id: 'TASK-STEP-1', title: 'Step 1' },
        { id: 'TASK-STEP-2', title: 'Step 2', dependencies: ['TASK-STEP-1'] },
        { id: 'TASK-STEP-3', title: 'Step 3', dependencies: ['TASK-STEP-1', 'TASK-STEP-2'] },
      ]);

      expect(created).toHaveLength(3);
      expect(taskRepo.count()).toBe(3);
      expect(taskRepo.getDependencies('TASK-STEP-3')).toEqual(['TASK-STEP-1', 'TASK-STEP-2']);
    });
  });
});
