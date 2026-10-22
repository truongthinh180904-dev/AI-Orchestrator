import { z } from 'zod';

export const RegisteredRepositorySchema = z.object({
  id: z.string().min(1, 'Repository ID cannot be empty'),
  path: z.string().min(1, 'Repository path cannot be empty'),
  name: z.string().optional(),
  isDefault: z.boolean().default(false),
  registeredAt: z.string(),
});

export type RegisteredRepository = z.infer<typeof RegisteredRepositorySchema>;

export const RegisterRepositoryInputSchema = z.object({
  id: z.string().min(1).optional(),
  path: z.string().min(1, 'Repository path cannot be empty'),
  name: z.string().min(1).optional(),
  isDefault: z.boolean().optional().default(false),
});

export type RegisterRepositoryInput = z.infer<typeof RegisterRepositoryInputSchema>;

export const WorktreeInfoSchema = z.object({
  path: z.string().min(1),
  head: z.string().min(1),
  branch: z.string().nullable().default(null),
  isBare: z.boolean().default(false),
  isDetached: z.boolean().default(false),
  isLocked: z.boolean().default(false),
  lockReason: z.string().nullable().default(null),
  prunable: z.string().nullable().default(null),
});

export type WorktreeInfo = z.infer<typeof WorktreeInfoSchema>;

export const CreateWorktreeOptionsSchema = z.object({
  repoPath: z.string().min(1, 'Repository path cannot be empty'),
  worktreePath: z.string().min(1, 'Worktree path cannot be empty'),
  branch: z.string().min(1).optional(),
  newBranch: z.boolean().optional().default(true),
  commitOrBranch: z.string().min(1).optional(),
  force: z.boolean().optional().default(false),
  detach: z.boolean().optional().default(false),
});

export type CreateWorktreeOptions = z.infer<typeof CreateWorktreeOptionsSchema>;
