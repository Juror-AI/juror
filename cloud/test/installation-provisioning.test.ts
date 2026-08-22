import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker/env';

const githubApi = vi.hoisted(() => vi.fn());
vi.mock('../worker/github', () => ({ githubApi }));

import { provisionInstallation } from '../worker/github-webhook';

interface DatabaseState {
  repositories: Set<string>;
  settings: Set<string>;
}

function fakeEnv(state: DatabaseState): Env {
  const prepare = (sql: string) => {
    let parameters: unknown[] = [];
    const statement = {
      bind: (...values: unknown[]) => { parameters = values; return statement; },
      first: async () => {
        if (sql.startsWith('SELECT 1 AS deleted')) return null;
        if (sql.startsWith('SELECT id FROM workspace')) return { id: 'ws_12' };
        if (sql.startsWith('SELECT action_detected')) return state.settings.has(String(parameters[0])) ? { action_detected: 0 } : null;
        throw new Error(`Unexpected first(): ${sql}`);
      },
      run: async () => {
        if (sql.startsWith('INSERT INTO repository ')) state.repositories.add(String(parameters[0]));
        else if (sql.startsWith('INSERT INTO repository_settings ')) state.settings.add(String(parameters[0]));
        return { meta: { changes: 1 } };
      },
    };
    return statement;
  };
  const DB = {
    prepare,
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => Promise.all(statements.map((statement) => statement.run())),
  };
  return { DB } as unknown as Env;
}

describe('installation provisioning recovery', () => {
  beforeEach(() => githubApi.mockReset());

  it('keeps importing repositories when optional Action detection is temporarily unavailable', async () => {
    const state: DatabaseState = { repositories: new Set(['repo_101']), settings: new Set(['repo_101']) };
    githubApi.mockResolvedValue(new Response('{}', { status: 503 }));

    await expect(provisionInstallation(fakeEnv(state), {
      installation: { id: 12, account: { login: 'octo', type: 'User' }, permissions: {}, repository_selection: 'selected' },
      repositories: [
        { id: 101, name: 'alpha', full_name: 'octo/alpha', private: false, archived: false, default_branch: 'main', owner: { login: 'octo' } },
        { id: 102, name: 'beta', full_name: 'octo/beta', private: false, archived: false, default_branch: 'main', owner: { login: 'octo' } },
      ],
    }, false)).resolves.toBeUndefined();

    expect(state.repositories).toEqual(new Set(['repo_101', 'repo_102']));
    expect(state.settings).toEqual(new Set(['repo_101', 'repo_102']));
    expect(githubApi).toHaveBeenCalledOnce();
  });

  it('keeps importing repositories when a workflow file has invalid base64 content', async () => {
    const state: DatabaseState = { repositories: new Set(), settings: new Set() };
    githubApi
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { type: 'file', name: 'review.yml', path: '.github/workflows/review.yml' },
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ encoding: 'base64', content: 'not_base64url!' }), { status: 200 }));

    await expect(provisionInstallation(fakeEnv(state), {
      installation: { id: 12, account: { login: 'octo', type: 'User' }, permissions: {}, repository_selection: 'selected' },
      repositories: [
        { id: 101, name: 'alpha', full_name: 'octo/alpha', private: false, archived: false, default_branch: 'main', owner: { login: 'octo' } },
      ],
    }, false)).resolves.toBeUndefined();

    expect(state.repositories).toEqual(new Set(['repo_101']));
    expect(state.settings).toEqual(new Set(['repo_101']));
    expect(githubApi).toHaveBeenCalledTimes(2);
  });
});
