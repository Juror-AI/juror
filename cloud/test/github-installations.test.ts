import { describe, expect, it, vi } from 'vitest';
import { discoverGitHubInstallations } from '../worker/github-installations';

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }, ...init });
}

describe('GitHub installation discovery', () => {
  it('returns only this GitHub App and follows repository pagination', async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/user/installations?per_page=100&page=1')) return json({ installations: [
        { id: 12, app_slug: 'juror-cloud', account: { login: 'octo', type: 'User' }, permissions: { contents: 'read' }, repository_selection: 'selected' },
        { id: 99, app_slug: 'another-app', account: { login: 'octo', type: 'User' }, permissions: {}, repository_selection: 'all' },
      ] });
      if (url.endsWith('/user/installations/12/repositories?per_page=100&page=1')) return json({ repositories: [
        { id: 101, name: 'alpha', full_name: 'octo/alpha', private: true, archived: false, default_branch: 'main', owner: { login: 'octo' } },
      ] }, { headers: { link: '<https://api.github.com/user/installations/12/repositories?per_page=100&page=2>; rel="next"' } });
      if (url.endsWith('/user/installations/12/repositories?per_page=100&page=2')) return json({ repositories: [
        { id: 102, name: 'beta', full_name: 'octo/beta', private: false, archived: false, default_branch: 'trunk', owner: { login: 'octo' } },
      ] });
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await discoverGitHubInstallations('user-token', 'juror-cloud', request as typeof fetch);

    expect(result).toEqual([{ id: 12, appSlug: 'juror-cloud', account: { login: 'octo', type: 'User' }, permissions: { contents: 'read' }, repositorySelection: 'selected', repositories: [
      { id: 101, name: 'alpha', fullName: 'octo/alpha', private: true, archived: false, defaultBranch: 'main', owner: { login: 'octo' } },
      { id: 102, name: 'beta', fullName: 'octo/beta', private: false, archived: false, defaultBranch: 'trunk', owner: { login: 'octo' } },
    ] }]);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ headers: expect.objectContaining({ authorization: 'Bearer user-token' }) });
  });

  it('follows installation pagination before filtering for this App', async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/user/installations?per_page=100&page=1')) return json({ installations: [
        { id: 99, app_slug: 'another-app', account: { login: 'octo', type: 'User' }, permissions: {}, repository_selection: 'all' },
      ] }, { headers: { link: '<https://api.github.com/user/installations?per_page=100&page=2>; rel="next"' } });
      if (url.endsWith('/user/installations?per_page=100&page=2')) return json({ installations: [
        { id: 12, app_slug: 'juror-cloud', account: { login: 'octo', type: 'User' }, permissions: { contents: 'read' }, repository_selection: 'selected' },
      ] });
      if (url.endsWith('/user/installations/12/repositories?per_page=100&page=1')) return json({ repositories: [] });
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await discoverGitHubInstallations('user-token', 'juror-cloud', request as typeof fetch);

    expect(result.map((installation) => installation.id)).toEqual([12]);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('fails closed when GitHub rejects the linked user token', async () => {
    const request = vi.fn(async () => json({ message: 'Bad credentials' }, { status: 401 }));
    await expect(discoverGitHubInstallations('expired', 'juror-cloud', request as typeof fetch)).rejects.toThrow('GitHub installation discovery failed (401)');
  });
});
