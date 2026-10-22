import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { AppError } from './errors.js';

export interface MigrationRunnerOptions {
  migrationsDir?: string;
}

export interface MigrationRecord {
  id: number;
  name: string;
  applied_at: string;
}

const defaultMigrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

export function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    );
  `);
}

export function getAppliedMigrations(db: Database.Database): MigrationRecord[] {
  ensureMigrationsTable(db);
  const stmt = db.prepare('SELECT id, name, applied_at FROM _migrations ORDER BY id ASC');
  return stmt.all() as MigrationRecord[];
}

export function runMigrations(db: Database.Database, options?: MigrationRunnerOptions): string[] {
  ensureMigrationsTable(db);

  const migrationsDir = options?.migrationsDir ?? defaultMigrationsDir;
  if (!fs.existsSync(migrationsDir)) {
    throw new AppError(
      'MIGRATIONS_DIR_NOT_FOUND',
      `Migrations directory not found: ${migrationsDir}`,
      { migrationsDir },
    );
  }

  const appliedList = getAppliedMigrations(db);
  const appliedSet = new Set(appliedList.map((m) => m.name));

  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const pendingFiles = files.filter((file) => !appliedSet.has(file));
  const newlyApplied: string[] = [];

  for (const file of pendingFiles) {
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf-8');

    const applyMigrationTx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(
        file,
        new Date().toISOString(),
      );
    });

    try {
      applyMigrationTx();
      newlyApplied.push(file);
    } catch (error) {
      throw new AppError(
        'MIGRATION_EXECUTION_FAILED',
        `Failed to execute migration ${file}: ${error instanceof Error ? error.message : String(error)}`,
        {
          file,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  return newlyApplied;
}
