import fs from 'node:fs';
import ExcelJSModule from 'exceljs';
import { AppError } from '../errors.js';
import {
  extractCellValue,
  type ParsedWorkbookResult,
  type ParsedTaskRow,
  type ParsedFeatureRow,
  type ParsedConfig,
} from './types.js';
import { mapTaskRow, mapFeatureRow, mapConfigRows } from './mappers.js';

// Support both ESM and CJS import variations of ExcelJS
const ExcelJS = (ExcelJSModule as unknown as { default?: typeof ExcelJSModule }).default ?? ExcelJSModule;

export async function parseExcelWorkbook(source: string | Buffer): Promise<ParsedWorkbookResult> {
  const workbook = new ExcelJS.Workbook();

  if (typeof source === 'string') {
    if (!fs.existsSync(source)) {
      throw new AppError('FILE_NOT_FOUND', `Excel file not found at path: ${source}`, { path: source });
    }
    try {
      await workbook.xlsx.readFile(source);
    } catch (err) {
      throw new AppError('INVALID_FILE_FORMAT', `Failed to read Excel file: ${err instanceof Error ? err.message : String(err)}`, {
        path: source,
        error: String(err),
      });
    }
  } else if (Buffer.isBuffer(source)) {
    if (source.length === 0) {
      throw new AppError('EMPTY_FILE', 'Excel buffer is empty');
    }
    try {
      await workbook.xlsx.load(source as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    } catch (err) {
      throw new AppError('INVALID_FILE_FORMAT', `Failed to parse Excel buffer: ${err instanceof Error ? err.message : String(err)}`, {
        error: String(err),
      });
    }
  } else {
    throw new AppError('INVALID_INPUT', 'Input must be a file path string or Buffer');
  }

  const findSheet = (name: string): ExcelJSModule.Worksheet | undefined => {
    const target = name.trim().toLowerCase();
    return workbook.worksheets.find((ws) => ws.name.trim().toLowerCase() === target);
  };

  const tasksSheet = findSheet('tasks');
  const featuresSheet = findSheet('features');
  const configSheet = findSheet('config');

  if (!tasksSheet) {
    const available = workbook.worksheets.map((w) => w.name);
    throw new AppError('MISSING_SHEET', `Workbook is missing required "Tasks" sheet. Available sheets: [${available.join(', ')}]`, {
      requiredSheet: 'Tasks',
      availableSheets: available,
    });
  }

  function readSheetRows(worksheet: ExcelJSModule.Worksheet): Array<{ rowNumber: number; data: Record<string, unknown> }> {
    const headers: Record<number, string> = {};
    const rows: Array<{ rowNumber: number; data: Record<string, unknown> }> = [];

    let headerRowNumber = 1;
    // Find the first row that has cells as header
    for (let r = 1; r <= worksheet.rowCount; r++) {
      const row = worksheet.getRow(r);
      let hasCell = false;
      row.eachCell((cell, colNumber) => {
        const val = extractCellValue(cell.value);
        if (val !== null && val !== undefined && String(val).trim() !== '') {
          headers[colNumber] = String(val).trim();
          hasCell = true;
        }
      });
      if (hasCell) {
        headerRowNumber = r;
        break;
      }
    }

    if (Object.keys(headers).length === 0) {
      return [];
    }

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber <= headerRowNumber) return;

      const rowData: Record<string, unknown> = {};
      let hasData = false;

      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const header = headers[colNumber];
        if (header) {
          const val = extractCellValue(cell.value);
          if (val !== null && val !== undefined && val !== '') {
            hasData = true;
          }
          rowData[header] = val;
        }
      });

      if (hasData) {
        rows.push({ rowNumber, data: rowData });
      }
    });

    return rows;
  }

  // Parse Tasks
  const taskRawRows = readSheetRows(tasksSheet);
  const tasks: ParsedTaskRow[] = taskRawRows.map((r) => mapTaskRow(r.data, r.rowNumber));

  // Parse Features
  const featuresRawRows = featuresSheet ? readSheetRows(featuresSheet) : [];
  const features: ParsedFeatureRow[] = featuresRawRows.map((r) => mapFeatureRow(r.data, r.rowNumber));

  // Parse Config
  const configRawRows = configSheet ? readSheetRows(configSheet) : [];
  const config: ParsedConfig = mapConfigRows(configRawRows);

  return {
    tasks,
    features,
    config,
    sourceType: 'excel',
  };
}

