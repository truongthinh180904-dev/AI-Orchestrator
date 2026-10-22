import { z } from 'zod';

export const DEFAULT_ENV_WHITELIST: readonly string[] = Object.freeze([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TERM',
  'COLORTERM',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'NODE_ENV',
  'NODE_PATH',
  'NODE_OPTIONS',
  'NVM_BIN',
  'NVM_DIR',
  'NVM_INC',
  'PNPM_HOME',
  'SSH_AUTH_SOCK',
  'GIT_EXEC_PATH',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'AGY_BIN',
  'AGY_ARGS',
]);

export const AgentCommandSchema = z.object({
  exe: z.string().min(1, 'Executable path cannot be empty'),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1, 'Working directory cannot be empty'),
  env: z.record(z.string(), z.string()).optional(),
  extraEnvWhitelist: z.array(z.string()).optional(),
  detached: z.boolean().optional().default(false),
});

export type AgentCommandInput = z.input<typeof AgentCommandSchema>;
export type AgentCommand = z.output<typeof AgentCommandSchema>;

export const ProcessExitResultSchema = z.object({
  exitCode: z.number().nullable(),
  signal: z.string().nullable(),
  durationMs: z.number().nonnegative(),
});

export interface ProcessExitResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

export interface BuildProcessEnvOptions {
  sourceEnv?: Record<string, string | undefined>;
  whitelist?: readonly string[];
  extraWhitelist?: readonly string[];
  explicitEnv?: Record<string, string>;
}

/**
 * Builds a sanitized environment map by filtering the source environment through
 * a whitelist of allowed variable names, preventing leaks of sensitive tokens or keys.
 */
export function buildProcessEnv(options: BuildProcessEnvOptions = {}): Record<string, string> {
  const source = options.sourceEnv ?? process.env;
  const baseWhitelist = options.whitelist ?? DEFAULT_ENV_WHITELIST;
  const extra = options.extraWhitelist ?? [];
  const allowedKeys = new Set([...baseWhitelist, ...extra]);

  const safeEnv: Record<string, string> = {};

  for (const key of allowedKeys) {
    const val = source[key];
    if (val !== undefined) {
      safeEnv[key] = val;
    }
  }

  if (options.explicitEnv) {
    for (const [key, val] of Object.entries(options.explicitEnv)) {
      safeEnv[key] = val;
    }
  }

  return safeEnv;
}
