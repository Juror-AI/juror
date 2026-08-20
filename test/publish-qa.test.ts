import { describe, expect, it, vi } from 'vitest';

import { GitHubApiError, type IssueComment } from '../src/github/client.js';
import { publishQaPending, publishQaResult, qaPublicationAllowed } from '../src/github/publish-qa.js';
import type { QaRunResult } from '../src/qa/types.js';
import { QA_STICKY_MARKER } from '../src/render/qa-summary.js';

function result(overrides: Partial<QaRunResult> = {}): QaRunResult {
  return {
    schema_version: 1,
    run_id: 'qa-run-1',
    repository: 'owner/repo',
    pr_number: 9,
    merge_sha: 'a'.repeat(40),
    base_resolution: 'exact',
    source_base_sha: 'b'.repeat(40),
    policy_base_shas: ['b'.repeat(40)],
    started_at: '2026-08-18T10:00:00.000Z',
    completed_at: '2026-08-18T10:00:01.000Z',
    duration_ms: 1_000,
    outcome: 'passed',
    conclusion: 'success',
    target: {
      kind: 'staging-static',
      url: 'https://staging.example.test/',
      allowed_origin: 'https://staging.example.test',
      environment: 'staging',
      deployment_id: null,
      deployment_status_id: null,
      revision: {
        verified_against: 'none', expected_sha: null, observed_sha: null, relation: 'unverified',
        method: 'none', contains_merge_sha: null, additional_commits: [], additional_commits_truncated: false,
      },
      stability: 'stable',
      verdict_eligible: false,
      resolved_at: '2026-08-18T10:00:00.000Z', ready_at: '2026-08-18T10:00:00.000Z',
    },
    plan: {
      schema_version: 1,
      impact_assessment: 'The visible control changed.',
      testability: 'testable',
      no_testable_surface_reason: null,
      surfaces: ['composer'],
      scenarios: [{
        id: 'composer-check', title: 'Composer remains visible', rationale: 'The control changed.',
        viewport: { kind: 'desktop', width: 1280, height: 720, justification: 'Default viewport.' },
        preconditions: [], seeded_state: [],
        checkpoints: [{
          id: 'composer-visible', description: 'Composer is visible', expected: 'Composer is visible',
          assertion: { kind: 'visible', locator: { by: 'role', value: 'textbox', name: 'Composer', exact: true, nth: null }, url_contains: null },
        }],
        allowed_mutations: ['none'], cleanup_expectations: [],
      }],
      risk_notes: [], blind_spots: [],
    },
    attempts: [{
      scenario_id: 'composer-check', attempt: 1, status: 'passed', started_at: '2026-08-18T10:00:00.000Z', duration_ms: 1,
      operations: [], checkpoints: [{ checkpoint_id: 'composer-visible', status: 'passed', expected: 'Composer is visible', observed: 'Composer is visible' }],
      observations: [], evidence_artifact_ids: [],
    }],
    issues: [],
    cleanup: { status: 'not_required', summary: 'No reset needed.', error: null },
    artifacts: [],
    runtime: {
      model_id: 'gpt-5.6-luna',
      model_version: null,
      browser_name: 'chromium',
      browser_version: '140.0.0',
    },
    cost: { usage: null, usd: null, source: 'unknown' },
    warnings: [],
    ...overrides,
  };
}

function fakeClient(
  comments: IssueComment[] = [],
  updatesThatFail = new Set<number>(),
  repo = 'owner/repo',
) {
  const listIssueComments = vi.fn(async () => comments.map((comment) => ({ ...comment })));
  const updateIssueComment = vi.fn(async (id: number, body: string) => {
    if (updatesThatFail.has(id)) {
      throw new GitHubApiError(
        403,
        `/comments/${id}`,
        'Resource not accessible by this bot identity',
        null,
        '',
      );
    }
    const comment = comments.find((item) => item.id === id);
    if (comment) comment.body = body;
  });
  const createIssueComment = vi.fn(async (_prNumber: number, body: string) => {
    const id = Math.max(100, ...comments.map((comment) => comment.id + 1));
    comments.push({ id, body, user: { login: 'juror[bot]' } });
    return { id };
  });
  return { repo, listIssueComments, updateIssueComment, createIssueComment, comments };
}

