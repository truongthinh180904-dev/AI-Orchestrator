import path from 'node:path';
import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  parseExcelWorkbook,
  parseCsvDirectory,
  parseImportFile,
  createSampleCsvFiles,
} from '../packages/shared/src/index.js';

describe('Acceptance TSK-002: Parser Excel/CSV (exceljs/papaparse) theo 3 sheet: Tasks, Features, Config', () => {
  const sampleExcelPath = path.resolve('fixtures/sample-tasks.xlsx');
  const sampleCsvDir = path.resolve('fixtures/sample-csv');

  it('Nghiệm thu 1: Đọc đúng file mẫu Excel (.xlsx) gồm 3 sheet Tasks, Features, Config', async () => {
    expect(fs.existsSync(sampleExcelPath)).toBe(true);

    const result = await parseExcelWorkbook(sampleExcelPath);

    expect(result.sourceType).toBe('excel');

    // 1. Kiểm tra sheet Tasks
    expect(result.tasks).toHaveLength(2);

    const task1 = result.tasks.find((t) => t.id === 'TSK-001');
    expect(task1).toBeDefined();
    expect(task1?.feature_id).toBe('FEAT-001');
    expect(task1?.title).toBe('Schema + model Task/Feature/Dependency');
    expect(task1?.description).toBe('Xây dựng schema Zod và repository class CRUD với SQLite');
    expect(task1?.phase).toBe('GĐ 1');
    expect(task1?.worker_type).toBe('agy');
    expect(task1?.repository).toBe('.');
    expect(task1?.acceptance_criteria).toEqual([
      'Migration + test CRUD',
      'Pass all repository unit tests',
    ]);
    expect(task1?.test_commands).toEqual(['pnpm test']);
    expect(task1?.priority).toBe(10);
    expect(task1?.max_attempts).toBe(3);
    expect(task1?.timeout_minutes).toBe(30);
    expect(task1?.dependencies).toEqual(['FND-003']);
    expect(task1?.status).toBe('DONE');

    const task2 = result.tasks.find((t) => t.id === 'TSK-002');
    expect(task2).toBeDefined();
    expect(task2?.feature_id).toBe('FEAT-001');
    expect(task2?.title).toBe('Parser Excel/CSV theo 3 sheet');
    expect(task2?.dependencies).toEqual(['TSK-001']);
    expect(task2?.status).toBe('TODO');

    // 2. Kiểm tra sheet Features
    expect(result.features).toHaveLength(1);
    const feature1 = result.features[0];
    expect(feature1?.id).toBe('FEAT-001');
    expect(feature1?.name).toBe('Task Management Engine');
    expect(feature1?.description).toBe('Quản lý task, schema và parser dữ liệu Excel/CSV');
    expect(feature1?.required_tasks).toEqual(['TSK-001', 'TSK-002']);
    expect(feature1?.integration_tests).toEqual(['pnpm test']);
    expect(feature1?.release_policy).toBe('require_all_done');
    expect(feature1?.status).toBe('IN_PROGRESS');

    // 3. Kiểm tra sheet Config
    expect(result.config.repository).toBe('.');
    expect(result.config.agy_bin).toBe('agy');
    expect(result.config.agy_args).toBe('-p');
    expect(result.config.verify_commands).toEqual(['pnpm lint', 'pnpm typecheck', 'pnpm test']);
    expect(result.config.max_attempts).toBe(3);
    expect(result.config.timeout_minutes).toBe(30);
    expect(result.config.max_concurrency).toBe(1);
  });

  it('Nghiệm thu 2: Đọc đúng file mẫu CSV qua thư mục chứa tasks.csv, features.csv, config.csv', async () => {
    expect(fs.existsSync(sampleCsvDir)).toBe(true);

    const result = await parseCsvDirectory(sampleCsvDir);

    expect(result.sourceType).toBe('csv');
    expect(result.tasks).toHaveLength(2);
    expect(result.features).toHaveLength(1);

    const task1 = result.tasks.find((t) => t.id === 'TSK-001');
    expect(task1?.title).toBe('Schema + model Task/Feature/Dependency');
    expect(task1?.dependencies).toEqual(['FND-003']);
    expect(task1?.status).toBe('DONE');

    const feature1 = result.features[0];
    expect(feature1?.id).toBe('FEAT-001');
    expect(feature1?.required_tasks).toEqual(['TSK-001', 'TSK-002']);

    expect(result.config.agy_bin).toBe('agy');
    expect(result.config.verify_commands).toEqual(['pnpm lint', 'pnpm typecheck', 'pnpm test']);
  });

  it('Nghiệm thu 3: Tự động nhận diện định dạng nguồn (Excel, CSV directory, Buffer, Object) qua parseImportFile', async () => {
    // 1. Đọc qua file path .xlsx
    const fromXlsx = await parseImportFile(sampleExcelPath);
    expect(fromXlsx.sourceType).toBe('excel');
    expect(fromXlsx.tasks).toHaveLength(2);

    // 2. Đọc qua thư mục CSV
    const fromDir = await parseImportFile(sampleCsvDir);
    expect(fromDir.sourceType).toBe('csv');
    expect(fromDir.tasks).toHaveLength(2);

    // 3. Đọc qua Buffer .xlsx
    const excelBuffer = fs.readFileSync(sampleExcelPath);
    const fromBuffer = await parseImportFile(excelBuffer, { filename: 'sample-tasks.xlsx' });
    expect(fromBuffer.sourceType).toBe('excel');
    expect(fromBuffer.tasks).toHaveLength(2);

    // 4. Đọc qua đối tượng file CSV mẫu
    const sampleCsvMap = createSampleCsvFiles();
    const fromMap = await parseImportFile(sampleCsvMap);
    expect(fromMap.sourceType).toBe('csv');
    expect(fromMap.tasks).toHaveLength(2);
    expect(fromMap.features).toHaveLength(1);
  });

  it('Nghiệm thu 4: Xử lý an toàn khi thiếu sheet bắt buộc hoặc dữ liệu sai định dạng', async () => {
    // Missing Tasks sheet
    await expect(parseImportFile({ 'features.csv': 'id,name\nFEAT-1,Test' })).rejects.toMatchObject({
      code: 'MISSING_SHEET',
    });

    // File not found
    await expect(parseImportFile('/non/existent/file.xlsx')).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
    });

    // Unsupported extension
    await expect(parseImportFile('tsconfig.json')).rejects.toMatchObject({
      code: 'UNSUPPORTED_FILE_TYPE',
    });
  });
});
