import { z } from 'zod';
import { TaskStatusSchema, type TaskStatus, type TaskWithDependencies } from '../models/task.js';

export const TaskDependencyItemSchema = z.object({
  id: z.string(),
  status: z.union([TaskStatusSchema, z.literal('MISSING')]),
});
export type TaskDependencyItem = z.infer<typeof TaskDependencyItemSchema>;

export const TaskDependencyStatusSchema = z.object({
  taskId: z.string(),
  isReady: booleanSchema(),
  currentStatus: TaskStatusSchema,
  totalDependencies: z.number().int().nonnegative(),
  satisfiedDependencies: z.array(z.string()),
  unsatisfiedDependencies: z.array(TaskDependencyItemSchema),
  missingDependencies: z.array(z.string()),
  reason: z.string().optional(),
});
export type TaskDependencyStatus = z.infer<typeof TaskDependencyStatusSchema>;

function booleanSchema() {
  return z.boolean();
}

export interface ResolveReadyOptions {
  /** Lọc theo feature_id nếu có */
  featureId?: string;
  /** Lọc theo phase nếu có */
  phase?: string;
  /** Lọc theo repository nếu có */
  repository?: string;
  /**
   * Trạng thái ứng viên được xét để coi là sẵn sàng thực thi.
   * Mặc định: ['TODO', 'READY'].
   */
  candidateStatuses?: TaskStatus[];
  /** Giới hạn số lượng task trả về */
  limit?: number;
}

export interface DependencyResolutionSummary {
  totalTasks: number;
  readyTasks: TaskWithDependencies[];
  blockedTasks: Array<{ task: TaskWithDependencies; blockedBy: string[] }>;
  pendingTasks: Array<{ task: TaskWithDependencies; waitingFor: string[] }>;
  completedTasks: TaskWithDependencies[];
}
