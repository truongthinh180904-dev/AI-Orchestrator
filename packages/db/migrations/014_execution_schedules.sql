-- Migration 014: Execution Schedules and Time Windows
-- Table: execution_schedules
-- Table: schedule_events

CREATE TABLE IF NOT EXISTS execution_schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  mode TEXT NOT NULL DEFAULT 'ALLOW',
  windows TEXT NOT NULL DEFAULT '[]',
  stop_at_hour INTEGER,
  graceful_completion INTEGER NOT NULL DEFAULT 1,
  max_runs_per_window INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  schedule_id TEXT NOT NULL DEFAULT 'default_schedule',
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schedule_events_created_at ON schedule_events(created_at);
CREATE INDEX IF NOT EXISTS idx_schedule_events_event_type ON schedule_events(event_type);
CREATE INDEX IF NOT EXISTS idx_schedule_events_schedule_id ON schedule_events(schedule_id);
