ALTER TABLE usage_ledger ADD COLUMN trial_applied_at TEXT;

CREATE INDEX IF NOT EXISTS usage_trial_pending_idx
  ON usage_ledger(workspace_id, trial_applied_at)
  WHERE trial_applied_at IS NULL;
