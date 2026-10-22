import path from 'node:path';
import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import ExcelJSModule from 'exceljs';
import {
  parseExcelWorkbook,
  parseCsvFiles,
  parseCsvDirectory,
  parseImportFile,
  mapTaskRow,
  mapFeatureRow,
  mapConfigRows,
  extractCellValue,
  parseIdList,
  parseMultilineList,
  createSampleCsvFiles,
} from '../parser/index.js';
import { AppError } from '../errors.js';

const ExcelJS = (ExcelJSModule as unknown as { default?: typeof ExcelJSModule }).default ?? ExcelJSModule;

describe('Parser Utilities & Mappers', () => {
  it('extractCellValue extracts richText, formula, hyperlink, and dates correctly', () => {
    expect(extractCellValue(null)).toBeNull();
    expect(extractCellValue('simple')).toBe('simple');
    expect(extractCellValue(123)).toBe(123);

    // Rich text
    const rich = { richText: [{ text: 'Hello ' }, { text: 'World' }] };
    expect(extractCellValue(rich)).toBe('Hello World');

    // Formula with result
    const formulaWithResult = { formula: 'A1+B1', result: 42 };
    expect(extractCellValue(formulaWithResult)).toBe(42);

    // Hyperlink
    const link = { text: 'Click Here', hyperlink: 'https://example.com' };
    expect(extractCellValue(link)).toBe('Click Here');

    // Date
    const now = new Date('2026-10-23T00:00:00Z');
    expect(extractCellValue(now)).toBe('2026-10-23T00:00:00.000Z');

    // Error
    expect(extractCellValue({ error: '#VALUE!' })).toBeNull();
  });

  it('parseIdList handles various delimiters and bullet points', () => {
    expect(parseIdList(null)).toEqual([]);
    expect(parseIdList('')).toEqual([]);
    expect(parseIdList(['A', 'B'])).toEqual(['A', 'B']);
    expect(parseIdList('TSK-001, TSK-002; TSK-003\nTSK-004')).toEqual([
      'TSK-001',
      'TSK-002',
      'TSK-003',
      'TSK-004',
    ]);
    expect(parseIdList('- TSK-001\n* TSK-002\n• TSK-003')).toEqual(['TSK-001', 'TSK-002', 'TSK-003']);
  });

  it('parseMultilineList splits multiline items without breaking commas inside commands', () => {
    expect(parseMultilineList(null)).toEqual([]);
    expect(parseMultilineList('pnpm lint\npnpm test; pnpm build')).toEqual([
      'pnpm lint',
      'pnpm test',
      'pnpm build',
    ]);
    expect(parseMultilineList('- Criteria 1: a, b, c\n- Criteria 2')).toEqual([
      'Criteria 1: a, b, c',
      'Criteria 2',
    ]);
  });

  it('mapTaskRow normalizes aliases and defaults', () => {
    const raw = {
      'Mã task': 'TSK-100',
      'Tiêu đề': 'Viết unit test',
      'Mô tả': 'Chi tiết task',
      'Nghiệm thu': 'Test pass 100%',
      'Lệnh test': 'pnpm test',
      'Phụ thuộc': 'TSK-001, TSK-002',
      'Độ ưu tiên': '5',
      'Số lần thử': '4',
      'Thời gian chờ': '45',
      'Trạng thái': 'READY',
    };

    const task = mapTaskRow(raw, 2);
    expect(task.id).toBe('TSK-100');
    expect(task.title).toBe('Viết unit test');
    expect(task.description).toBe('Chi tiết task');
    expect(task.acceptance_criteria).toEqual(['Test pass 100%']);
    expect(task.test_commands).toEqual(['pnpm test']);
    expect(task.dependencies).toEqual(['TSK-001', 'TSK-002']);
    expect(task.priority).toBe(5);
    expect(task.max_attempts).toBe(4);
    expect(task.timeout_minutes).toBe(45);
    expect(task.status).toBe('READY');
    expect(task.rowNumber).toBe(2);
  });

  it('mapFeatureRow normalizes aliases and defaults', () => {
    const raw = {
      'Mã feature': 'FEAT-009',
      'Tên': 'Feature Core',
      'Mô tả': 'Mô tả feature',
      'Danh sách task': 'TSK-1, TSK-2',
      'Lệnh test': 'pnpm test',
      'Chính sách release': 'strict',
      'Trạng thái': 'IN_PROGRESS',
    };

    const feat = mapFeatureRow(raw, 3);
    expect(feat.id).toBe('FEAT-009');
    expect(feat.name).toBe('Feature Core');
    expect(feat.description).toBe('Mô tả feature');
    expect(feat.required_tasks).toEqual(['TSK-1', 'TSK-2']);
    expect(feat.integration_tests).toEqual(['pnpm test']);
    expect(feat.release_policy).toBe('strict');
    expect(feat.status).toBe('IN_PROGRESS');
    expect(feat.rowNumber).toBe(3);
  });

  it('mapConfigRows handles horizontal column-based format', () => {
    const rows = [
      {
        rowNumber: 2,
        data: {
          repository: '/path/to/repo',
          agy_bin: '/custom/bin/agy',
          agy_args: '-p --debug',
          verify_commands: 'pnpm lint\npnpm test',
          max_attempts: '5',
          timeout_minutes: '60',
          max_concurrency: '2',
          custom_flag: 'true',
        },
      },
    ];

    const config = mapConfigRows(rows);
    expect(config.repository).toBe('/path/to/repo');
    expect(config.agy_bin).toBe('/custom/bin/agy');
    expect(config.agy_args).toBe('-p --debug');
    expect(config.verify_commands).toEqual(['pnpm lint', 'pnpm test']);
    expect(config.max_attempts).toBe(5);
    expect(config.timeout_minutes).toBe(60);
    expect(config.max_concurrency).toBe(2);
    expect(config.settings['custom_flag']).toBe('true');
  });
});

