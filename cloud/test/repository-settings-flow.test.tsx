// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FindingDetailResponse, RepositoryItem } from '../shared/api';
import { FindingDetailPage, RepositoriesPage } from '../src/pages';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

const configuredRepository: RepositoryItem = {
  id: 'repo_101',
  owner: 'octo',
  name: 'alpha',
  fullName: 'octo/alpha',
  private: true,
  defaultBranch: 'main',
  connectionStatus: 'healthy',
  hostedAutomationBlocked: false,
  reviewEnabled: true,
  reviewPreset: 'fast',
  publishMode: 'all',
  severityFloor: 'P3',
  qaEnabled: true,
  qaReady: true,
  qaTarget: 'https://staging.example.com',
  allowedOrigins: ['https://staging.example.com'],
  hasSessionBootstrap: true,
  hasSecretHeaders: true,
  hasResetHook: true,
  evidencePolicy: { screenshot: 'failure', trace: 'failure', video: 'off' },
  latestRun: null,
};

const reviewFinding: FindingDetailResponse = {
  id: 'finding_test',
  fingerprint: 'fixture',
  title: 'Diff fixture',
  status: 'open',
  source: 'review',
  severity: 'P2',
  repository: configuredRepository,
  prNumber: 42,
  pathOrCheckpoint: 'src/example.ts',
  line: 10,
  agreement: { agreeing: 2, total: 3 },
  reproducible: null,
  assignee: null,
  firstSeenAt: '2026-08-22T00:00:00.000Z',
  lastSeenAt: '2026-08-22T00:00:00.000Z',
  body: 'The current patch is needed to inspect this finding.',
  claim: null,
  expected: null,
  actual: null,
  attempts: [],
  targetUrl: null,
  targetRevision: null,
  verification: null,
  githubUrl: 'https://github.com/octo/alpha/pull/42',
  diff: null,
};

describe('repository settings', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('can explicitly clear every stored QA secret and hook', async () => {
    const mutations: unknown[] = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = typeof input === 'string' ? input : input instanceof Request ? new URL(input.url).pathname : input.pathname;
      const method = init?.method ?? 'GET';
      if (path === '/api/readiness') return json({ data: {
        ready: true,
        checks: { github: true, google: false, reviews: true, qa: true, billing: false, corpus: true, costs: true },
        reviewPresets: { starter: true, fast: true, balanced: true, high: true, ultra: true },
      } });
      if (path === '/api/repositories' && method === 'GET') return json({ data: [configuredRepository] });
      if (path === '/api/repositories/repo_101' && method === 'PATCH') {
        mutations.push(JSON.parse(String(init?.body)));
        return json({ data: { id: 'repo_101', updatedAt: '2026-08-22T00:00:00.000Z' } });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', request);

    render(<MemoryRouter><RepositoriesPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: /configure/i }));
    fireEvent.click(screen.getByLabelText(/clear saved session bootstrap/i));
    fireEvent.click(screen.getByLabelText(/clear saved scoped headers/i));
    fireEvent.click(screen.getByLabelText(/clear saved reset hook/i));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0]).toMatchObject({
      sessionBootstrap: null,
      secretHeaders: null,
      resetHook: null,
    });
    await waitFor(() => {
      expect(screen.getByLabelText(/clear saved session bootstrap/i)).not.toBeChecked();
      expect(screen.getByLabelText(/clear saved scoped headers/i)).not.toBeChecked();
      expect(screen.getByLabelText(/clear saved reset hook/i)).not.toBeChecked();
    });
  });
});

describe('finding diff loading', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows a provider error and permits retry when the GitHub diff cannot load', async () => {
    let diffRequests = 0;
    const request = vi.fn(async (input: string | URL | Request) => {
      const path = typeof input === 'string' ? input : input instanceof Request ? new URL(input.url).pathname : input.pathname;
      if (path === '/api/findings/finding_test') return json({ data: reviewFinding });
      if (path === '/api/findings/finding_test/diff') {
        diffRequests += 1;
        return json({ error: { message: 'GitHub temporarily rejected the diff request.' } }, 502);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', request);

    render(<MemoryRouter initialEntries={['/findings/finding_test']}><Routes><Route path="/findings/:findingId" element={<FindingDetailPage />} /></Routes></MemoryRouter>);

    const button = await screen.findByRole('button', { name: 'Load GitHub diff' });
    fireEvent.click(button);

    expect(await screen.findByText('GitHub temporarily rejected the diff request.')).toBeInTheDocument();
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(diffRequests).toBe(2));
  });
});
