import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError, loadEnv, loadEnvFile, parseEnv, validateEnv } from '../index.js';

describe('packages/shared: Environment validation & loader (FND-005)', () => {
  describe('Nghiệm thu FND-005: Thiếu biến bắt buộc → báo lỗi rõ', () => {
    it('Thiếu DATABASE_PATH ném AppError với code ENV_VALIDATION_ERROR và thông báo rõ ràng', () => {
      let thrownError: unknown;
      try {
        validateEnv({});
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeInstanceOf(AppError);
      const appErr = thrownError as AppError;
      expect(appErr.code).toBe('ENV_VALIDATION_ERROR');
      expect(appErr.message).toContain('Missing or invalid environment configuration');
      expect(appErr.message).toContain('[DATABASE_PATH]');
      expect(appErr.message).toContain('DATABASE_PATH is required');

      const issues = appErr.context['issues'] as Array<{ path: string; message: string }>;
      expect(Array.isArray(issues)).toBe(true);
      expect(issues.some((i) => i.path === 'DATABASE_PATH')).toBe(true);
    });

    it('DATABASE_PATH rỗng ném AppError với thông báo không được để trống', () => {
      expect(() => validateEnv({ DATABASE_PATH: '' })).toThrowError(
        /DATABASE_PATH cannot be empty/,
      );
    });
  });

  describe('Validation quy chuẩn các biến môi trường', () => {
    it('Gán giá trị mặc định chuẩn xác khi chỉ cung cấp biến bắt buộc', () => {
      const parsed = validateEnv({ DATABASE_PATH: './data/orchestrator.db' });
      expect(parsed).toEqual({
        NODE_ENV: 'development',
        PORT: 3000,
        HOST: '127.0.0.1',
        DATABASE_PATH: './data/orchestrator.db',
        LOG_LEVEL: 'info',
        AGY_BIN: 'agy',
        AGY_ARGS: undefined,
        NEXT_PUBLIC_ORCH_URL: undefined,
      });
    });

    it('Coerce PORT từ chuỗi thành số nguyên hợp lệ', () => {
      const parsed = validateEnv({
        DATABASE_PATH: ':memory:',
        PORT: '8080',
      });
      expect(parsed.PORT).toBe(8080);
      expect(typeof parsed.PORT).toBe('number');
    });

    it('Từ chối PORT không phải là số hợp lệ', () => {
      expect(() =>
        validateEnv({
          DATABASE_PATH: ':memory:',
          PORT: 'not-a-number',
        }),
      ).toThrowError(/PORT/);
    });

    it('Từ chối PORT nằm ngoài phạm vi 1-65535', () => {
      expect(() =>
        validateEnv({
          DATABASE_PATH: ':memory:',
          PORT: '0',
        }),
      ).toThrowError(/PORT must be between 1 and 65535/);

      expect(() =>
        validateEnv({
          DATABASE_PATH: ':memory:',
          PORT: '70000',
        }),
      ).toThrowError(/PORT must be between 1 and 65535/);
    });

    it('Từ chối NODE_ENV không hợp lệ', () => {
      expect(() =>
        validateEnv({
          DATABASE_PATH: ':memory:',
          NODE_ENV: 'staging',
        }),
      ).toThrowError(/NODE_ENV/);
    });

    it('Từ chối LOG_LEVEL không hợp lệ', () => {
      expect(() =>
        validateEnv({
          DATABASE_PATH: ':memory:',
          LOG_LEVEL: 'verbose',
        }),
      ).toThrowError(/LOG_LEVEL/);
    });
  });

  describe('parseEnv helper', () => {
    it('Parse đầy đủ các dạng comment, khoảng trắng, quotes và export', () => {
      const sample = `
# Đây là dòng ghi chú
NODE_ENV=production
  PORT = 4000
HOST="0.0.0.0" # comment cạnh dòng
DATABASE_PATH='./data/prod.db'
export AGY_BIN=custom-agy

# Dòng trống ở dưới

      `;

      const result = parseEnv(sample);
      expect(result).toEqual({
        NODE_ENV: 'production',
        PORT: '4000',
        HOST: '0.0.0.0',
        DATABASE_PATH: './data/prod.db',
        AGY_BIN: 'custom-agy',
      });
    });
  });

  describe('loadEnv & loadEnvFile', () => {
    it('loadEnvFile ném ENV_FILE_NOT_FOUND khi file không tồn tại', () => {
      expect(() => loadEnvFile('/path/to/non-existent-file.env')).toThrowError(
        /Environment configuration file not found/,
      );
      try {
        loadEnvFile('/path/to/non-existent-file.env');
      } catch (e) {
        expect((e as AppError).code).toBe('ENV_FILE_NOT_FOUND');
      }
    });

    it('loadEnv đọc từ file tạm và validate thành công mà không lỗi', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-test-'));
      const tempEnv = path.join(tempDir, '.env');
      try {
        fs.writeFileSync(tempEnv, 'DATABASE_PATH=./data/test.db\nPORT=5000\nNODE_ENV=test\n');

        const loaded = loadEnv({
          envFile: tempEnv,
          mutateProcessEnv: false,
        });

        expect(loaded.DATABASE_PATH).toBe('./data/test.db');
        expect(loaded.PORT).toBe(5000);
        expect(loaded.NODE_ENV).toBe('test');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
