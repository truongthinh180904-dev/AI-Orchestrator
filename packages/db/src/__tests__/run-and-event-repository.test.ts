import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../connection.js';
import { runMigrations } from '../migrator.js';
import { TaskRepository } from '../repositories/task-repository.js';
import { RunRepository } from '../repositories/run-repository.js';
import { EventRepository } from '../repositories/event-repository.js';

describe('AGY-003: RunRepository & EventRepository', () => {
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let runRepo: RunRepository;
  let eventRepo: EventRepository;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    runRepo = new RunRepository(db);
    eventRepo = new EventRepository(db);

    // Create a base task to satisfy foreign key constraints
    taskRepo.create({
      id: 'TASK-1',
      title: 'Test Task',
    });
  });

  describe('RunRepository', () => {
    it('creates and retrieves a run with default and custom values', () => {
      const run = runRepo.create({
        id: 'run-1',
        task_id: 'TASK-1',
        attempt: 1,
        status: 'RUNNING',
        pid: 12345,
      });

      expect(run.id).toBe('run-1');
      expect(run.task_id).toBe('TASK-1');
      expect(run.attempt).toBe(1);
      expect(run.status).toBe('RUNNING');
      expect(run.pid).toBe(12345);
      expect(run.exit_code).toBeNull();
      expect(run.finished_at).toBeNull();
      expect(run.started_at).toBeDefined();

      const retrieved = runRepo.getById('run-1');
      expect(retrieved).toEqual(run);
    });

    it('finds runs by task_id in sequential order', () => {
      runRepo.create({ id: 'run-1', task_id: 'TASK-1', attempt: 1 });
      runRepo.create({ id: 'run-2', task_id: 'TASK-1', attempt: 2 });

      const runs = runRepo.findByTaskId('TASK-1');
      expect(runs).toHaveLength(2);
      expect(runs[0]?.id).toBe('run-1');
      expect(runs[1]?.id).toBe('run-2');
    });

    it('updates run status and details', () => {
      runRepo.create({ id: 'run-1', task_id: 'TASK-1' });

      const updated = runRepo.updateStatus('run-1', 'SUCCESS', {
        exit_code: 0,
        finished_at: '2026-10-23T04:00:00.000Z',
      });

      expect(updated.status).toBe('SUCCESS');
      expect(updated.exit_code).toBe(0);
      expect(updated.finished_at).toBe('2026-10-23T04:00:00.000Z');
    });

    it('deletes a run', () => {
      runRepo.create({ id: 'run-del', task_id: 'TASK-1' });
      expect(runRepo.delete('run-del')).toBe(true);
      expect(runRepo.getById('run-del')).toBeNull();
    });
  });

  describe('EventRepository', () => {
    beforeEach(() => {
      runRepo.create({ id: 'run-1', task_id: 'TASK-1' });
    });

    it('creates events with automatic monotonic sequence numbers', () => {
      const e1 = eventRepo.create({
        run_id: 'run-1',
        type: 'stdout',
        payload: { text: 'Starting process' },
      });
      const e2 = eventRepo.create({
        run_id: 'run-1',
        type: 'step',
        payload: { stepNumber: 1, action: 'compile' },
      });
      const e3 = eventRepo.create({
        run_id: 'run-1',
        type: 'process_exit',
        payload: { exitCode: 0 },
      });

      expect(e1.seq).toBe(1);
      expect(e2.seq).toBe(2);
      expect(e3.seq).toBe(3);
      expect(eventRepo.getNextSeq('run-1')).toBe(4);
      expect(eventRepo.countByRunId('run-1')).toBe(3);
    });

    it('creates events with explicit sequence numbers', () => {
      const e10 = eventRepo.create({
        run_id: 'run-1',
        seq: 10,
        type: 'custom',
        payload: { message: 'jump' },
      });

      expect(e10.seq).toBe(10);
      expect(eventRepo.getNextSeq('run-1')).toBe(11);
    });

    it('batch inserts events atomically in a transaction', () => {
      const records = eventRepo.createBatch([
        { run_id: 'run-1', type: 'stdout', payload: { text: 'line 1' } },
        { run_id: 'run-1', type: 'stdout', payload: { text: 'line 2' } },
        { run_id: 'run-1', type: 'stderr', payload: { text: 'warn 1' } },
      ]);

      expect(records).toHaveLength(3);
      expect(records[0]?.seq).toBe(1);
      expect(records[1]?.seq).toBe(2);
      expect(records[2]?.seq).toBe(3);
      expect(eventRepo.countByRunId('run-1')).toBe(3);
    });

    it('filters events by type, after_seq, and pagination', () => {
      eventRepo.createBatch([
        { run_id: 'run-1', seq: 1, type: 'stdout', payload: { text: 'out 1' } },
        { run_id: 'run-1', seq: 2, type: 'stderr', payload: { text: 'err 1' } },
        { run_id: 'run-1', seq: 3, type: 'stdout', payload: { text: 'out 2' } },
        { run_id: 'run-1', seq: 4, type: 'result', payload: { status: 'DONE' } },
      ]);

      const stdoutEvents = eventRepo.findByRunId('run-1', { type: 'stdout' });
      expect(stdoutEvents).toHaveLength(2);
      expect(stdoutEvents[0]?.seq).toBe(1);
      expect(stdoutEvents[1]?.seq).toBe(3);

      const afterSeqEvents = eventRepo.findByRunId('run-1', { after_seq: 2 });
      expect(afterSeqEvents).toHaveLength(2);
      expect(afterSeqEvents[0]?.seq).toBe(3);
      expect(afterSeqEvents[1]?.seq).toBe(4);

      const paged = eventRepo.findByRunId('run-1', { limit: 2, offset: 1 });
      expect(paged).toHaveLength(2);
      expect(paged[0]?.seq).toBe(2);
      expect(paged[1]?.seq).toBe(3);
    });

    it('extracts raw logs chronologically for stdout and stderr', () => {
      eventRepo.createBatch([
        { run_id: 'run-1', seq: 1, type: 'stdout', payload: { text: 'Log message 1' } },
        { run_id: 'run-1', seq: 2, type: 'result', payload: { success: true } },
        { run_id: 'run-1', seq: 3, type: 'stderr', payload: { text: 'Warning message 1' } },
        { run_id: 'run-1', seq: 4, type: 'stdout', payload: { text: 'Log message 2' } },
      ]);

      const rawLogs = eventRepo.getRawLogs('run-1');
      expect(rawLogs).toHaveLength(3);
      expect(rawLogs[0]).toMatchObject({ type: 'stdout', text: 'Log message 1', seq: 1 });
      expect(rawLogs[1]).toMatchObject({ type: 'stderr', text: 'Warning message 1', seq: 3 });
      expect(rawLogs[2]).toMatchObject({ type: 'stdout', text: 'Log message 2', seq: 4 });
    });

    it('properly serializes and parses structured payloads', () => {
      const complexPayload = {
        nested: { count: 42, tags: ['a', 'b'] },
        flag: true,
      };

      const event = eventRepo.create({
        run_id: 'run-1',
        type: 'complex_event',
        payload: complexPayload,
      });

      expect(event.payload).toEqual(complexPayload);

      const retrieved = eventRepo.findByRunId('run-1', { type: 'complex_event' });
      expect(retrieved[0]?.payload).toEqual(complexPayload);
    });

    it('cascades delete when parent run is deleted', () => {
      eventRepo.create({ run_id: 'run-1', type: 'stdout', payload: 'test' });
      expect(eventRepo.countByRunId('run-1')).toBe(1);

      runRepo.delete('run-1');
      expect(eventRepo.countByRunId('run-1')).toBe(0);
    });
  });
});
