import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../connection.js';
import { runMigrations } from '../migrator.js';
import { AgentLockRepository } from '../repositories/agent-lock-repository.js';
import { TaskRepository } from '../repositories/task-repository.js';
import { RunRepository } from '../repositories/run-repository.js';
import { AppError } from '@ai-orchestrator/shared';

describe('AgentLockRepository (SQLite Lock 1 Agent)', () => {
  let db: Database.Database;
  let lockRepo: AgentLockRepository;
  let taskRepo: TaskRepository;
  let runRepo: RunRepository;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    lockRepo = new AgentLockRepository(db);
    taskRepo = new TaskRepository(db);
    runRepo = new RunRepository(db);

    taskRepo.create({
      id: 'TASK-LOCK-1',
      title: 'Task for lock test 1',
    });
    taskRepo.create({
      id: 'TASK-LOCK-2',
      title: 'Task for lock test 2',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('acquires and releases agent lock successfully', () => {
    expect(lockRepo.isLocked('default_agent')).toBe(false);
    expect(lockRepo.getCurrentLock('default_agent')).toBeNull();

    const lock = lockRepo.acquire({
      id: 'default_agent',
      task_id: 'TASK-LOCK-1',
      owner_pid: 12345,
    });

    expect(lock.id).toBe('default_agent');
    expect(lock.task_id).toBe('TASK-LOCK-1');
    expect(lock.owner_pid).toBe(12345);
    expect(lock.acquired_at).toBeTruthy();
    expect(lockRepo.isLocked('default_agent')).toBe(true);

    const released = lockRepo.release('default_agent', 'TASK-LOCK-1');
    expect(released).toBe(true);
    expect(lockRepo.isLocked('default_agent')).toBe(false);
    expect(lockRepo.getCurrentLock('default_agent')).toBeNull();
  });

  it('rejects acquiring lock if already held (throws AGENT_LOCK_HELD)', () => {
    lockRepo.acquire({
      id: 'default_agent',
      task_id: 'TASK-LOCK-1',
    });

    expect(() => {
      lockRepo.acquire({
        id: 'default_agent',
        task_id: 'TASK-LOCK-2',
      });
    }).toThrow(AppError);

    try {
      lockRepo.acquire({
        id: 'default_agent',
        task_id: 'TASK-LOCK-2',
      });
    } catch (err: unknown) {
      const appErr = err as AppError;
      expect(appErr.code).toBe('AGENT_LOCK_HELD');
      expect(appErr.context['lockId']).toBe('default_agent');
    }
  });

  it('updates runId on existing lock', () => {
    lockRepo.acquire({
      id: 'default_agent',
      task_id: 'TASK-LOCK-1',
    });

    const run = runRepo.create({
      id: 'RUN-TEST-123',
      task_id: 'TASK-LOCK-1',
      status: 'RUNNING',
    });

    lockRepo.updateRunId('default_agent', run.id);
    const current = lockRepo.getCurrentLock('default_agent');
    expect(current?.run_id).toBe(run.id);
  });

  it('forceRelease clears the lock unconditionally', () => {
    lockRepo.acquire({
      id: 'default_agent',
      task_id: 'TASK-LOCK-1',
    });
    expect(lockRepo.isLocked('default_agent')).toBe(true);

    lockRepo.forceRelease('default_agent');
    expect(lockRepo.isLocked('default_agent')).toBe(false);
  });
});
