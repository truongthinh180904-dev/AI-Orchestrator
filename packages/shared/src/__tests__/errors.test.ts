import { describe, expect, it } from 'vitest';
import { AppError, isAppError, toAppError } from '../errors.js';

describe('AppError', () => {
  it('instantiates correctly with code, message, and context', () => {
    const error = new AppError('TASK_NOT_FOUND', 'Task TSK-001 not found', {
      taskId: 'TSK-001',
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppError);
    expect(error.name).toBe('AppError');
    expect(error.code).toBe('TASK_NOT_FOUND');
    expect(error.message).toBe('Task TSK-001 not found');
    expect(error.context).toEqual({ taskId: 'TSK-001' });
  });

  it('provides default empty context when omitted', () => {
    const error = new AppError('UNKNOWN_ERROR', 'Something broke');
    expect(error.context).toEqual({});
  });

  it('serializes to JSON correctly via toJSON', () => {
    const error = new AppError('VALIDATION_FAILED', 'Invalid input', { field: 'name' });
    const json = error.toJSON();

    expect(json.name).toBe('AppError');
    expect(json.code).toBe('VALIDATION_FAILED');
    expect(json.message).toBe('Invalid input');
    expect(json.context).toEqual({ field: 'name' });
    expect(json.stack).toBeDefined();
  });

  it('isAppError detects AppError instances correctly', () => {
    const appErr = new AppError('TEST_CODE', 'test message');
    const standardErr = new Error('standard error');

    expect(isAppError(appErr)).toBe(true);
    expect(isAppError(standardErr)).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError(undefined)).toBe(false);
    expect(isAppError('string error')).toBe(false);
    expect(isAppError({ name: 'AppError', code: 'CUSTOM' })).toBe(true);
  });

  it('toAppError converts various inputs into AppError', () => {
    const original = new AppError('ALREADY_APP_ERROR', 'existing');
    expect(toAppError(original)).toBe(original);

    const fromError = toAppError(new Error('native error message'), 'NATIVE_ERR');
    expect(fromError).toBeInstanceOf(AppError);
    expect(fromError.code).toBe('NATIVE_ERR');
    expect(fromError.message).toBe('native error message');
    expect(fromError.context['originalName']).toBe('Error');

    const fromString = toAppError('plain text error', 'STRING_ERR');
    expect(fromString).toBeInstanceOf(AppError);
    expect(fromString.code).toBe('STRING_ERR');
    expect(fromString.message).toBe('plain text error');

    const fromUnknown = toAppError({ foo: 'bar' }, 'UNKNOWN');
    expect(fromUnknown).toBeInstanceOf(AppError);
    expect(fromUnknown.code).toBe('UNKNOWN');
    expect(fromUnknown.context['rawError']).toEqual({ foo: 'bar' });
  });
});
