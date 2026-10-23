import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDatabase } from '../connection.js';
import { AppError } from '../errors.js';
import { getAppliedMigrations, runMigrations } from '../migrator.js';

describe('Migration Runner', () => {
  it('Chạy migration 2 lần không lỗi (Nghiệm thu FND-003)', () => {
    const db = createDatabase(':memory:');
    try {
      // First run: executes all migrations
      const firstRun = runMigrations(db);
      expect(firstRun).toContain('001_initial_schema.sql');
      expect(firstRun).toContain('002_agent_lock.sql');
      expect(firstRun).toContain('003_checkpoints.sql');
      expect(firstRun).toContain('004_plans.sql');

      const appliedAfterFirst = getAppliedMigrations(db);
      expect(appliedAfterFirst.length).toBe(4);
      expect(appliedAfterFirst[0]?.name).toBe('001_initial_schema.sql');
      expect(appliedAfterFirst[1]?.name).toBe('002_agent_lock.sql');
      expect(appliedAfterFirst[2]?.name).toBe('003_checkpoints.sql');
      expect(appliedAfterFirst[3]?.name).toBe('004_plans.sql');
      expect(appliedAfterFirst[0]?.applied_at).toBeTruthy();
      expect(appliedAfterFirst[1]?.applied_at).toBeTruthy();
      expect(appliedAfterFirst[2]?.applied_at).toBeTruthy();
      expect(appliedAfterFirst[3]?.applied_at).toBeTruthy();

      // Second run: idempotent, returns empty array, no error
      const secondRun = runMigrations(db);
      expect(secondRun).toEqual([]);

      const appliedAfterSecond = getAppliedMigrations(db);
      expect(appliedAfterSecond.length).toBe(4);
    } finally {
      db.close();
    }
  });

  it('creates all core tables (tasks, features, runs, events, reports, task_dependencies)', () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name ASC")
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);

      expect(tableNames).toContain('_migrations');
      expect(tableNames).toContain('features');
      expect(tableNames).toContain('tasks');
      expect(tableNames).toContain('task_dependencies');
      expect(tableNames).toContain('runs');
      expect(tableNames).toContain('events');
      expect(tableNames).toContain('reports');
      expect(tableNames).toContain('agent_locks');
      expect(tableNames).toContain('checkpoints');
      expect(tableNames).toContain('plans');
    } finally {
      db.close();
    }
  });

  it('enforces foreign key constraints and cascade rules', () => {
    const db = createDatabase(':memory:');
    try {
      runMigrations(db);

      const now = new Date().toISOString();

      // 1. Task referencing nonexistent feature should fail
      expect(() => {
        db.prepare(
          `INSERT INTO tasks (id, feature_id, title, created_at, updated_at)
           VALUES ('TSK-001', 'NON_EXISTENT_FEAT', 'Test Task', ?, ?)`,
        ).run(now, now);
      }).toThrow();

      // 2. Insert valid feature and task
      db.prepare(
        `INSERT INTO features (id, name, created_at, updated_at)
         VALUES ('FEAT-001', 'Core Feature', ?, ?)`,
      ).run(now, now);

      db.prepare(
        `INSERT INTO tasks (id, feature_id, title, created_at, updated_at)
         VALUES ('TSK-001', 'FEAT-001', 'Task 1', ?, ?)`,
      ).run(now, now);

      db.prepare(
        `INSERT INTO tasks (id, feature_id, title, created_at, updated_at)
         VALUES ('TSK-002', 'FEAT-001', 'Task 2', ?, ?)`,
      ).run(now, now);

      // 3. Task dependencies
      db.prepare(
        `INSERT INTO task_dependencies (task_id, depends_on_id)
         VALUES ('TSK-002', 'TSK-001')`,
      ).run();

      // 4. Runs and Events
      db.prepare(
        `INSERT INTO runs (id, task_id, status, started_at)
         VALUES ('RUN-001', 'TSK-001', 'RUNNING', ?)`,
      ).run(now);

      db.prepare(
        `INSERT INTO events (run_id, seq, type, payload, ts)
         VALUES ('RUN-001', 1, 'log', '{"msg":"test"}', ?)`,
      ).run(now);

      db.prepare(
        `INSERT INTO reports (id, run_id, kind, content, created_at)
         VALUES ('REP-001', 'RUN-001', 'acceptance', 'All pass', ?)`,
      ).run(now);

      // Verify cascade delete: deleting RUN-001 cascades to events and reports
      db.prepare('DELETE FROM runs WHERE id = ?').run('RUN-001');
      const eventsCount = db
        .prepare('SELECT COUNT(*) as cnt FROM events WHERE run_id = ?')
        .get('RUN-001') as { cnt: number };
      const reportsCount = db
        .prepare('SELECT COUNT(*) as cnt FROM reports WHERE run_id = ?')
        .get('RUN-001') as { cnt: number };
      expect(eventsCount.cnt).toBe(0);
      expect(reportsCount.cnt).toBe(0);

      // Verify ON DELETE SET NULL on features -> tasks
      db.prepare('DELETE FROM features WHERE id = ?').run('FEAT-001');
      const task = db.prepare('SELECT feature_id FROM tasks WHERE id = ?').get('TSK-001') as {
        feature_id: string | null;
      };
      expect(task.feature_id).toBeNull();
    } finally {
      db.close();
    }
  });

  it('rolls back transaction if a migration fails midway', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-mig-fail-'));
    const db = createDatabase(':memory:');
    try {
      // Create a valid migration and a broken migration
      fs.writeFileSync(
        path.join(tmpDir, '001_good.sql'),
        'CREATE TABLE test_good (id TEXT PRIMARY KEY);',
      );
      fs.writeFileSync(
        path.join(tmpDir, '002_bad.sql'),
        'CREATE TABLE test_bad (id TEXT PRIMARY KEY); SYNTAX ERROR HERE;',
      );

      // Running migrations should throw AppError
      expect(() => {
        runMigrations(db, { migrationsDir: tmpDir });
      }).toThrow(AppError);

      // 001 should be applied
      const applied = getAppliedMigrations(db);
      expect(applied.map((m) => m.name)).toEqual(['001_good.sql']);

      // 002 should NOT be in applied, and table test_bad should NOT exist
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);

      expect(tableNames).toContain('test_good');
      expect(tableNames).not.toContain('test_bad');
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws AppError when migrations directory does not exist', () => {
    const db = createDatabase(':memory:');
    try {
      expect(() => {
        runMigrations(db, { migrationsDir: '/non/existent/path/for/migrations' });
      }).toThrow(AppError);
    } finally {
      db.close();
    }
  });
});
