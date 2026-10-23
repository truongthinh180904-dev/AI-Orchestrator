-- Migration 018: Soak test runs history and metrics
CREATE TABLE IF NOT EXISTS soak_test_runs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,
  target_duration_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  iterations_completed INTEGER NOT NULL,
  tasks_processed INTEGER NOT NULL,
  faults_injected_count INTEGER NOT NULL,
  faults_recovered_count INTEGER NOT NULL,
  duration_achieved INTEGER NOT NULL,
  zero_data_loss INTEGER NOT NULL,
  status TEXT NOT NULL,
  data_integrity TEXT NOT NULL,
  memory_report TEXT NOT NULL,
  faults_events TEXT NOT NULL,
  summary TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_soak_test_runs_created_at ON soak_test_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_soak_test_runs_status ON soak_test_runs(status);
