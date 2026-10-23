import { z } from 'zod';

export const AgentLockSchema = z.object({
  id: z.string(),
  task_id: z.string(),
  run_id: z.string().nullable().default(null),
  acquired_at: z.string(),
  owner_pid: z.number().nullable().default(null),
  metadata: z.string().nullable().default(null),
});

export type AgentLock = z.infer<typeof AgentLockSchema>;

export const CreateAgentLockSchema = z.object({
  id: z.string().default('default_agent'),
  task_id: z.string(),
  run_id: z.string().nullable().optional(),
  acquired_at: z.string().optional(),
  owner_pid: z.number().nullable().optional(),
  metadata: z.string().nullable().optional(),
});

export type CreateAgentLockInput = z.infer<typeof CreateAgentLockSchema>;

export const SchedulerStatusSchema = z.object({
  isRunning: z.boolean(),
  isPaused: z.boolean(),
  activeLock: AgentLockSchema.nullable(),
  activeTaskId: z.string().nullable(),
  activeRunId: z.string().nullable(),
  readyTasksCount: z.number(),
});

export type SchedulerStatus = z.infer<typeof SchedulerStatusSchema>;

export const ScheduleNextOptionsSchema = z.object({
  workerType: z.string().optional(),
  featureId: z.string().optional(),
  planId: z.string().optional(),
  phase: z.string().optional(),
  autoVerify: z.boolean().optional(),
  timeoutMs: z.number().optional(),
  lockId: z.string().optional(),
  autoRetry: z.boolean().optional(),
  waitBackoff: z.boolean().optional(),
});

export type ScheduleNextOptions = z.infer<typeof ScheduleNextOptionsSchema>;

export const ScheduleStepResultSchema = z.object({
  executed: z.boolean(),
  taskId: z.string().optional(),
  runId: z.string().optional(),
  status: z.string().optional(),
  reason: z.string().optional(),
  activeTaskId: z.string().optional(),
  retried: z.boolean().optional(),
  delayMs: z.number().optional(),
  nextRetryAt: z.string().optional(),
});

export type ScheduleStepResult = z.infer<typeof ScheduleStepResultSchema>;
