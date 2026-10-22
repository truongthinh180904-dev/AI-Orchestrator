import { z } from 'zod';

export const STANDARD_EVENT_TYPES = {
  STDOUT: 'stdout',
  STDERR: 'stderr',
  PARSE_ERROR: 'parse_error',
  PROCESS_START: 'process_start',
  PROCESS_EXIT: 'process_exit',
  RESULT: 'result',
  PROCESS_TIMEOUT: 'process_timeout',
  PROCESS_STOPPED: 'process_stopped',
} as const;

export type StandardEventType = (typeof STANDARD_EVENT_TYPES)[keyof typeof STANDARD_EVENT_TYPES];

export const EventRecordSchema = z.object({
  id: z.number().int().positive(),
  run_id: z.string().min(1, 'Run id cannot be empty'),
  seq: z.number().int().positive('Sequence number must be positive'),
  type: z.string().min(1, 'Event type cannot be empty'),
  payload: z.unknown(),
  ts: z.string(),
});

export type EventRecord<T = unknown> = {
  id: number;
  run_id: string;
  seq: number;
  type: string;
  payload: T;
  ts: string;
};

export const CreateEventInputSchema = z.object({
  run_id: z.string().min(1, 'Run id cannot be empty'),
  seq: z.number().int().positive('Sequence number must be positive').optional(),
  type: z.string().min(1, 'Event type cannot be empty'),
  payload: z.unknown(),
  ts: z.string().optional(),
});

export type CreateEventInput = z.input<typeof CreateEventInputSchema>;
export type CreateEventData = z.output<typeof CreateEventInputSchema>;

export const EventFilterSchema = z.object({
  run_id: z.string().min(1).optional(),
  after_seq: z.number().int().nonnegative().optional(),
  type: z.string().optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
});

export type EventFilter = z.input<typeof EventFilterSchema>;
export type EventFilterData = z.output<typeof EventFilterSchema>;
