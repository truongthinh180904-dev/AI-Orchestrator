-- Migration 016: Process Heartbeat and Liveness
-- Add last_heartbeat_at column to runs table

ALTER TABLE runs ADD COLUMN last_heartbeat_at TEXT;

CREATE INDEX IF NOT EXISTS idx_runs_last_heartbeat_at ON runs(last_heartbeat_at);
