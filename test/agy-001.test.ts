import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  processAdapter,
  type ProcessHandle,
} from '../apps/orchestrator/src/adapters/process-adapter.js';
import { AppError, isAppError } from '../packages/shared/src/index.js';

describe('AGY-001 Acceptance Tests: ProcessAdapter: spawn(exe, args[]), cwd, env whitelist, trả handle — Không dùng shell; test với node -e', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy001-acceptance-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('Nghiệm thu 1: spawn(exe, args[]) và trả về ProcessHandle', () => {
    it('nhận mảng tách biệt exe và args[], khởi tạo tiến trình và trả handle đầy đủ thuộc tính', async () => {
      const handle: ProcessHandle = processAdapter.spawn({
        exe: 'node',
        args: ['-e', 'console.log("handle-ok")'],
        cwd: tmpDir,
      });

      expect(handle).toBeDefined();
      expect(handle.pid).toBeTypeOf('number');
      expect(handle.pid).toBeGreaterThan(0);
      expect(handle.startedAt).toBeInstanceOf(Date);
      expect(handle.command.exe).toBe('node');
      expect(handle.command.args).toEqual(['-e', 'console.log("handle-ok")']);
      expect(handle.command.cwd).toBe(tmpDir);
      expect(handle.stdout).toBeDefined();
      expect(handle.stderr).toBeDefined();
      expect(handle.isRunning()).toBe(true);

      let output = '';
      handle.stdout.on('data', (c: Buffer) => {
        output += c.toString();
      });

      const exitResult = await handle.waitForExit();
      expect(exitResult.exitCode).toBe(0);
      expect(exitResult.signal).toBeNull();
      expect(exitResult.durationMs).toBeGreaterThanOrEqual(0);
      expect(output.trim()).toBe('handle-ok');
      expect(handle.isRunning()).toBe(false);
      expect(handle.getExitResult()).toEqual(exitResult);
    });

    it('từ chối input nếu args không phải mảng (chống ghép chuỗi lệnh)', () => {
      let thrown: unknown;
      try {
        processAdapter.spawn({
          exe: 'node',
          args: '-e console.log("string")' as unknown as string[],
          cwd: tmpDir,
        });
      } catch (err) {
        thrown = err;
      }
      expect(isAppError(thrown)).toBe(true);
      expect((thrown as AppError).code).toBe('INVALID_COMMAND');
    });
  });

  describe('Nghiệm thu 2: Không dùng shell (Tuyệt đối shell: false)', () => {
    it('không cho phép shell command chaining bằng toán tử && hoặc ;', async () => {
      // Khi shell: false, '&&' được chuyển trực tiếp vào node làm đối số, không bị shell tách lệnh
      const handle = processAdapter.spawn({
        exe: 'node',
        args: [
          '-e',
          'process.stdout.write("CMD1");',
          '&&',
          'node',
          '-e',
          'process.stdout.write("CMD2");',
        ],
        cwd: tmpDir,
      });

      let stdout = '';
      handle.stdout.on('data', (c: Buffer) => {
        stdout += c.toString();
      });

      const result = await handle.waitForExit();
      expect(result.exitCode).toBe(0);
      // Chỉ CMD1 được thực thi từ node -e, chuỗi && node -e CMD2 bị coi là đối số thường (process.argv)
      expect(stdout).toBe('CMD1');
      expect(stdout).not.toContain('CMD2');
    });

    it('không nội suy biến môi trường kiểu shell ($VAR)', async () => {
      const handle = processAdapter.spawn({
        exe: 'node',
        args: ['-e', 'process.stdout.write(process.argv[1]);', '$MY_SHELL_VAR'],
        cwd: tmpDir,
      });

      let stdout = '';
      handle.stdout.on('data', (c: Buffer) => {
        stdout += c.toString();
      });

      const result = await handle.waitForExit();
      expect(result.exitCode).toBe(0);
      // Kết quả phải là chuỗi ký tự nguyên bản '$MY_SHELL_VAR', không bị shell thay thế
      expect(stdout).toBe('$MY_SHELL_VAR');
    });

    it('không cho phép chuyển hướng file bằng toán tử shell redirection (>)', async () => {
      const targetFilePath = path.join(tmpDir, 'hacker_output.txt');

      const handle = processAdapter.spawn({
        exe: 'node',
        args: ['-e', 'console.log("leak")', '>', targetFilePath],
        cwd: tmpDir,
      });

      await handle.waitForExit();

      // File không được tạo vì '>' chỉ là đối số dòng lệnh, không phải file descriptor redirection
      expect(fs.existsSync(targetFilePath)).toBe(false);
    });
  });

  describe('Nghiệm thu 3: Test với node -e (Chụp stdout, stderr, exit code)', () => {
    it('kiểm tra chạy lệnh thành công và đọc độc lập stdout và stderr', async () => {
      const handle = processAdapter.spawn({
        exe: 'node',
        args: [
          '-e',
          'process.stdout.write("test-stdout-line\\n"); process.stderr.write("test-stderr-line\\n");',
        ],
        cwd: tmpDir,
      });

      let stdout = '';
      let stderr = '';

      handle.stdout.on('data', (c: Buffer) => {
        stdout += c.toString();
      });
      handle.stderr.on('data', (c: Buffer) => {
        stderr += c.toString();
      });

      const exitResult = await handle.waitForExit();
      expect(exitResult.exitCode).toBe(0);
      expect(stdout.trim()).toBe('test-stdout-line');
      expect(stderr.trim()).toBe('test-stderr-line');
    });

    it('kiểm tra mã thoát khác 0 (non-zero exit code)', async () => {
      const handle = processAdapter.spawn({
        exe: 'node',
        args: ['-e', 'process.exit(77)'],
        cwd: tmpDir,
      });

      const result = await handle.waitForExit();
      expect(result.exitCode).toBe(77);
      expect(result.signal).toBeNull();
      expect(handle.isRunning()).toBe(false);
    });

    it('kiểm tra ngắt tiến trình đang chạy bằng tín hiệu SIGTERM', async () => {
      const handle = processAdapter.spawn({
        exe: 'node',
        args: ['-e', 'setInterval(() => {}, 500)'],
        cwd: tmpDir,
      });

      expect(handle.isRunning()).toBe(true);

      // Cho phép process khởi động
      await new Promise((r) => setTimeout(r, 60));

      const killed = handle.kill('SIGTERM');
      expect(killed).toBe(true);

      const result = await handle.waitForExit();
      expect(result.signal).toBe('SIGTERM');
      expect(handle.isRunning()).toBe(false);
    });
  });

  describe('Nghiệm thu 4: Env whitelist an toàn (Lọc secret, không lộ token)', () => {
    it('loại bỏ triệt để biến môi trường nhạy cảm khỏi tiến trình con', async () => {
      process.env.APP_SECRET_TOKEN = 'secret-token-xyz-12345';
      process.env.DB_PASSWORD = 'super-secret-password-999';

      try {
        const handle = processAdapter.spawn({
          exe: 'node',
          args: ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
          cwd: tmpDir,
        });

        let output = '';
        handle.stdout.on('data', (c: Buffer) => {
          output += c.toString();
        });

        const result = await handle.waitForExit();
        expect(result.exitCode).toBe(0);

        const childEnv = JSON.parse(output) as Record<string, string>;

        // Biến nhạy cảm không xuất hiện trong env của child process
        expect(childEnv.APP_SECRET_TOKEN).toBeUndefined();
        expect(childEnv.DB_PASSWORD).toBeUndefined();

        // Biến an toàn trong whitelist vẫn được bảo tồn
        expect(childEnv.PATH).toBeDefined();
      } finally {
        delete process.env.APP_SECRET_TOKEN;
        delete process.env.DB_PASSWORD;
      }
    });

    it('cho phép nạp biến chủ đích qua command.env hoặc extraEnvWhitelist', async () => {
      process.env.AGENT_SPECIAL_VAR = 'special_value';

      try {
        const handle = processAdapter.spawn({
          exe: 'node',
          args: [
            '-e',
            'process.stdout.write(JSON.stringify({ explicit: process.env.CUSTOM_EXPLICIT, extra: process.env.AGENT_SPECIAL_VAR }))',
          ],
          cwd: tmpDir,
          env: {
            CUSTOM_EXPLICIT: 'explicit_ok',
          },
          extraEnvWhitelist: ['AGENT_SPECIAL_VAR'],
        });

        let output = '';
        handle.stdout.on('data', (c: Buffer) => {
          output += c.toString();
        });

        const result = await handle.waitForExit();
        expect(result.exitCode).toBe(0);

        const parsed = JSON.parse(output) as { explicit?: string; extra?: string };
        expect(parsed.explicit).toBe('explicit_ok');
        expect(parsed.extra).toBe('special_value');
      } finally {
        delete process.env.AGENT_SPECIAL_VAR;
      }
    });
  });

  describe('Nghiệm thu 5: Kiểm tra và từ chối cwd không hợp lệ', () => {
    it('quăng lỗi AppError INVALID_WORKING_DIRECTORY khi cwd không tồn tại', () => {
      const nonExistentPath = path.join(tmpDir, 'non_existent_dir_999');

      let thrownError: AppError | undefined;
      try {
        processAdapter.spawn({
          exe: 'node',
          args: ['-v'],
          cwd: nonExistentPath,
        });
      } catch (err) {
        if (isAppError(err)) thrownError = err;
      }

      expect(thrownError).toBeDefined();
      expect(thrownError?.code).toBe('INVALID_WORKING_DIRECTORY');
    });

    it('quăng lỗi AppError INVALID_WORKING_DIRECTORY khi cwd là file chứ không phải thư mục', () => {
      const filePath = path.join(tmpDir, 'some-file.txt');
      fs.writeFileSync(filePath, 'sample content');

      let thrownError: AppError | undefined;
      try {
        processAdapter.spawn({
          exe: 'node',
          args: ['-v'],
          cwd: filePath,
        });
      } catch (err) {
        if (isAppError(err)) thrownError = err;
      }

      expect(thrownError).toBeDefined();
      expect(thrownError?.code).toBe('INVALID_WORKING_DIRECTORY');
    });
  });
});
