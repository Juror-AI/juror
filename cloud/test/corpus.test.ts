import { describe, expect, it } from 'vitest';
import { buildCorpusEvent, redactCorpusText } from '../worker/corpus';

describe('training corpus boundary', () => {
  it('redacts direct identifiers and common credentials before queueing', () => {
    const redacted = redactCorpusText('Email alice@example.com authorization: Bearer-secret ghp_abcdefghijklmnopqrstuvwxyz123456');
    expect(redacted).not.toContain('alice@example.com');
    expect(redacted).not.toContain('Bearer-secret');
    expect(redacted).not.toContain('ghp_');
    expect(redacted).toContain('[redacted-email]');
  });

  it('normalizes an inline review comment without identity, email, or raw path', async () => {
    const event = await buildCorpusEvent('delivery-1', 'pull_request_review_comment', {
      action: 'created',
      repository: { id: 42 },
      pull_request: { number: 7, state: 'open', base: { sha: 'base' }, head: { sha: 'head' }, merged: false },
      comment: { id: 99, body: 'Fix this for bob@example.com', path: 'src/private/customer.ts', line: 12, created_at: '2026-08-21T12:00:00.000Z', user: { id: 123, login: 'alice', type: 'User', email: 'alice@example.com' } },
    }, { workspaceId: 'ws_1', repositoryId: 'repo_42', private: true, mode: 'workspace_private', consentVersion: 'v1', retentionDays: 365, includePrBody: false, includePaths: false });

    expect(event).not.toBeNull();
    expect(event?.subject.path).toBeNull();
    expect(event?.subject.pathHash).toHaveLength(64);
    expect(event?.subject.body).toBe('Fix this for [redacted-email]');
    expect(event?.author?.kind).toBe('human');
    expect(event?.author?.pseudonym).toHaveLength(64);
    expect(JSON.stringify(event)).not.toContain('alice');
    expect(JSON.stringify(event)).not.toContain('customer.ts');
  });

  it('does not capture ordinary issue comments outside pull requests', async () => {
    const event = await buildCorpusEvent('delivery-2', 'issue_comment', { action: 'created', issue: { id: 1, number: 1 }, comment: { id: 2, body: 'not a PR' } }, { workspaceId: 'ws_1', repositoryId: 'repo_42', private: false, mode: 'shared', consentVersion: 'v1', retentionDays: 365, includePrBody: false, includePaths: false });
    expect(event).toBeNull();
  });

  it('retains pull request metadata but omits the description unless separately enabled', async () => {
    const event = await buildCorpusEvent('delivery-3', 'pull_request', {
      action: 'opened',
      repository: { id: 42 },
      pull_request: { id: 7, number: 7, state: 'open', body: 'Private roadmap details', base: { sha: 'base' }, head: { sha: 'head' }, user: { id: 123, login: 'alice', type: 'User' } },
    }, { workspaceId: 'ws_1', repositoryId: 'repo_42', private: true, mode: 'workspace_private', consentVersion: 'v1', retentionDays: 365, includePrBody: false, includePaths: false });

    expect(event?.subject.kind).toBe('pull_request');
    expect(event?.subject.body).toBeNull();
    expect(event?.pullRequest).toMatchObject({ number: 7, baseSha: 'base', headSha: 'head' });
  });
});
