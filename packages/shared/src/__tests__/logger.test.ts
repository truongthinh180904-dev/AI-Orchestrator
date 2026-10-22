import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { createLogger, type LogEntry, sanitizeValue } from '../logger.js';

describe('Logger', () => {
  it('Test log đủ trường (Nghiệm thu FND-004)', () => {
    const lines: string[] = [];
    const logger = createLogger({
      destination: (line) => lines.push(line),
      level: 'debug',
    });

    logger.info('System initialized', { component: 'orchestrator', version: '0.1.0' });

    expect(lines.length).toBe(1);
    const line = lines[0];
    expect(line).toBeDefined();

    // Verify it ends with newline
    expect(line?.endsWith('\n')).toBe(true);

    const parsed = JSON.parse(line!) as LogEntry;

    // Check all required fields exist
    expect(parsed).toHaveProperty('timestamp');
    expect(parsed).toHaveProperty('level');
    expect(parsed).toHaveProperty('message');
    expect(parsed).toHaveProperty('context');

    // Check timestamp is valid ISO string
    expect(typeof parsed.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(parsed.timestamp))).toBe(false);

    // Check level, message, context contents
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('System initialized');
    expect(parsed.context).toEqual({
      component: 'orchestrator',
      version: '0.1.0',
    });
  });

  it('provides empty context object when none is supplied', () => {
    const lines: string[] = [];
    const logger = createLogger({
      destination: (line) => lines.push(line),
    });

    logger.warn('Warning with no context');

    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as LogEntry;

    expect(parsed.timestamp).toBeDefined();
    expect(parsed.level).toBe('warn');
    expect(parsed.message).toBe('Warning with no context');
    expect(parsed.context).toEqual({});
  });

  it('supports all log levels (debug, info, warn, error)', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'debug',
      destination: (line) => lines.push(line),
    });

    logger.debug('debug message', { step: 1 });
    logger.info('info message', { step: 2 });
    logger.warn('warn message', { step: 3 });
    logger.error('error message', { step: 4 });

    expect(lines.length).toBe(4);
    const levels = lines.map((l) => (JSON.parse(l) as LogEntry).level);
    expect(levels).toEqual(['debug', 'info', 'warn', 'error']);
  });

  it('filters out messages below current log level', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'warn',
      destination: (line) => lines.push(line),
    });

    logger.debug('should be ignored');
    logger.info('should also be ignored');
    logger.warn('should be logged');
    logger.error('should also be logged');

    expect(lines.length).toBe(2);
    const levels = lines.map((l) => (JSON.parse(l) as LogEntry).level);
    expect(levels).toEqual(['warn', 'error']);
  });

  it('redacts sensitive fields in context (không log secrets)', () => {
    const lines: string[] = [];
    const logger = createLogger({
      destination: (line) => lines.push(line),
    });

    logger.info('User authenticated', {
      user: 'alice',
      password: 'super-secret-password',
      token: 'jwt.token.here',
      apiKey: 'sk-1234567890abcdef1234567890',
      nested: {
        authorization: 'Bearer secret-jwt-bearer',
        safeKey: 'safe-value',
        cookie: 'session=xyz123',
      },
    });

    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as LogEntry;

    expect(parsed.context['user']).toBe('alice');
    expect(parsed.context['password']).toBe('[REDACTED]');
    expect(parsed.context['token']).toBe('[REDACTED]');
    expect(parsed.context['apiKey']).toBe('[REDACTED]');

    const nested = parsed.context['nested'] as Record<string, unknown>;
    expect(nested['authorization']).toBe('[REDACTED]');
    expect(nested['safeKey']).toBe('safe-value');
    expect(nested['cookie']).toBe('[REDACTED]');
  });

  it('masks Bearer tokens and API keys in messages and string values', () => {
    const lines: string[] = [];
    const logger = createLogger({
      destination: (line) => lines.push(line),
    });

    logger.info(
      'Request failed with header Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDc',
      {
        url: 'https://api.github.com',
        rawHeader: 'Bearer ghp_abcdefghijklmnopqrstuvwxyz1234567890',
      },
    );

    const parsed = JSON.parse(lines[0]!) as LogEntry;
    expect(parsed.message).toBe('Request failed with header Bearer [REDACTED]');
    expect(parsed.context['rawHeader']).toBe('Bearer [REDACTED]');
  });

  it('formats Error and AppError properly in logger.error', () => {
    const lines: string[] = [];
    const logger = createLogger({
      destination: (line) => lines.push(line),
    });

    const appError = new AppError('TASK_TIMEOUT', 'Execution exceeded limit', {
      timeoutMs: 30000,
      token: 'secret-token-in-error',
    });

    logger.error('Worker failed', appError, { taskId: 'TSK-005' });

    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as LogEntry;

    expect(parsed.level).toBe('error');
    expect(parsed.message).toBe('Worker failed');
    expect(parsed.context['taskId']).toBe('TSK-005');

    const errDetail = parsed.context['error'] as {
      name: string;
      code: string;
      message: string;
      context: Record<string, unknown>;
      stack?: string;
    };

    expect(errDetail).toBeDefined();
    expect(errDetail.name).toBe('AppError');
    expect(errDetail.code).toBe('TASK_TIMEOUT');
    expect(errDetail.message).toBe('Execution exceeded limit');
    expect(errDetail.context['timeoutMs']).toBe(30000);
    expect(errDetail.context['token']).toBe('[REDACTED]');
    expect(errDetail.stack).toBeDefined();
  });

  it('creates child logger that preserves and merges context', () => {
    const lines: string[] = [];
    const rootLogger = createLogger({
      destination: (line) => lines.push(line),
      defaultContext: { service: 'orchestrator' },
    });

    const taskLogger = rootLogger.child({ taskId: 'FND-004' });
    const runLogger = taskLogger.child({ runId: 'run-123' });

    runLogger.info('Starting run step', { step: 1 });

    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as LogEntry;

    expect(parsed.context).toEqual({
      service: 'orchestrator',
      taskId: 'FND-004',
      runId: 'run-123',
      step: 1,
    });
  });

  it('handles circular references gracefully without crashing', () => {
    const circularObj: Record<string, unknown> = { name: 'cyclic' };
    circularObj['self'] = circularObj;

    const sanitized = sanitizeValue(circularObj) as Record<string, unknown>;
    expect(sanitized['name']).toBe('cyclic');
    expect(sanitized['self']).toBe('[CIRCULAR]');

    const lines: string[] = [];
    const logger = createLogger({
      destination: (line) => lines.push(line),
    });

    expect(() => {
      logger.info('Cyclic test', { data: circularObj });
    }).not.toThrow();

    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as LogEntry;
    const data = parsed.context['data'] as Record<string, unknown>;
    expect(data['self']).toBe('[CIRCULAR]');
  });
});
