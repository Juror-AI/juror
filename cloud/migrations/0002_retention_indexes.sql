CREATE INDEX IF NOT EXISTS run_completed_retention_idx ON run(completed_at) WHERE completed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS finding_retention_idx ON finding(status, last_seen_at) WHERE status IN ('resolved', 'ignored');
CREATE INDEX IF NOT EXISTS webhook_received_idx ON webhook_delivery(received_at);
