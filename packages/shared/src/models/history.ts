import { z } from 'zod';
import { RunSchema } from './run.js';
import { CheckpointSchema } from './checkpoint.js';
import { ReportSchema } from './report.js';
import { TaskSchema } from './task.js';
import { EventRecordSchema } from './event.js';

export const RUN_OUTCOMES = [
  'SUCCESS',
  'ERROR',
  'TIMEOUT',
  'CANCELLED',
  'IN_PROGRESS',
  'UNKNOWN',
] as const;

export const RunOutcomeSchema = z.enum(RUN_OUTCOMES);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

export const RunResultSummarySchema = z.object({
  outcome: RunOutcomeSchema,
  success: z.boolean(),
  exit_code: z.number().int().nullable().default(null),
  duration_ms: z.number().int().nullable().default(null),
  error_message: z.string().nullable().optional(),
  event_count: z.number().int().nonnegative().default(0),
  checkpoint_count: z.number().int().nonnegative().default(0),
  report_count: z.number().int().nonnegative().default(0),
});
export type RunResultSummary = z.infer<typeof RunResultSummarySchema>;

export const TaskAttemptHistoryItemSchema = z.object({
  attempt: z.number().int().min(1),
  run: RunSchema,
  result: RunResultSummarySchema,
  checkpoints: z.array(CheckpointSchema).default([]),
  reports: z.array(ReportSchema).default([]),
});
export type TaskAttemptHistoryItem = z.infer<typeof TaskAttemptHistoryItemSchema>;

export const TaskRunHistorySchema = z.object({
  taskId: z.string().min(1),
  taskTitle: z.string(),
  taskStatus: z.string(),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  latestRun: RunSchema.nullable().default(null),
  latestCheckpoint: CheckpointSchema.nullable().default(null),
  history: z.array(TaskAttemptHistoryItemSchema).default([]),
});
export type TaskRunHistory = z.infer<typeof TaskRunHistorySchema>;

export const RunDetailSchema = z.object({
  run: RunSchema,
  task: TaskSchema.nullable().default(null),
  result: RunResultSummarySchema,
  checkpoints: z.array(CheckpointSchema).default([]),
  reports: z.array(ReportSchema).default([]),
  events: z.array(EventRecordSchema).default([]),
  eventStats: z.object({
    total: z.number().int().nonnegative(),
    byType: z.record(z.string(), z.number().int().nonnegative()),
  }),
});
export type RunDetail = z.infer<typeof RunDetailSchema>;
