import { z } from 'zod';

export const RUN_STATUSES = [
  'PENDING',
  'RUNNING',
  'SUCCESS',
  'ERROR',
  'INVALID_OUTPUT',
  'TIMEOUT',
  'CANCELLED',
] as const;

export const RunStatusSchema = z.enum(RUN_STATUSES, {
  message: `Run status must be one of ${RUN_STATUSES.join(', ')}`,
});

export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunSchema = z.object({
  id: z.string().min(1, 'Run id cannot be empty'),
  task_id: z.string().min(1, 'Task id cannot be empty'),
  attempt: z.number().int().min(1).default(1),
  status: RunStatusSchema,
  exit_code: z.number().int().nullable().default(null),
  pid: z.number().int().nullable().default(null),
  started_at: z.string(),
  finished_at: z.string().nullable().default(null),
  branch: z.string().nullable().default(null),
  commit_sha: z.string().nullable().default(null),
});

export type Run = z.infer<typeof RunSchema>;

export const CreateRunInputSchema = z.object({
  id: z.string().min(1, 'Run id cannot be empty').optional(),
  task_id: z.string().min(1, 'Task id cannot be empty'),
  attempt: z.number().int().min(1).optional().default(1),
  status: RunStatusSchema.optional().default('RUNNING'),
  exit_code: z.number().int().nullable().optional(),
  pid: z.number().int().nullable().optional(),
  started_at: z.string().optional(),
  finished_at: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  commit_sha: z.string().nullable().optional(),
});

export type CreateRunInput = z.input<typeof CreateRunInputSchema>;
export type CreateRunData = z.output<typeof CreateRunInputSchema>;

export const UpdateRunInputSchema = z.object({
  status: RunStatusSchema.optional(),
  exit_code: z.number().int().nullable().optional(),
  pid: z.number().int().nullable().optional(),
  finished_at: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  commit_sha: z.string().nullable().optional(),
});

export type UpdateRunInput = z.input<typeof UpdateRunInputSchema>;
export type UpdateRunData = z.output<typeof UpdateRunInputSchema>;

export const RunCommandOverrideSchema = z.object({
  exe: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  extraEnvWhitelist: z.array(z.string()).optional(),
  detached: z.boolean().optional(),
});
export type RunCommandOverride = z.infer<typeof RunCommandOverrideSchema>;

export const CreateRunApiSchema = z.object({
  taskId: z.string().min(1, 'Task ID is required'),
  command: RunCommandOverrideSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
  gracePeriodMs: z.number().int().positive().optional(),
  branch: z.string().optional(),
});
export type CreateRunApiInput = z.infer<typeof CreateRunApiSchema>;

export const StopRunApiSchema = z.object({
  gracePeriodMs: z.number().int().positive().optional(),
  signal: z.enum(['SIGTERM', 'SIGINT', 'SIGKILL']).optional(),
  reason: z.string().optional(),
});
export type StopRunApiInput = z.infer<typeof StopRunApiSchema>;

export const RunFilterSchema = z.object({
  taskId: z.string().optional(),
  task_id: z.string().optional(),
  status: RunStatusSchema.optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
});
export type RunFilter = z.infer<typeof RunFilterSchema>;