describe('Excel Workbook Parsing (parseExcelWorkbook)', () => {
  const sampleExcelPath = path.resolve('fixtures/sample-tasks.xlsx');

  it('parses sample Excel file successfully with all 3 sheets', async () => {
    const result = await parseExcelWorkbook(sampleExcelPath);

    expect(result.sourceType).toBe('excel');
    expect(result.tasks.length).toBe(2);
    expect(result.features.length).toBe(1);

    // Verify task 1
    const t1 = result.tasks[0]!;
    expect(t1.id).toBe('TSK-001');
    expect(t1.feature_id).toBe('FEAT-001');
    expect(t1.title).toBe('Schema + model Task/Feature/Dependency');
    expect(t1.acceptance_criteria).toEqual([
      'Migration + test CRUD',
      'Pass all repository unit tests',
    ]);
    expect(t1.test_commands).toEqual(['pnpm test']);
    expect(t1.dependencies).toEqual(['FND-003']);
    expect(t1.priority).toBe(10);
    expect(t1.status).toBe('DONE');

    // Verify task 2
    const t2 = result.tasks[1]!;
    expect(t2.id).toBe('TSK-002');
    expect(t2.feature_id).toBe('FEAT-001');
    expect(t2.dependencies).toEqual(['TSK-001']);
    expect(t2.status).toBe('TODO');

    // Verify feature
    const f1 = result.features[0]!;
    expect(f1.id).toBe('FEAT-001');
    expect(f1.name).toBe('Task Management Engine');
    expect(f1.required_tasks).toEqual(['TSK-001', 'TSK-002']);
    expect(f1.status).toBe('IN_PROGRESS');

    // Verify config
    expect(result.config.repository).toBe('.');
    expect(result.config.agy_bin).toBe('agy');
    expect(result.config.agy_args).toBe('-p');
    expect(result.config.verify_commands).toEqual(['pnpm lint', 'pnpm typecheck', 'pnpm test']);
    expect(result.config.max_attempts).toBe(3);
    expect(result.config.timeout_minutes).toBe(30);
    expect(result.config.max_concurrency).toBe(1);
  });

  it('parses Excel from in-memory Buffer', async () => {
    const buffer = fs.readFileSync(sampleExcelPath);
    const result = await parseExcelWorkbook(buffer);

    expect(result.sourceType).toBe('excel');
    expect(result.tasks.length).toBe(2);
    expect(result.features.length).toBe(1);
    expect(result.config.agy_bin).toBe('agy');
  });

  it('throws AppError(MISSING_SHEET) when Tasks sheet is missing', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('OtherSheet');
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer);

    await expect(parseExcelWorkbook(buf)).rejects.toThrow(AppError);
    await expect(parseExcelWorkbook(buf)).rejects.toMatchObject({
      code: 'MISSING_SHEET',
    });
  });

  it('throws AppError(FILE_NOT_FOUND) when file does not exist', async () => {
    await expect(parseExcelWorkbook('/non/existent/path.xlsx')).rejects.toThrow(AppError);
    await expect(parseExcelWorkbook('/non/existent/path.xlsx')).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
    });
  });

  it('throws AppError(EMPTY_FILE) on empty buffer', async () => {
    await expect(parseExcelWorkbook(Buffer.alloc(0))).rejects.toMatchObject({
      code: 'EMPTY_FILE',
    });
  });

  it('throws AppError(INVALID_FILE_FORMAT) on corrupted buffer', async () => {
    await expect(parseExcelWorkbook(Buffer.from('not an excel file content'))).rejects.toMatchObject({
      code: 'INVALID_FILE_FORMAT',
    });
  });
});