export async function createSampleExcelWorkbook(filePath?: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'AI Coding Orchestrator';
  workbook.created = new Date();

  // 1. Tasks Sheet
  const tasksSheet = workbook.addWorksheet('Tasks');
  tasksSheet.columns = [
    { header: 'id', key: 'id', width: 14 },
    { header: 'feature_id', key: 'feature_id', width: 14 },
    { header: 'title', key: 'title', width: 30 },
    { header: 'description', key: 'description', width: 40 },
    { header: 'phase', key: 'phase', width: 16 },
    { header: 'worker_type', key: 'worker_type', width: 14 },
    { header: 'repository', key: 'repository', width: 16 },
    { header: 'acceptance_criteria', key: 'acceptance_criteria', width: 35 },
    { header: 'test_commands', key: 'test_commands', width: 25 },
    { header: 'priority', key: 'priority', width: 10 },
    { header: 'max_attempts', key: 'max_attempts', width: 14 },
    { header: 'timeout_minutes', key: 'timeout_minutes', width: 16 },
    { header: 'dependencies', key: 'dependencies', width: 20 },
    { header: 'status', key: 'status', width: 12 },
  ];

  tasksSheet.addRow({
    id: 'TSK-001',
    feature_id: 'FEAT-001',
    title: 'Schema + model Task/Feature/Dependency',
    description: 'Xây dựng schema Zod và repository class CRUD với SQLite',
    phase: 'GĐ 1',
    worker_type: 'agy',
    repository: '.',
    acceptance_criteria: 'Migration + test CRUD\nPass all repository unit tests',
    test_commands: 'pnpm test',
    priority: 10,
    max_attempts: 3,
    timeout_minutes: 30,
    dependencies: 'FND-003',
    status: 'DONE',
  });

  tasksSheet.addRow({
    id: 'TSK-002',
    feature_id: 'FEAT-001',
    title: 'Parser Excel/CSV theo 3 sheet',
    description: 'Parser ExcelJS/PapaParse theo 3 sheet Tasks, Features, Config',
    phase: 'GĐ 1',
    worker_type: 'agy',
    repository: '.',
    acceptance_criteria: 'Đọc đúng file mẫu\nPass all test cases',
    test_commands: 'pnpm test',
    priority: 9,
    max_attempts: 3,
    timeout_minutes: 30,
    dependencies: 'TSK-001',
    status: 'TODO',
  });

  // 2. Features Sheet
  const featuresSheet = workbook.addWorksheet('Features');
  featuresSheet.columns = [
    { header: 'id', key: 'id', width: 14 },
    { header: 'name', key: 'name', width: 30 },
    { header: 'description', key: 'description', width: 40 },
    { header: 'required_tasks', key: 'required_tasks', width: 25 },
    { header: 'integration_tests', key: 'integration_tests', width: 25 },
    { header: 'release_policy', key: 'release_policy', width: 20 },
    { header: 'status', key: 'status', width: 12 },
  ];

  featuresSheet.addRow({
    id: 'FEAT-001',
    name: 'Task Management Engine',
    description: 'Quản lý task, schema và parser dữ liệu Excel/CSV',
    required_tasks: 'TSK-001, TSK-002',
    integration_tests: 'pnpm test',
    release_policy: 'require_all_done',
    status: 'IN_PROGRESS',
  });

  // 3. Config Sheet (Key-Value format)
  const configSheet = workbook.addWorksheet('Config');
  configSheet.columns = [
    { header: 'key', key: 'key', width: 25 },
    { header: 'value', key: 'value', width: 40 },
  ];

  configSheet.addRow({ key: 'repository', value: '.' });
  configSheet.addRow({ key: 'agy_bin', value: 'agy' });
  configSheet.addRow({ key: 'agy_args', value: '-p' });
  configSheet.addRow({ key: 'verify_commands', value: 'pnpm lint\npnpm typecheck\npnpm test' });
  configSheet.addRow({ key: 'max_attempts', value: 3 });
  configSheet.addRow({ key: 'timeout_minutes', value: 30 });
  configSheet.addRow({ key: 'max_concurrency', value: 1 });

  const writeResult = await workbook.xlsx.writeBuffer();
  const buffer = Buffer.from(writeResult as unknown as ArrayBuffer);

  if (filePath) {
    fs.writeFileSync(filePath, buffer);
  }

  return buffer;
}
