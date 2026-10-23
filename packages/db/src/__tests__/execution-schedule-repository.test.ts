import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../connection.js';
import { runMigrations } from '../migrator.js';
import { ExecutionScheduleRepository } from '../repositories/execution-schedule-repository.js';
import type Database from 'better-sqlite3';

describe('ExecutionScheduleRepository', () => {
  let db: Database.Database;
  let repo: ExecutionScheduleRepository;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repo = new ExecutionScheduleRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('saves, retrieves, and updates schedule configuration', () => {
    // Initial fetch returns null
    expect(repo.getConfig('custom_schedule')).toBeNull();

    // Create / upsert
    const saved = repo.upsertConfig({
      id: 'custom_schedule',
      name: 'Night Schedule',
      enabled: true,
      timezone: 'Asia/Ho_Chi_Minh',
      mode: 'ALLOW',
      windows: [
        {
          name: 'Night window',
          start: '22:00',
          end: '06:00',
          days: [1, 2, 3, 4, 5],
        },
      ],
      stop_at_hour: 7,
      graceful_completion: true,
      max_runs_per_window: 10,
    });

    expect(saved.id).toBe('custom_schedule');
    expect(saved.name).toBe('Night Schedule');
    expect(saved.timezone).toBe('Asia/Ho_Chi_Minh');
    expect(saved.windows.length).toBe(1);
    expect(saved.windows[0]?.name).toBe('Night window');
    expect(saved.stop_at_hour).toBe(7);

    // Retrieve
    const retrieved = repo.getConfig('custom_schedule');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.timezone).toBe('Asia/Ho_Chi_Minh');

    // Update
    const updated = repo.upsertConfig({
      ...saved,
      enabled: false,
      mode: 'ALWAYS',
    });
    expect(updated.enabled).toBe(false);
    expect(updated.mode).toBe('ALWAYS');
  });

  it('creates, retrieves, and filters schedule audit events', () => {
    const event1 = repo.createEvent({
      event_type: 'CONFIG_UPDATED',
      schedule_id: 'default_schedule',
      details: { mode: 'ALLOW' },
    });
    expect(event1.id).toBeDefined();
    expect(event1.event_type).toBe('CONFIG_UPDATED');

    const event2 = repo.createEvent({
      event_type: 'EXECUTION_BLOCKED',
      schedule_id: 'default_schedule',
      task_id: null,
      details: { reason: 'OUTSIDE_ALLOWED_WINDOW' },
    });

    const allEvents = repo.findEvents({ scheduleId: 'default_schedule' });
    expect(allEvents.length).toBe(2);

    const blockedEvents = repo.findEvents({ eventType: 'EXECUTION_BLOCKED' });
    expect(blockedEvents.length).toBe(1);
    expect(blockedEvents[0]?.id).toBe(event2.id);

    const latest = repo.getLatestEvent();
    expect(latest?.id).toBe(event2.id);
  });
});
