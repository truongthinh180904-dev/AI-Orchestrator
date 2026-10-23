import { describe, expect, it } from 'vitest';
import { createDatabase, runMigrations, TaskRepository, RunRepository } from '@ai-orchestrator/db';
import { QualityGateService } from '../services/quality-gate-service.js';
import { TaskScheduler } from '../services/task-scheduler.js';
import { RunService } from '../services/run-service.js';
import { createExecutionManager } from '../adapters/execution-manager.js';
import type { QualityCommandRecord } from '@ai-orchestrator/shared';

describe('QualityGateService & TaskScheduler Integration (QLT-007)', () => {
  function setupTestEnv() {
    const db = createDatabase(':memory:');
    runMigrations(db);

    const taskRepo = new TaskRepository(db);
    const runRepo = new RunRepository(db);

    const now = new Date().toISOString();
    taskRepo.create({
      id: 'TASK-QG-SVC',
      title: 'Service Quality Gate Test',
      acceptance_criteria: ['Verification tests pass'],
      status: 'VERIFYING',
      created_at: now,
      updated_at: now,
    });

    const run = runRepo.create({
      task_id: 'TASK-QG-SVC',
      attempt: 1,
      status: 'SUCCESS',
      exit_code: 0,
      started_at: now,
      finished_at: now,
    });

    const qualityGateService = new QualityGateService({ db });

    return { db, taskRepo, runRepo, run, qualityGateService };
  }

  it('1. runQualityGateForTask throws error when task is not found', async () => {
    const { qualityGateService } = setupTestEnv();
    await expect(qualityGateService.runQualityGateForTask('NON-EXISTENT-TASK')).rejects.toThrow(
      'Task with id \'NON-EXISTENT-TASK\' not found',
    );
  });

  it('2. verifyAndTransitionTask transitions task to DONE when Quality Gate passes with genuine evidence', async () => {
    const { taskRepo, run, qualityGateService } = setupTestEnv();

    const dummyPassedCmd: QualityCommandRecord = {
      id: 'cmd-pass',
      task_id: 'TASK-QG-SVC',
      run_id: run.id,
      stage: 'test',
      command_id: 'test',
      name: 'Unit tests',
      command: 'pnpm test',
      exe: 'pnpm',
      args: ['test'],
      cwd: '.',
      exit_code: 0,
      signal: null,
      status: 'SUCCESS',
      stdout: '10 tests passed',
      stderr: '',
      duration_ms: 50,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };

    const { result, task } = await qualityGateService.verifyAndTransitionTask('TASK-QG-SVC', {
      runId: run.id,
      evidenceOverrides: {
        commandRecords: [dummyPassedCmd],
      },
    });

    expect(result.passed).toBe(true);
    expect(result.status).toBe('PASSED');
    expect(task.status).toBe('DONE');

    const inDb = taskRepo.findById('TASK-QG-SVC');
    expect(inDb?.status).toBe('DONE');
  });

  it('3. verifyAndTransitionTask transitions task to FAILED when Quality Gate fails, fulfilling "Không PASS chỉ vì CLI báo SUCCESS"', async () => {
    const { taskRepo, run, qualityGateService } = setupTestEnv();

    // CLI reported exit 0 / SUCCESS, but test command exited 1
    const dummyFailedCmd: QualityCommandRecord = {
      id: 'cmd-fail',
      task_id: 'TASK-QG-SVC',
      run_id: run.id,
      stage: 'test',
      command_id: 'test',
      name: 'Unit tests',
      command: 'pnpm test',
      exe: 'pnpm',
      args: ['test'],
      cwd: '.',
      exit_code: 1,
      signal: null,
      status: 'FAILURE',
      stdout: '',
      stderr: 'FAIL: assertion error',
      duration_ms: 60,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };

    const { result, task } = await qualityGateService.verifyAndTransitionTask('TASK-QG-SVC', {
      runId: run.id,
      evidenceOverrides: {
        cliExitCode: 0,
        cliStatus: 'SUCCESS',
        commandRecords: [dummyFailedCmd],
      },
    });

    expect(result.passed).toBe(false);
    expect(result.status).toBe('FAILED');
    expect(task.status).toBe('FAILED');

    const inDb = taskRepo.findById('TASK-QG-SVC');
    expect(inDb?.status).toBe('FAILED');
  });

  it('4. TaskScheduler delegates verification to QualityGateService and prevents marking DONE if checks fail', async () => {
    const { db, taskRepo, runRepo } = setupTestEnv();
    taskRepo.updateStatus('TASK-QG-SVC', 'DONE');

    // Setup task ready for execution
    const now = new Date().toISOString();
    taskRepo.create({
      id: 'TASK-SCHED-QG',
      title: 'Scheduler with Quality Gate Task',
      acceptance_criteria: ['Must pass gate'],
      status: 'READY',
      created_at: now,
      updated_at: now,
    });

    const executionManager = createExecutionManager();
    const runService = new RunService({ db, executionManager });
    runService.startRun = async (input) => {
      const run = runRepo.create({
        task_id: input.taskId,
        attempt: 1,
        status: 'SUCCESS',
        exit_code: 0,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      });
      return {
        run,
        execution: {
          waitForCompletion: async () => {},
        } as unknown as Awaited<ReturnType<RunService['startRun']>>['execution'],
      };
    };
    const qualityGateService = new QualityGateService({ db });

    // Mock verifyAndTransitionTask to simulate failing Quality Gate despite CLI success
    let verifyCalled = false;
    qualityGateService.verifyAndTransitionTask = async (taskId, options) => {
      verifyCalled = true;
      const res = qualityGateService.evaluate(
        {
          cliExitCode: 0,
          cliStatus: 'SUCCESS',
          commandRecords: [
            {
              id: 'cmd-failing',
              task_id: taskId,
              run_id: options?.runId ?? null,
              stage: 'test',
              command_id: 'test',
              name: 'Tests',
              command: 'pnpm test',
              exe: 'pnpm',
              args: ['test'],
              cwd: '.',
              exit_code: 1,
              signal: null,
              status: 'FAILURE',
              stdout: '',
              stderr: 'Failed',
              duration_ms: 10,
              started_at: new Date().toISOString(),
              finished_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
            },
          ],
        },
        { taskId, runId: options?.runId },
      );
      // Mark failed
      const updated = taskRepo.updateStatus(taskId, 'FAILED');
      return { result: res, task: updated };
    };

    const scheduler = new TaskScheduler({
      db,
      runService,
      qualityGateService,
      autoVerify: true,
    });

    const stepResult = await scheduler.step();
    expect(stepResult.executed).toBe(true);
    expect(verifyCalled).toBe(true);

    const taskInDb = taskRepo.findById('TASK-SCHED-QG');
    expect(taskInDb?.status).toBe('FAILED'); // NOT DONE!
  });
});
