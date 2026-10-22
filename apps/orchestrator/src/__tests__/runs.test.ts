import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDatabase, runMigrations, TaskRepository } from '@ai-orchestrator/db';
import { buildServer } from '../server.js';
import { RunService } from '../services/run-service.js';
import { createExecutionManager, type ExecutionManager } from '../adapters/execution-manager.js';
import type Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mockCliPath = path.resolve(__dirname, '../../../../fixtures/mock-agy-cli.cjs');

describe('Orchestrator RunService & Runs Routes Unit Tests', () => {
  let db: Database.Database;
  let server: FastifyInstance;
  let executionManager: ExecutionManager;
  let runService: RunService;
  let taskRepo: TaskRepository;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);
    executionManager = createExecutionManager();
    runService = new RunService({ db, executionManager });
    taskRepo = new TaskRepository(db);

    // Seed test task
    taskRepo.create({
      id: 'TASK-API-1',
      title: 'Test task for API runs',
      description: 'Run unit test task',
      repository: '.',
      timeout_minutes: 5,
    });

    server = await buildServer({ db, executionManager, logger: false });
    await server.ready();
  });

  afterEach(async () => {
    await executionManager.stopAll();
    await server.close();
    db.close();
  });

  describe('RunService unit methods', () => {
    it('startRun starts a managed execution and creates a run record in DB', async () => {
      const { run, execution } = await runService.startRun({
        taskId: 'TASK-API-1',
        command: {
          exe: 'node',
          args: [mockCliPath, 'success'],
          cwd: process.cwd(),
        },
      });

      expect(run.id).toBeTruthy();
      expect(run.task_id).toBe('TASK-API-1');
      expect(run.attempt).toBe(1);
      expect(run.status).toBe('RUNNING');
      expect(execution.handle.pid).toBeTruthy();

      await execution.waitForCompletion();
      const updated = runService.getRun(run.id);
      expect(updated.status).toBe('SUCCESS');
      expect(updated.isRunning).toBe(false);
    });

    it('startRun throws TASK_NOT_FOUND when task does not exist', async () => {
      await expect(
        runService.startRun({
          taskId: 'NON-EXISTENT-TASK',
        }),
      ).rejects.toThrow('Task with id \'NON-EXISTENT-TASK\' not found');
    });

    it('listRuns returns all created runs with filtering', async () => {
      const { run, execution } = await runService.startRun({
        taskId: 'TASK-API-1',
        command: {
          exe: 'node',
          args: [mockCliPath, 'success'],
          cwd: process.cwd(),
        },
      });
      await execution.waitForCompletion();

      const all = runService.listRuns();
      expect(all.length).toBe(1);
      expect(all[0]?.id).toBe(run.id);

      const filtered = runService.listRuns({ taskId: 'TASK-API-1' });
      expect(filtered.length).toBe(1);

      const empty = runService.listRuns({ taskId: 'OTHER-TASK' });
      expect(empty.length).toBe(0);
    });

    it('stopRun cancels an active running execution', async () => {
      const { run, execution } = await runService.startRun({
        taskId: 'TASK-API-1',
        command: {
          exe: 'node',
          args: [mockCliPath, 'hang'],
          cwd: process.cwd(),
        },
      });

      expect(runService.getRun(run.id).isRunning).toBe(true);
      const stopResult = await runService.stopRun(run.id, { reason: 'Test cancel' });

      expect(stopResult.stopped).toBe(true);
      expect(stopResult.run.status).toBe('CANCELLED');
      await execution.waitForCompletion();
    });

    it('getEvents retrieves recorded events for run', async () => {
      const { run, execution } = await runService.startRun({
        taskId: 'TASK-API-1',
        command: {
          exe: 'node',
          args: [mockCliPath, 'success'],
          cwd: process.cwd(),
        },
      });
      await execution.waitForCompletion();

      const events = runService.getEvents(run.id);
      expect(events.length).toBeGreaterThan(0);
      expect(events.some((e) => e.type === 'process_start')).toBe(true);
      expect(events.some((e) => e.type === 'result')).toBe(true);
    });
  });

  describe('Fastify routes injection', () => {
    it('POST /runs starts run via API with mock CLI', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-API-1',
          command: {
            exe: 'node',
            args: [mockCliPath, 'success'],
            cwd: process.cwd(),
          },
        },
      });

      expect(res.statusCode).toBe(201);
      const json = res.json();
      expect(json.data.id).toBeTruthy();
      expect(json.data.task_id).toBe('TASK-API-1');
      expect(json.data.status).toBe('RUNNING');
      expect(json.data.pid).toBeTypeOf('number');

      // Wait for completion
      const managed = executionManager.get(json.data.id);
      if (managed) {
        await managed.waitForCompletion();
      }
    });

    it('POST /runs rejects non-existent taskId with 404', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'DOES-NOT-EXIST',
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('TASK_NOT_FOUND');
    });

    it('GET /runs/:id returns 200 with run status and isRunning', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-API-1',
          command: {
            exe: 'node',
            args: [mockCliPath, 'success'],
            cwd: process.cwd(),
          },
        },
      });
      const runId = postRes.json().data.id;

      const managed = executionManager.get(runId);
      if (managed) {
        await managed.waitForCompletion();
      }

      const getRes = await server.inject({
        method: 'GET',
        url: `/runs/${runId}`,
      });

      expect(getRes.statusCode).toBe(200);
      const data = getRes.json().data;
      expect(data.id).toBe(runId);
      expect(data.status).toBe('SUCCESS');
      expect(data.isRunning).toBe(false);
    });

    it('POST /runs/:id/stop stops active execution via API', async () => {
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-API-1',
          command: {
            exe: 'node',
            args: [mockCliPath, 'hang'],
            cwd: process.cwd(),
          },
        },
      });
      const runId = postRes.json().data.id;

      const stopRes = await server.inject({
        method: 'POST',
        url: `/runs/${runId}/stop`,
        payload: {
          reason: 'Stopped via API test',
        },
      });

      expect(stopRes.statusCode).toBe(200);
      expect(stopRes.json().data.stopped).toBe(true);
      expect(stopRes.json().data.status).toBe('CANCELLED');
    });

    it('GET /runs/:id/stream serves SSE format events', async () => {
      // Run and wait for completion
      const postRes = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-API-1',
          command: {
            exe: 'node',
            args: [mockCliPath, 'success'],
            cwd: process.cwd(),
          },
        },
      });
      const runId = postRes.json().data.id;
      const managed = executionManager.get(runId);
      if (managed) {
        await managed.waitForCompletion();
      }

      const streamRes = await server.inject({
        method: 'GET',
        url: `/runs/${runId}/stream`,
      });

      expect(streamRes.statusCode).toBe(200);
      expect(streamRes.headers['content-type']).toContain('text/event-stream');
      expect(streamRes.payload).toContain('id: 1');
      expect(streamRes.payload).toContain('event: process_start');
      expect(streamRes.payload).toContain('event: done');
    });
  });
});
