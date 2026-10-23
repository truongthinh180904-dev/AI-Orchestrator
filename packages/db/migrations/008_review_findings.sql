-- Migration 008: Review Findings
-- Table: review_findings

CREATE TABLE IF NOT EXISTS review_findings (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  severity TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  message TEXT NOT NULL,
  category TEXT,
  rule_id TEXT,
  suggestion TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_findings_task_id ON review_findings(task_id);
CREATE INDEX IF NOT EXISTS idx_review_findings_run_id ON review_findings(run_id);
CREATE INDEX IF NOT EXISTS idx_review_findings_severity ON review_findings(severity);
CREATE INDEX IF NOT EXISTS idx_review_findings_file ON review_findings(file);
CREATE INDEX IF NOT EXISTS idx_review_findings_created_at ON review_findings(created_at);
