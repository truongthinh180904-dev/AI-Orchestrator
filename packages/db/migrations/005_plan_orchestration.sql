-- Migration 005: Plan Orchestration and task association
-- Add plan_id column to tasks table and create index

ALTER TABLE tasks ADD COLUMN plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_plan_id ON tasks(plan_id);