describe('publishQaResult', () => {
  it('does not authorize publication after caller cancellation', () => {
    expect(qaPublicationAllowed(true, false)).toBe(true);
    expect(qaPublicationAllowed(true, true)).toBe(false);
    expect(qaPublicationAllowed(false, false)).toBe(false);
  });

  it('creates a dedicated QA sticky while ignoring user-authored marker spoofing', async () => {
    const fake = fakeClient([
      { id: 1, body: `${QA_STICKY_MARKER}\nspoof`, user: { login: 'pull-request-author' } },
      { id: 2, body: 'ordinary bot comment', user: { login: 'other[bot]' } },
    ]);

    await expect(publishQaResult(fake, 9, result(), {
      jobUrl: 'https://github.com/owner/repo/actions/runs/1',
    })).resolves.toEqual({ commentId: 100, updated: false });

    expect(fake.listIssueComments).toHaveBeenCalledWith(9);
    expect(fake.updateIssueComment).not.toHaveBeenCalled();
    expect(fake.createIssueComment).toHaveBeenCalledTimes(1);
    expect(fake.createIssueComment.mock.calls[0]?.[0]).toBe(9);
    expect(fake.createIssueComment.mock.calls[0]?.[1]).toContain(QA_STICKY_MARKER);
    expect(fake.createIssueComment.mock.calls[0]?.[1]).toContain('## ✅ Juror QA — Passed');
  });

  it('uses a non-final sticky until the immutable result is committed', async () => {
    const fake = fakeClient();

    await publishQaPending(fake, 9, result(), {
      jobUrl: 'https://github.com/owner/repo/actions/runs/1',
    });

    const pending = fake.createIssueComment.mock.calls[0]?.[1];
    expect(pending).toContain('## ⏳ Juror QA — Finalizing evidence');
    expect(pending).toContain('sealing the evidence before publishing a verdict');
    expect(pending).not.toContain('## ✅ Juror QA — Passed');

    await publishQaResult(fake, 9, result());
    expect(fake.updateIssueComment.mock.calls.at(-1)?.[1]).toContain('## ✅ Juror QA — Passed');
  });

  it('updates the newest bot-owned QA marker idempotently', async () => {
    const fake = fakeClient([
      { id: 3, body: `${QA_STICKY_MARKER}\noldest`, user: { login: 'juror[bot]' } },
      { id: 15, body: `${QA_STICKY_MARKER}\nnewest`, user: { login: 'github-actions[bot]' } },
      { id: 20, body: 'newer but unrelated', user: { login: 'juror[bot]' } },
    ]);

    await expect(publishQaResult(fake, 9, result({ outcome: 'blocked', conclusion: 'failure' })))
      .resolves.toEqual({ commentId: 15, updated: true });

    expect(fake.updateIssueComment).toHaveBeenCalledTimes(1);
    expect(fake.updateIssueComment.mock.calls[0]?.[0]).toBe(15);
    expect(fake.updateIssueComment.mock.calls[0]?.[1]).toContain('## ⛔ Juror QA — QA blocked');
    expect(fake.createIssueComment).not.toHaveBeenCalled();
  });

  it('falls back through old bot identities before creating another comment', async () => {
    const comments: IssueComment[] = [
      { id: 8, body: `${QA_STICKY_MARKER}\nold`, user: { login: 'juror[bot]' } },
      { id: 12, body: `${QA_STICKY_MARKER}\nnew`, user: { login: 'github-actions[bot]' } },
    ];
    const recoverable = fakeClient(comments, new Set([12]));

    await expect(publishQaResult(recoverable, 9, result()))
      .resolves.toEqual({ commentId: 8, updated: true });
    expect(recoverable.updateIssueComment.mock.calls.map((call) => call[0])).toEqual([12, 8]);
    expect(recoverable.createIssueComment).not.toHaveBeenCalled();

    const createFallback = fakeClient([
      { id: 21, body: `${QA_STICKY_MARKER}\nold identity`, user: { login: 'retired[bot]' } },
    ], new Set([21]));
    await expect(publishQaResult(createFallback, 9, result()))
      .resolves.toEqual({ commentId: 100, updated: false });
    expect(createFallback.updateIssueComment).toHaveBeenCalledWith(21, expect.any(String));
    expect(createFallback.createIssueComment).toHaveBeenCalledTimes(1);
  });

  it('rethrows transient update failures instead of creating duplicate stickies', async () => {
    const comment = { id: 30, body: `${QA_STICKY_MARKER}\ncurrent`, user: { login: 'juror[bot]' } };
    for (const error of [
      new Error('socket reset'),
      new GitHubApiError(429, '/comments/30', 'rate limited', null, ''),
      new GitHubApiError(503, '/comments/30', 'unavailable', null, ''),
    ]) {
      const fake = fakeClient([comment]);
      fake.updateIssueComment.mockRejectedValueOnce(error);

      await expect(publishQaResult(fake, 9, result())).rejects.toBe(error);
      expect(fake.createIssueComment).not.toHaveBeenCalled();
    }
  });

  it('redacts secrets and keeps a bounded comment structurally complete', async () => {
    const fake = fakeClient();
    const secret = `github_pat_${'a'.repeat(48)}`;
    const boundedWarning = `${secret} ${'x'.repeat(430)}`;

    await publishQaResult(fake, 9, result({ warnings: [boundedWarning] }));

    const body = fake.createIssueComment.mock.calls[0]?.[1];
    expect(body).toBeDefined();
    expect(body.length).toBeLessThanOrEqual(65_000);
    expect(body).not.toContain(secret);
    expect(body).toContain('\\[redacted\\]');
    expect(body).toContain('</details>');
  });

  it.each([publishQaResult, publishQaPending])('fails closed when %s would publish an exact canary from fixed copy', async (publish) => {
    const fake = fakeClient();

    await expect(publish(fake, 9, result(), { secrets: ['Juror QA'] }))
      .rejects.toThrow('configured secret canary');
    expect(fake.listIssueComments).not.toHaveBeenCalled();
    expect(fake.createIssueComment).not.toHaveBeenCalled();
  });

  it.each([publishQaResult, publishQaPending])('refuses invalid direct publication through %s', async (publish) => {
    const fake = fakeClient();
    const invalid = result({ attempts: [] });

    await expect(publish(fake, 9, invalid)).rejects.toThrow('Refusing to publish an invalid QA result');
    expect(fake.createIssueComment).not.toHaveBeenCalled();
  });

  it.each([publishQaResult, publishQaPending])('binds publication to the result pull request through %s', async (publish) => {
    const fake = fakeClient();
    await expect(publish(fake, 10, result())).rejects.toThrow('different pull request');
    expect(fake.listIssueComments).not.toHaveBeenCalled();
    expect(fake.createIssueComment).not.toHaveBeenCalled();
  });

  it.each([publishQaResult, publishQaPending])('binds publication to the client repository through %s', async (publish) => {
    const fake = fakeClient([], new Set(), 'expected/repo');
    await expect(publish(fake, 9, result())).rejects.toThrow('different repository');
    expect(fake.listIssueComments).not.toHaveBeenCalled();
    expect(fake.createIssueComment).not.toHaveBeenCalled();
  });
});
