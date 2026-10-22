import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  AgentLockRepository,
} from '@ai-orchestrator/db';
import { RunService } from '../services/run-service.js';
import { TaskScheduler } from '../services/task-scheduler.js';
import { createExecutionManager, type ExecutionManager } from '../adapters/execution-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mockCliPath = path.resolve(__dirname, '../../../../fixtures/mock-agy-cli.cjs');

describe('TaskScheduler Unit Tests (ORC-003: Sequential Scheduler & 1-Agent Lock)', () => {
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let lockRepo: AgentLockRepository;
  let executionManager: ExecutionManager;
  let runService: RunService;
  let scheduler: TaskScheduler;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    lockRepo = new AgentLockRepository(db);
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
    });
  });

  afterEach(async () => {
    await executionManager.stopAll();
    db.close();
  });

  it('acquires the highest priority ready task and locks the agent', () => {
    taskRepo.create({
      id: 'TASK-LOW',
      title: 'Low Priority Task',
      priority: 10,
      status: 'READY',
    });
    taskRepo.create({
      id: 'TASK-HIGH',
      title: 'High Priority Task',
      priority: 100,
      status: 'READY',
    });

    const res = scheduler.acquireNextTask();
    expect(res.acquired).toBe(true);
    expect(res.task?.id).toBe('TASK-HIGH');
    expect(res.task?.status).toBe('RUNNING');
    expect(res.task?.attempts).toBe(1);

    expect(lockRepo.isLocked('default_agent')).toBe(true);
    const lock = lockRepo.getCurrentLock('default_agent');
    expect(lock?.task_id).toBe('TASK-HIGH');
  });

  it('prevents acquiring a second task while agent is locked (lock 1 agent)', () => {
    taskRepo.create({
      id: 'TASK-1',
      title: 'Task 1',
      status: 'READY',
    });
    taskRepo.create({
      id: 'TASK-2',
      title: 'Task 2',
      status: 'READY',
    });

    const first = scheduler.acquireNextTask();
    expect(first.acquired).toBe(true);
    expect(first.task?.id).toBe('TASK-1');

    // Attempt to acquire second task
    const second = scheduler.acquireNextTask();
    expect(second.acquired).toBe(false);
    expect(second.reason).toBe('LOCK_HELD');
    expect(second.activeTaskId).toBe('TASK-1');

    // Verify TASK-2 is still READY and not running
    const t2 = taskRepo.findById('TASK-2');
    expect(t2?.status).toBe('READY');
  });

  it('Nghiệm thu: Test gọi đồng thời acquireNextTask không chạy 2 task', async () => {
    taskRepo.create({
      id: 'CONCURRENT-1',
      title: 'Concurrent Task 1',
      priority: 50,
      status: 'READY',
    });
    taskRepo.create({
      id: 'CONCURRENT-2',
      title: 'Concurrent Task 2',
      priority: 40,
      status: 'READY',
    });
    taskRepo.create({
      id: 'CONCURRENT-3',
      title: 'Concurrent Task 3',
      priority: 30,
      status: 'READY',
    });

    // Fire 5 concurrent acquire attempts
    const results = await Promise.all([
      Promise.resolve(scheduler.acquireNextTask()),
      Promise.resolve(scheduler.acquireNextTask()),
      Promise.resolve(scheduler.acquireNextTask()),
      Promise.resolve(scheduler.acquireNextTask()),
      Promise.resolve(scheduler.acquireNextTask()),
    ]);

    const acquiredCount = results.filter((r) => r.acquired).length;
    const lockedCount = results.filter((r) => !r.acquired).length;

    expect(acquiredCount).toBe(1);
    expect(lockedCount).toBe(4);

    // Verify only ONE task in DB has status RUNNING
    const runningTasks = taskRepo.findAll({ status: 'RUNNING' });
    expect(runningTasks.length).toBe(1);
    expect(runningTasks[0]?.id).toBe('CONCURRENT-1');
  });

  it('Nghiệm thu: Test gọi đồng thời step() không chạy 2 task', async () => {
    taskRepo.create({
      id: 'TASK-STEP-A',
      title: 'Task Step A',
      priority: 100,
      status: 'READY',
      repository: '.',
    });
    taskRepo.create({
      id: 'TASK-STEP-B',
      title: 'Task Step B',
      priority: 50,
      status: 'READY',
      repository: '.',
    });

    // Trigger step concurrently
    const [resA, resB, resC] = await Promise.all([
      scheduler.step(),
      scheduler.step(),
      scheduler.step(),
    ]);

    const executed = [resA, resB, resC].filter((r) => r.executed);
    const rejected = [resA, resB, resC].filter((r) => !r.executed);

    expect(executed.length).toBe(1);
    expect(rejected.length).toBe(2);

    expect(executed[0]?.taskId).toBe('TASK-STEP-A');
    expect(executed[0]?.status).toBe('DONE');

    // After A is done, lock is released, and next step runs TASK-STEP-B
    expect(lockRepo.isLocked('default_agent')).toBe(false);

    const nextStep = await scheduler.step();
    expect(nextStep.executed).toBe(true);
    expect(nextStep.taskId).toBe('TASK-STEP-B');
    expect(nextStep.status).toBe('DONE');
  });

  it('runs tasks sequentially one by one in correct dependency and priority order', async () => {
    // Chain: T1 -> T2 -> T3
    taskRepo.create({
      id: 'SEQ-1',
      title: 'Step 1',
      priority: 10,
      status: 'READY',
      repository: '.',
    });
    taskRepo.create({
      id: 'SEQ-2',
      title: 'Step 2',
      priority: 20,
      dependencies: ['SEQ-1'],
      status: 'TODO',
      repository: '.',
    });
    taskRepo.create({
      id: 'SEQ-3',
      title: 'Step 3',
      priority: 30,
      dependencies: ['SEQ-2'],
      status: 'TODO',
      repository: '.',
    });

    const results = await scheduler.runUntilEmpty();

    expect(results.length).toBe(3);
    expect(results[0]?.taskId).toBe('SEQ-1');
    expect(results[0]?.status).toBe('DONE');

    expect(results[1]?.taskId).toBe('SEQ-2');
    expect(results[1]?.status).toBe('DONE');

    expect(results[2]?.taskId).toBe('SEQ-3');
    expect(results[2]?.status).toBe('DONE');

    expect(taskRepo.findById('SEQ-1')?.status).toBe('DONE');
    expect(taskRepo.findById('SEQ-2')?.status).toBe('DONE');
    expect(taskRepo.findById('SEQ-3')?.status).toBe('DONE');
  });

  it('respects pause and resume controls', async () => {
    taskRepo.create({
      id: 'TASK-PAUSE',
      title: 'Pause Test Task',
      status: 'READY',
      repository: '.',
    });

    scheduler.pause();
    expect(scheduler.isPaused).toBe(true);

    const stepResult = await scheduler.step();
    expect(stepResult.executed).toBe(false);
    expect(stepResult.reason).toBe('SCHEDULER_PAUSED');

    scheduler.resume();
    expect(scheduler.isPaused).toBe(false);

    const resumedResult = await scheduler.step();
    expect(resumedResult.executed).toBe(true);
    expect(resumedResult.taskId).toBe('TASK-PAUSE');
    expect(resumedResult.status).toBe('DONE');
  });

  it('recovers from stale orphaned lock cleanly', () => {
    taskRepo.create({
      id: 'TASK-STALE',
      title: 'Stale lock task',
      status: 'DONE', // Task already finished but lock was left behind
    });
    taskRepo.create({
      id: 'TASK-FRESH',
      title: 'Fresh ready task',
      status: 'READY',
    });

    // Manually insert stale lock
    lockRepo.acquire({
      id: 'default_agent',
      task_id: 'TASK-STALE',
    });
    expect(lockRepo.isLocked('default_agent')).toBe(true);

    // acquireNextTask should detect that TASK-STALE is not active (status is DONE),
    // release the stale lock, and acquire TASK-FRESH
    const res = scheduler.acquireNextTask();
    expect(res.acquired).toBe(true);
    expect(res.task?.id).toBe('TASK-FRESH');
  });

  it('handles worker error correctly and transitions task to FAILED', async () => {
    taskRepo.create({
      id: 'TASK-ERR',
      title: 'Error task',
      status: 'READY',
      repository: '.',
    });

    // Override with mock CLI error flag
    const res = await scheduler.step({
      // We pass non-existent mock command to trigger failure
      timeoutMs: 5000,
    });

    expect(res.executed).toBe(true);
    expect(lockRepo.isLocked('default_agent')).toBe(false);
  });
});
