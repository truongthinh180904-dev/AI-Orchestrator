import { z } from 'zod';

export const CHECKPOINT_STATUSES = [
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'SKIPPED',
] as const;

export const CheckpointStatusSchema = z.enum(CHECKPOINT_STATUSES, {
  message: `Checkpoint status must be one of ${CHECKPOINT_STATUSES.join(', ')}`,
});

export type CheckpointStatus = z.infer<typeof CheckpointStatusSchema>;

export const CheckpointSchema = z.object({
  id: z.string().min(1, 'Checkpoint id cannot be empty'),
  task_id: z.string().min(1, 'Task id cannot be empty'),
  run_id: z.string().nullable().default(null),
  attempt: z.number().int().min(1).default(1),
  step: z.string().min(1, 'Checkpoint step cannot be empty'),
  status: CheckpointStatusSchema.default('COMPLETED'),
  data: z.record(z.string(), z.unknown()).default({}),
  created_at: z.string(),
});

export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const CreateCheckpointInputSchema = z.object({
  id: z.string().min(1).optional(),
  task_id: z.string().min(1, 'Task id is required'),
  run_id: z.string().nullable().optional(),
  attempt: z.number().int().min(1).optional().default(1),
  step: z.string().min(1, 'Step name is required'),
  status: CheckpointStatusSchema.optional().default('COMPLETED'),
  data: z.record(z.string(), z.unknown()).optional().default({}),
  created_at: z.string().optional(),
});

export type CreateCheckpointInput = z.input<typeof CreateCheckpointInputSchema>;
export type CreateCheckpointData = z.output<typeof CreateCheckpointInputSchema>;

export const CheckpointFilterSchema = z.object({
  task_id: z.string().optional(),
  run_id: z.string().optional(),
  attempt: z.number().int().min(1).optional(),
  step: z.string().optional(),
  status: CheckpointStatusSchema.optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
});

export type CheckpointFilter = z.infer<typeof CheckpointFilterSchema>;
