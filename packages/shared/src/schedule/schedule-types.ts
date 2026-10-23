import { z } from 'zod';

export const TimeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Time must be in format HH:mm (00:00 to 23:59)');

export const DayOfWeekSchema = z.number().int().min(0).max(6); // 0=Sunday, 1=Monday, ..., 6=Saturday

export const TimeWindowSchema = z.object({
  name: z.string().optional(),
  start: TimeOfDaySchema, // e.g. "22:00"
  end: TimeOfDaySchema, // e.g. "06:00"
  days: z.array(DayOfWeekSchema).default([0, 1, 2, 3, 4, 5, 6]),
  description: z.string().optional(),
});
export type TimeWindow = z.infer<typeof TimeWindowSchema>;
export type TimeWindowInput = z.input<typeof TimeWindowSchema>;

export const ScheduleModeSchema = z.enum(['ALLOW', 'BLOCK', 'ALWAYS']);
export type ScheduleMode = z.infer<typeof ScheduleModeSchema>;

export const ScheduleConfigSchema = z.object({
  id: z.string().default('default_schedule'),
  name: z.string().default('Default Execution Schedule'),
  enabled: z.boolean().default(true),
  timezone: z.string().default('UTC'),
  mode: ScheduleModeSchema.default('ALLOW'),
  windows: z.array(TimeWindowSchema).default([]),
  stop_at_hour: z.number().int().min(0).max(23).nullable().default(null),
  graceful_completion: z.boolean().default(true),
  max_runs_per_window: z.number().int().positive().nullable().default(null),
});
export type ScheduleConfig = z.infer<typeof ScheduleConfigSchema>;
export type ScheduleConfigInput = z.input<typeof ScheduleConfigSchema>;

export type ScheduleEvaluationReason =
  | 'SCHEDULE_DISABLED'
  | 'MODE_ALWAYS'
  | 'INSIDE_ALLOWED_WINDOW'
  | 'OUTSIDE_ALLOWED_WINDOW'
  | 'INSIDE_BLOCKED_WINDOW'
  | 'OUTSIDE_BLOCKED_WINDOW'
  | 'DEADLINE_REACHED'
  | 'NO_WINDOWS_CONFIGURED';

export interface ScheduleEvaluationResult {
  allowed: boolean;
  reason: ScheduleEvaluationReason;
  message: string;
  activeMode: ScheduleMode;
  currentTimestamp: string;
  currentLocalTime: string;
  timezone: string;
  currentWindow?: TimeWindow;
  msUntilWindowEnd?: number;
  windowEnd?: string;
  msUntilNextWindow?: number;
  nextWindowStart?: string;
}

export interface ScheduleStatus {
  config: ScheduleConfig;
  evaluation: ScheduleEvaluationResult;
}

export type ScheduleEventType =
  | 'CONFIG_UPDATED'
  | 'WINDOW_ENTERED'
  | 'WINDOW_EXITED'
  | 'DEADLINE_REACHED'
  | 'EXECUTION_ALLOWED'
  | 'EXECUTION_BLOCKED';

export interface ScheduleEventRecord {
  id: string;
  event_type: ScheduleEventType;
  schedule_id: string;
  task_id: string | null;
  run_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

export interface CreateScheduleEventInput {
  event_type: ScheduleEventType;
  schedule_id?: string;
  task_id?: string | null;
  run_id?: string | null;
  details?: Record<string, unknown>;
  created_at?: string;
}
