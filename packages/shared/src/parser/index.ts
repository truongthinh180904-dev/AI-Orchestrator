import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../errors.js';
import { type ParsedWorkbookResult } from './types.js';
import { parseExcelWorkbook } from './excel.js';
import { parseCsvFiles, parseCsvDirectory } from './csv.js';
import { validateWorkbook, WorkbookValidationError } from '../validator/workbookValidator.js';
import type { ValidationOptions, ValidationReport } from '../validator/types.js';

export * from './types.js';
export * from './mappers.js';
export * from './excel.js';
export * from './csv.js';

export async function parseAndValidateWorkbook(
  input: string | Buffer | Record<string, string>,
  options: { filename?: string; validationOptions?: ValidationOptions; assertValid?: boolean } = {},
): Promise<{ parsed: ParsedWorkbookResult; report: ValidationReport }> {
  const parsed = await parseImportFile(input, { filename: options.filename });
  const report = validateWorkbook(parsed, options.validationOptions);
  if (options.assertValid && !report.valid) {
    throw new WorkbookValidationError(report);
  }
  return { parsed, report };
}

export async function parseImportFile(
  input: string | Buffer | Record<string, string>,
  options: { filename?: string } = {},
): Promise<ParsedWorkbookResult> {
  // 1. Record of CSV files
  if (typeof input === 'object' && !Buffer.isBuffer(input)) {
    return parseCsvFiles(input);
  }

  // 2. File path or directory
  if (typeof input === 'string') {
    if (!fs.existsSync(input)) {
      throw new AppError('FILE_NOT_FOUND', `Import path not found: ${input}`, { path: input });
    }

    const stat = fs.statSync(input);
    if (stat.isDirectory()) {
      return parseCsvDirectory(input);
    }

    const ext = path.extname(input).toLowerCase();
    if (ext === '.xlsx' || ext === '.xls') {
      return parseExcelWorkbook(input);
    }

    if (ext === '.csv') {
      // Single CSV file, assumed to be Tasks sheet unless filename indicates otherwise
      const content = fs.readFileSync(input, 'utf8');
      const base = path.basename(input, ext).toLowerCase();
      if (base === 'features') {
        throw new AppError('MISSING_SHEET', 'Importing only features.csv is not sufficient. Tasks sheet is required.', {
          requiredSheet: 'Tasks',
        });
      }
      return parseCsvFiles({ tasks: content });
    }

    throw new AppError('UNSUPPORTED_FILE_TYPE', `Unsupported file extension: ${ext}. Expected .xlsx, .xls, or .csv`, {
      path: input,
      extension: ext,
    });
  }

  // 3. Buffer
  if (Buffer.isBuffer(input)) {
    const filename = options.filename?.toLowerCase() ?? '';
    if (filename.endsWith('.csv')) {
      return parseCsvFiles({ tasks: input.toString('utf8') });
    }

    // Default to Excel parser for buffers
    try {
      return await parseExcelWorkbook(input);
    } catch (err) {
      // If excel parsing fails and no explicit filename, try parsing buffer as CSV UTF-8
      if (!filename.endsWith('.xlsx') && !filename.endsWith('.xls')) {
        try {
          const str = input.toString('utf8');
          return parseCsvFiles({ tasks: str });
        } catch {
          // Throw original Excel parsing error
        }
      }
      throw err;
    }
  }

  throw new AppError('INVALID_INPUT', 'Input must be a string path, Buffer, or Record<string, string>');
}
