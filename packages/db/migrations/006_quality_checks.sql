-- Migration 006: Quality Command Records
-- Table: quality_command_records

CREATE TABLE IF NOT EXISTS quality_command_records (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  command_id TEXT NOT NULL,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  exe TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '[]',
  cwd TEXT NOT NULL,
  exit_code INTEGER,
  signal TEXT,
  status TEXT NOT NULL,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quality_records_task_id ON quality_command_records(task_id);
CREATE INDEX IF NOT EXISTS idx_quality_records_run_id ON quality_command_records(run_id);
CREATE INDEX IF NOT EXISTS idx_quality_records_status ON quality_command_records(status);
CREATE INDEX IF NOT EXISTS idx_quality_records_stage ON quality_command_records(stage);
CREATE INDEX IF NOT EXISTS idx_quality_records_created_at ON quality_command_records(created_at);
