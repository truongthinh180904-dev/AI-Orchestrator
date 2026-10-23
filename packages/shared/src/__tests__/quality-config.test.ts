import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseCommandLine,
  normalizeQualityCommand,
  resolveRepoQualityConfig,
  getExecutionPipeline,
  RepoQualityConfigSchema,
  type ParsedConfig,
} from '../index.js';

describe('QLT-001: Quality Command Configuration', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlt-001-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('parseCommandLine', () => {
    it('splits simple commands into executable and arguments', () => {
      const result = parseCommandLine('pnpm test');
      expect(result).toEqual({ exe: 'pnpm', args: ['test'] });
    });

    it('handles multiple arguments and flags', () => {
      const result = parseCommandLine('pnpm vitest run --coverage --reporter=dot');
      expect(result).toEqual({
        exe: 'pnpm',
        args: ['vitest', 'run', '--coverage', '--reporter=dot'],
      });
    });

    it('preserves single-quoted strings with spaces', () => {
      const result = parseCommandLine("git commit -m 'feat: add quality gate config'");
      expect(result).toEqual({
        exe: 'git',
        args: ['commit', '-m', 'feat: add quality gate config'],
      });
    });

    it('preserves double-quoted strings with spaces', () => {
      const result = parseCommandLine('node -e "console.log(\'hello\')"');
      expect(result).toEqual({
        exe: 'node',
        args: ['-e', "console.log('hello')"],
      });
    });

    it('handles escaped spaces', () => {
      const result = parseCommandLine('my\\ app/bin run\\ tests');
      expect(result).toEqual({
        exe: 'my app/bin',
        args: ['run tests'],
      });
    });

    it('throws AppError on empty command', () => {
      expect(() => parseCommandLine('')).toThrow(/Command line cannot be empty/);
      expect(() => parseCommandLine('   ')).toThrow(/Command line cannot be empty/);
    });

    it('throws AppError on unclosed single or double quotes', () => {
      expect(() => parseCommandLine("pnpm test 'unclosed")).toThrow(/unclosed quote/);
      expect(() => parseCommandLine('pnpm test "unclosed')).toThrow(/unclosed quote/);
    });

    it('throws AppError on dangling escape backslash', () => {
      expect(() => parseCommandLine('pnpm test \\')).toThrow(/trailing dangling escape backslash/);
    });
  });

  describe('normalizeQualityCommand', () => {
    it('normalizes string command with defaults', () => {
      const cmd = normalizeQualityCommand('lint', 'pnpm eslint .', { cwd: tempDir });
      expect(cmd).not.toBeNull();
      expect(cmd?.id).toBe('lint-cmd');
      expect(cmd?.stage).toBe('lint');
      expect(cmd?.exe).toBe('pnpm');
      expect(cmd?.args).toEqual(['eslint', '.']);
      expect(cmd?.cwd).toBe(tempDir);
      expect(cmd?.required).toBe(true);
      expect(cmd?.enabled).toBe(true);
      expect(cmd?.timeout_ms).toBe(120_000);
    });

    it('normalizes array command', () => {
      const cmd = normalizeQualityCommand('test', ['pnpm', 'vitest', 'run'], { cwd: tempDir });
      expect(cmd?.exe).toBe('pnpm');
      expect(cmd?.args).toEqual(['vitest', 'run']);
      expect(cmd?.command).toBe('pnpm vitest run');
      expect(cmd?.required).toBe(true);
    });

    it('normalizes build stage with required: false by default', () => {
      const cmd = normalizeQualityCommand('build', 'pnpm build', { cwd: tempDir });
      expect(cmd?.stage).toBe('build');
      expect(cmd?.required).toBe(false);
    });

    it('preserves object properties and overrides', () => {
      const cmd = normalizeQualityCommand(
        'typecheck',
        {
          id: 'custom-typecheck',
          command: 'tsc --noEmit',
          timeout_ms: 60_000,
          required: false,
          continueOnError: true,
        },
        { cwd: tempDir },
      );
      expect(cmd?.id).toBe('custom-typecheck');
      expect(cmd?.exe).toBe('tsc');
      expect(cmd?.args).toEqual(['--noEmit']);
      expect(cmd?.timeout_ms).toBe(60_000);
      expect(cmd?.required).toBe(false);
      expect(cmd?.continueOnError).toBe(true);
    });

    it('returns null when input is null or undefined', () => {
      expect(normalizeQualityCommand('format', null)).toBeNull();
      expect(normalizeQualityCommand('format', undefined)).toBeNull();
    });
  });

  describe('resolveRepoQualityConfig from repo files', () => {
    it('reads configuration from quality.json in repository', () => {
      const configJson = {
        format: 'pnpm prettier --check .',
        lint: 'pnpm eslint .',
        typecheck: 'pnpm tsc --noEmit',
        test: 'pnpm vitest run',
        build: 'pnpm build',
        stop_on_first_failure: true,
      };
      fs.writeFileSync(path.join(tempDir, 'quality.json'), JSON.stringify(configJson, null, 2));

      const resolved = resolveRepoQualityConfig({ repoPath: tempDir });
      expect(resolved.format?.command).toBe('pnpm prettier --check .');
      expect(resolved.lint?.command).toBe('pnpm eslint .');
      expect(resolved.typecheck?.command).toBe('pnpm tsc --noEmit');
      expect(resolved.test?.command).toBe('pnpm vitest run');
      expect(resolved.build?.command).toBe('pnpm build');
      expect(resolved.stop_on_first_failure).toBe(true);
    });

    it('reads configuration from .orchestrator/quality.json', () => {
      const orchDir = path.join(tempDir, '.orchestrator');
      fs.mkdirSync(orchDir, { recursive: true });
      fs.writeFileSync(
        path.join(orchDir, 'quality.json'),
        JSON.stringify({
          format: 'npm run format:check',
          lint: 'npm run lint',
          test: 'npm test',
        }),
      );

      const resolved = resolveRepoQualityConfig({ repoPath: tempDir });
      expect(resolved.format?.exe).toBe('npm');
      expect(resolved.format?.args).toEqual(['run', 'format:check']);
      expect(resolved.lint?.command).toBe('npm run lint');
      expect(resolved.test?.command).toBe('npm test');
      expect(resolved.typecheck).toBeNull();
      expect(resolved.build).toBeNull();
    });

    it('reads configuration from package.json qualityGate property', () => {
      const pkgJson = {
        name: 'test-repo',
        version: '1.0.0',
        qualityGate: {
          format: 'pnpm format',
          lint: 'pnpm lint',
          typecheck: 'pnpm typecheck',
          test: 'pnpm test',
          build: 'pnpm build',
        },
      };
      fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

      const resolved = resolveRepoQualityConfig({ repoPath: tempDir });
      expect(resolved.format?.command).toBe('pnpm format');
      expect(resolved.lint?.command).toBe('pnpm lint');
      expect(resolved.typecheck?.command).toBe('pnpm typecheck');
      expect(resolved.test?.command).toBe('pnpm test');
      expect(resolved.build?.command).toBe('pnpm build');
    });

    it('auto-detects commands from package.json scripts when no explicit quality config exists', () => {
      fs.writeFileSync(path.join(tempDir, 'pnpm-lock.yaml'), '');
      const pkgJson = {
        name: 'test-auto-repo',
        scripts: {
          'format:check': 'prettier --check .',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
          test: 'vitest run',
          build: 'tsup',
        },
      };
      fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify(pkgJson, null, 2));

      const resolved = resolveRepoQualityConfig({ repoPath: tempDir });
      expect(resolved.format?.command).toBe('pnpm format:check');
      expect(resolved.lint?.command).toBe('pnpm lint');
      expect(resolved.typecheck?.command).toBe('pnpm typecheck');
      expect(resolved.test?.command).toBe('pnpm test');
      expect(resolved.build?.command).toBe('pnpm build');
    });
  });

  describe('resolveRepoQualityConfig with workbook config and overrides', () => {
    it('reads configuration from Workbook ParsedConfig settings and verify_commands', () => {
      const mockWorkbookConfig: ParsedConfig = {
        repository: '.',
        agy_bin: 'agy',
        agy_args: '-p',
        verify_commands: [
          'pnpm format:check',
          'pnpm lint',
          'pnpm typecheck',
          'pnpm test',
          'pnpm build',
          'pnpm custom-verify',
        ],
        max_attempts: 3,
        timeout_minutes: 30,
        max_concurrency: 1,
        settings: {
          format_command: 'pnpm prettier --check .',
        },
        raw: {},
      };

      const resolved = resolveRepoQualityConfig({
        repoPath: tempDir,
        workbookConfig: mockWorkbookConfig,
      });

      // format_command in settings overrides verify_commands format
      expect(resolved.format?.command).toBe('pnpm prettier --check .');
      expect(resolved.lint?.command).toBe('pnpm lint');
      expect(resolved.typecheck?.command).toBe('pnpm typecheck');
      expect(resolved.test?.command).toBe('pnpm test');
      expect(resolved.build?.command).toBe('pnpm build');
      expect(resolved.custom_commands.length).toBe(1);
      expect(resolved.custom_commands[0]?.command).toBe('pnpm custom-verify');
    });

    it('applies taskTestCommands to override the test stage', () => {
      const configJson = {
        format: 'pnpm format',
        lint: 'pnpm lint',
        test: 'pnpm test:all',
      };
      fs.writeFileSync(path.join(tempDir, 'quality.json'), JSON.stringify(configJson, null, 2));

      const resolved = resolveRepoQualityConfig({
        repoPath: tempDir,
        taskTestCommands: ['pnpm vitest run src/specific.test.ts', 'pnpm vitest run src/extra.test.ts'],
      });

      expect(resolved.test?.command).toBe('pnpm vitest run src/specific.test.ts');
      expect(resolved.custom_commands.length).toBe(1);
      expect(resolved.custom_commands[0]?.command).toBe('pnpm vitest run src/extra.test.ts');
    });

    it('explicit overrides take precedence over repo files and workbook', () => {
      fs.writeFileSync(
        path.join(tempDir, 'quality.json'),
        JSON.stringify({
          format: 'pnpm format',
          lint: 'pnpm lint',
          test: 'pnpm test',
        }),
      );

      const resolved = resolveRepoQualityConfig({
        repoPath: tempDir,
        overrides: {
          test: 'vitest run --bail 1',
          stop_on_first_failure: false,
        },
      });

      expect(resolved.format?.command).toBe('pnpm format');
      expect(resolved.lint?.command).toBe('pnpm lint');
      expect(resolved.test?.command).toBe('vitest run --bail 1');
      expect(resolved.stop_on_first_failure).toBe(false);
    });
  });

  describe('getExecutionPipeline', () => {
    it('returns an ordered list of enabled commands in standard order: format -> lint -> typecheck -> test -> build -> custom', () => {
      const resolved = RepoQualityConfigSchema.parse({
        repo_path: tempDir,
        format: normalizeQualityCommand('format', 'pnpm format', { cwd: tempDir }),
        lint: normalizeQualityCommand('lint', 'pnpm lint', { cwd: tempDir }),
        typecheck: normalizeQualityCommand('typecheck', 'pnpm typecheck', { cwd: tempDir }),
        test: normalizeQualityCommand('test', 'pnpm test', { cwd: tempDir }),
        build: normalizeQualityCommand('build', 'pnpm build', { cwd: tempDir }),
        custom_commands: [
          normalizeQualityCommand('custom', 'pnpm audit', { cwd: tempDir })!,
        ],
      });

      const pipeline = getExecutionPipeline(resolved);
      expect(pipeline.map((c) => c.stage)).toEqual([
        'format',
        'lint',
        'typecheck',
        'test',
        'build',
        'custom',
      ]);
    });

    it('skips disabled commands and null stages', () => {
      const formatCmd = normalizeQualityCommand('format', 'pnpm format', { cwd: tempDir })!;
      formatCmd.enabled = false;

      const resolved = RepoQualityConfigSchema.parse({
        repo_path: tempDir,
        format: formatCmd,
        lint: normalizeQualityCommand('lint', 'pnpm lint', { cwd: tempDir }),
        typecheck: null,
        test: normalizeQualityCommand('test', 'pnpm test', { cwd: tempDir }),
        build: null,
        custom_commands: [],
      });

      const pipeline = getExecutionPipeline(resolved);
      expect(pipeline.map((c) => c.stage)).toEqual(['lint', 'test']);
    });
  });
});
