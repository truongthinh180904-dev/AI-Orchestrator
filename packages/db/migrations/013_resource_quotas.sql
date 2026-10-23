-- Migration 013: Quota Events and Resource Audit
-- Table: quota_events

CREATE TABLE IF NOT EXISTS quota_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  backoff_ms INTEGER NOT NULL DEFAULT 0,
  consecutive_hits INTEGER NOT NULL DEFAULT 0,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quota_events_created_at ON quota_events(created_at);
CREATE INDEX IF NOT EXISTS idx_quota_events_task_id ON quota_events(task_id);
CREATE INDEX IF NOT EXISTS idx_quota_events_event_type ON quota_events(event_type);
