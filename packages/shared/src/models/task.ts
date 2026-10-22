import { z } from 'zod';

export const TASK_STATUSES = [
  'TODO',
  'READY',
  'RUNNING',
  'VERIFYING',
  'DONE',
  'FAILED',
  'BLOCKED',
  'PAUSED',
  'CANCELLED',
] as const;

export const TaskStatusSchema = z.enum(TASK_STATUSES, {
  message: `Task status must be one of ${TASK_STATUSES.join(', ')}`,
});

export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  id: z.string().min(1, 'Task id cannot be empty'),
  feature_id: z.string().nullable().default(null),
  title: z.string().min(1, 'Task title cannot be empty'),
  description: z.string().nullable().default(null),
  phase: z.string().nullable().default(null),
  worker_type: z.string().min(1).default('agy'),
  repository: z.string().min(1).default('.'),
  acceptance_criteria: z.array(z.string()).default([]),
  test_commands: z.array(z.string()).default([]),
  priority: z.number().int().default(0),
  max_attempts: z.number().int().min(1).default(3),
  timeout_minutes: z.number().int().min(1).default(30),
  status: TaskStatusSchema.default('TODO'),
  attempts: z.number().int().min(0).default(0),
  created_at: z.string(),
  updated_at: z.string(),
});

export type Task = z.infer<typeof TaskSchema>;

export const TaskWithDependenciesSchema = TaskSchema.extend({
  dependencies: z.array(z.string()).default([]),
});

export type TaskWithDependencies = z.infer<typeof TaskWithDependenciesSchema>;

export const CreateTaskInputSchema = z.object({
  id: z.string().min(1, 'Task id cannot be empty'),
  feature_id: z.string().nullable().optional(),
  title: z.string().min(1, 'Task title cannot be empty'),
  description: z.string().nullable().optional(),
  phase: z.string().nullable().optional(),
  worker_type: z.string().min(1).optional().default('agy'),
  repository: z.string().min(1).optional().default('.'),
  acceptance_criteria: z.array(z.string()).optional().default([]),
  test_commands: z.array(z.string()).optional().default([]),
  priority: z.number().int().optional().default(0),
  max_attempts: z.number().int().min(1).optional().default(3),
  timeout_minutes: z.number().int().min(1).optional().default(30),
  status: TaskStatusSchema.optional().default('TODO'),
  attempts: z.number().int().min(0).optional().default(0),
  dependencies: z.array(z.string()).optional().default([]),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export type CreateTaskInput = z.input<typeof CreateTaskInputSchema>;

export const UpdateTaskInputSchema = z.object({
  feature_id: z.string().nullable().optional(),
  title: z.string().min(1, 'Task title cannot be empty').optional(),
  description: z.string().nullable().optional(),
  phase: z.string().nullable().optional(),
  worker_type: z.string().min(1).optional(),
  repository: z.string().min(1).optional(),
  acceptance_criteria: z.array(z.string()).optional(),
  test_commands: z.array(z.string()).optional(),
  priority: z.number().int().optional(),
  max_attempts: z.number().int().min(1).optional(),
  timeout_minutes: z.number().int().min(1).optional(),
  status: TaskStatusSchema.optional(),
  attempts: z.number().int().min(0).optional(),
  dependencies: z.array(z.string()).optional(),
  updated_at: z.string().optional(),
});

export type UpdateTaskInput = z.input<typeof UpdateTaskInputSchema>;

export const TaskFilterSchema = z.object({
  status: TaskStatusSchema.optional(),
  feature_id: z.string().optional(),
  phase: z.string().optional(),
});

export type TaskFilter = z.input<typeof TaskFilterSchema>;
