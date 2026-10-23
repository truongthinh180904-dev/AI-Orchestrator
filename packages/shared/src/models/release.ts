import { z } from 'zod';
import { TaskStatusSchema } from './task.js';
import { FeatureStatusSchema } from './feature.js';

/**
 * Đại diện cho một task thành phần trong một feature.
 */
export const FeatureComponentTaskSchema = z.object({
  id: z.string().min(1, 'Task id cannot be empty'),
  feature_id: z.string().nullable().default(null),
  title: z.string().min(1, 'Task title cannot be empty'),
  description: z.string().nullable().default(null),
  phase: z.string().nullable().default(null),
  priority: z.number().int().default(0),
  status: TaskStatusSchema,
  worker_type: z.string().default('agy'),
  repository: z.string().default('.'),
  acceptance_criteria: z.array(z.string()).default([]),
  test_commands: z.array(z.string()).default([]),
  scope_files: z.array(z.string()).nullable().default(null),
  dependencies: z.array(z.string()).default([]),
  is_required: z.boolean().default(false),
  execution_order: z.number().int().nonnegative().default(0),
});

export type FeatureComponentTask = z.infer<typeof FeatureComponentTaskSchema>;

/**
 * Thống kê tổng quan về tiến độ và trạng thái các task của feature.
 */
export const FeatureTaskSummarySchema = z.object({
  total_tasks: z.number().int().nonnegative(),
  required_count: z.number().int().nonnegative(),
  completed_count: z.number().int().nonnegative(),
  pending_count: z.number().int().nonnegative(),
  failed_count: z.number().int().nonnegative(),
  missing_count: z.number().int().nonnegative(),
  is_all_required_done: z.boolean(),
  ready_for_release: z.boolean(),
});

export type FeatureTaskSummary = z.infer<typeof FeatureTaskSummarySchema>;

/**
 * Kết quả phân giải / xác định feature và tập task bắt buộc (Danh sách task thành phần).
 */
export const FeatureComponentTasksResultSchema = z.object({
  feature_id: z.string().min(1, 'Feature id cannot be empty'),
  feature_name: z.string().min(1, 'Feature name cannot be empty'),
  description: z.string().nullable().default(null),
  status: FeatureStatusSchema,
  release_policy: z.string().nullable().default(null),
  integration_tests: z.array(z.string()).default([]),
  required_task_ids: z.array(z.string()).default([]),
  all_task_ids: z.array(z.string()).default([]),
  tasks: z.array(FeatureComponentTaskSchema).default([]),
  missing_task_ids: z.array(z.string()).default([]),
  summary: FeatureTaskSummarySchema,
});

export type FeatureComponentTasksResult = z.infer<typeof FeatureComponentTasksResultSchema>;

/**
 * Schema input để xác định hoặc cập nhật tập task bắt buộc / thành phần của feature.
 */
export const DefineFeatureTasksInputSchema = z.object({
  required_tasks: z.array(z.string()).optional(),
  assign_task_ids: z.array(z.string()).optional(),
  unassign_task_ids: z.array(z.string()).optional(),
});

export type DefineFeatureTasksInput = z.infer<typeof DefineFeatureTasksInputSchema>;
