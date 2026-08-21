ALTER TABLE workspace ADD COLUMN deletion_requested_at TEXT;

CREATE TABLE IF NOT EXISTS workspace_deletion_job (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  github_installation_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  requested_by_user_id TEXT,
  object_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS workspace_deletion_status_idx ON workspace_deletion_job(status, created_at);

CREATE TABLE IF NOT EXISTS deleted_installation (
  github_installation_id INTEGER PRIMARY KEY NOT NULL,
  deleted_at TEXT NOT NULL
);
