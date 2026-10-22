import { isAppError } from './errors.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export const LOG_LEVEL_PRIORITIES: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context: Record<string, unknown>;
}

export interface LoggerOptions {
  level?: LogLevel;
  destination?: (line: string) => void;
  defaultContext?: Record<string, unknown>;
  redactKeys?: string[];
}

export interface Logger {
  readonly level: LogLevel;
  readonly defaultContext: Record<string, unknown>;
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, errorOrContext?: unknown, context?: Record<string, unknown>): void;
  child(childContext: Record<string, unknown>): Logger;
}

const DEFAULT_REDACT_KEYS = [
  'password',
  'token',
  'secret',
  'apikey',
  'api_key',
  'authorization',
  'auth',
  'cookie',
  'credential',
  'private_key',
  'privatekey',
  'access_token',
  'refresh_token',
];

const BEARER_REGEX = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const COMMON_SECRET_REGEX =
  /(?:sk-[a-zA-Z0-9_-]{20,}|ghp_[a-zA-Z0-9]{20,}|gho_[a-zA-Z0-9]{20,}|glpat-[a-zA-Z0-9_-]{20,})/gi;

function maskString(str: string): string {
  return str.replace(BEARER_REGEX, 'Bearer [REDACTED]').replace(COMMON_SECRET_REGEX, '[REDACTED]');
}

function isSensitiveKey(key: string, sensitiveKeys: string[]): boolean {
  const lower = key.toLowerCase();
  return sensitiveKeys.some((s) => lower === s || lower.includes(s));
}

export function sanitizeValue(
  value: unknown,
  sensitiveKeys: string[] = DEFAULT_REDACT_KEYS,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return maskString(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'function') {
    return `[Function: ${value.name || 'anonymous'}]`;
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[CIRCULAR]';
    }
    seen.add(value);

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (value instanceof RegExp) {
      return value.toString();
    }

    if (Array.isArray(value)) {
      return value.map((item) => sanitizeValue(item, sensitiveKeys, seen));
    }

    if (value instanceof Error) {
      const serialized: Record<string, unknown> = {
        name: value.name,
        message: maskString(value.message),
      };

      if (isAppError(value)) {
        serialized.code = value.code;
        serialized.context = sanitizeValue(value.context, sensitiveKeys, seen);
      } else if ('code' in value && typeof (value as { code?: unknown }).code === 'string') {
        serialized.code = (value as { code: string }).code;
      }

      if (value.stack) {
        serialized.stack = maskString(value.stack);
      }

      return serialized;
    }

    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKey(k, sensitiveKeys)) {
        result[k] = '[REDACTED]';
      } else {
        result[k] = sanitizeValue(v, sensitiveKeys, seen);
      }
    }
    return result;
  }

  return String(value);
}

export function formatLogLine(entry: LogEntry): string {
  return JSON.stringify(entry) + '\n';
}

function resolveLogLevel(level?: LogLevel): LogLevel {
  if (level && level in LOG_LEVEL_PRIORITIES) {
    return level;
  }

  const envLevel = process.env['LOG_LEVEL']?.toLowerCase() as LogLevel | undefined;
  if (envLevel && envLevel in LOG_LEVEL_PRIORITIES) {
    return envLevel;
  }

  return 'info';
}

class JsonLogger implements Logger {
  public readonly level: LogLevel;
  public readonly defaultContext: Record<string, unknown>;
  private readonly destination: (line: string) => void;
  private readonly redactKeys: string[];

  constructor(options: LoggerOptions = {}) {
    this.level = resolveLogLevel(options.level);
    this.destination =
      options.destination ??
      ((line: string) => {
        process.stdout.write(line);
      });
    this.defaultContext = options.defaultContext ?? {};
    this.redactKeys = options.redactKeys
      ? [...new Set([...DEFAULT_REDACT_KEYS, ...options.redactKeys.map((k) => k.toLowerCase())])]
      : DEFAULT_REDACT_KEYS;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITIES[level] >= LOG_LEVEL_PRIORITIES[this.level];
  }

  private emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const mergedContext = {
      ...this.defaultContext,
      ...(context ?? {}),
    };

    const sanitizedContext = sanitizeValue(mergedContext, this.redactKeys) as Record<
      string,
      unknown
    >;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: maskString(message),
      context: sanitizedContext,
    };

    const line = formatLogLine(entry);
    this.destination(line);
  }

  public debug(message: string, context?: Record<string, unknown>): void {
    this.emit('debug', message, context);
  }

  public info(message: string, context?: Record<string, unknown>): void {
    this.emit('info', message, context);
  }

  public warn(message: string, context?: Record<string, unknown>): void {
    this.emit('warn', message, context);
  }

  public error(message: string, errorOrContext?: unknown, context?: Record<string, unknown>): void {
    let errorObj: unknown = undefined;
    let explicitContext: Record<string, unknown> = {};

    if (errorOrContext !== undefined && errorOrContext !== null) {
      if (
        errorOrContext instanceof Error ||
        (typeof errorOrContext === 'object' &&
          'name' in errorOrContext &&
          'message' in errorOrContext)
      ) {
        errorObj = errorOrContext;
        explicitContext = context ?? {};
      } else if (typeof errorOrContext === 'object' && !Array.isArray(errorOrContext)) {
        explicitContext = {
          ...(errorOrContext as Record<string, unknown>),
          ...(context ?? {}),
        };
      } else {
        errorObj = errorOrContext;
        explicitContext = context ?? {};
      }
    } else if (context !== undefined) {
      explicitContext = context;
    }

    const mergedContext: Record<string, unknown> = {
      ...explicitContext,
    };

    if (errorObj !== undefined) {
      mergedContext['error'] = sanitizeValue(errorObj, this.redactKeys);
    }

    this.emit('error', message, mergedContext);
  }

  public child(childContext: Record<string, unknown>): Logger {
    return new JsonLogger({
      level: this.level,
      destination: this.destination,
      defaultContext: {
        ...this.defaultContext,
        ...childContext,
      },
      redactKeys: this.redactKeys,
    });
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new JsonLogger(options);
}

export const logger = createLogger();
