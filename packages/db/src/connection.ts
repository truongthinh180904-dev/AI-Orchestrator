import Database from 'better-sqlite3';

export type DatabaseInstance = Database.Database;
export type DatabaseOptions = Database.Options;

export function createDatabase(
  filename: string = ':memory:',
  options: Database.Options = {},
): Database.Database {
  const db = new Database(filename, options);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}
