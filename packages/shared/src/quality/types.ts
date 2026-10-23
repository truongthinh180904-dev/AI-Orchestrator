import { z } from 'zod';

export const QUALITY_STAGES = ['format', 'lint', 'typecheck', 'test', 'build'] as const;
export type QualityStage = (typeof QUALITY_STAGES)[number] | 'custom';

export const QualityStageSchema = z.enum(['format', 'lint', 'typecheck', 'test', 'build', 'custom']);

/**
 * Normalized command definition ready for process execution.
 */
export const QualityCommandDefinitionSchema = z.object({
  id: z.string().min(1, 'Command ID cannot be empty'),
  stage: QualityStageSchema,
  name: z.string().min(1, 'Command name cannot be empty'),
  command: z.string().min(1, 'Command string cannot be empty'),
  exe: z.string().min(1, 'Executable binary cannot be empty'),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1, 'Working directory cannot be empty'),
  env: z.record(z.string(), z.string()).optional(),
  timeout_ms: z.number().int().positive().default(120_000),
  enabled: z.boolean().default(true),
  required: z.boolean().default(true),
  continueOnError: z.boolean().default(false),
});

export type QualityCommandDefinition = z.infer<typeof QualityCommandDefinitionSchema>;

/**
 * Flexible input schema for a single command.
 * Allows a single string (e.g. "pnpm lint"), string array (e.g. ["pnpm", "lint"]),
 * or an object with specific stage configuration.
 */
export const QualityCommandInputSchema = z.union([
  z.string().min(1, 'Command string cannot be empty'),
  z.array(z.string().min(1)).min(1, 'Command arguments cannot be empty'),
  z.object({
    id: z.string().optional(),
    stage: QualityStageSchema.optional(),
    name: z.string().optional(),
    command: z.string().optional(),
    exe: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    timeout_ms: z.number().int().positive().optional(),
    enabled: z.boolean().optional(),
    required: z.boolean().optional(),
    continueOnError: z.boolean().optional(),
  }),
]);

export type QualityCommandInput = z.infer<typeof QualityCommandInputSchema>;

/**
 * Repository Quality Configuration Schema.
 * Configures the repository verification stages: format, lint, typecheck, test, build, and custom commands.
 */
export const RepoQualityConfigSchema = z.object({
  repo_id: z.string().optional(),
  repo_path: z.string().min(1, 'Repository path cannot be empty').default('.'),
  format: QualityCommandDefinitionSchema.nullable().default(null),
  lint: QualityCommandDefinitionSchema.nullable().default(null),
  typecheck: QualityCommandDefinitionSchema.nullable().default(null),
  test: QualityCommandDefinitionSchema.nullable().default(null),
  build: QualityCommandDefinitionSchema.nullable().default(null),
  custom_commands: z.array(QualityCommandDefinitionSchema).default([]),
  stop_on_first_failure: z.boolean().default(true),
  default_timeout_ms: z.number().int().positive().default(120_000),
});

export type RepoQualityConfig = z.infer<typeof RepoQualityConfigSchema>;

/**
 * Flexible input schema for repository quality configuration,
 * used when reading from files (quality.json, package.json), workbook sheets, or REST API.
 */
export const RepoQualityConfigInputSchema = z.object({
  repo_id: z.string().optional(),
  repo_path: z.string().optional(),
  format: QualityCommandInputSchema.nullable().optional(),
  lint: QualityCommandInputSchema.nullable().optional(),
  typecheck: QualityCommandInputSchema.nullable().optional(),
  test: QualityCommandInputSchema.nullable().optional(),
  build: QualityCommandInputSchema.nullable().optional(),
  custom_commands: z.array(QualityCommandInputSchema).optional(),
  verify_commands: z.array(z.string()).optional(),
  stop_on_first_failure: z.boolean().optional(),
  default_timeout_ms: z.number().int().positive().optional(),
  // Generic settings dictionary for workbook compatibility
  settings: z.record(z.string(), z.unknown()).optional(),
});

export type RepoQualityConfigInput = z.infer<typeof RepoQualityConfigInputSchema>;

/**
 * Returns an ordered array of enabled verification commands for execution in Quality Gate runner.
 * Standard pipeline order: format -> lint -> typecheck -> test -> build -> custom commands.
 */
export function getExecutionPipeline(config: RepoQualityConfig): QualityCommandDefinition[] {
  const pipeline: QualityCommandDefinition[] = [];
  const stages: Array<'format' | 'lint' | 'typecheck' | 'test' | 'build'> = [
    'format',
    'lint',
    'typecheck',
    'test',
    'build',
  ];

  for (const stage of stages) {
    const cmd = config[stage];
    if (cmd && cmd.enabled) {
      pipeline.push(cmd);
    }
  }

  for (const custom of config.custom_commands) {
    if (custom.enabled) {
      pipeline.push(custom);
    }
  }

  return pipeline;
}
