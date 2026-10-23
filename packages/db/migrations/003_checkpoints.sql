-- Migration 003: Checkpoints for Task Runs and Execution History
-- Tables: checkpoints

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL DEFAULT 1,
  step TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'COMPLETED',
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_task_id ON checkpoints(task_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_run_id ON checkpoints(run_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_task_attempt ON checkpoints(task_id, attempt);
