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

  it('fetches the authoritative PR diff and validates commit parents', async () => {
    const parent = 'b'.repeat(40);
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/pulls/9')) {
        return new Response('diff --git a/a.ts b/a.ts\n', { status: 200 });
      }
      return new Response(JSON.stringify({ parents: [{ sha: parent }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', request);
    const client = new GitHubClient({ token: 'test-token', repo: 'owner/name' });

    await expect(client.getPullDiff(9)).resolves.toContain('diff --git');
    await expect(client.getCommitParents('a'.repeat(40))).resolves.toEqual([parent]);
    expect((request.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      Accept: 'application/vnd.github.v3.diff',
    });
  });

  it('validates the authoritative commit relationship', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ status: 'diverged' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', request);
    const client = new GitHubClient({ token: 'test-token', repo: 'owner/name' });

    await expect(
      client.getCommitRelationship('a'.repeat(40), 'b'.repeat(40)),
    ).resolves.toBe('diverged');
    expect(String(request.mock.calls[0]?.[0])).toContain(
      `/compare/${'a'.repeat(40)}...${'b'.repeat(40)}?per_page=1&page=2`,
    );
  });

  it('cancels requests without spending the retry budget', async () => {
    const controller = new AbortController();
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      controller.abort();
      init?.signal?.throwIfAborted();
      return new Response('{}', { status: 200 });
    });
    const client = new GitHubClient({
      token: 'test-token',
      repo: 'owner/name',
      fetchImpl: request,
      signal: controller.signal,
    });

    await expect(client.getCommitParents('a'.repeat(40))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it('uses an explicit transport override instead of ambient fetch', async () => {
    const ambient = vi.fn();
    const transport = vi.fn(async () => new Response(JSON.stringify({ parents: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', ambient);
    const client = new GitHubClient({
      token: 'test-token',
      repo: 'owner/name',
      fetchImpl: transport,
    });

    await expect(client.getCommitParents('a'.repeat(40))).resolves.toEqual([]);
    expect(transport).toHaveBeenCalledOnce();
    expect(ambient).not.toHaveBeenCalled();
  });
});
