-- Migration 002: Agent Lock for Sequential Scheduling and Concurrency Control
-- Table: agent_locks

CREATE TABLE IF NOT EXISTS agent_locks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  acquired_at TEXT NOT NULL,
  owner_pid INTEGER,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_locks_task_id ON agent_locks(task_id);
