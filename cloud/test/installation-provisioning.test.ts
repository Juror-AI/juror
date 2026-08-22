import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker/env';

const githubApi = vi.hoisted(() => vi.fn());
vi.mock('../worker/github', () => ({ githubApi }));

import { provisionInstallation } from '../worker/github-webhook';

interface DatabaseState {
  repositories: Set<string>;
  settings: Set<string>;
  detected: Map<string, number>;
}

function fakeEnv(state: DatabaseState): Env {
  const prepare = (sql: string) => {
    let parameters: unknown[] = [];
    const statement = {
      bind: (...values: unknown[]) => { parameters = values; return statement; },
      first: async () => {
        if (sql.startsWith('SELECT 1 AS deleted')) return null;
        if (sql.startsWith('SELECT id FROM workspace')) return { id: 'ws_12' };
        if (sql.startsWith('SELECT action_detected')) return state.settings.has(String(parameters[0])) ? { action_detected: state.detected.get(String(parameters[0])) ?? 0 } : null;
        throw new Error(`Unexpected first(): ${sql}`);
      },
      run: async () => {
        if (sql.startsWith('INSERT INTO repository ')) state.repositories.add(String(parameters[0]));
        else if (sql.startsWith('INSERT INTO repository_settings ')) {
          state.settings.add(String(parameters[0]));
          state.detected.set(String(parameters[0]), Number(parameters[1]));
        }
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

  it('preserves a known-safe repository and blocks a new repository when detection is unavailable', async () => {
    const state: DatabaseState = { repositories: new Set(['repo_101']), settings: new Set(['repo_101']), detected: new Map([['repo_101', 0]]) };
    githubApi.mockResolvedValue(new Response('{}', { status: 503 }));

    await expect(provisionInstallation(fakeEnv(state), {
      installation: { id: 12, account: { login: 'octo', type: 'User' }, permissions: {}, repository_selection: 'selected' },
      repositories: [
        { id: 101, name: 'alpha', full_name: 'octo/alpha', private: false, archived: false, default_branch: 'main', owner: { login: 'octo' } },
        { id: 102, name: 'beta', full_name: 'octo/beta', private: false, archived: false, default_branch: 'main', owner: { login: 'octo' } },
      ],
    })).resolves.toBeUndefined();

    expect(state.repositories).toEqual(new Set(['repo_101', 'repo_102']));
    expect(state.settings).toEqual(new Set(['repo_101', 'repo_102']));
    expect(state.detected).toEqual(new Map([['repo_101', 0], ['repo_102', 1]]));
    expect(githubApi).toHaveBeenCalledTimes(2);
  });

  it('detects the root Juror review Action and keeps hosted automation blocked', async () => {
    const state: DatabaseState = { repositories: new Set(), settings: new Set(), detected: new Map() };
    githubApi
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { type: 'file', name: 'review.yml', sha: 'a'.repeat(40) },
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { repository: { workflow0: { isBinary: false, text: 'steps:\n  - uses: Juror-AI/juror@v1' } } } }), { status: 200 }));

    await provisionInstallation(fakeEnv(state), {
      installation: { id: 12, account: { login: 'octo', type: 'User' }, permissions: {}, repository_selection: 'selected' },
      repositories: [
        { id: 101, name: 'alpha', full_name: 'octo/alpha', private: false, archived: false, default_branch: 'main', owner: { login: 'octo' } },
      ],
    });

    expect(state.detected.get('repo_101')).toBe(1);
    expect(githubApi).toHaveBeenCalledTimes(2);
  });

  it('checks every workflow before approving hosted automation', async () => {
    const state: DatabaseState = { repositories: new Set(), settings: new Set(), detected: new Map() };
    const workflows = Array.from({ length: 31 }, (_, index) => ({ type: 'file', name: `${index}.yml`, sha: index.toString(16).padStart(40, '0') }));
    githubApi.mockResolvedValueOnce(new Response(JSON.stringify(workflows), { status: 200 }));
    const blobs = Object.fromEntries(workflows.map((_, index) => [`workflow${index}`, { isBinary: false, text: index === workflows.length - 1 ? 'steps:\n  - uses: Juror-AI/juror@v1' : 'steps:\n  - run: npm test' }]));
    githubApi.mockResolvedValueOnce(new Response(JSON.stringify({ data: { repository: blobs } }), { status: 200 }));

    await provisionInstallation(fakeEnv(state), {
      installation: { id: 12, account: { login: 'octo', type: 'User' }, permissions: {}, repository_selection: 'selected' },
      repositories: [
        { id: 101, name: 'alpha', full_name: 'octo/alpha', private: false, archived: false, default_branch: 'main', owner: { login: 'octo' } },
      ],
    });

    expect(state.detected.get('repo_101')).toBe(1);
    expect(githubApi).toHaveBeenCalledTimes(2);
  });

  it('imports but blocks a repository when a workflow blob is unreadable', async () => {
    const state: DatabaseState = { repositories: new Set(), settings: new Set(), detected: new Map() };
    githubApi
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { type: 'file', name: 'review.yml', sha: 'a'.repeat(40) },
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { repository: { workflow0: { isBinary: false, text: null } } } }), { status: 200 }));

    await expect(provisionInstallation(fakeEnv(state), {
      installation: { id: 12, account: { login: 'octo', type: 'User' }, permissions: {}, repository_selection: 'selected' },
      repositories: [
        { id: 101, name: 'alpha', full_name: 'octo/alpha', private: false, archived: false, default_branch: 'main', owner: { login: 'octo' } },
      ],
    })).resolves.toBeUndefined();

    expect(state.detected.get('repo_101')).toBe(1);
    expect(githubApi).toHaveBeenCalledTimes(2);
  });
});
