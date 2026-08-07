import { afterEach, describe, expect, it, vi } from 'vitest';

import { GitHubClient } from '../src/github/client.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GitHubClient immutable comparisons', () => {
  it('fetches a captured base/head pair instead of the mutable pull endpoint', async () => {
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response('diff --git a/a.ts b/a.ts\n', {
        status: 200,
        headers: { 'content-type': 'application/vnd.github.v3.diff' },
      }),
    );
    vi.stubGlobal('fetch', request);

    const client = new GitHubClient({
      token: 'test-token',
      repo: 'owner/name',
      apiBase: 'https://github.example/api/v3',
    });
    const patch = await client.getCompareDiff('base-sha', 'head-sha');

    expect(patch).toContain('diff --git');
    expect(request).toHaveBeenCalledOnce();
    const [url, options] = request.mock.calls[0] ?? [];
    expect(url).toBe('https://github.example/api/v3/repos/owner/name/compare/base-sha...head-sha');
    expect((options as RequestInit | undefined)?.headers).toMatchObject({
      Accept: 'application/vnd.github.v3.diff',
    });
  });
});
