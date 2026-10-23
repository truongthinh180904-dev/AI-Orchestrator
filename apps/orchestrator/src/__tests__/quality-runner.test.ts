import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createDatabase,
  runMigrations,
  QualityCheckRepository,
  ReportRepository,
  TaskRepository,
  RunRepository,
} from '@ai-orchestrator/db';
import type { QualityCommandDefinition } from '@ai-orchestrator/shared';
import { QualityRunner } from '../services/quality-runner.js';
import { QualityConfigService } from '../services/quality-config-service.js';

describe('QualityRunner', () => {
  let db: Database.Database;
  let qualityCheckRepo: QualityCheckRepository;
  let reportRepo: ReportRepository;
  let taskRepo: TaskRepository;
  let runRepo: RunRepository;
  let runner: QualityRunner;
  let configService: QualityConfigService;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    qualityCheckRepo = new QualityCheckRepository(db);
    reportRepo = new ReportRepository(db);
    taskRepo = new TaskRepository(db);
    runRepo = new RunRepository(db);

    configService = new QualityConfigService({ db });
    runner = new QualityRunner({
      db,
      qualityCheckRepo,
      reportRepo,
      taskRepo,
      qualityConfigService: configService,
    });

    taskRepo.create({
      id: 'TASK-QR-1',
      title: 'Runner Test Task',
      repository: process.cwd(),
    });

    runRepo.create({
      id: 'run-pipe-1',
      task_id: 'TASK-QR-1',
      attempt: 1,
      status: 'RUNNING',
      started_at: new Date().toISOString(),
    });
  });

  describe('runCommand', () => {
    it('executes a command successfully, capturing stdout, exit_code 0, duration, and status SUCCESS', async () => {
      const cmd: QualityCommandDefinition = {
        id: 'cmd-format',
        stage: 'format',
        name: 'Echo format check',
        command: 'node -e "console.log(\'code formatting passed\')"',
        exe: 'node',
        args: ['-e', 'console.log("code formatting passed")'],
        cwd: process.cwd(),
        timeout_ms: 5000,
        enabled: true,
        required: true,
        continueOnError: false,
      };

      const record = await runner.runCommand(cmd, { taskId: 'TASK-QR-1' });

      expect(record.id).toBeDefined();
      expect(record.task_id).toBe('TASK-QR-1');
      expect(record.stage).toBe('format');
      expect(record.command_id).toBe('cmd-format');
      expect(record.status).toBe('SUCCESS');
      expect(record.exit_code).toBe(0);
      expect(record.stdout.trim()).toBe('code formatting passed');
      expect(record.stderr).toBe('');
      expect(record.duration_ms).toBeGreaterThanOrEqual(0);

      // Verify DB record
      const dbRecord = qualityCheckRepo.getById(record.id);
      expect(dbRecord).not.toBeNull();
      expect(dbRecord?.stdout.trim()).toBe('code formatting passed');
    });

    it('captures stderr and non-zero exit code when a command fails with status FAILURE', async () => {
      const cmd: QualityCommandDefinition = {
        id: 'cmd-lint',
        stage: 'lint',
        name: 'Failing lint check',
        command: 'node -e "console.error(\'lint rule violation at line 10\'); process.exit(2)"',
        exe: 'node',
        args: ['-e', 'console.error("lint rule violation at line 10"); process.exit(2)'],
        cwd: process.cwd(),
        timeout_ms: 5000,
        enabled: true,
        required: true,
        continueOnError: false,
      };

      const record = await runner.runCommand(cmd, { taskId: 'TASK-QR-1' });

      expect(record.status).toBe('FAILURE');
      expect(record.exit_code).toBe(2);
      expect(record.stderr).toContain('lint rule violation at line 10');

      const dbRecord = qualityCheckRepo.getById(record.id);
      expect(dbRecord?.status).toBe('FAILURE');
      expect(dbRecord?.exit_code).toBe(2);
    });

    it('marks status as TIMEOUT when command execution exceeds timeout_ms', async () => {
      const cmd: QualityCommandDefinition = {
        id: 'cmd-timeout',
        stage: 'test',
        name: 'Hanging test suite',
        command: 'node -e "setTimeout(() => {}, 10000)"',
        exe: 'node',
        args: ['-e', 'setTimeout(() => {}, 10000)'],
        cwd: process.cwd(),
        timeout_ms: 200, // short timeout for test
        enabled: true,
        required: true,
        continueOnError: false,
      };

      const record = await runner.runCommand(cmd);

      expect(record.status).toBe('TIMEOUT');
      expect(record.duration_ms).toBeGreaterThanOrEqual(150);

      const dbRecord = qualityCheckRepo.getById(record.id);
      expect(dbRecord?.status).toBe('TIMEOUT');
    });

    it('records ERROR status when executable cannot be spawned', async () => {
      const cmd: QualityCommandDefinition = {
        id: 'cmd-invalid-exe',
        stage: 'build',
        name: 'Non existent tool',
        command: 'non_existent_executable_123456789',
        exe: 'non_existent_executable_123456789',
        args: [],
        cwd: process.cwd(),
        timeout_ms: 5000,
        enabled: true,
        required: true,
        continueOnError: false,
      };

      const record = await runner.runCommand(cmd);

      expect(record.status).toBe('ERROR');
      expect(record.exit_code).toBeNull();
      expect(record.stderr).toContain('Execution error');
    });
  });

  describe('runPipeline', () => {
    it('executes a complete multi-stage pipeline and records each step in DB', async () => {
      const pipeline: QualityCommandDefinition[] = [
        {
          id: 'step-format',
          stage: 'format',
          name: 'Format check',
          command: 'node -e "console.log(\'prettier: 10 files formatted\')"',
          exe: 'node',
          args: ['-e', 'console.log("prettier: 10 files formatted")'],
          cwd: process.cwd(),
          timeout_ms: 5000,
          enabled: true,
          required: true,
          continueOnError: false,
        },
        {
          id: 'step-lint',
          stage: 'lint',
          name: 'Lint check',
          command: 'node -e "console.log(\'eslint: 0 warnings, 0 errors\')"',
          exe: 'node',
          args: ['-e', 'console.log("eslint: 0 warnings, 0 errors")'],
          cwd: process.cwd(),
          timeout_ms: 5000,
          enabled: true,
          required: true,
          continueOnError: false,
        },
        {
          id: 'step-test',
          stage: 'test',
          name: 'Test check',
          command: 'node -e "console.log(\'vitest: 5 tests passed\')"',
          exe: 'node',
          args: ['-e', 'console.log("vitest: 5 tests passed")'],
          cwd: process.cwd(),
          timeout_ms: 5000,
          enabled: true,
          required: true,
          continueOnError: false,
        },
      ];

      const result = await runner.runPipeline(pipeline, {
        taskId: 'TASK-QR-1',
        runId: 'run-pipe-1',
      });

      expect(result.success).toBe(true);
      expect(result.total_commands).toBe(3);
      expect(result.passed_commands).toBe(3);
      expect(result.failed_commands).toBe(0);
      expect(result.skipped_commands).toBe(0);
      expect(result.records).toHaveLength(3);

      // Verify database records
      const recordsInDb = qualityCheckRepo.findByTaskId('TASK-QR-1');
      expect(recordsInDb).toHaveLength(3);
      expect(recordsInDb.map((r) => r.stage)).toEqual(['format', 'lint', 'test']);

      // Verify quality report created
      const reports = reportRepo.findByRunId('run-pipe-1');
      expect(reports).toHaveLength(1);
      expect(reports[0]?.kind).toBe('quality_report');
      const content = JSON.parse(reports[0]?.content ?? '{}');
      expect(content.success).toBe(true);
      expect(content.total_commands).toBe(3);
    });

    it('stops on first failure and marks remaining stages as SKIPPED when stopOnFirstFailure is true', async () => {
      const pipeline: QualityCommandDefinition[] = [
        {
          id: 'step-format',
          stage: 'format',
          name: 'Format step',
          command: 'node -e "console.log(\'format passed\')"',
          exe: 'node',
          args: ['-e', 'console.log("format passed")'],
          cwd: process.cwd(),
          timeout_ms: 5000,
          enabled: true,
          required: true,
          continueOnError: false,
        },
        {
          id: 'step-lint',
          stage: 'lint',
          name: 'Lint step failing',
          command: 'node -e "console.error(\'lint failure\'); process.exit(1)"',
          exe: 'node',
          args: ['-e', 'console.error("lint failure"); process.exit(1)'],
          cwd: process.cwd(),
          timeout_ms: 5000,
          enabled: true,
          required: true,
          continueOnError: false,
        },
        {
          id: 'step-test',
          stage: 'test',
          name: 'Test step',
          command: 'node -e "console.log(\'test\')"',
          exe: 'node',
          args: ['-e', 'console.log("test")'],
          cwd: process.cwd(),
          timeout_ms: 5000,
          enabled: true,
          required: true,
          continueOnError: false,
        },
      ];

      const result = await runner.runPipeline(pipeline, {
        taskId: 'TASK-QR-1',
        stopOnFirstFailure: true,
      });

      expect(result.success).toBe(false);
      expect(result.total_commands).toBe(3);
      expect(result.passed_commands).toBe(1);
      expect(result.failed_commands).toBe(1);
      expect(result.skipped_commands).toBe(1);

      expect(result.records[0]?.status).toBe('SUCCESS');
      expect(result.records[1]?.status).toBe('FAILURE');
      expect(result.records[2]?.status).toBe('SKIPPED');
      expect(result.records[2]?.stderr).toContain('Skipped due to prior stage failure');

      // Verify database stored all 3 records including the SKIPPED one
      const recordsInDb = qualityCheckRepo.findByTaskId('TASK-QR-1');
      expect(recordsInDb).toHaveLength(3);
      expect(recordsInDb[2]?.status).toBe('SKIPPED');
    });

    it('continues execution when continueOnError is true even if the command fails', async () => {
      const pipeline: QualityCommandDefinition[] = [
        {
          id: 'step-custom',
          stage: 'custom',
          name: 'Optional advisory audit',
          command: 'node -e "console.error(\'minor advisory\'); process.exit(1)"',
          exe: 'node',
          args: ['-e', 'console.error("minor advisory"); process.exit(1)'],
          cwd: process.cwd(),
          timeout_ms: 5000,
          enabled: true,
          required: false,
          continueOnError: true,
        },
        {
          id: 'step-test',
          stage: 'test',
          name: 'Test step',
          command: 'node -e "console.log(\'test passed\')"',
          exe: 'node',
          args: ['-e', 'console.log("test passed")'],
          cwd: process.cwd(),
          timeout_ms: 5000,
          enabled: true,
          required: true,
          continueOnError: false,
        },
      ];

      const result = await runner.runPipeline(pipeline, {
        taskId: 'TASK-QR-1',
      });

      expect(result.total_commands).toBe(2);
      expect(result.passed_commands).toBe(1);
      expect(result.failed_commands).toBe(1);
      expect(result.skipped_commands).toBe(0);
      expect(result.records[0]?.status).toBe('FAILURE');
      expect(result.records[1]?.status).toBe('SUCCESS');
      // Success because the failed step was optional (required: false, continueOnError: true)
      expect(result.success).toBe(true);
    });

    it('emits onCommandStart and onCommandComplete callbacks', async () => {
      const started: string[] = [];
      const completed: string[] = [];

      const pipeline: QualityCommandDefinition[] = [
        {
          id: 'cmd-1',
          stage: 'format',
          name: 'Step 1',
          command: 'node -e "console.log(1)"',
          exe: 'node',
          args: ['-e', 'console.log(1)'],
          cwd: process.cwd(),
          timeout_ms: 5000,
          enabled: true,
          required: true,
          continueOnError: false,
        },
      ];

      await runner.runPipeline(pipeline, {
        onCommandStart: (cmd) => started.push(cmd.id),
        onCommandComplete: (record) => completed.push(record.command_id),
      });

      expect(started).toEqual(['cmd-1']);
      expect(completed).toEqual(['cmd-1']);
    });
  });
});
