// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryItem } from '../shared/api';
import { OnboardingPage } from '../src/pages';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function repository(id: string, fullName: string): RepositoryItem {
  const [owner, name] = fullName.split('/');
  return {
    id,
    owner: owner!,
    name: name!,
    fullName,
    private: false,
    defaultBranch: 'main',
    connectionStatus: 'healthy',
    hostedAutomationBlocked: false,
    reviewEnabled: false,
    reviewPreset: 'fast',
    publishMode: 'all',
    severityFloor: 'P3',
    qaEnabled: false,
    qaReady: false,
    qaTarget: null,
    allowedOrigins: [],
    hasSessionBootstrap: false,
    hasSecretHeaders: false,
    hasResetHook: false,
    evidencePolicy: { screenshot: 'failure', trace: 'failure', video: 'off' },
    latestRun: null,
  };
}

describe('new-user hosted review onboarding', () => {
  beforeEach(() => window.history.replaceState({}, '', '/onboarding'));
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('claims a GitHub installation and enables reviews only for selected repositories', async () => {
    const repositories = [repository('repo_101', 'octo/alpha'), repository('repo_102', 'octo/beta'), { ...repository('repo_103', 'octo/gamma'), hostedAutomationBlocked: true, connectionStatus: 'attention' as const }];
    const mutations: Array<{ path: string; body: unknown }> = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input instanceof Request ? new URL(input.url).pathname : input.pathname;
      const method = init?.method ?? 'GET';
      if (path === '/api/readiness') return json({ data: {
        ready: true,
        checks: { github: true, google: false, reviews: true, qa: false, billing: false, corpus: true, costs: true },
        reviewPresets: { starter: true, fast: false, balanced: false, high: false, ultra: false },
      }, requestId: 'readiness' });
      if (path === '/api/onboarding/status') return json({ data: { hasGithub: true, hasWorkspace: false, workspaceId: null }, requestId: 'status' });
      if (path === '/api/onboarding/installations') return json({ data: {
        state: 'signed-installation-state',
        installations: [{
          id: 12,
          accountLogin: 'octo',
          accountType: 'User',
          repositorySelection: 'selected',
          repositories: repositories.map((item) => ({ id: Number(item.id.slice(5)), fullName: item.fullName, private: item.private, archived: false, defaultBranch: item.defaultBranch })),
        }],
      }, requestId: 'installations' });
      if (path === '/api/onboarding/claim-installation' && method === 'POST') return json({ data: { workspaceId: 'ws_12', role: 'admin' }, requestId: 'claim' });
      if (path === '/api/repositories') return json({ data: repositories, requestId: 'repositories' });
      if (path.startsWith('/api/repositories/') && method === 'PATCH') {
        mutations.push({ path, body: JSON.parse(String(init?.body)) });
        return json({ data: { id: path.split('/').at(-1), updatedAt: '2026-08-22T00:00:00.000Z' }, requestId: 'mutation' });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', request);

    render(<BrowserRouter><OnboardingPage /></BrowserRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Use installation' }));
    expect(screen.queryByText('GitHub Action')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(await screen.findByRole('checkbox', { name: /octo\/gamma/i })).not.toBeChecked();
    const beta = await screen.findByRole('checkbox', { name: /octo\/beta/i });
    expect(beta).not.toBeChecked();
    fireEvent.click(beta);
    fireEvent.click(screen.getByRole('button', { name: 'Enable reviews for 1' }));

    expect(await screen.findByRole('heading', { name: 'Automated reviews are ready' })).toBeInTheDocument();
    expect(mutations).toEqual([
      { path: '/api/repositories/repo_102', body: { reviewEnabled: true, reviewPreset: 'starter' } },
    ]);
    await waitFor(() => expect(request).toHaveBeenCalledWith('/api/onboarding/claim-installation', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ installationId: 12, state: 'signed-installation-state' }),
    })));
  });
});
