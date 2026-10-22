import fs from 'node:fs';
import path from 'node:path';
import PapaModule from 'papaparse';
import { AppError } from '../errors.js';
import {
  type ParsedWorkbookResult,
  type ParsedTaskRow,
  type ParsedFeatureRow,
  type ParsedConfig,
} from './types.js';
import { mapTaskRow, mapFeatureRow, mapConfigRows } from './mappers.js';

// Support both ESM and CJS import variations of PapaParse
const Papa = (PapaModule as unknown as { default?: typeof PapaModule }).default ?? PapaModule;

export function parseRawCsv(content: string): Array<{ rowNumber: number; data: Record<string, unknown> }> {
  if (!content || !content.trim()) {
    return [];
  }

  const result = Papa.parse<Record<string, unknown>>(content, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  });

  if (result.errors && result.errors.length > 0) {
    const fatalErrors = result.errors.filter((e) => e.type === 'Quotes' || e.type === 'FieldMismatch');
    if (fatalErrors.length > 0) {
      const firstErr = fatalErrors[0];
      const message = firstErr?.message ?? 'Unknown CSV parse error';
      throw new AppError('INVALID_CSV_FORMAT', `CSV parsing error: ${message}`, {
        errors: result.errors,
      });
    }
  }

  return result.data.map((row, index) => ({
    rowNumber: index + 2, // 1-based index with header at row 1
    data: row,
  }));
}

export function parseCsvSheet(
  content: string,
  sheetType: 'Tasks' | 'Features' | 'Config',
): {
  tasks?: ParsedTaskRow[];
  features?: ParsedFeatureRow[];
  config?: ParsedConfig;
  rawRows: Array<{ rowNumber: number; data: Record<string, unknown> }>;
} {
  const rawRows = parseRawCsv(content);

  switch (sheetType) {
    case 'Tasks':
      return {
        tasks: rawRows.map((r) => mapTaskRow(r.data, r.rowNumber)),
        rawRows,
      };
    case 'Features':
      return {
        features: rawRows.map((r) => mapFeatureRow(r.data, r.rowNumber)),
        rawRows,
      };
    case 'Config':
      return {
        config: mapConfigRows(rawRows),
        rawRows,
      };
  }
}

export function parseCsvFiles(files: Record<string, string>): ParsedWorkbookResult {
  const findContent = (target: string): string | undefined => {
    const lower = target.toLowerCase();
    for (const [key, content] of Object.entries(files)) {
      const base = path.basename(key, path.extname(key)).toLowerCase();
      if (base === lower || key.toLowerCase() === lower) {
        return content;
      }
    }
    return undefined;
  };

  const tasksContent = findContent('tasks');
  const featuresContent = findContent('features');
  const configContent = findContent('config');

  if (tasksContent === undefined) {
    throw new AppError('MISSING_SHEET', 'CSV dataset is missing required "Tasks" sheet (e.g. tasks.csv)', {
      requiredSheet: 'Tasks',
      providedKeys: Object.keys(files),
    });
  }

  const tasks = parseCsvSheet(tasksContent, 'Tasks').tasks ?? [];
  const features = featuresContent !== undefined ? parseCsvSheet(featuresContent, 'Features').features ?? [] : [];
  const config = configContent !== undefined ? parseCsvSheet(configContent, 'Config').config ?? mapConfigRows([]) : mapConfigRows([]);

  return {
    tasks,
    features,
    config,
    sourceType: 'csv',
  };
}

export async function parseCsvDirectory(dirPath: string): Promise<ParsedWorkbookResult> {
  if (!fs.existsSync(dirPath)) {
    throw new AppError('DIRECTORY_NOT_FOUND', `Directory not found at path: ${dirPath}`, { path: dirPath });
  }

  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    throw new AppError('NOT_A_DIRECTORY', `Path is not a directory: ${dirPath}`, { path: dirPath });
  }

  const files = fs.readdirSync(dirPath);
  const csvFiles: Record<string, string> = {};

  for (const file of files) {
    if (file.toLowerCase().endsWith('.csv')) {
      const fullPath = path.join(dirPath, file);
      const content = fs.readFileSync(fullPath, 'utf8');
      csvFiles[file] = content;
    }
  }

  return parseCsvFiles(csvFiles);
}

export function createSampleCsvFiles(): { tasks: string; features: string; config: string } {
  const tasks = `id,feature_id,title,description,phase,worker_type,repository,acceptance_criteria,test_commands,priority,max_attempts,timeout_minutes,dependencies,status
TSK-001,FEAT-001,Schema + model Task/Feature/Dependency,Xây dựng schema Zod và repository class CRUD với SQLite,GĐ 1,agy,.,Migration + test CRUD;Pass all repository unit tests,pnpm test,10,3,30,FND-003,DONE
TSK-002,FEAT-001,Parser Excel/CSV theo 3 sheet,Parser ExcelJS/PapaParse theo 3 sheet Tasks Features Config,GĐ 1,agy,.,Đọc đúng file mẫu;Pass all test cases,pnpm test,9,3,30,TSK-001,TODO
`;

  const features = `id,name,description,required_tasks,integration_tests,release_policy,status
FEAT-001,Task Management Engine,Quản lý task schema và parser dữ liệu Excel/CSV,"TSK-001, TSK-002",pnpm test,require_all_done,IN_PROGRESS
`;

  const config = `key,value
repository,.
agy_bin,agy
agy_args,-p
verify_commands,pnpm lint;pnpm typecheck;pnpm test
max_attempts,3
timeout_minutes,30
max_concurrency,1
`;

  return { tasks, features, config };
}
