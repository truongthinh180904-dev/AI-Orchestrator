import { z } from 'zod';

export const FEATURE_STATUSES = ['TODO', 'IN_PROGRESS', 'DONE', 'FAILED', 'BLOCKED'] as const;

export const FeatureStatusSchema = z.enum(FEATURE_STATUSES, {
  message: `Feature status must be one of ${FEATURE_STATUSES.join(', ')}`,
});

export type FeatureStatus = z.infer<typeof FeatureStatusSchema>;

export const FeatureSchema = z.object({
  id: z.string().min(1, 'Feature id cannot be empty'),
  name: z.string().min(1, 'Feature name cannot be empty'),
  description: z.string().nullable().default(null),
  required_tasks: z.array(z.string()).default([]),
  integration_tests: z.array(z.string()).default([]),
  release_policy: z.string().nullable().default(null),
  status: FeatureStatusSchema.default('TODO'),
  created_at: z.string(),
  updated_at: z.string(),
});

export type Feature = z.infer<typeof FeatureSchema>;

export const CreateFeatureInputSchema = z.object({
  id: z.string().min(1, 'Feature id cannot be empty'),
  name: z.string().min(1, 'Feature name cannot be empty'),
  description: z.string().nullable().optional(),
  required_tasks: z.array(z.string()).optional().default([]),
  integration_tests: z.array(z.string()).optional().default([]),
  release_policy: z.string().nullable().optional(),
  status: FeatureStatusSchema.optional().default('TODO'),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export type CreateFeatureInput = z.input<typeof CreateFeatureInputSchema>;

export const UpdateFeatureInputSchema = z.object({
  name: z.string().min(1, 'Feature name cannot be empty').optional(),
  description: z.string().nullable().optional(),
  required_tasks: z.array(z.string()).optional(),
  integration_tests: z.array(z.string()).optional(),
  release_policy: z.string().nullable().optional(),
  status: FeatureStatusSchema.optional(),
  updated_at: z.string().optional(),
});

export type UpdateFeatureInput = z.input<typeof UpdateFeatureInputSchema>;

export const FeatureFilterSchema = z.object({
  status: FeatureStatusSchema.optional(),
});

export type FeatureFilter = z.input<typeof FeatureFilterSchema>;
