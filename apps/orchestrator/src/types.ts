import { z } from 'zod';
import {
  TaskFilterSchema,
  UpdateTaskInputSchema,
  FeatureFilterSchema,
  CreateRunApiSchema,
  StopRunApiSchema,
  RunFilterSchema,
  type CreateRunApiInput,
  type StopRunApiInput,
  type RunFilter,
  type Env,
} from '@ai-orchestrator/shared';
import type Database from 'better-sqlite3';
import type { ExecutionManager } from './adapters/execution-manager.js';
import type { RepositoryRegistry } from './adapters/repository-registry.js';

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

export const RunParamsSchema = z.object({
  id: z.string().min(1, 'Run ID is required'),
});
export type RunParamsInput = z.infer<typeof RunParamsSchema>;

export const RunStreamQuerySchema = z.object({
  after_seq: z.coerce.number().int().nonnegative().optional(),
  live: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((val) => {
      if (val === undefined) return true;
      if (typeof val === 'boolean') return val;
      return val !== 'false' && val !== '0';
    }),
});
export type RunStreamQueryInput = z.infer<typeof RunStreamQuerySchema>;

export {
  CreateRunApiSchema,
  StopRunApiSchema,
  RunFilterSchema,
  type CreateRunApiInput,
  type StopRunApiInput,
  type RunFilter,
};

export type {
  ImportSummary,
  ImportDryRunResult,
  ImportCommitResult,
  ImportExecutionResult,
} from '@ai-orchestrator/shared';

export interface BuildServerOptions {
  db: Database.Database;
  logger?: boolean | Record<string, unknown>;
  config?: Partial<Env>;
  executionManager?: ExecutionManager;
  repositoryRegistry?: RepositoryRegistry;
}
