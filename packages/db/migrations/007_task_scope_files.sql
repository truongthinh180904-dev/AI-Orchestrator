-- Migration 007: Task Scope Files
-- Add scope_files JSON column to tasks table

ALTER TABLE tasks ADD COLUMN scope_files TEXT NOT NULL DEFAULT '[]';
