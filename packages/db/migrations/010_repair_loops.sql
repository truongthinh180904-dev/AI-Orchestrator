-- Migration 010: Repair Loops and Iterations for Quality Gate
-- Tables: repair_loops, repair_iterations

CREATE TABLE IF NOT EXISTS repair_loops (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  max_iterations INTEGER NOT NULL DEFAULT 3,
  current_iteration INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  passed INTEGER NOT NULL DEFAULT 0,
  final_reason TEXT,
  feedback_summary TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_repair_loops_task_id ON repair_loops(task_id);
CREATE INDEX IF NOT EXISTS idx_repair_loops_status ON repair_loops(status);
CREATE INDEX IF NOT EXISTS idx_repair_loops_created_at ON repair_loops(created_at);

CREATE TABLE IF NOT EXISTS repair_iterations (
  id TEXT PRIMARY KEY,
  repair_loop_id TEXT NOT NULL REFERENCES repair_loops(id) ON DELETE CASCADE,
  iteration_number INTEGER NOT NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  passed INTEGER NOT NULL DEFAULT 0,
  command_failures_count INTEGER NOT NULL DEFAULT 0,
  review_findings_count INTEGER NOT NULL DEFAULT 0,
  prompt TEXT,
  feedback_json TEXT NOT NULL DEFAULT '{}',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_repair_iterations_loop_id ON repair_iterations(repair_loop_id);
CREATE INDEX IF NOT EXISTS idx_repair_iterations_number ON repair_iterations(repair_loop_id, iteration_number);
