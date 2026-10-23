import { z } from 'zod';
import { TaskStatusSchema } from './task.js';
import { RunStatusSchema } from './run.js';

export const RecoveredTaskActionSchema = z.enum(['REQUEUED', 'FAILED']);
export type RecoveredTaskAction = z.infer<typeof RecoveredTaskActionSchema>;

export const RecoveredTaskItemSchema = z.object({
  taskId: z.string(),
  previousStatus: TaskStatusSchema,
  newStatus: TaskStatusSchema,
  action: RecoveredTaskActionSchema,
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  runId: z.string().nullable().optional(),
  reason: z.string().optional(),
});
export type RecoveredTaskItem = z.infer<typeof RecoveredTaskItemSchema>;

export const CleanedRunItemSchema = z.object({
  runId: z.string(),
  taskId: z.string(),
  previousStatus: RunStatusSchema,
  newStatus: RunStatusSchema,
  pid: z.number().nullable().optional(),
  reason: z.string().optional(),
});
export type CleanedRunItem = z.infer<typeof CleanedRunItemSchema>;

export const RecoveryResultSchema = z.object({
  recoveryId: z.string(),
  trigger: z.string(),
  recoveredTasks: z.array(RecoveredTaskItemSchema),
  cleanedRuns: z.array(CleanedRunItemSchema),
  releasedLocks: z.number().int(),
  timestamp: z.string(),
});
export type RecoveryResult = z.infer<typeof RecoveryResultSchema>;

export const RecoveryOptionsSchema = z.object({
  trigger: z.string().optional().default('restart'),
  autoRequeue: z.boolean().optional().default(true),
  forceFailAll: z.boolean().optional().default(false),
  lockId: z.string().optional().default('default_agent'),
  releaseAllLocks: z.boolean().optional().default(true),
  recordAudit: z.boolean().optional().default(true),
});
export type RecoveryOptions = z.input<typeof RecoveryOptionsSchema>;
export type RecoveryOptionsOutput = z.output<typeof RecoveryOptionsSchema>;

export const RecoveryStatusSchema = z.object({
  needsRecovery: z.boolean(),
  runningTasksCount: z.number().int(),
  activeRunsCount: z.number().int(),
  heldLocksCount: z.number().int(),
  runningTaskIds: z.array(z.string()),
  activeRunIds: z.array(z.string()),
  heldLockIds: z.array(z.string()),
});
export type RecoveryStatus = z.infer<typeof RecoveryStatusSchema>;

export const RecoveryAuditSchema = z.object({
  id: z.string(),
  trigger: z.string(),
  recovered_tasks_count: z.number().int(),
  cleaned_runs_count: z.number().int(),
  released_locks_count: z.number().int(),
  details: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});
export type RecoveryAudit = z.infer<typeof RecoveryAuditSchema>;

export const CreateRecoveryAuditInputSchema = z.object({
  id: z.string().optional(),
  trigger: z.string(),
  recovered_tasks_count: z.number().int().default(0),
  cleaned_runs_count: z.number().int().default(0),
  released_locks_count: z.number().int().default(0),
  details: z.record(z.string(), z.unknown()).default({}),
  created_at: z.string().optional(),
});
export type CreateRecoveryAuditInput = z.input<typeof CreateRecoveryAuditInputSchema>;
export type CreateRecoveryAuditInputOutput = z.output<typeof CreateRecoveryAuditInputSchema>;
