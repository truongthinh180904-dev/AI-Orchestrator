import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDatabase } from '../connection.js';

describe('Database Connection', () => {
  it('creates in-memory database with foreign_keys and busy_timeout enabled', () => {
    const db = createDatabase(':memory:');
    try {
      const fk = db.pragma('foreign_keys', { simple: true });
      const busyTimeout = db.pragma('busy_timeout', { simple: true });

      expect(fk).toBe(1);
      expect(busyTimeout).toBe(5000);
    } finally {
      db.close();
    }
  });

  it('enables WAL mode on file-based databases', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-conn-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const db = createDatabase(dbPath);
    try {
      const journalMode = db.pragma('journal_mode', { simple: true });
      expect(journalMode).toBe('wal');
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
