import type { ValidationReport } from '../validator/types.js';
import type { TaskWithDependencies } from './task.js';
import type { Feature } from './feature.js';
import type { ParsedTaskRow, ParsedFeatureRow } from '../parser/types.js';

export interface ImportSummary {
  tasksCount: number;
  featuresCount: number;
  errorsCount: number;
  warningsCount: number;
}

export interface ImportDryRunResult {
  dryRun: true;
  valid: boolean;
  summary: ImportSummary;
  report: ValidationReport;
  preview: {
    tasks: ParsedTaskRow[];
    features: ParsedFeatureRow[];
  };
}

export interface ImportCommitResult {
  dryRun: false;
  valid: true;
  imported: {
    tasksCount: number;
    featuresCount: number;
  };
  tasks: TaskWithDependencies[];
  features: Feature[];
}

export type ImportExecutionResult = ImportDryRunResult | ImportCommitResult;
