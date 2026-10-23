import { z } from 'zod';
import {
  TaskFilterSchema,
  TaskStatusSchema,
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
import type { TaskScheduler } from './services/task-scheduler.js';
import type { PlannerService } from './services/planner-service.js';
import type { QualityConfigService } from './services/quality-config-service.js';
import type { QualityRunner } from './services/quality-runner.js';
import type { ScopeDiffService } from './services/scope-diff-service.js';
import type { ReviewerService } from './services/reviewer-service.js';

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

export const TaskTransitionBodySchema = z.object({
  status: TaskStatusSchema,
  reason: z.string().optional(),
  runId: z.string().optional(),
  incrementAttempt: z.boolean().optional(),
  force: z.boolean().optional(),
});
export type TaskTransitionBodyInput = z.infer<typeof TaskTransitionBodySchema>;

export const TaskRetryBodySchema = z.object({
  reason: z.string().optional(),
  force: z.boolean().optional(),
  runId: z.string().optional(),
});
export type TaskRetryBodyInput = z.infer<typeof TaskRetryBodySchema>;

export const TaskReadyQuerySchema = TaskFilterSchema.extend({
  autoTransition: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((val) => {
      if (val === undefined) return false;
      if (typeof val === 'boolean') return val;
      return val === 'true' || val === '1';
    }),
  limit: z.coerce.number().int().positive().optional(),
});
export type TaskReadyQueryInput = z.infer<typeof TaskReadyQuerySchema>;

export const TaskResolveReadyBodySchema = TaskFilterSchema.extend({});
export type TaskResolveReadyBodyInput = z.infer<typeof TaskResolveReadyBodySchema>;

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

export const CreateCheckpointBodySchema = z.object({
  step: z.string().min(1, 'Step name is required'),
  status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'SKIPPED']).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  runId: z.string().optional(),
  run_id: z.string().optional(),
  attempt: z.number().int().min(1).optional(),
});
export type CreateCheckpointBodyInput = z.infer<typeof CreateCheckpointBodySchema>;

export const CheckpointQuerySchema = z.object({
  runId: z.string().optional(),
  run_id: z.string().optional(),
  attempt: z.coerce.number().int().min(1).optional(),
  step: z.string().optional(),
  status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'SKIPPED']).optional(),
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});
export type CheckpointQueryInput = z.infer<typeof CheckpointQuerySchema>;

export const CreateReportBodySchema = z.object({
  kind: z.string().min(1, 'Report kind is required'),
  content: z.string().optional().default(''),
});
export type CreateReportBodyInput = z.infer<typeof CreateReportBodySchema>;

export const ReportQuerySchema = z.object({
  kind: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});
export type ReportQueryInput = z.infer<typeof ReportQuerySchema>;

export const PlanParamsSchema = z.object({
  id: z.string().min(1, 'Plan ID is required'),
});
export type PlanParamsInput = z.infer<typeof PlanParamsSchema>;

export const ValidatePlanBodySchema = z.object({
  rawOutput: z.string().min(1, 'rawOutput is required'),
  repository: z.string().optional(),
  feature_id: z.string().nullable().optional(),
});
export type ValidatePlanBodyInput = z.infer<typeof ValidatePlanBodySchema>;

export const ApprovePlanBodySchema = z.object({
  approved_by: z.string().min(1).optional().default('reviewer'),
  comments: z.string().optional(),
  edits: z
    .object({
      title: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      tasks: z.array(z.record(z.string(), z.unknown())).min(1).optional(),
    })
    .optional(),
});
export type ApprovePlanBodyInput = z.infer<typeof ApprovePlanBodySchema>;

export const RejectPlanBodySchema = z.object({
  reason: z.string().min(1, 'Rejection reason is required and cannot be empty'),
  rejected_by: z.string().min(1).optional().default('reviewer'),
});
export type RejectPlanBodyInput = z.infer<typeof RejectPlanBodySchema>;

export const ExecutePlanBodySchema = z.object({
  executor: z.string().optional().default('orchestrator'),
  dryRun: z.boolean().optional().default(false),
  orchestrate: z.boolean().optional().default(false),
  autoStart: z.boolean().optional().default(false),
  autoVerify: z.boolean().optional().default(true),
  autoRetry: z.boolean().optional().default(true),
  timeoutMs: z.number().int().min(1000).optional(),
});
export type ExecutePlanBodyInput = z.infer<typeof ExecutePlanBodySchema>;

export const OrchestratePlanBodySchema = z.object({
  autoVerify: z.boolean().optional().default(true),
  autoRetry: z.boolean().optional().default(true),
  timeoutMs: z.number().int().min(1000).optional(),
  dryRun: z.boolean().optional().default(false),
  maxSteps: z.number().int().min(1).optional(),
  waitBackoff: z.boolean().optional().default(false),
});
export type OrchestratePlanBodyInput = z.infer<typeof OrchestratePlanBodySchema>;

export const StepPlanBodySchema = z.object({
  autoVerify: z.boolean().optional(),
  autoRetry: z.boolean().optional(),
  timeoutMs: z.number().optional(),
  lockId: z.string().optional(),
  waitBackoff: z.boolean().optional(),
});
export type StepPlanBodyInput = z.infer<typeof StepPlanBodySchema>;

export const UpdatePlanBodySchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  repository: z.string().min(1).optional(),
  feature_id: z.string().nullable().optional(),
  tasks: z.array(z.record(z.string(), z.unknown())).optional(),
  status: z.enum(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXECUTING', 'COMPLETED', 'FAILED']).optional(),
});
export type UpdatePlanBodyInput = z.infer<typeof UpdatePlanBodySchema>;

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
  taskScheduler?: TaskScheduler;
  plannerService?: PlannerService;
  qualityConfigService?: QualityConfigService;
  qualityRunner?: QualityRunner;
  scopeDiffService?: ScopeDiffService;
  reviewerService?: ReviewerService;
}
