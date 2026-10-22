import { describe, expect, it } from 'vitest';
import {
  AppError,
  createLogger,
  isAppError,
  toAppError,
  type LogEntry,
} from '../packages/shared/src/index.js';

describe('FND-004: Logger JSON (timestamp, level, context) + AppError', () => {
  it('Nghiệm thu FND-004: Test log đủ trường', () => {
    const logs: string[] = [];
    const testLogger = createLogger({
      destination: (line) => logs.push(line),
      level: 'debug',
    });

    testLogger.info('Task execution started', {
      taskId: 'FND-004',
      phase: 0,
    });

    expect(logs.length).toBe(1);
    const entry = JSON.parse(logs[0]!) as LogEntry;

    // Phải có đầy đủ các trường: timestamp, level, message, context
    expect(entry).toHaveProperty('timestamp');
    expect(entry).toHaveProperty('level');
    expect(entry).toHaveProperty('message');
    expect(entry).toHaveProperty('context');

    // Kiểm tra timestamp là chuỗi ISO hợp lệ
    expect(typeof entry.timestamp).toBe('string');
    expect(isNaN(Date.parse(entry.timestamp))).toBe(false);

    // Kiểm tra giá trị level và context
    expect(entry.level).toBe('info');
    expect(entry.message).toBe('Task execution started');
    expect(entry.context).toEqual({
      taskId: 'FND-004',
      phase: 0,
    });
  });

  it('AppError satisfies structure with code, message, context', () => {
    const err = new AppError('TEST_ERROR', 'A test error message', {
      detail: 'test detail',
    });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
    expect(err.name).toBe('AppError');
    expect(err.code).toBe('TEST_ERROR');
    expect(err.message).toBe('A test error message');
    expect(err.context).toEqual({ detail: 'test detail' });

    expect(isAppError(err)).toBe(true);
    expect(isAppError(new Error('native'))).toBe(false);

    const converted = toAppError(new Error('native error'), 'FALLBACK_CODE');
    expect(converted.code).toBe('FALLBACK_CODE');
    expect(converted.message).toBe('native error');
  });

  it('Logger ensures no secrets are logged in context or messages', () => {
    const logs: string[] = [];
    const testLogger = createLogger({
      destination: (line) => logs.push(line),
    });

    testLogger.warn('Auth check with Bearer secret-auth-token-12345', {
      token: 'super_secret_token',
      password: 'mypassword',
      nested: {
        apiKey: 'sk-abcdef1234567890abcdef1234567890',
        normalField: 'ok',
      },
    });

    const entry = JSON.parse(logs[0]!) as LogEntry;
    expect(entry.message).not.toContain('secret-auth-token-12345');
    expect(entry.message).toContain('Bearer [REDACTED]');

    expect(entry.context['token']).toBe('[REDACTED]');
    expect(entry.context['password']).toBe('[REDACTED]');
    const nested = entry.context['nested'] as Record<string, unknown>;
    expect(nested['apiKey']).toBe('[REDACTED]');
    expect(nested['normalField']).toBe('ok');
  });
});
