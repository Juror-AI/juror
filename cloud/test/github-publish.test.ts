import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostedReviewReportV1 } from '../../src/cloud/types';
import type { Env } from '../worker/env';

const githubApi = vi.hoisted(() => vi.fn());
vi.mock('../worker/github', () => ({ githubApi }));

import { publishHostedReview } from '../worker/github-publish';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function report(): HostedReviewReportV1 {
  return {
    models: [{ skipped: false }],
    clusters: [{ fingerprint: 'seen-on-page-two', path: 'src/index.ts', line: 7, severity: 'P2', title: 'Already published', body: 'Do not duplicate this.', agreement: 1, verification: null }],
    publishedFingerprints: ['seen-on-page-two'],
    summary: { summary: 'Review complete.' },
    verdict: { score: 4, confirmed: { P0: 0, P1: 0, P2: 1, P3: 0 } },
    totals: { usd: 0.01 },
    diff: { baseSha: 'base-sha', headSha: 'head-sha', files: [{ path: 'src/index.ts', changedLines: [7] }] },
  } as unknown as HostedReviewReportV1;
}

describe('hosted GitHub publication', () => {
  beforeEach(() => {
    githubApi.mockReset();
  });

  it('paginates existing inline comments before deduplicating findings', async () => {
    githubApi.mockImplementation(async (...args: [Env, number, string, RequestInit?]) => {
      const [, , path, init] = args;
      if (typeof path !== 'string') throw new Error(`GitHub mock received invalid arguments: ${JSON.stringify(args)}`);
      const method = init?.method ?? 'GET';
      if (path.endsWith('/pulls/7')) return json({ head: { sha: 'head-sha' }, base: { sha: 'base-sha' } });
      if (path.endsWith('/pulls/7/comments?per_page=100') || path.endsWith('/pulls/7/comments?per_page=100&page=1')) {
        return json(Array.from({ length: 100 }, (_, index) => ({ body: `ordinary comment ${index}` })));
      }
      if (path.endsWith('/pulls/7/comments?per_page=100&page=2')) return json([{ body: '<!-- juror:finding:seen-on-page-two -->' }]);
      if (path.includes('/issues/7/comments?per_page=100&page=1')) return json([]);
      if (path.endsWith('/issues/7/comments') && method === 'POST') return json({ id: 1 });
      if (path.includes('/commits/head-sha/check-runs?')) return json({ check_runs: [] });
      if (path.endsWith('/check-runs') && method === 'POST') return json({ id: 2 });
      if (path.endsWith('/pulls/7/reviews') && method === 'POST') return json({ id: 3 });
      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    });
    const env = {
      APP_URL: 'https://juror.example',
      DB: { prepare: () => ({ bind: () => ({ first: async () => ({ repository: 'octo/example', pr_number: 7, revision_sha: 'head-sha', github_installation_id: 12 }) }) }) },
    } as unknown as Env;

    await expect(publishHostedReview(env, 'run_1', report())).resolves.toEqual({ published: true, stale: false });

    expect(githubApi.mock.calls.some((call) => String(call[2]).endsWith('/pulls/7/comments?per_page=100&page=2'))).toBe(true);
    expect(githubApi.mock.calls.some((call) => String(call[2]).endsWith('/pulls/7/reviews') && call[3]?.method === 'POST')).toBe(false);
  });
});
