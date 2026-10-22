import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from './errors.js';

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'], {
      message: "NODE_ENV must be one of 'development' | 'test' | 'production'",
    })
    .default('development'),
  PORT: z.coerce
    .number({ message: 'PORT must be a valid number' })
    .int('PORT must be an integer')
    .min(1, 'PORT must be between 1 and 65535')
    .max(65535, 'PORT must be between 1 and 65535')
    .default(3000),
  HOST: z.string().min(1, 'HOST cannot be empty').default('127.0.0.1'),
  DATABASE_PATH: z
    .string({ message: 'DATABASE_PATH is required' })
    .min(1, 'DATABASE_PATH cannot be empty'),
  LOG_LEVEL: z
    .enum(['debug', 'info', 'warn', 'error'], {
      message: "LOG_LEVEL must be one of 'debug' | 'info' | 'warn' | 'error'",
    })
    .default('info'),
  AGY_BIN: z.string().min(1, 'AGY_BIN cannot be empty').default('agy'),
  AGY_ARGS: z.string().optional(),
  NEXT_PUBLIC_ORCH_URL: z
    .string()
    .url('NEXT_PUBLIC_ORCH_URL must be a valid URL')
    .optional()
    .or(z.literal('')),
});

export type Env = z.infer<typeof envSchema>;

export interface EnvIssue {
  path: string;
  message: string;
  code: string;
}

export function formatZodError(error: z.ZodError): string {
  const issues = error.issues.map((issue) => {
    const field = issue.path.join('.') || 'root';
    return `[${field}] ${issue.message}`;
  });
  return `Missing or invalid environment configuration:\n  - ${issues.join('\n  - ')}`;
}

export function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const strippedLine = line.startsWith('export ') ? line.slice(7).trim() : line;
    const equalIndex = strippedLine.indexOf('=');
    if (equalIndex === -1) {
      continue;
    }

    const key = strippedLine.slice(0, equalIndex).trim();
    if (!key) {
      continue;
    }

    let val = strippedLine.slice(equalIndex + 1).trim();

    if (val.startsWith('"')) {
      const closeIdx = val.indexOf('"', 1);
      if (closeIdx !== -1) {
        val = val.slice(1, closeIdx);
      }
    } else if (val.startsWith("'")) {
      const closeIdx = val.indexOf("'", 1);
      if (closeIdx !== -1) {
        val = val.slice(1, closeIdx);
      }
    } else {
      const inlineCommentIndex = val.indexOf(' #');
      if (inlineCommentIndex !== -1) {
        val = val.slice(0, inlineCommentIndex).trim();
      }
    }

    result[key] = val;
  }

  return result;
}

export function loadEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    throw new AppError(
      'ENV_FILE_NOT_FOUND',
      `Environment configuration file not found at: ${filePath}`,
      { path: filePath },
    );
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  return parseEnv(content);
}

export interface LoadEnvOptions<T extends z.ZodTypeAny = typeof envSchema> {
  envFile?: string;
  schema?: T;
  env?: Record<string, unknown>;
  override?: boolean;
  mutateProcessEnv?: boolean;
}

export function validateEnv<T extends z.ZodTypeAny = typeof envSchema>(
  raw: Record<string, unknown> = process.env,
  schema: T = envSchema as unknown as T,
): z.infer<T> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const formatted = formatZodError(result.error);
    const issues: EnvIssue[] = result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
      code: i.code,
    }));
    throw new AppError('ENV_VALIDATION_ERROR', formatted, { issues });
  }
  return result.data;
}

export function loadEnv<T extends z.ZodTypeAny = typeof envSchema>(
  options: LoadEnvOptions<T> = {},
): z.infer<T> {
  const schema = (options.schema ?? envSchema) as T;

  if (options.env) {
    return validateEnv(options.env, schema);
  }

  const explicitFile = options.envFile;
  const defaultFile = path.resolve(process.cwd(), '.env');

  let fileVars: Record<string, string> = {};
  if (explicitFile) {
    fileVars = loadEnvFile(explicitFile);
  } else if (fs.existsSync(defaultFile)) {
    fileVars = loadEnvFile(defaultFile);
  }

  const shouldMutate = options.mutateProcessEnv !== false;
  if (shouldMutate) {
    for (const [key, value] of Object.entries(fileVars)) {
      if (options.override || process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }

  const targetEnv = shouldMutate ? process.env : { ...fileVars, ...process.env };

  return validateEnv(targetEnv, schema);
}
