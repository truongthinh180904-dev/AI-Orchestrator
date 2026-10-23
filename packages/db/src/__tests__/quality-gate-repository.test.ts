import { describe, expect, it } from 'vitest';
import {
  createDatabase,
  runMigrations,
  QualityGateRepository,
  TaskRepository,
  RunRepository,
  ReportRepository,
} from '../index.js';
import { evaluateQualityGate, type QualityCommandRecord } from '@ai-orchestrator/shared';

describe('QualityGateRepository (QLT-007)', () => {
  function setupDb() {
    const db = createDatabase(':memory:');
    runMigrations(db);
    const taskRepo = new TaskRepository(db);
    const runRepo = new RunRepository(db);
    const reportRepo = new ReportRepository(db);
    const qualityGateRepo = new QualityGateRepository(db);

    const now = new Date().toISOString();
    taskRepo.create({
      id: 'TASK-QG-DB',
      title: 'Database Quality Gate Test Task',
      acceptance_criteria: ['Pass tests'],
      status: 'VERIFYING',
      created_at: now,
      updated_at: now,
    });

    const run = runRepo.create({
      task_id: 'TASK-QG-DB',
      attempt: 1,
      status: 'SUCCESS',
      exit_code: 0,
      started_at: now,
      finished_at: now,
    });

    return { db, taskRepo, runRepo, reportRepo, qualityGateRepo, run };
  }

  it('1. Creates evaluation record and retrieves it by ID', () => {
    const { qualityGateRepo, run } = setupDb();

    const dummyCmd: QualityCommandRecord = {
      id: 'cmd-db-1',
      task_id: 'TASK-QG-DB',
      run_id: run.id,
      stage: 'test',
      command_id: 'test',
      name: 'Vitest',
      command: 'pnpm test',
      exe: 'pnpm',
      args: ['test'],
      cwd: '.',
      exit_code: 0,
      signal: null,
      status: 'SUCCESS',
      stdout: 'All tests passed',
      stderr: '',
      duration_ms: 100,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };

    const evalResult = evaluateQualityGate(
      {},
      {
        cliExitCode: 0,
        cliStatus: 'SUCCESS',
        commandRecords: [dummyCmd],
      },
      {
        taskId: 'TASK-QG-DB',
        runId: run.id,
        durationMs: 250,
      },
    );

    const created = qualityGateRepo.create(evalResult);
    expect(created.id).toBe(evalResult.id);
    expect(created.task_id).toBe('TASK-QG-DB');
    expect(created.passed).toBe(true);

    const retrieved = qualityGateRepo.getById(created.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(created.id);
    expect(retrieved?.status).toBe('PASSED');
    expect(retrieved?.command_records).toHaveLength(1);
    expect(retrieved?.command_records[0]?.command).toBe('pnpm test');
  });

  it('2. Automatically creates markdown report in reports table when run_id is supplied', () => {
    const { qualityGateRepo, reportRepo, run } = setupDb();

    const evalResult = evaluateQualityGate(
      {},
      {
        cliExitCode: 0,
        cliStatus: 'SUCCESS',
        commandRecords: [],
      },
      {
        taskId: 'TASK-QG-DB',
        runId: run.id,
      },
    );

    qualityGateRepo.create(evalResult);

    const reports = reportRepo.findByRunId(run.id);
    const qgReport = reports.find((r) => r.kind === 'quality_gate');
    expect(qgReport).toBeDefined();
    expect(qgReport?.content).toContain('# Quality Gate Evaluation Report');
    expect(qgReport?.content).toContain('TASK-QG-DB');
  });

  it('3. Finds latest evaluation, by taskId, by runId, and counts records', () => {
    const { qualityGateRepo, run } = setupDb();

    const eval1 = evaluateQualityGate(
      {},
      { cliExitCode: 0, cliStatus: 'SUCCESS', commandRecords: [] },
      { taskId: 'TASK-QG-DB', runId: run.id, evaluatedAt: '2026-10-23T01:00:00.000Z' },
    );
    const eval2 = evaluateQualityGate(
      {},
      { cliExitCode: 0, cliStatus: 'SUCCESS', commandRecords: [] },
      { taskId: 'TASK-QG-DB', runId: run.id, evaluatedAt: '2026-10-23T02:00:00.000Z' },
    );

    qualityGateRepo.create(eval1);
    qualityGateRepo.create(eval2);

    const latest = qualityGateRepo.findLatestByTaskId('TASK-QG-DB');
    expect(latest?.id).toBe(eval2.id);

    const allForTask = qualityGateRepo.findByTaskId('TASK-QG-DB');
    expect(allForTask).toHaveLength(2);

    const allForRun = qualityGateRepo.findByRunId(run.id);
    expect(allForRun).toHaveLength(2);

    const totalCount = qualityGateRepo.count();
    expect(totalCount).toBe(2);

    const taskCount = qualityGateRepo.count({ taskId: 'TASK-QG-DB' });
    expect(taskCount).toBe(2);
  });

  it('4. Cascade delete: Deleting task removes quality gate evaluations and reports', () => {
    const { qualityGateRepo, taskRepo, reportRepo, run } = setupDb();

    const evalResult = evaluateQualityGate(
      {},
      { cliExitCode: 0, cliStatus: 'SUCCESS', commandRecords: [] },
      { taskId: 'TASK-QG-DB', runId: run.id },
    );
    qualityGateRepo.create(evalResult);

    expect(qualityGateRepo.getById(evalResult.id)).not.toBeNull();

    // Delete task
    taskRepo.delete('TASK-QG-DB');

    // Cascade delete in SQLite
    expect(qualityGateRepo.getById(evalResult.id)).toBeNull();
    const remainingReports = reportRepo.findByRunId(run.id);
    expect(remainingReports).toHaveLength(0);
  });
});
