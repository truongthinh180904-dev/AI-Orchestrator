import { describe, expect, it, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../connection.js';
import { runMigrations } from '../migrator.js';
import { TaskRepository } from '../repositories/task-repository.js';
import { RunRepository } from '../repositories/run-repository.js';
import { ReviewFindingRepository } from '../repositories/review-finding-repository.js';

describe('ReviewFindingRepository', () => {
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let runRepo: RunRepository;
  let findingRepo: ReviewFindingRepository;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    runRepo = new RunRepository(db);
    findingRepo = new ReviewFindingRepository(db);
  });

  it('creates and retrieves a review finding with required fields {severity, file, line, message}', () => {
    const created = findingRepo.create({
      severity: 'high',
      file: 'src/services/auth.ts',
      line: 42,
      message: 'Token verification is bypassed in development mode',
      category: 'security',
      rule_id: 'SEC-002',
      suggestion: 'Remove dev bypass in production',
    });

    expect(created.id).toBeTruthy();
    expect(created.severity).toBe('high');
    expect(created.file).toBe('src/services/auth.ts');
    expect(created.line).toBe(42);
    expect(created.message).toBe('Token verification is bypassed in development mode');
    expect(created.category).toBe('security');
    expect(created.rule_id).toBe('SEC-002');
    expect(created.suggestion).toBe('Remove dev bypass in production');

    const fetched = findingRepo.findById(created.id);
    expect(fetched).toEqual(created);
  });

  it('associates finding with task_id and run_id', () => {
    taskRepo.create({
      id: 'TSK-100',
      title: 'Review Test Task',
    });

    runRepo.create({
      id: 'RUN-100',
      task_id: 'TSK-100',
      status: 'RUNNING',
    });

    const finding = findingRepo.create({
      task_id: 'TSK-100',
      run_id: 'RUN-100',
      severity: 'critical',
      file: 'packages/db/src/index.ts',
      line: 10,
      message: 'Critical DB deadlock risk',
    });

    expect(finding.task_id).toBe('TSK-100');
    expect(finding.run_id).toBe('RUN-100');

    const byTask = findingRepo.findByTaskId('TSK-100');
    expect(byTask).toHaveLength(1);
    expect(byTask[0]?.id).toBe(finding.id);

    const byRun = findingRepo.findByRunId('RUN-100');
    expect(byRun).toHaveLength(1);
    expect(byRun[0]?.id).toBe(finding.id);
  });

  it('supports createBatch in transaction', () => {
    const batch = findingRepo.createBatch([
      {
        severity: 'info',
        file: 'README.md',
        line: 1,
        message: 'Add badges',
      },
      {
        severity: 'low',
        file: 'src/utils.ts',
        line: 15,
        message: 'Naming convention',
      },
      {
        severity: 'medium',
        file: 'src/api.ts',
        line: 55,
        message: 'Slow query warning',
      },
    ]);

    expect(batch).toHaveLength(3);
    expect(findingRepo.count()).toBe(3);
  });

  it('filters findings by severity, file, and pagination', () => {
    findingRepo.createBatch([
      { severity: 'high', file: 'src/a.ts', line: 1, message: 'High issue in a' },
      { severity: 'high', file: 'src/b.ts', line: 5, message: 'High issue in b' },
      { severity: 'low', file: 'src/a.ts', line: 10, message: 'Low issue in a' },
    ]);

    const highFindings = findingRepo.find({ severity: 'high' });
    expect(highFindings).toHaveLength(2);

    const fileAFindings = findingRepo.find({ file: 'src/a.ts' });
    expect(fileAFindings).toHaveLength(2);

    const paginated = findingRepo.find({ limit: 1, offset: 0 });
    expect(paginated).toHaveLength(1);
  });

  it('cascades deletion on task delete', () => {
    taskRepo.create({
      id: 'TSK-200',
      title: 'Task To Delete',
    });

    findingRepo.create({
      task_id: 'TSK-200',
      severity: 'medium',
      file: 'src/test.ts',
      line: 3,
      message: 'Some issue',
    });

    expect(findingRepo.findByTaskId('TSK-200')).toHaveLength(1);

    taskRepo.delete('TSK-200');
    expect(findingRepo.findByTaskId('TSK-200')).toHaveLength(0);
  });
});
