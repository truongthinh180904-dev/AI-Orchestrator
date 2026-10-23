-- Migration 009: Security Check Results and Secret Findings
-- Tables: security_checks, secret_findings

CREATE TABLE IF NOT EXISTS security_checks (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  repo_path TEXT NOT NULL,
  passed INTEGER NOT NULL,
  audit_passed INTEGER NOT NULL,
  secret_passed INTEGER NOT NULL,
  audit_high_critical_count INTEGER NOT NULL DEFAULT 0,
  secret_findings_count INTEGER NOT NULL DEFAULT 0,
  audit_summary TEXT NOT NULL DEFAULT '{}',
  secret_summary TEXT NOT NULL DEFAULT '{}',
  raw_details TEXT NOT NULL DEFAULT '{}',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_security_checks_task_id ON security_checks(task_id);
CREATE INDEX IF NOT EXISTS idx_security_checks_run_id ON security_checks(run_id);
CREATE INDEX IF NOT EXISTS idx_security_checks_passed ON security_checks(passed);
CREATE INDEX IF NOT EXISTS idx_security_checks_created_at ON security_checks(created_at);

CREATE TABLE IF NOT EXISTS secret_findings (
  id TEXT PRIMARY KEY,
  security_check_id TEXT REFERENCES security_checks(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  description TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  match_preview TEXT NOT NULL,
  secret_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_secret_findings_security_check_id ON secret_findings(security_check_id);
CREATE INDEX IF NOT EXISTS idx_secret_findings_task_id ON secret_findings(task_id);
CREATE INDEX IF NOT EXISTS idx_secret_findings_rule_id ON secret_findings(rule_id);