describe('CSV Parsing (parseCsvFiles & parseCsvDirectory)', () => {
  const sampleCsvDir = path.resolve('fixtures/sample-csv');

  it('parses CSV directory with tasks.csv, features.csv, and config.csv', async () => {
    const result = await parseCsvDirectory(sampleCsvDir);

    expect(result.sourceType).toBe('csv');
    expect(result.tasks.length).toBe(2);
    expect(result.features.length).toBe(1);

    const t1 = result.tasks[0]!;
    expect(t1.id).toBe('TSK-001');
    expect(t1.feature_id).toBe('FEAT-001');
    expect(t1.title).toBe('Schema + model Task/Feature/Dependency');
    expect(t1.acceptance_criteria).toEqual([
      'Migration + test CRUD',
      'Pass all repository unit tests',
    ]);
    expect(t1.dependencies).toEqual(['FND-003']);
    expect(t1.status).toBe('DONE');

    const f1 = result.features[0]!;
    expect(f1.id).toBe('FEAT-001');
    expect(f1.name).toBe('Task Management Engine');
    expect(f1.required_tasks).toEqual(['TSK-001', 'TSK-002']);

    expect(result.config.agy_bin).toBe('agy');
    expect(result.config.verify_commands).toEqual(['pnpm lint', 'pnpm typecheck', 'pnpm test']);
  });

  it('parses CSV from record map', () => {
    const sample = createSampleCsvFiles();
    const result = parseCsvFiles({
      'tasks.csv': sample.tasks,
      'features.csv': sample.features,
      'config.csv': sample.config,
    });

    expect(result.tasks.length).toBe(2);
    expect(result.features.length).toBe(1);
    expect(result.config.agy_bin).toBe('agy');
  });

  it('throws AppError(MISSING_SHEET) when tasks.csv is missing', () => {
    expect(() => parseCsvFiles({ 'features.csv': 'id,name\nFEAT-1,Test' })).toThrow(AppError);
    expect(() => parseCsvFiles({ 'features.csv': 'id,name\nFEAT-1,Test' })).toThrowError(/missing required "Tasks" sheet/i);
  });

  it('throws AppError(DIRECTORY_NOT_FOUND) when directory does not exist', async () => {
    await expect(parseCsvDirectory('/non/existent/dir')).rejects.toMatchObject({
      code: 'DIRECTORY_NOT_FOUND',
    });
  });
});

describe('Unified parseImportFile', () => {
  it('parses .xlsx file path', async () => {
    const result = await parseImportFile('fixtures/sample-tasks.xlsx');
    expect(result.sourceType).toBe('excel');
    expect(result.tasks.length).toBe(2);
  });

  it('parses CSV directory path', async () => {
    const result = await parseImportFile('fixtures/sample-csv');
    expect(result.sourceType).toBe('csv');
    expect(result.tasks.length).toBe(2);
  });

  it('parses single CSV file path', async () => {
    const result = await parseImportFile('fixtures/sample-csv/tasks.csv');
    expect(result.sourceType).toBe('csv');
    expect(result.tasks.length).toBe(2);
  });

  it('parses Record<string, string> input', async () => {
    const sample = createSampleCsvFiles();
    const result = await parseImportFile(sample);
    expect(result.sourceType).toBe('csv');
    expect(result.tasks.length).toBe(2);
  });

  it('parses Buffer input with .xlsx hint', async () => {
    const buf = fs.readFileSync('fixtures/sample-tasks.xlsx');
    const result = await parseImportFile(buf, { filename: 'custom-tasks.xlsx' });
    expect(result.sourceType).toBe('excel');
    expect(result.tasks.length).toBe(2);
  });

  it('parses Buffer input with .csv hint', async () => {
    const buf = fs.readFileSync('fixtures/sample-csv/tasks.csv');
    const result = await parseImportFile(buf, { filename: 'tasks.csv' });
    expect(result.sourceType).toBe('csv');
    expect(result.tasks.length).toBe(2);
  });

  it('throws AppError(UNSUPPORTED_FILE_TYPE) for unknown extensions', async () => {
    await expect(parseImportFile('package.json')).rejects.toMatchObject({
      code: 'UNSUPPORTED_FILE_TYPE',
    });
  });
});
