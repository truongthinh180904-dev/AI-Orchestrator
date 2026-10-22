import type { ValidationErrorItem, ValidationReport } from './types.js';

export function formatValidationError(item: ValidationErrorItem): string {
  const prefix = `[${item.sheet}: dòng ${item.row}, cột '${item.column}']`;
  const codeStr = `(${item.code})`;
  const valStr = item.value !== undefined ? ` [Giá trị: ${JSON.stringify(item.value)}]` : '';
  return `${prefix} ${item.message} ${codeStr}${valStr}`;
}

export function formatValidationReport(report: ValidationReport): string {
  const lines: string[] = [];

  if (report.valid) {
    lines.push('Dữ liệu hợp lệ: không tìm thấy lỗi nào.');
    if (report.warningCount > 0) {
      lines.push(`Cảnh báo (${report.warningCount}):`);
      for (const warn of report.warnings) {
        lines.push(`  - ${formatValidationError(warn)}`);
      }
    }
    return lines.join('\n');
  }

  lines.push(`Phát hiện ${report.errorCount} lỗi và ${report.warningCount} cảnh báo:`);

  if (report.errorCount > 0) {
    lines.push('Danh sách lỗi:');
    for (const err of report.errors) {
      lines.push(`  - ${formatValidationError(err)}`);
    }
  }

  if (report.warningCount > 0) {
    lines.push('Danh sách cảnh báo:');
    for (const warn of report.warnings) {
      lines.push(`  - ${formatValidationError(warn)}`);
    }
  }

  return lines.join('\n');
}
