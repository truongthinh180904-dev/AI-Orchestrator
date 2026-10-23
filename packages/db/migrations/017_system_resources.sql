-- Migration 017: System Resource Metrics and Audit
-- Table: system_resource_events

CREATE TABLE IF NOT EXISTS system_resource_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  cpu_percent REAL NOT NULL,
  memory_percent REAL NOT NULL,
  memory_free_bytes INTEGER NOT NULL,
  memory_total_bytes INTEGER NOT NULL,
  disk_percent REAL NOT NULL,
  disk_free_bytes INTEGER NOT NULL,
  disk_total_bytes INTEGER NOT NULL,
  breaches TEXT NOT NULL DEFAULT '[]',
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_system_resource_events_created_at ON system_resource_events(created_at);
CREATE INDEX IF NOT EXISTS idx_system_resource_events_status ON system_resource_events(status);
CREATE INDEX IF NOT EXISTS idx_system_resource_events_event_type ON system_resource_events(event_type);
