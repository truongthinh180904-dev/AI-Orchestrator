import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createProcessAdapter, processAdapter } from '../adapters/process-adapter.js';
import { AppError } from '@ai-orchestrator/shared';

describe('ProcessAdapter Unit Tests', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'process-adapter-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('spawn with node -e (Basic execution & handles)', () => {
    it('spawns a process with node -e, returns valid handle, and captures stdout', async () => {
      const handle = processAdapter.spawn({
        exe: 'node',
        args: ['-e', 'console.log("hello from process adapter")'],
        cwd: tmpDir,
      });

      expect(handle.pid).toBeTypeOf('number');
      expect(handle.pid).toBeGreaterThan(0);
      expect(handle.isRunning()).toBe(true);
      expect(handle.command.exe).toBe('node');
      expect(handle.startedAt).toBeInstanceOf(Date);

      let stdoutData = '';
      handle.stdout.on('data', (chunk: Buffer) => {
        stdoutData += chunk.toString();
      });

      const result = await handle.waitForExit();

      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(stdoutData.trim()).toBe('hello from process adapter');
      expect(handle.isRunning()).toBe(false);
      expect(handle.getExitResult()).toEqual(result);
    });

    it('captures stderr from node -e independently from stdout', async () => {
      const handle = processAdapter.spawn({
        exe: 'node',
        args: [
          '-e',
          'process.stdout.write("standard-out\\n"); process.stderr.write("standard-err\\n");',
        ],
        cwd: tmpDir,
      });

      let stdout = '';
      let stderr = '';

      handle.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      handle.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const result = await handle.waitForExit();

      expect(result.exitCode).toBe(0);
      expect(stdout.trim()).toBe('standard-out');
      expect(stderr.trim()).toBe('standard-err');
    });

    it('captures non-zero exit codes correctly', async () => {
      const handle = processAdapter.spawn({
        exe: 'node',
        args: ['-e', 'process.exit(42)'],
        cwd: tmpDir,
      });

      const result = await handle.waitForExit();

      expect(result.exitCode).toBe(42);
      expect(result.signal).toBeNull();
      expect(handle.isRunning()).toBe(false);
    });

    it('supports alternative spawn argument overload (exe, args, cwd)', async () => {
      const handle = processAdapter.spawn('node', ['-e', 'console.log("overload works")'], tmpDir);

      let stdout = '';
      handle.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      const result = await handle.waitForExit();

      expect(result.exitCode).toBe(0);
      expect(stdout.trim()).toBe('overload works');
    });

    it('streams event data via handle event emitter (stdout, stderr, exit, close)', async () => {
      const handle = processAdapter.spawn({
        exe: 'node',
        args: ['-e', 'console.log("ev-out"); console.error("ev-err");'],
        cwd: tmpDir,
      });

      let eventStdout = '';
      let eventStderr = '';
      let closeFired = false;

      handle.on('stdout', (chunk: Buffer) => {
        eventStdout += chunk.toString();
      });
      handle.on('stderr', (chunk: Buffer) => {
        eventStderr += chunk.toString();
      });
      handle.on('close', (code) => {
        closeFired = true;
        expect(code).toBe(0);
      });

      await handle.waitForExit();

      expect(eventStdout.trim()).toBe('ev-out');
      expect(eventStderr.trim()).toBe('ev-err');
      expect(closeFired).toBe(true);
    });
  });

  describe('Environment Whitelist Isolation', () => {
    it('isolates process.env and filters unwhitelisted secrets', async () => {
      const secretKey = 'SECRET_TOKEN_DO_NOT_LEAK_987654';
      const dbUrl = 'postgres://admin:topsecret@internal-db:5432/main';
      process.env.TEST_SECRET_TOKEN = secretKey;
      process.env.TEST_DB_URL = dbUrl;

      try {
        const handle = processAdapter.spawn({
          exe: 'node',
          args: ['-e', 'console.log(JSON.stringify(process.env))'],
          cwd: tmpDir,
        });

        let output = '';
        handle.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });

        const result = await handle.waitForExit();
        expect(result.exitCode).toBe(0);

        const childEnv = JSON.parse(output.trim()) as Record<string, string>;

        // Whitelisted safe vars are retained
        expect(childEnv.PATH).toBeDefined();

        // Sensitive vars NOT in whitelist are strictly excluded
        expect(childEnv.TEST_SECRET_TOKEN).toBeUndefined();
        expect(childEnv.TEST_DB_URL).toBeUndefined();
      } finally {
        delete process.env.TEST_SECRET_TOKEN;
        delete process.env.TEST_DB_URL;
      }
    });

    it('allows explicitly supplied environment variables in command.env', async () => {
      const handle = processAdapter.spawn({
        exe: 'node',
        args: ['-e', 'console.log(process.env.EXPLICIT_CONFIG_VAR)'],
        cwd: tmpDir,
        env: {
          EXPLICIT_CONFIG_VAR: 'orchestrator_custom_value',
        },
      });

      let output = '';
      handle.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });

      const result = await handle.waitForExit();
      expect(result.exitCode).toBe(0);
      expect(output.trim()).toBe('orchestrator_custom_value');
    });

    it('allows extra whitelist keys via command.extraEnvWhitelist', async () => {
      process.env.SPECIAL_FLAG_VAR = 'flag_value_abc';

      try {
        const handle = processAdapter.spawn({
          exe: 'node',
          args: ['-e', 'console.log(process.env.SPECIAL_FLAG_VAR)'],
          cwd: tmpDir,
          extraEnvWhitelist: ['SPECIAL_FLAG_VAR'],
        });

        let output = '';
        handle.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });

        const result = await handle.waitForExit();
        expect(result.exitCode).toBe(0);
        expect(output.trim()).toBe('flag_value_abc');
      } finally {
        delete process.env.SPECIAL_FLAG_VAR;
      }
    });

    it('allows custom whitelist and base environment in ProcessAdapter constructor', async () => {
      const customAdapter = createProcessAdapter({
        defaultEnvWhitelist: ['CUSTOM_ONLY_VAR', 'PATH'],
        baseEnv: {
          PATH: process.env.PATH,
          CUSTOM_ONLY_VAR: 'custom_adapter_val',
          FORBIDDEN_VAR: 'forbidden',
        },
      });

      const handle = customAdapter.spawn({
        exe: 'node',
        args: ['-e', 'console.log(JSON.stringify(process.env))'],
        cwd: tmpDir,
      });

      let output = '';
      handle.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });

      await handle.waitForExit();
      const parsed = JSON.parse(output.trim());
      expect(parsed.CUSTOM_ONLY_VAR).toBe('custom_adapter_val');
      expect(parsed.FORBIDDEN_VAR).toBeUndefined();
    });
  });

  describe('Shell Isolation (Không dùng shell)', () => {
    it('passes arguments as an array directly without shell command chaining (&&)', async () => {
      // In shell, 'node -e ... && node -e ...' executes both.
      // With shell: false, '&&' and following arguments are passed as arguments to node (process.argv).
      const handle = processAdapter.spawn({
        exe: 'node',
        args: [
          '-e',
          'console.log("ARG0=" + process.argv[1]); console.log("ARGV_LEN=" + process.argv.length);',
          '&&',
          'echo',
          'should_not_run_as_command',
        ],
        cwd: tmpDir,
      });

      let output = '';
      handle.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });

      const result = await handle.waitForExit();
      expect(result.exitCode).toBe(0);
      expect(output).toContain('ARG0=&&');
      expect(output).toContain('ARGV_LEN=4');
    });

    it('does not expand shell variables ($VAR)', async () => {
      const handle = processAdapter.spawn({
        exe: 'node',
        args: ['-e', 'console.log(process.argv[1])', '$PATH'],
        cwd: tmpDir,
      });

      let output = '';
      handle.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });

      const result = await handle.waitForExit();
      expect(result.exitCode).toBe(0);
      // Literal '$PATH' should be preserved, not expanded
      expect(output.trim()).toBe('$PATH');
    });

    it('does not interpret shell redirection (>)', async () => {
      const forbiddenFile = path.join(tmpDir, 'shell_redirect_test.txt');

      const handle = processAdapter.spawn({
        exe: 'node',
        args: ['-e', 'console.log("redirect_attempt")', '>', forbiddenFile],
        cwd: tmpDir,
      });

      const result = await handle.waitForExit();
      expect(result.exitCode).toBe(0);
      // File must NOT exist because '>' was treated as an argument, not redirection
      expect(fs.existsSync(forbiddenFile)).toBe(false);
    });

    it('does not interpret semicolon command separator (;)', async () => {
      const handle = processAdapter.spawn({
        exe: 'node',
        args: ['-e', 'console.log("main")', ';', 'process.exit(99)'],
        cwd: tmpDir,
      });

      const result = await handle.waitForExit();
      // Exit code is 0 because the second command was not executed by shell
      expect(result.exitCode).toBe(0);
    });
  });

  describe('Process Control & Lifecycle (kill, stop, error handling)', () => {
    it('terminates long-running process with handle.kill()', async () => {
      const handle = processAdapter.spawn({
        exe: 'node',
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: tmpDir,
      });

      expect(handle.isRunning()).toBe(true);

      // Allow process to start running
      await new Promise((r) => setTimeout(r, 50));

      const killed = handle.kill('SIGTERM');
      expect(killed).toBe(true);

      const result = await handle.waitForExit();
      expect(result.signal).toBe('SIGTERM');
      expect(handle.isRunning()).toBe(false);

      // Calling kill again on dead process returns false
      expect(handle.kill('SIGTERM')).toBe(false);
    });

    it('supports detached process option', async () => {
      const handle = processAdapter.spawn({
        exe: 'node',
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: tmpDir,
        detached: true,
      });

      expect(handle.command.detached).toBe(true);
      expect(handle.isRunning()).toBe(true);

      await new Promise((r) => setTimeout(r, 50));

      const killed = handle.kill('SIGTERM');
      expect(killed).toBe(true);

      const result = await handle.waitForExit();
      expect(handle.isRunning()).toBe(false);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('throws AppError when cwd does not exist', () => {
      const nonExistentDir = path.join(tmpDir, 'does-not-exist-' + Date.now());

      expect(() =>
        processAdapter.spawn({
          exe: 'node',
          args: ['-v'],
          cwd: nonExistentDir,
        }),
      ).toThrow(AppError);

      try {
        processAdapter.spawn({
          exe: 'node',
          args: ['-v'],
          cwd: nonExistentDir,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('INVALID_WORKING_DIRECTORY');
      }
    });

    it('throws AppError when cwd is a file instead of directory', () => {
      const filePath = path.join(tmpDir, 'a-file.txt');
      fs.writeFileSync(filePath, 'hello');

      expect(() =>
        processAdapter.spawn({
          exe: 'node',
          args: ['-v'],
          cwd: filePath,
        }),
      ).toThrow(AppError);

      try {
        processAdapter.spawn({
          exe: 'node',
          args: ['-v'],
          cwd: filePath,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('INVALID_WORKING_DIRECTORY');
      }
    });

    it('throws AppError when command schema is invalid (empty exe)', () => {
      expect(() =>
        processAdapter.spawn({
          exe: '',
          args: ['-v'],
          cwd: tmpDir,
        }),
      ).toThrow(AppError);

      try {
        processAdapter.spawn({
          exe: '',
          args: ['-v'],
          cwd: tmpDir,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('INVALID_COMMAND');
      }
    });

    it('rejects waitForExit with AppError when executable does not exist (ENOENT)', async () => {
      const nonExistentExe = 'non_existent_binary_xyz_12345';
      const handle = processAdapter.spawn({
        exe: nonExistentExe,
        args: ['--help'],
        cwd: tmpDir,
      });

      await expect(handle.waitForExit()).rejects.toThrow(AppError);

      try {
        await handle.waitForExit();
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('PROCESS_EXECUTION_ERROR');
      }
    });
  });
});
