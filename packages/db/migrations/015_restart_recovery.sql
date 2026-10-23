-- Migration 015: Restart Recovery and Crash Audits
-- Table: recovery_audits

CREATE TABLE IF NOT EXISTS recovery_audits (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,
  recovered_tasks_count INTEGER NOT NULL DEFAULT 0,
  cleaned_runs_count INTEGER NOT NULL DEFAULT 0,
  released_locks_count INTEGER NOT NULL DEFAULT 0,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recovery_audits_created_at ON recovery_audits(created_at);
CREATE INDEX IF NOT EXISTS idx_recovery_audits_trigger ON recovery_audits(trigger);
