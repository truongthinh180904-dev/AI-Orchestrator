import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../connection.js';
import { runMigrations } from '../migrator.js';
import { QuotaEventRepository } from '../repositories/quota-event-repository.js';

describe('QuotaEventRepository Unit Tests', () => {
  let db: Database.Database;
  let repo: QuotaEventRepository;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repo = new QuotaEventRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates and retrieves quota event by id', () => {
    const created = repo.create({
      event_type: 'QUOTA_HIT',
      backoff_ms: 1800000,
      consecutive_hits: 1,
      details: { error: 'Rate limit 429' },
    });

    expect(created.id).toBeTruthy();
    expect(created.event_type).toBe('QUOTA_HIT');
    expect(created.backoff_ms).toBe(1800000);
    expect(created.consecutive_hits).toBe(1);
    expect(created.details).toEqual({ error: 'Rate limit 429' });

    const fetched = repo.getById(created.id);
    expect(fetched).toEqual(created);
  });

  it('lists events with filters and counts hits since timestamp', () => {
    const t0 = new Date(Date.now() - 10000).toISOString();
    repo.create({ event_type: 'QUOTA_HIT', created_at: new Date(Date.now() - 5000).toISOString() });
    repo.create({ event_type: 'QUOTA_HIT', created_at: new Date().toISOString() });
    repo.create({ event_type: 'QUOTA_RESET', created_at: new Date().toISOString() });

    const hitsCount = repo.countHitsSince(t0);
    expect(hitsCount).toBe(2);

    const hitEvents = repo.list({ eventType: 'QUOTA_HIT' });
    expect(hitEvents.length).toBe(2);

    const allEvents = repo.list({ limit: 10 });
    expect(allEvents.length).toBe(3);

    const latest = repo.getLatest();
    expect(latest?.event_type).toBe('QUOTA_RESET');
  });
});
