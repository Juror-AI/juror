ALTER TABLE repository_settings ADD COLUMN training_enabled INTEGER NOT NULL DEFAULT 0 CHECK (training_enabled IN (0, 1));

ALTER TABLE webhook_delivery ADD COLUMN queued_at TEXT;
ALTER TABLE webhook_delivery ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS workspace_corpus_policy (
  workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'workspace_private', 'shared')),
  consent_version TEXT NOT NULL DEFAULT '2026-08-21.v1',
  retention_days INTEGER NOT NULL DEFAULT 365 CHECK (retention_days BETWEEN 30 AND 3650),
  include_pr_body INTEGER NOT NULL DEFAULT 0 CHECK (include_pr_body IN (0, 1)),
  include_paths INTEGER NOT NULL DEFAULT 0 CHECK (include_paths IN (0, 1)),
  consented_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  consented_at TEXT,
  stored_objects INTEGER NOT NULL DEFAULT 0,
  stored_bytes INTEGER NOT NULL DEFAULT 0,
  last_ingested_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_corpus_key (
  workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  key_version INTEGER NOT NULL DEFAULT 1,
  wrapped_data_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  rotated_at TEXT
);

CREATE TABLE IF NOT EXISTS corpus_job (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('delete')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  requested_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  object_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS corpus_job_workspace_created_idx ON corpus_job(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS webhook_delivery_status_idx ON webhook_delivery(provider, status, received_at);
