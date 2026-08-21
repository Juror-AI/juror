import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('D1 schema contract', () => {
  it('contains the live records, idempotency constraints, and retention indexes', async () => {
    const schema = await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
    for (const table of ['workspace', 'membership', 'installation', 'repository', 'run', 'run_event', 'finding', 'finding_occurrence', 'triage_event', 'artifact_metadata', 'usage_ledger', 'invoice', 'webhook_delivery']) {
      expect(schema).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    }
    expect(schema).toContain('identity TEXT NOT NULL UNIQUE');
    expect(schema).toContain('run_id TEXT NOT NULL UNIQUE');
    expect(schema).toContain('PRIMARY KEY (provider, delivery_id)');
    const retention = await readFile(new URL('../migrations/0002_retention_indexes.sql', import.meta.url), 'utf8');
    expect(schema).toContain('artifact_expiry_idx');
    expect(retention).toContain('run_completed_retention_idx');
    const corpus = await readFile(new URL('../migrations/0005_training_corpus.sql', import.meta.url), 'utf8');
    expect(corpus).toContain('CREATE TABLE IF NOT EXISTS workspace_corpus_policy');
    expect(corpus).toContain('CREATE TABLE IF NOT EXISTS workspace_corpus_key');
    expect(corpus).not.toMatch(/(?:body|comment|review)_text\s+TEXT/i);
    const deletion = await readFile(new URL('../migrations/0006_workspace_deletion.sql', import.meta.url), 'utf8');
    expect(deletion).toContain('CREATE TABLE IF NOT EXISTS workspace_deletion_job');
    expect(deletion).toContain('CREATE TABLE IF NOT EXISTS deleted_installation');
    const minimizedFindings = await readFile(new URL('../migrations/0007_minimize_finding_content.sql', import.meta.url), 'utf8');
    expect(minimizedFindings).toContain("SET body = '', claim_json = NULL, expected = NULL, actual = NULL");
    expect(minimizedFindings).toContain("SET details_json = '{}'");
  });
});
