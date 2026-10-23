import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  RunRepository,
  EventRepository,
} from '@ai-orchestrator/db';
import {
  type EventRecord,
} from '@ai-orchestrator/shared';
import {
  processAdapter,
  createExecutionManager,
  stop,
  defaultExecutionManager,
} from '../adapters/index.js';
import type Database from 'better-sqlite3';

async function waitForFile(filePath: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for file: ${filePath}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('ExecutionManager & Process Termination Unit Tests', () => {
  let tmpDir: string;
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let runRepo: RunRepository;
  let eventRepo: EventRepository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-mgr-test-'));
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    runRepo = new RunRepository(db);
    eventRepo = new EventRepository(db);

    taskRepo.create({
      id: 'TASK-001',
      title: 'Test Task 1',
    });

    defaultExecutionManager.clearAll();
  });

  afterEach(async () => {
    await defaultExecutionManager.stopAll({ gracePeriodMs: 50 });
    defaultExecutionManager.clearAll();
    db.close();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('ProcessHandle.terminate(options)', () => {
    it('terminates a cooperative process with SIGTERM within grace period without needing SIGKILL', async () => {
      const handle = processAdapter.spawn({
        exe: 'node',
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: tmpDir,
      });

      expect(handle.isRunning()).toBe(true);

      const exitResult = await handle.terminate({
        gracePeriodMs: 500,
        signal: 'SIGTERM',
      });

      expect(exitResult.signal).toBe('SIGTERM');
      expect(handle.isRunning()).toBe(false);
    });

    it('escalates to SIGKILL when process ignores SIGTERM after grace period elapses', async () => {
      const readyFile = path.join(tmpDir, `ready-${Date.now()}-1.txt`);
      // Stubborn script that traps SIGTERM and refuses to quit
      const handle = processAdapter.spawn({
        exe: 'node',
        args: [
          '-e',
          `const fs = require('fs'); process.on("SIGTERM", () => { /* ignore */ }); fs.writeFileSync(${JSON.stringify(readyFile)}, '1'); setInterval(() => {}, 1000);`,
        ],
        cwd: tmpDir,
      });

      await waitForFile(readyFile);
      expect(handle.isRunning()).toBe(true);

      const startTime = Date.now();
      const exitResult = await handle.terminate({
        gracePeriodMs: 80,
        signal: 'SIGTERM',
        forceSignal: 'SIGKILL',
      });

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeGreaterThanOrEqual(70);
      expect(exitResult.signal).toBe('SIGKILL');
      expect(handle.isRunning()).toBe(false);
    });

    it('returns immediately when terminate is called on an already stopped process', async () => {
      const handle = processAdapter.spawn({
        exe: 'node',
        args: ['-e', 'process.exit(0)'],
        cwd: tmpDir,
      });

      const firstExit = await handle.waitForExit();
      expect(firstExit.exitCode).toBe(0);

      const secondExit = await handle.terminate({ gracePeriodMs: 1000 });
      expect(secondExit.exitCode).toBe(0);
    });

    it('terminates a detached process group cleanly', async () => {
      const handle = processAdapter.spawn({
        exe: 'node',
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: tmpDir,
        detached: true,
      });

      expect(handle.command.detached).toBe(true);
      expect(handle.isRunning()).toBe(true);

      const exitResult = await handle.terminate({
        gracePeriodMs: 100,
      });

      expect(exitResult.signal).toBe('SIGTERM');
      expect(handle.isRunning()).toBe(false);
    });
  });

  describe('ExecutionManager Timeout Mechanism', () => {
    it('allows normal process that finishes before timeout to complete as SUCCESS', async () => {
      const manager = createExecutionManager();
      const runId = 'run-timeout-ok-1';

      runRepo.create({
        id: runId,
        task_id: 'TASK-001',
        status: 'RUNNING',
      });

      const managed = manager.startRun({
        runId,
        command: {
          exe: 'node',
          args: [
            '-e',
            'console.log(JSON.stringify({ type: "result", status: "SUCCESS" }));',
          ],
          cwd: tmpDir,
        },
        timeoutMs: 2000,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const result = await managed.waitForCompletion();
      expect('status' in result && result.status).toBe('SUCCESS');
      expect(managed.isTimeout).toBe(false);
      expect(managed.isRunning()).toBe(false);

      const dbRun = runRepo.getById(runId);
      expect(dbRun?.status).toBe('SUCCESS');
    });

    it('terminates a hanging process when timeoutMs expires and sets status to TIMEOUT', async () => {
      const manager = createExecutionManager({ defaultGracePeriodMs: 100 });
      const runId = 'run-timeout-triggered-1';

      runRepo.create({
        id: runId,
        task_id: 'TASK-001',
        status: 'RUNNING',
      });

      const managed = manager.startRun({
        runId,
        command: {
          exe: 'node',
          args: ['-e', 'setInterval(() => {}, 1000);'],
          cwd: tmpDir,
        },
        timeoutMs: 80,
        gracePeriodMs: 100,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      let timeoutEventFired = false;
      manager.on('timeout', (evt) => {
        if (evt.runId === runId) {
          timeoutEventFired = true;
        }
      });

      const result = await managed.waitForCompletion();
      expect('status' in result && result.status).toBe('TIMEOUT');
      expect(managed.isTimeout).toBe(true);
      expect(timeoutEventFired).toBe(true);
      expect(managed.isRunning()).toBe(false);

      const dbRun = runRepo.getById(runId);
      expect(dbRun?.status).toBe('TIMEOUT');

      const events = eventRepo.findByRunId(runId);
      const timeoutEvent = events.find((e: EventRecord) => e.type === 'process_timeout');
      expect(timeoutEvent).toBeDefined();
    });

    it('escalates to SIGKILL for a stubborn process that ignores SIGTERM upon timeout', async () => {
      const manager = createExecutionManager();
      const runId = 'run-timeout-stubborn-1';
      const readyFile = path.join(tmpDir, `ready-${Date.now()}-2.txt`);

      runRepo.create({
        id: runId,
        task_id: 'TASK-001',
        status: 'RUNNING',
      });

      const managed = manager.startRun({
        runId,
        command: {
          exe: 'node',
          args: [
            '-e',
            `const fs = require('fs'); process.on("SIGTERM", () => { /* stubborn ignore */ }); fs.writeFileSync(${JSON.stringify(readyFile)}, '1'); setInterval(() => {}, 1000);`,
          ],
          cwd: tmpDir,
        },
        timeoutMs: 500,
        gracePeriodMs: 200,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      await waitForFile(readyFile);
      const startTime = Date.now();
      const result = await managed.waitForCompletion();
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeGreaterThanOrEqual(100);
      expect('status' in result && result.status).toBe('TIMEOUT');
      expect('signal' in result && result.signal).toBe('SIGKILL');
      expect(managed.isTimeout).toBe(true);
      expect(managed.isRunning()).toBe(false);

      const dbRun = runRepo.getById(runId);
      expect(dbRun?.status).toBe('TIMEOUT');
    });
  });

  describe('ExecutionManager stop(runId) Functionality', () => {
    it('stops a running process and sets status to CANCELLED', async () => {
      const manager = createExecutionManager();
      const runId = 'run-stop-test-1';

      runRepo.create({
        id: runId,
        task_id: 'TASK-001',
        status: 'RUNNING',
      });

      const managed = manager.startRun({
        runId,
        command: {
          exe: 'node',
          args: ['-e', 'setInterval(() => {}, 1000);'],
          cwd: tmpDir,
        },
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      expect(manager.isRunning(runId)).toBe(true);

      const stopped = await manager.stop(runId, {
        reason: 'User cancelled task',
        gracePeriodMs: 100,
      });

      expect(stopped).toBe(true);
      expect(managed.isCancelled).toBe(true);
      expect(managed.isRunning()).toBe(false);

      const result = await managed.waitForCompletion();
      expect('status' in result && result.status).toBe('CANCELLED');

      const dbRun = runRepo.getById(runId);
      expect(dbRun?.status).toBe('CANCELLED');

      const events = eventRepo.findByRunId(runId);
      const stopEvent = events.find((e: EventRecord) => e.type === 'process_stopped');
      expect(stopEvent).toBeDefined();
    });

    it('kills a stubborn process with SIGKILL after grace period when stop(runId) is called', async () => {
      const manager = createExecutionManager();
      const runId = 'run-stop-stubborn-1';
      const readyFile = path.join(tmpDir, `ready-${Date.now()}-3.txt`);

      runRepo.create({
        id: runId,
        task_id: 'TASK-001',
        status: 'RUNNING',
      });

      const managed = manager.startRun({
        runId,
        command: {
          exe: 'node',
          args: [
            '-e',
            `const fs = require('fs'); process.on("SIGTERM", () => { /* stubborn ignore */ }); fs.writeFileSync(${JSON.stringify(readyFile)}, '1'); setInterval(() => {}, 1000);`,
          ],
          cwd: tmpDir,
        },
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      await waitForFile(readyFile);
      const startTime = Date.now();
      const stopped = await manager.stop(runId, { gracePeriodMs: 80 });
      const elapsed = Date.now() - startTime;

      expect(stopped).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(70);
      expect(managed.isRunning()).toBe(false);

      const result = await managed.waitForCompletion();
      expect('status' in result && result.status).toBe('CANCELLED');
      expect('signal' in result && result.signal).toBe('SIGKILL');

      const dbRun = runRepo.getById(runId);
      expect(dbRun?.status).toBe('CANCELLED');
    });

    it('cancels pending timeout timer when stop(runId) is called before timeout', async () => {
      const manager = createExecutionManager();
      const runId = 'run-stop-before-timeout';

      runRepo.create({
        id: runId,
        task_id: 'TASK-001',
        status: 'RUNNING',
      });

      const managed = manager.startRun({
        runId,
        command: {
          exe: 'node',
          args: ['-e', 'setInterval(() => {}, 1000);'],
          cwd: tmpDir,
        },
        timeoutMs: 500,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const stopped = await manager.stop(runId, { gracePeriodMs: 50 });
      expect(stopped).toBe(true);

      // Wait past the original timeout
      await new Promise((r) => setTimeout(r, 600));

      expect(managed.isTimeout).toBe(false);
      expect(managed.isCancelled).toBe(true);

      const dbRun = runRepo.getById(runId);
      expect(dbRun?.status).toBe('CANCELLED');
    });

    it('returns false when stop(runId) is called on a non-existent or already stopped run', async () => {
      const manager = createExecutionManager();

      const notFoundResult = await manager.stop('non-existent-run');
      expect(notFoundResult).toBe(false);

      const runId = 'run-already-completed';
      const managed = manager.startRun({
        runId,
        command: {
          exe: 'node',
          args: ['-e', 'process.exit(0);'],
          cwd: tmpDir,
        },
      });

      await managed.waitForCompletion();
      const alreadyStoppedResult = await manager.stop(runId);
      expect(alreadyStoppedResult).toBe(false);
    });

    it('convenience top-level stop(runId) function uses defaultExecutionManager', async () => {
      const runId = 'run-default-stop';

      runRepo.create({
        id: runId,
        task_id: 'TASK-001',
        status: 'RUNNING',
      });

      const managed = defaultExecutionManager.startRun({
        runId,
        command: {
          exe: 'node',
          args: ['-e', 'setInterval(() => {}, 1000);'],
          cwd: tmpDir,
        },
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      expect(defaultExecutionManager.isRunning(runId)).toBe(true);

      const stopped = await stop(runId, { gracePeriodMs: 50 });
      expect(stopped).toBe(true);

      const result = await managed.waitForCompletion();
      expect('status' in result && result.status).toBe('CANCELLED');
    });

    it('stopAll() stops all active executions and returns stopped count', async () => {
      const manager = createExecutionManager();

      manager.startRun({
        runId: 'multi-run-1',
        command: { exe: 'node', args: ['-e', 'setInterval(() => {}, 1000);'], cwd: tmpDir },
      });
      manager.startRun({
        runId: 'multi-run-2',
        command: { exe: 'node', args: ['-e', 'setInterval(() => {}, 1000);'], cwd: tmpDir },
      });

      expect(manager.listRunning().length).toBe(2);

      const count = await manager.stopAll({ gracePeriodMs: 50 });
      expect(count).toBe(2);
      expect(manager.listRunning().length).toBe(0);
    });
  });
});
