import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  RunRepository,
  EventRepository,
} from '@ai-orchestrator/db';
import {
  createExecutionManager,
  type ExecutionManager,
  type ExecutionCompletionResult,
} from '../adapters/index.js';
import type Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mockCliPath = path.resolve(__dirname, '../../../../fixtures/mock-agy-cli.cjs');

describe('Mock CLI Execution Scenarios (AGY-008)', () => {
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let runRepo: RunRepository;
  let eventRepo: EventRepository;
  let executionManager: ExecutionManager;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    runRepo = new RunRepository(db);
    eventRepo = new EventRepository(db);
    executionManager = createExecutionManager({ defaultGracePeriodMs: 200 });

    // Seed task for runs
    taskRepo.create({
      id: 'TASK-MOCK-MAIN',
      title: 'Task for Mock CLI tests',
      repository: '.',
      timeout_minutes: 5,
    });
  });

  afterEach(async () => {
    await executionManager.stopAll();
    db.close();
  });

  describe('Scenario: Error handling', () => {
    it('handles process exit with code 1 and captures error result event', async () => {
      const run = runRepo.create({ task_id: 'TASK-MOCK-MAIN', attempt: 1, status: 'RUNNING' });
      const execution = executionManager.startRun({
        runId: run.id,
        taskId: 'TASK-MOCK-MAIN',
        command: { exe: 'node', args: [mockCliPath, 'error'], cwd: process.cwd() },
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = (await execution.waitForCompletion()) as ExecutionCompletionResult;
      expect(completion.status).toBe('ERROR');
      expect(completion.exitCode).toBe(1);

      const updatedRun = runRepo.getById(run.id);
      expect(updatedRun?.status).toBe('ERROR');
      expect(updatedRun?.exit_code).toBe(1);

      const logs = eventRepo.getRawLogs(run.id);
      expect(logs.some((l) => l.type === 'stderr' && l.text.includes('Fatal: compile error'))).toBe(true);
    });

    it('handles zero exit code with logical error result event', async () => {
      const run = runRepo.create({ task_id: 'TASK-MOCK-MAIN', attempt: 2, status: 'RUNNING' });
      const execution = executionManager.startRun({
        runId: run.id,
        taskId: 'TASK-MOCK-MAIN',
        command: { exe: 'node', args: [mockCliPath, 'error_result_zero_exit'], cwd: process.cwd() },
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = (await execution.waitForCompletion()) as ExecutionCompletionResult;
      expect(completion.status).toBe('ERROR');
      expect(completion.exitCode).toBe(0);

      const updatedRun = runRepo.getById(run.id);
      expect(updatedRun?.status).toBe('ERROR');
    });
  });

  describe('Scenario: Timeout handling', () => {
    it('terminates hanging process via SIGTERM within grace period', async () => {
      const run = runRepo.create({ task_id: 'TASK-MOCK-MAIN', attempt: 3, status: 'RUNNING' });
      const execution = executionManager.startRun({
        runId: run.id,
        taskId: 'TASK-MOCK-MAIN',
        command: { exe: 'node', args: [mockCliPath, 'timeout'], cwd: process.cwd() },
        timeoutMs: 150,
        gracePeriodMs: 300,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = (await execution.waitForCompletion()) as ExecutionCompletionResult;
      expect(completion.status).toBe('TIMEOUT');

      const updatedRun = runRepo.getById(run.id);
      expect(updatedRun?.status).toBe('TIMEOUT');
    });

    it('terminates stubborn process via SIGKILL after grace period', async () => {
      const run = runRepo.create({ task_id: 'TASK-MOCK-MAIN', attempt: 4, status: 'RUNNING' });
      const execution = executionManager.startRun({
        runId: run.id,
        taskId: 'TASK-MOCK-MAIN',
        command: { exe: 'node', args: [mockCliPath, 'stubborn'], cwd: process.cwd() },
        timeoutMs: 150,
        gracePeriodMs: 150,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = (await execution.waitForCompletion()) as ExecutionCompletionResult;
      expect(completion.status).toBe('TIMEOUT');

      const updatedRun = runRepo.getById(run.id);
      expect(updatedRun?.status).toBe('TIMEOUT');
    });
  });

  describe('Scenario: Crash handling', () => {
    it('handles segfault exit code 139 gracefully', async () => {
      const run = runRepo.create({ task_id: 'TASK-MOCK-MAIN', attempt: 5, status: 'RUNNING' });
      const execution = executionManager.startRun({
        runId: run.id,
        taskId: 'TASK-MOCK-MAIN',
        command: { exe: 'node', args: [mockCliPath, 'crash_segfault'], cwd: process.cwd() },
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = (await execution.waitForCompletion()) as ExecutionCompletionResult;
      expect(completion.status).toBe('ERROR');
      expect(completion.exitCode).toBe(139);

      const updatedRun = runRepo.getById(run.id);
      expect(updatedRun?.status).toBe('ERROR');
      expect(updatedRun?.exit_code).toBe(139);
    });

    it('handles uncaught exception in process runtime', async () => {
      const run = runRepo.create({ task_id: 'TASK-MOCK-MAIN', attempt: 6, status: 'RUNNING' });
      const execution = executionManager.startRun({
        runId: run.id,
        taskId: 'TASK-MOCK-MAIN',
        command: { exe: 'node', args: [mockCliPath, 'crash_uncaught'], cwd: process.cwd() },
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = (await execution.waitForCompletion()) as ExecutionCompletionResult;
      expect(completion.status).toBe('ERROR');

      const events = eventRepo.findByRunId(run.id);
      expect(events.some((e) => e.type === 'stderr' && e.payload && JSON.stringify(e.payload).includes('Uncaught TypeError'))).toBe(true);
    });
  });

  describe('Scenario: Garbage output handling', () => {
    it('resolves to INVALID_OUTPUT when CLI emits plain text without result event', async () => {
      const run = runRepo.create({ task_id: 'TASK-MOCK-MAIN', attempt: 7, status: 'RUNNING' });
      const execution = executionManager.startRun({
        runId: run.id,
        taskId: 'TASK-MOCK-MAIN',
        command: { exe: 'node', args: [mockCliPath, 'no_result'], cwd: process.cwd() },
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = (await execution.waitForCompletion()) as ExecutionCompletionResult;
      expect(completion.status).toBe('INVALID_OUTPUT');
      expect(completion.exitCode).toBe(0);

      const updatedRun = runRepo.getById(run.id);
      expect(updatedRun?.status).toBe('INVALID_OUTPUT');
    });

    it('recovers from garbage JSON lines and records parse_error events while completing with SUCCESS', async () => {
      const run = runRepo.create({ task_id: 'TASK-MOCK-MAIN', attempt: 8, status: 'RUNNING' });
      const execution = executionManager.startRun({
        runId: run.id,
        taskId: 'TASK-MOCK-MAIN',
        command: { exe: 'node', args: [mockCliPath, 'garbage_stream'], cwd: process.cwd() },
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = (await execution.waitForCompletion()) as ExecutionCompletionResult;
      expect(completion.status).toBe('SUCCESS');

      const events = eventRepo.findByRunId(run.id);
      const parseErrors = events.filter((e) => e.type === 'parse_error');
      expect(parseErrors.length).toBeGreaterThanOrEqual(2);

      const resultEvents = events.filter((e) => e.type === 'result');
      expect(resultEvents.length).toBe(1);
    });

    it('handles huge line (200KB+) safely without crashing', async () => {
      const run = runRepo.create({ task_id: 'TASK-MOCK-MAIN', attempt: 9, status: 'RUNNING' });
      const execution = executionManager.startRun({
        runId: run.id,
        taskId: 'TASK-MOCK-MAIN',
        command: { exe: 'node', args: [mockCliPath, 'huge_line'], cwd: process.cwd() },
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = (await execution.waitForCompletion()) as ExecutionCompletionResult;
      expect(completion.status).toBe('SUCCESS');
      expect(completion.exitCode).toBe(0);
    });
  });
});
