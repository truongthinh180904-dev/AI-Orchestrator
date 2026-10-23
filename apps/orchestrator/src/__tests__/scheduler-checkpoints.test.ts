import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  CheckpointRepository,
} from '@ai-orchestrator/db';
import { TaskScheduler } from '../services/task-scheduler.js';
import { RunService } from '../services/run-service.js';
import { createExecutionManager, type ExecutionManager } from '../adapters/execution-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mockCliPath = path.resolve(__dirname, '../../../../fixtures/mock-agy-cli.cjs');

describe('Scheduler Checkpoint Integration (ORC-005)', () => {
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let checkpointRepo: CheckpointRepository;
  let runService: RunService;
  let executionManager: ExecutionManager;
  let scheduler: TaskScheduler;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    checkpointRepo = new CheckpointRepository(db);

    executionManager = createExecutionManager();
    runService = new RunService({
      db,
      executionManager,
      config: {
        AGY_BIN: 'node',
        AGY_ARGS: mockCliPath,
      },
    });

    scheduler = new TaskScheduler({
      db,
      runService,
      autoVerify: true,
      autoRetry: false,
    });
  });

  afterEach(async () => {
    await scheduler.stop(true);
    await executionManager.stopAll();
    db.close();
  });

  it('records run_started and run_completed checkpoints upon successful scheduler execution', async () => {
    taskRepo.create({
      id: 'TASK-SCHED-SUCCESS',
      title: 'Successful task',
      description: 'success',
      status: 'READY',
      max_attempts: 1,
    });

    const result = await scheduler.step();
    expect(result.executed).toBe(true);
    expect(result.status).toBe('DONE');

    const checkpoints = checkpointRepo.findByTaskId('TASK-SCHED-SUCCESS');
    expect(checkpoints.length).toBeGreaterThanOrEqual(2);

    const steps = checkpoints.map((c) => c.step);
    expect(steps).toContain('run_started');
    expect(steps).toContain('run_completed');

    const completedCp = checkpoints.find((c) => c.step === 'run_completed');
    expect(completedCp?.status).toBe('COMPLETED');
    expect((completedCp?.data as Record<string, unknown>).exit_code).toBe(0);
  });

  it('records run_started and run_failed checkpoints when execution fails', async () => {
    const failRunService = new RunService({
      db,
      executionManager,
      config: {
        AGY_BIN: 'node',
        AGY_ARGS: 'non_existent_file_fail.js',
      },
    });

    const failScheduler = new TaskScheduler({
      db,
      runService: failRunService,
      autoVerify: true,
      autoRetry: false,
    });

    taskRepo.create({
      id: 'TASK-SCHED-FAIL',
      title: 'Failing task',
      description: 'should fail',
      status: 'READY',
      max_attempts: 1,
    });

    const result = await failScheduler.step();
    expect(result.executed).toBe(true);
    expect(result.status).toBe('FAILED');

    const checkpoints = checkpointRepo.findByTaskId('TASK-SCHED-FAIL');
    expect(checkpoints.length).toBeGreaterThanOrEqual(2);

    const steps = checkpoints.map((c) => c.step);
    expect(steps).toContain('run_started');
    expect(steps).toContain('run_failed');

    const failedCp = checkpoints.find((c) => c.step === 'run_failed');
    expect(failedCp?.status).toBe('FAILED');
    expect((failedCp?.data as Record<string, unknown>).exit_code).toBe(1);

    await failScheduler.stop(true);
  });
});
