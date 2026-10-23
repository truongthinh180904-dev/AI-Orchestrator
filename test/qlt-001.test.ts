import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
} from '../packages/db/src/index.js';
import {
  buildServer,
  QualityConfigService,
  createRepositoryRegistry,
} from '../apps/orchestrator/src/index.js';
import {
  getExecutionPipeline,
  RepoQualityConfigSchema,
  type RepoQualityConfig,
  type ParsedConfig,
} from '../packages/shared/src/index.js';

describe('QLT-001 Acceptance Tests: Cấu hình lệnh kiểm định theo repo (format/lint/test/build) — Đọc từ config', () => {
  let db: Database.Database;
  let server: FastifyInstance;
  let taskRepo: TaskRepository;
  let qualityService: QualityConfigService;
  let tempRepoDir: string;
  let secondaryRepoDir: string;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);

    tempRepoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qlt-001-main-')));
    secondaryRepoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qlt-001-secondary-')));

    const repoRegistry = createRepositoryRegistry([tempRepoDir, secondaryRepoDir]);

    qualityService = new QualityConfigService({
      repositoryRegistry: repoRegistry,
      db,
    });

    server = await buildServer({
      db,
      repositoryRegistry: repoRegistry,
      qualityConfigService: qualityService,
    });
  });

  afterEach(async () => {
    await server.close();
    db.close();

    if (fs.existsSync(tempRepoDir)) {
      fs.rmSync(tempRepoDir, { recursive: true, force: true });
    }
    if (fs.existsSync(secondaryRepoDir)) {
      fs.rmSync(secondaryRepoDir, { recursive: true, force: true });
    }
  });

  describe('Nghiệm thu: Đọc từ config (Repo Configuration File)', () => {
    it('1. Đọc đầy đủ các lệnh kiểm định (format/lint/typecheck/test/build) từ quality.json trong repo', () => {
      const configData = {
        repo_id: 'my-custom-repo',
        format: 'pnpm prettier --check .',
        lint: 'pnpm eslint .',
        typecheck: 'pnpm tsc --noEmit',
        test: 'pnpm vitest run',
        build: 'pnpm build',
        stop_on_first_failure: true,
      };

      fs.writeFileSync(
        path.join(tempRepoDir, 'quality.json'),
        JSON.stringify(configData, null, 2),
      );

      const config = qualityService.getConfigForRepo(tempRepoDir);

      expect(config.repo_path).toBe(tempRepoDir);
      expect(config.format?.command).toBe('pnpm prettier --check .');
      expect(config.format?.exe).toBe('pnpm');
      expect(config.format?.args).toEqual(['prettier', '--check', '.']);
      expect(config.format?.stage).toBe('format');
      expect(config.format?.required).toBe(true);

      expect(config.lint?.command).toBe('pnpm eslint .');
      expect(config.lint?.exe).toBe('pnpm');
      expect(config.lint?.args).toEqual(['eslint', '.']);

      expect(config.typecheck?.command).toBe('pnpm tsc --noEmit');
      expect(config.typecheck?.exe).toBe('pnpm');
      expect(config.typecheck?.args).toEqual(['tsc', '--noEmit']);

      expect(config.test?.command).toBe('pnpm vitest run');
      expect(config.test?.exe).toBe('pnpm');
      expect(config.test?.args).toEqual(['vitest', 'run']);

      expect(config.build?.command).toBe('pnpm build');
      expect(config.build?.exe).toBe('pnpm');
      expect(config.build?.args).toEqual(['build']);
      expect(config.build?.required).toBe(false); // build defaults to optional
    });

    it('2. Đọc cấu hình từ .orchestrator/quality.json khi repo sử dụng thư mục ẩn', () => {
      const orchDir = path.join(tempRepoDir, '.orchestrator');
      fs.mkdirSync(orchDir, { recursive: true });
      fs.writeFileSync(
        path.join(orchDir, 'quality.json'),
        JSON.stringify({
          format: 'npm run format',
          lint: 'npm run lint',
          test: 'npm test',
        }),
      );

      const config = qualityService.getConfigForRepo(tempRepoDir);
      expect(config.format?.command).toBe('npm run format');
      expect(config.lint?.command).toBe('npm run lint');
      expect(config.test?.command).toBe('npm test');
      expect(config.typecheck).toBeNull();
      expect(config.build).toBeNull();
    });

    it('3. Đọc cấu hình từ package.json qualityGate property', () => {
      fs.writeFileSync(
        path.join(tempRepoDir, 'package.json'),
        JSON.stringify({
          name: 'sample-project',
          qualityGate: {
            format: 'pnpm format',
            lint: 'pnpm lint',
            test: 'pnpm test:unit',
          },
        }),
      );

      const config = qualityService.getConfigForRepo(tempRepoDir);
      expect(config.format?.command).toBe('pnpm format');
      expect(config.lint?.command).toBe('pnpm lint');
      expect(config.test?.command).toBe('pnpm test:unit');
    });
  });

  describe('Nghiệm thu: Đọc từ config (Workbook Settings & verify_commands)', () => {
    it('4. Đọc và phân loại cấu hình từ imported workbook Config sheet', () => {
      const mockWorkbookConfig: ParsedConfig = {
        repository: tempRepoDir,
        agy_bin: 'agy',
        agy_args: '-p',
        verify_commands: [
          'pnpm format:check',
          'pnpm lint',
          'pnpm typecheck',
          'pnpm test:ci',
          'pnpm build',
          'pnpm audit',
        ],
        max_attempts: 3,
        timeout_minutes: 30,
        max_concurrency: 1,
        settings: {
          test_command: 'pnpm test:override',
        },
        raw: {},
      };

      const resolved = qualityService.resolveConfig({
        repoPath: tempRepoDir,
        workbookConfig: mockWorkbookConfig,
      });

      expect(resolved.format?.command).toBe('pnpm format:check');
      expect(resolved.lint?.command).toBe('pnpm lint');
      expect(resolved.typecheck?.command).toBe('pnpm typecheck');
      // settings.test_command takes precedence over verify_commands test
      expect(resolved.test?.command).toBe('pnpm test:override');
      expect(resolved.build?.command).toBe('pnpm build');
      expect(resolved.custom_commands.length).toBe(1);
      expect(resolved.custom_commands[0]?.command).toBe('pnpm audit');
    });
  });

  describe('Nghiệm thu: Đọc từ config theo task (Task-level test_commands)', () => {
    it('5. Đọc cấu hình kiểm định theo task ID và ghi đè stage test bằng task.test_commands', () => {
      // Setup repo config
      fs.writeFileSync(
        path.join(tempRepoDir, 'quality.json'),
        JSON.stringify({
          format: 'pnpm format',
          lint: 'pnpm lint',
          test: 'pnpm test:all',
        }),
      );

      // Create task with specific test_commands in database
      const task = taskRepo.create({
        id: 'TSK-CUSTOM-TEST',
        title: 'Task with custom tests',
        repository: tempRepoDir,
        test_commands: ['pnpm vitest run test/specific.test.ts', 'pnpm vitest run test/secondary.test.ts'],
      });

      const taskConfig = qualityService.getConfigForTask(task.id);

      expect(taskConfig.format?.command).toBe('pnpm format');
      expect(taskConfig.lint?.command).toBe('pnpm lint');
      expect(taskConfig.test?.command).toBe('pnpm vitest run test/specific.test.ts');
      expect(taskConfig.custom_commands.length).toBe(1);
      expect(taskConfig.custom_commands[0]?.command).toBe('pnpm vitest run test/secondary.test.ts');
    });
  });

  describe('Nghiệm thu qua REST API', () => {
    it('6. GET /repos/:id/quality-config trả về toàn bộ cấu hình kiểm định của repo', async () => {
      fs.writeFileSync(
        path.join(secondaryRepoDir, 'quality.json'),
        JSON.stringify({
          format: 'npm run format',
          lint: 'npm run lint',
          typecheck: 'npm run typecheck',
          test: 'npm test',
          build: 'npm run build',
        }),
      );

      const response = await server.inject({
        method: 'GET',
        url: `/repos/${encodeURIComponent(secondaryRepoDir)}/quality-config`,
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.data).toBeDefined();
      expect(json.data.format.command).toBe('npm run format');
      expect(json.data.lint.command).toBe('npm run lint');
      expect(json.data.typecheck.command).toBe('npm run typecheck');
      expect(json.data.test.command).toBe('npm test');
      expect(json.data.build.command).toBe('npm run build');
    });

    it('7. GET /tasks/:id/quality-config trả về cấu hình cho task', async () => {
      fs.writeFileSync(
        path.join(tempRepoDir, 'quality.json'),
        JSON.stringify({
          format: 'pnpm format',
          lint: 'pnpm lint',
          test: 'pnpm test',
        }),
      );

      taskRepo.create({
        id: 'TSK-API-TEST',
        title: 'Task API Test',
        repository: tempRepoDir,
        test_commands: ['pnpm test:feature-1'],
      });

      const response = await server.inject({
        method: 'GET',
        url: '/tasks/TSK-API-TEST/quality-config',
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.data.test.command).toBe('pnpm test:feature-1');
    });

    it('8. POST /quality/resolve phân giải cấu hình động từ tham số overrides', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/quality/resolve',
        payload: {
          repoPath: tempRepoDir,
          overrides: {
            format: 'prettier --check .',
            lint: 'eslint .',
            test: 'vitest run',
            stop_on_first_failure: false,
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.data.format.command).toBe('prettier --check .');
      expect(json.data.lint.command).toBe('eslint .');
      expect(json.data.test.command).toBe('vitest run');
      expect(json.data.stop_on_first_failure).toBe(false);
    });

    it('9. PUT /repos/:id/quality-config lưu cấu hình mới vào .orchestrator/quality.json', async () => {
      const response = await server.inject({
        method: 'PUT',
        url: `/repos/${encodeURIComponent(tempRepoDir)}/quality-config`,
        payload: {
          format: 'pnpm format:fix',
          lint: 'pnpm lint:strict',
          test: 'pnpm test:coverage',
        },
      });

      expect(response.statusCode).toBe(200);
      const savedPath = path.join(tempRepoDir, '.orchestrator', 'quality.json');
      expect(fs.existsSync(savedPath)).toBe(true);

      const savedContent = JSON.parse(fs.readFileSync(savedPath, 'utf-8'));
      expect(savedContent.format).toBe('pnpm format:fix');
      expect(savedContent.lint).toBe('pnpm lint:strict');
      expect(savedContent.test).toBe('pnpm test:coverage');
    });
  });

  describe('Nghiệm thu: Pipeline thực thi & Xử lý lỗi', () => {
    it('10. getExecutionPipeline trả về các lệnh theo đúng trật tự format -> lint -> typecheck -> test -> build', () => {
      const config: RepoQualityConfig = RepoQualityConfigSchema.parse({
        repo_path: tempRepoDir,
        format: {
          id: 'format-cmd',
          stage: 'format',
          name: 'Format check',
          command: 'pnpm format',
          exe: 'pnpm',
          args: ['format'],
          cwd: tempRepoDir,
          timeout_ms: 60000,
          enabled: true,
          required: true,
          continueOnError: false,
        },
        lint: {
          id: 'lint-cmd',
          stage: 'lint',
          name: 'Lint check',
          command: 'pnpm lint',
          exe: 'pnpm',
          args: ['lint'],
          cwd: tempRepoDir,
          timeout_ms: 60000,
          enabled: true,
          required: true,
          continueOnError: false,
        },
        typecheck: {
          id: 'typecheck-cmd',
          stage: 'typecheck',
          name: 'Typecheck',
          command: 'pnpm typecheck',
          exe: 'pnpm',
          args: ['typecheck'],
          cwd: tempRepoDir,
          timeout_ms: 60000,
          enabled: true,
          required: true,
          continueOnError: false,
        },
        test: {
          id: 'test-cmd',
          stage: 'test',
          name: 'Tests',
          command: 'pnpm test',
          exe: 'pnpm',
          args: ['test'],
          cwd: tempRepoDir,
          timeout_ms: 60000,
          enabled: true,
          required: true,
          continueOnError: false,
        },
        build: {
          id: 'build-cmd',
          stage: 'build',
          name: 'Build',
          command: 'pnpm build',
          exe: 'pnpm',
          args: ['build'],
          cwd: tempRepoDir,
          timeout_ms: 60000,
          enabled: true,
          required: false,
          continueOnError: false,
        },
        custom_commands: [],
      });

      const pipeline = getExecutionPipeline(config);
      expect(pipeline.map((p) => p.stage)).toEqual([
        'format',
        'lint',
        'typecheck',
        'test',
        'build',
      ]);
    });

    it('11. Trả về mã lỗi 404 khi truy vấn task hoặc repo không tồn tại', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/tasks/NON-EXISTENT-TASK/quality-config',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('TASK_NOT_FOUND');
    });

    it('12. Trả về mã lỗi 400 khi payload cấu hình không hợp lệ', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/quality/resolve',
        payload: {
          overrides: {
            format: '', // empty command not allowed
          },
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    });
  });
});
