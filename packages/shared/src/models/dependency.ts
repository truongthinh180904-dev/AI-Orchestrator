import { z } from 'zod';

export const TaskDependencySchema = z.object({
  task_id: z.string().min(1, 'task_id cannot be empty'),
  depends_on_id: z.string().min(1, 'depends_on_id cannot be empty'),
});

export type TaskDependency = z.infer<typeof TaskDependencySchema>;

export const CreateTaskDependencyInputSchema = TaskDependencySchema;
export type CreateTaskDependencyInput = z.input<typeof CreateTaskDependencyInputSchema>;
