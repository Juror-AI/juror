PRAGMA foreign_keys = ON;

-- Better Auth 1.7 core schema. Better Auth uses camelCase fields by default.
CREATE TABLE IF NOT EXISTS "user" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL DEFAULT 0,
  "image" TEXT,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "session" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "token" TEXT NOT NULL UNIQUE,
  "expiresAt" INTEGER NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session"("userId");

CREATE TABLE IF NOT EXISTS "account" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "issuer" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "accessTokenExpiresAt" INTEGER,
  "refreshTokenExpiresAt" INTEGER,
  "scope" TEXT,
  "idToken" TEXT,
  "password" TEXT,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL,
  UNIQUE("issuer", "accountId")
);
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account"("userId");

CREATE TABLE IF NOT EXISTS "verification" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" INTEGER NOT NULL,
  "createdAt" INTEGER,
  "updatedAt" INTEGER
);
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification"("identifier");

CREATE TABLE IF NOT EXISTS workspace (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  github_installation_id INTEGER NOT NULL UNIQUE,
  trial_granted_micro_usd INTEGER NOT NULL DEFAULT 10000000,
  trial_remaining_micro_usd INTEGER NOT NULL DEFAULT 10000000,
  monthly_cap_micro_usd INTEGER NOT NULL DEFAULT 100000000,
  billing_state TEXT NOT NULL DEFAULT 'trial' CHECK (billing_state IN ('trial', 'active', 'past_due', 'paused')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS membership (
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS workspace_data_key (
  workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  key_version INTEGER NOT NULL DEFAULT 1,
  wrapped_data_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  rotated_at TEXT
);

CREATE TABLE IF NOT EXISTS installation (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL UNIQUE REFERENCES workspace(id) ON DELETE CASCADE,
  github_installation_id INTEGER NOT NULL UNIQUE,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL,
  suspended_at TEXT,
  permissions_json TEXT NOT NULL,
  repository_selection TEXT NOT NULL CHECK (repository_selection IN ('all', 'selected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repository (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  github_repository_id INTEGER NOT NULL UNIQUE,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  is_private INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  github_access_state TEXT NOT NULL DEFAULT 'active' CHECK (github_access_state IN ('active', 'removed', 'suspended')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, full_name)
);
CREATE INDEX IF NOT EXISTS repository_workspace_idx ON repository(workspace_id);

CREATE TABLE IF NOT EXISTS repository_settings (
  repository_id TEXT PRIMARY KEY NOT NULL REFERENCES repository(id) ON DELETE CASCADE,
  execution_mode TEXT NOT NULL DEFAULT 'cloud' CHECK (execution_mode IN ('cloud', 'action', 'unresolved')),
  action_detected INTEGER NOT NULL DEFAULT 0,
  review_enabled INTEGER NOT NULL DEFAULT 1,
  review_preset TEXT NOT NULL DEFAULT 'fast' CHECK (review_preset IN ('starter', 'fast', 'balanced', 'high', 'ultra')),
  publish_mode TEXT NOT NULL DEFAULT 'all' CHECK (publish_mode IN ('all', 'consensus')),
  severity_floor TEXT NOT NULL DEFAULT 'P3' CHECK (severity_floor IN ('P0', 'P1', 'P2', 'P3')),
  qa_enabled INTEGER NOT NULL DEFAULT 0,
  qa_security_ready INTEGER NOT NULL DEFAULT 0,
  qa_target_url TEXT,
  qa_allowed_origins_json TEXT NOT NULL DEFAULT '[]',
  qa_session_bootstrap_json TEXT,
  qa_secret_headers_ciphertext TEXT,
  qa_reset_hook_ciphertext TEXT,
  qa_evidence_policy_json TEXT NOT NULL DEFAULT '{"screenshot":"failure","trace":"failure","video":"failure","retention_days":90}',
  settings_version INTEGER NOT NULL DEFAULT 1,
  updated_by_user_id TEXT REFERENCES "user"(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pull_request (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT NOT NULL REFERENCES repository(id) ON DELETE CASCADE,
  github_pr_id INTEGER NOT NULL UNIQUE,
  number INTEGER NOT NULL,
  state TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  merge_sha TEXT,
  is_fork INTEGER NOT NULL DEFAULT 0,
  author_login TEXT NOT NULL,
  github_url TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  merged_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(repository_id, number)
);
CREATE INDEX IF NOT EXISTS pull_request_repository_idx ON pull_request(repository_id, number);

CREATE TABLE IF NOT EXISTS run (
  id TEXT PRIMARY KEY NOT NULL,
  identity TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repository(id) ON DELETE CASCADE,
  pull_request_id TEXT REFERENCES pull_request(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('review', 'qa')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'warning', 'failed', 'cancelled', 'blocked')),
  outcome TEXT,
  phase TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  revision_sha TEXT NOT NULL,
  workflow_instance_id TEXT,
  report_r2_key TEXT,
  findings_count INTEGER NOT NULL DEFAULT 0,
  provider_micro_usd INTEGER NOT NULL DEFAULT 0,
  sandbox_micro_usd INTEGER NOT NULL DEFAULT 0,
  storage_micro_usd INTEGER NOT NULL DEFAULT 0,
  service_fee_micro_usd INTEGER NOT NULL DEFAULT 0,
  billable_micro_usd INTEGER NOT NULL DEFAULT 0,
  reserved_micro_usd INTEGER NOT NULL DEFAULT 0,
  billable INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_workspace_created_idx ON run(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS run_repository_status_idx ON run(repository_id, status);
CREATE INDEX IF NOT EXISTS run_pr_revision_idx ON run(repository_id, pr_number, revision_sha);

CREATE TABLE IF NOT EXISTS run_event (
  run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL CHECK (length(message) <= 240),
  metrics_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (run_id, sequence)
);

CREATE TABLE IF NOT EXISTS finding (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repository(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('review', 'qa')),
  severity TEXT NOT NULL CHECK (severity IN ('P0', 'P1', 'P2', 'P3')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  path_or_checkpoint TEXT NOT NULL,
  line INTEGER,
  claim_json TEXT,
  expected TEXT,
  actual TEXT,
  reproducible INTEGER,
  agreement_count INTEGER,
  agreement_total INTEGER,
  assignee_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  github_thread_id TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT,
  ignored_at TEXT,
  UNIQUE(workspace_id, repository_id, source, fingerprint)
);
CREATE INDEX IF NOT EXISTS finding_workspace_status_idx ON finding(workspace_id, status, severity);
CREATE INDEX IF NOT EXISTS finding_repository_idx ON finding(repository_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS finding_occurrence (
  finding_id TEXT NOT NULL REFERENCES finding(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  pr_number INTEGER NOT NULL,
  revision_sha TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  seen_at TEXT NOT NULL,
  PRIMARY KEY (finding_id, run_id)
);

CREATE TABLE IF NOT EXISTS triage_event (
  id TEXT PRIMARY KEY NOT NULL,
  finding_id TEXT NOT NULL REFERENCES finding(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('dashboard', 'github')),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifact_metadata (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  sanitized INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artifact_expiry_idx ON artifact_metadata(expires_at);

CREATE TABLE IF NOT EXISTS usage_ledger (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL UNIQUE REFERENCES run(id) ON DELETE CASCADE,
  provider_micro_usd INTEGER NOT NULL,
  sandbox_micro_usd INTEGER NOT NULL,
  storage_micro_usd INTEGER NOT NULL,
  service_fee_micro_usd INTEGER NOT NULL,
  billable_micro_usd INTEGER NOT NULL,
  trial_debit_micro_usd INTEGER NOT NULL DEFAULT 0,
  invoice_micro_usd INTEGER NOT NULL DEFAULT 0,
  stripe_meter_event_name TEXT,
  stripe_meter_emitted_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_workspace_created_idx ON usage_ledger(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS stripe_customer (
  workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  stripe_subscription_item_id TEXT,
  payment_state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  stripe_invoice_id TEXT NOT NULL UNIQUE,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  amount_micro_usd INTEGER NOT NULL,
  status TEXT NOT NULL,
  hosted_invoice_url TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_delivery (
  provider TEXT NOT NULL CHECK (provider IN ('github', 'stripe')),
  delivery_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  error TEXT,
  PRIMARY KEY (provider, delivery_id)
);
