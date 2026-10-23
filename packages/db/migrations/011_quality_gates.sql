-- Migration 011: Quality Gate Evaluations
-- Table: quality_gate_evaluations

CREATE TABLE IF NOT EXISTS quality_gate_evaluations (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  passed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  policy_json TEXT NOT NULL DEFAULT '{}',
  evaluations_json TEXT NOT NULL DEFAULT '[]',
  evidence_summary_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  evaluated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quality_gate_task_id ON quality_gate_evaluations(task_id);
CREATE INDEX IF NOT EXISTS idx_quality_gate_run_id ON quality_gate_evaluations(run_id);
CREATE INDEX IF NOT EXISTS idx_quality_gate_passed ON quality_gate_evaluations(passed);
CREATE INDEX IF NOT EXISTS idx_quality_gate_created_at ON quality_gate_evaluations(created_at);
