import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError, loadEnv, validateEnv } from '../packages/shared/src/index.js';
import { getOrchestratorConfig } from '../apps/orchestrator/src/index.js';

describe('FND-005: Load env bằng zod, .env.example, .gitignore chặn .env', () => {
  describe('Nghiệm thu 1: Thiếu biến bắt buộc → báo lỗi rõ', () => {
    it('Báo lỗi rõ ràng khi thiếu biến bắt buộc DATABASE_PATH', () => {
      let caughtError: AppError | undefined;
      try {
        validateEnv({});
      } catch (err) {
        if (err instanceof AppError) {
          caughtError = err;
        }
      }

      expect(caughtError).toBeDefined();
      expect(caughtError?.code).toBe('ENV_VALIDATION_ERROR');
      expect(caughtError?.message).toContain('Missing or invalid environment configuration');
      expect(caughtError?.message).toContain('[DATABASE_PATH]');
      expect(caughtError?.message).toContain('DATABASE_PATH is required');

      const issues = caughtError?.context['issues'] as Array<{ path: string; message: string }>;
      expect(issues.some((issue) => issue.path === 'DATABASE_PATH')).toBe(true);
    });

    it('Báo lỗi rõ ràng khi DATABASE_PATH là chuỗi rỗng', () => {
      let caughtError: AppError | undefined;
      try {
        validateEnv({ DATABASE_PATH: '' });
      } catch (err) {
        if (err instanceof AppError) {
          caughtError = err;
        }
      }

      expect(caughtError).toBeDefined();
      expect(caughtError?.code).toBe('ENV_VALIDATION_ERROR');
      expect(caughtError?.message).toContain('DATABASE_PATH cannot be empty');
    });

    it('Báo lỗi rõ ràng khi biến có định dạng sai (ví dụ PORT không phải số)', () => {
      let caughtError: AppError | undefined;
      try {
        validateEnv({
          DATABASE_PATH: ':memory:',
          PORT: 'not-a-valid-port',
        });
      } catch (err) {
        if (err instanceof AppError) {
          caughtError = err;
        }
      }

      expect(caughtError).toBeDefined();
      expect(caughtError?.code).toBe('ENV_VALIDATION_ERROR');
      expect(caughtError?.message).toContain('[PORT]');
    });
  });

  describe('Nghiệm thu 2: không secret trong git (.gitignore chặn .env, .env.example không chứa secret)', () => {
    it('.gitignore chặn file .env và các biến thể .env.*', () => {
      const gitignoreContent = fs.readFileSync(path.resolve('.gitignore'), 'utf-8');
      expect(gitignoreContent).toMatch(/^\.env$/m);
      expect(gitignoreContent).toMatch(/^\.env\.\*$/m);

      const checkIgnoredEnv = execSync('git check-ignore .env .env.local .env.production', {
        encoding: 'utf-8',
      });
      expect(checkIgnoredEnv).toContain('.env');
      expect(checkIgnoredEnv).toContain('.env.local');
      expect(checkIgnoredEnv).toContain('.env.production');
    });

    it('.gitignore không chặn file mẫu .env.example', () => {
      const gitignoreContent = fs.readFileSync(path.resolve('.gitignore'), 'utf-8');
      expect(gitignoreContent).toMatch(/^!\.env\.example$/m);

      // git check-ignore trả về exit code 1 khi file KHÔNG bị bỏ qua
      expect(() => {
        execSync('git check-ignore .env.example', { encoding: 'utf-8', stdio: 'pipe' });
      }).toThrow();
    });

    it('Không có file .env nào đang được Git theo dõi (git ls-files)', () => {
      const trackedFiles = execSync('git ls-files', { encoding: 'utf-8' })
        .split('\n')
        .filter((file) => file.trim().length > 0);

      const trackedEnvFiles = trackedFiles.filter(
        (file) => file === '.env' || (file.startsWith('.env.') && file !== '.env.example'),
      );

      expect(trackedEnvFiles).toEqual([]);
    });

    it('.env.example tồn tại, chứa đầy đủ template biến cần thiết và không có secret thật', () => {
      const examplePath = path.resolve('.env.example');
      expect(fs.existsSync(examplePath)).toBe(true);

      const exampleContent = fs.readFileSync(examplePath, 'utf-8');

      // Chứa các biến mẫu cấu hình hệ thống
      expect(exampleContent).toContain('DATABASE_PATH=');
      expect(exampleContent).toContain('NODE_ENV=');
      expect(exampleContent).toContain('PORT=');
      expect(exampleContent).toContain('HOST=');
      expect(exampleContent).toContain('LOG_LEVEL=');
      expect(exampleContent).toContain('AGY_BIN=');

      // Tuyệt đối không chứa secret thật (như token GitHub, API key sk-..., private keys)
      expect(exampleContent).not.toMatch(/ghp_[A-Za-z0-9_]{30,}/);
      expect(exampleContent).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
      expect(exampleContent).not.toContain('BEGIN PRIVATE KEY');
      expect(exampleContent).not.toContain('BEGIN RSA PRIVATE KEY');
    });
  });

  describe('Tích hợp module orchestrator và loadEnv', () => {
    it('Orchestrator có thể nạp cấu hình hợp lệ qua loadEnv', () => {
      const loaded = loadEnv({
        env: {
          DATABASE_PATH: ':memory:',
          PORT: '4200',
          NODE_ENV: 'test',
        },
      });

      expect(loaded.DATABASE_PATH).toBe(':memory:');
      expect(loaded.PORT).toBe(4200);
      expect(loaded.NODE_ENV).toBe('test');
      expect(loaded.HOST).toBe('127.0.0.1');
    });

    it('getOrchestratorConfig function được export từ apps/orchestrator', () => {
      expect(typeof getOrchestratorConfig).toBe('function');
    });
  });
});
