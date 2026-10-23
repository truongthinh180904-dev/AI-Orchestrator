-- Migration 012: Feature Releases and Branch Management
-- Table: feature_releases

CREATE TABLE IF NOT EXISTS feature_releases (
  id TEXT PRIMARY KEY,
  feature_id TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  branch TEXT NOT NULL UNIQUE,
  base_branch TEXT NOT NULL,
  commit_sha TEXT,
  pr_url TEXT,
  status TEXT NOT NULL DEFAULT 'BRANCH_CREATED',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feature_releases_feature_id ON feature_releases(feature_id);
CREATE INDEX IF NOT EXISTS idx_feature_releases_branch ON feature_releases(branch);
CREATE INDEX IF NOT EXISTS idx_feature_releases_status ON feature_releases(status);
