import { z } from 'zod';
import {
  TaskFilterSchema,
  UpdateTaskInputSchema,
  FeatureFilterSchema,
  type TaskWithDependencies,
  type Feature,
  type ValidationReport,
  type Env,
} from '@ai-orchestrator/shared';
import type Database from 'better-sqlite3';

export const ImportRequestSchema = z.object({
  filePath: z.string().optional(),
  fileContent: z.string().optional(),
  filename: z.string().optional(),
  files: z.record(z.string(), z.string()).optional(),
  tasks: z.array(z.record(z.string(), z.unknown())).optional(),
  features: z.array(z.record(z.string(), z.unknown())).optional(),
  dryRun: z.boolean().optional(),
  mode: z.enum(['dry-run', 'commit']).optional(),
});

export type ImportRequestInput = z.infer<typeof ImportRequestSchema>;

export const TaskQuerySchema = TaskFilterSchema.extend({
  search: z.string().optional(),
});
export type TaskQueryInput = z.infer<typeof TaskQuerySchema>;

export const TaskParamsSchema = z.object({
  id: z.string().min(1, 'Task ID is required'),
});
export type TaskParamsInput = z.infer<typeof TaskParamsSchema>;

export const TaskPatchBodySchema = UpdateTaskInputSchema.extend({
  id: z.string().optional(),
});
export type TaskPatchBodyInput = z.infer<typeof TaskPatchBodySchema>;

export const FeatureQuerySchema = FeatureFilterSchema;
export type FeatureQueryInput = z.infer<typeof FeatureQuerySchema>;

export const FeatureParamsSchema = z.object({
  id: z.string().min(1, 'Feature ID is required'),
});
export type FeatureParamsInput = z.infer<typeof FeatureParamsSchema>;

export interface ImportDryRunResult {
  dryRun: true;
  valid: boolean;
  summary: {
    tasksCount: number;
    featuresCount: number;
    errorsCount: number;
    warningsCount: number;
  };
  report: ValidationReport;
  preview: {
    tasks: unknown[];
    features: unknown[];
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

export interface BuildServerOptions {
  db: Database.Database;
  logger?: boolean | Record<string, unknown>;
  config?: Partial<Env>;
}
