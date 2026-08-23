import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { BILLING_READMISSION_SQL } from '../worker/github-webhook';

const databases: DatabaseSync[] = [];

function database(trialRemaining: number): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  db.exec(`
    CREATE TABLE workspace (id TEXT PRIMARY KEY, monthly_cap_micro_usd INTEGER, trial_remaining_micro_usd INTEGER, billing_state TEXT);
    CREATE TABLE repository (id TEXT PRIMARY KEY, workspace_id TEXT, github_access_state TEXT);
    CREATE TABLE run (id TEXT PRIMARY KEY, identity TEXT UNIQUE, workspace_id TEXT, repository_id TEXT, pull_request_id TEXT, status TEXT, phase TEXT, outcome TEXT, reserved_micro_usd INTEGER, updated_at TEXT);
    CREATE TABLE usage_ledger (workspace_id TEXT, billable_micro_usd INTEGER, created_at TEXT);
    CREATE TABLE stripe_customer (workspace_id TEXT, payment_state TEXT);
    INSERT INTO workspace VALUES ('ws_1', 100000000, ${trialRemaining}, 'trial');
    INSERT INTO repository VALUES ('repo_1', 'ws_1', 'active');
    INSERT INTO run VALUES ('run_1', 'review:1:2:sha', 'ws_1', 'repo_1', 'pr_old', 'blocked', 'billing', NULL, 0, 'old');
  `);
  return db;
}

function readmit(db: DatabaseSync): void {
  db.prepare(BILLING_READMISSION_SQL).run('pr_new', 5_000_000, 'new', 'run_1', 'ws_1', 'repo_1', 'repo_1', 'ws_1', 'ws_1', 5_000_000, '2026-08-01T00:00:00.000Z', 5_000_000);
}

afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

describe('blocked run re-admission', () => {
  it('atomically queues the same run identity after billing capacity recovers', () => {
    const db = database(10_000_000);

    readmit(db);

    expect(db.prepare('SELECT status, phase, pull_request_id, reserved_micro_usd FROM run WHERE id = ?').get('run_1')).toEqual({
      status: 'queued', phase: 'queued', pull_request_id: 'pr_new', reserved_micro_usd: 5_000_000,
    });
  });

  it('leaves the blocked identity unchanged while capacity is unavailable', () => {
    const db = database(0);

    readmit(db);

    expect(db.prepare('SELECT status, phase, reserved_micro_usd FROM run WHERE id = ?').get('run_1')).toEqual({
      status: 'blocked', phase: 'billing', reserved_micro_usd: 0,
    });
  });

  it('does not reserve capacity after repository access is revoked', () => {
    const db = database(10_000_000);
    db.prepare("UPDATE repository SET github_access_state = 'removed' WHERE id = 'repo_1'").run();

    readmit(db);

    expect(db.prepare('SELECT status, reserved_micro_usd FROM run WHERE id = ?').get('run_1')).toEqual({
      status: 'blocked', reserved_micro_usd: 0,
    });
  });
});
