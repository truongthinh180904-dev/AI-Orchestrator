import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../connection.js';
import { runMigrations } from '../migrator.js';
import { QualityCheckRepository } from '../repositories/quality-check-repository.js';
import { TaskRepository } from '../repositories/task-repository.js';
import { RunRepository } from '../repositories/run-repository.js';

describe('QualityCheckRepository', () => {
  let db: Database.Database;
  let repo: QualityCheckRepository;
  let taskRepo: TaskRepository;
  let runRepo: RunRepository;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repo = new QualityCheckRepository(db);
    taskRepo = new TaskRepository(db);
    runRepo = new RunRepository(db);

    // Seed task and run for relational tests
    taskRepo.create({
      id: 'TASK-100',
      title: 'Test Quality Task',
      repository: '.',
    });

    runRepo.create({
      id: 'run-100',
      task_id: 'TASK-100',
      attempt: 1,
      status: 'RUNNING',
      started_at: new Date().toISOString(),
    });
  });

  it('creates and retrieves a quality command record with stdout, stderr, and exit_code', () => {
    const record = repo.create({
      task_id: 'TASK-100',
      run_id: 'run-100',
      stage: 'lint',
      command_id: 'lint-cmd',
      name: 'ESLint check',
      command: 'eslint .',
      exe: 'eslint',
      args: ['.'],
      cwd: '/workspace/test',
      exit_code: 0,
      signal: null,
      status: 'SUCCESS',
      stdout: 'All files pass linting\n',
      stderr: '',
      duration_ms: 250,
    });

    expect(record.id).toBeDefined();
    expect(record.task_id).toBe('TASK-100');
    expect(record.run_id).toBe('run-100');
    expect(record.stage).toBe('lint');
    expect(record.command).toBe('eslint .');
    expect(record.exe).toBe('eslint');
    expect(record.args).toEqual(['.']);
    expect(record.exit_code).toBe(0);
    expect(record.status).toBe('SUCCESS');
    expect(record.stdout).toBe('All files pass linting\n');
    expect(record.stderr).toBe('');
    expect(record.duration_ms).toBe(250);

    const fetched = repo.getById(record.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(record.id);
    expect(fetched?.name).toBe('ESLint check');
  });

  it('stores records with failure exit code and stderr', () => {
    const record = repo.create({
      task_id: 'TASK-100',
      run_id: 'run-100',
      stage: 'test',
      command_id: 'test-cmd',
      name: 'Vitest suite',
      command: 'vitest run',
      exe: 'vitest',
      args: ['run'],
      cwd: '/workspace/test',
      exit_code: 1,
      signal: null,
      status: 'FAILURE',
      stdout: '1 failed test\n',
      stderr: 'AssertionError: expected true to be false',
      duration_ms: 1200,
    });

    expect(record.status).toBe('FAILURE');
    expect(record.exit_code).toBe(1);
    expect(record.stderr).toContain('AssertionError');
  });

  it('finds records by task_id and run_id', () => {
    repo.create({
      task_id: 'TASK-100',
      run_id: 'run-100',
      stage: 'format',
      command_id: 'format-1',
      name: 'Prettier',
      command: 'prettier --check .',
      exe: 'prettier',
      cwd: '/test',
      exit_code: 0,
      status: 'SUCCESS',
    });

    repo.create({
      task_id: 'TASK-100',
      run_id: 'run-100',
      stage: 'lint',
      command_id: 'lint-1',
      name: 'ESLint',
      command: 'eslint .',
      exe: 'eslint',
      cwd: '/test',
      exit_code: 0,
      status: 'SUCCESS',
    });

    const taskRecords = repo.findByTaskId('TASK-100');
    expect(taskRecords).toHaveLength(2);
    expect(taskRecords[0]?.stage).toBe('format');
    expect(taskRecords[1]?.stage).toBe('lint');

    const runRecords = repo.findByRunId('run-100');
    expect(runRecords).toHaveLength(2);
  });

  it('supports filtering by stage and status in findAll', () => {
    repo.create({
      task_id: 'TASK-100',
      stage: 'format',
      command_id: 'c1',
      name: 'Format',
      command: 'format',
      exe: 'format',
      cwd: '/test',
      exit_code: 0,
      status: 'SUCCESS',
    });

    repo.create({
      task_id: 'TASK-100',
      stage: 'lint',
      command_id: 'c2',
      name: 'Lint',
      command: 'lint',
      exe: 'lint',
      cwd: '/test',
      exit_code: 1,
      status: 'FAILURE',
    });

    const successRecords = repo.findAll({ status: 'SUCCESS' });
    expect(successRecords).toHaveLength(1);
    expect(successRecords[0]?.stage).toBe('format');

    const lintRecords = repo.findAll({ stage: 'lint' });
    expect(lintRecords).toHaveLength(1);
    expect(lintRecords[0]?.status).toBe('FAILURE');
  });

  it('creates batch records in a single transaction', () => {
    const batch = repo.createBatch([
      {
        task_id: 'TASK-100',
        stage: 'typecheck',
        command_id: 'tc-1',
        name: 'Typecheck',
        command: 'tsc --noEmit',
        exe: 'tsc',
        cwd: '/test',
        exit_code: 0,
        status: 'SUCCESS',
      },
      {
        task_id: 'TASK-100',
        stage: 'build',
        command_id: 'b-1',
        name: 'Build',
        command: 'pnpm build',
        exe: 'pnpm',
        cwd: '/test',
        exit_code: 0,
        status: 'SUCCESS',
      },
    ]);

    expect(batch).toHaveLength(2);
    expect(repo.count()).toBe(2);
  });

  it('deletes records by task_id and run_id', () => {
    repo.create({
      task_id: 'TASK-100',
      run_id: 'run-100',
      stage: 'format',
      command_id: 'f-1',
      name: 'Format',
      command: 'format',
      exe: 'format',
      cwd: '/test',
      exit_code: 0,
      status: 'SUCCESS',
    });

    expect(repo.count()).toBe(1);
    const deleted = repo.deleteByTaskId('TASK-100');
    expect(deleted).toBe(1);
    expect(repo.count()).toBe(0);
  });
});
