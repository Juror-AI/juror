import { describe, expect, it, vi } from 'vitest';

import {
  latestDeploymentStatus,
  listDeployments,
  listDeploymentStatuses,
  recheckQaTarget,
  resolveCommit,
  resolveQaTarget,
  type DeploymentGitHubApi,
} from '../src/github/deployments.js';
import type { QaConfig } from '../src/qa/types.js';

const MERGE_SHA = 'a'.repeat(40);
const DEPLOYED_SHA = 'b'.repeat(40);
const HEAD_SHA = 'c'.repeat(40);
const NOW = Date.parse('2026-08-18T12:00:00.000Z');

function deployment(
  id: number,
  sha = DEPLOYED_SHA,
  environment = 'staging',
  createdAt = '2026-08-18T11:00:00Z',
) {
  return {
    id,
    sha,
    ref: 'main',
    environment,
    transient_environment: environment !== 'staging',
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function deploymentStatus(
  id: number,
  state = 'success',
  environmentUrl: string | null = 'https://staging.example.test/',
  createdAt = '2026-08-18T11:01:00Z',
) {
  return {
    id,
    state,
    environment_url: environmentUrl,
    log_url: 'https://deployments.example.test/log',
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function github(
  handler: (method: string, path: string, body?: unknown) => Promise<unknown> | unknown,
): DeploymentGitHubApi & { request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(handler);
  return { repo: 'owner/name', request } as unknown as DeploymentGitHubApi & {
    request: ReturnType<typeof vi.fn>;
  };
}

function qaConfig(overrides: Partial<QaConfig['target']> = {}): QaConfig {
  return {
    enabled: true,
    model: { id: 'gpt-5.6-luna', reasoning_effort: 'medium' },
    testability: { early_exit_paths: [] },
    target: {
      strategy: 'staging-first',
      environment: 'staging',
      deployment_environment: null,
      static_url: null,
      readiness_path: '/health',
      readiness_statuses: null,
      commit_probe: null,
      preview_fallback: true,
      wait_seconds: 0,
      ...overrides,
    },
    auth: { session_bootstrap: null, browser_secret_headers: [], steps: [] },
    sandbox: {
      allowed_origins: [
        'https://staging.example.test',
        'https://preview.example.test',
      ],
      reset: null,
    },
    limits: {
      max_scenarios: 6,
      max_browser_operations: 40,
      timeout_seconds: 1200,
      mobile_when_relevant: true,
    },
    evidence: { video: 'all', trace: 'failure', screenshot: 'failure', retention_days: 14 },
  };
}

function healthyFetch(body: unknown = {}): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('GitHub deployment API helpers', () => {
  it('filters, normalizes, and newest-first sorts deployments', async () => {
    const client = github((_method, path) => {
      expect(path).toContain('/repos/owner/name/deployments?');
      expect(path).toContain('environment=staging');
      return [
        deployment(1, MERGE_SHA, 'staging', '2026-08-18T10:00:00Z'),
        { id: 'malformed' },
        deployment(2, DEPLOYED_SHA, 'staging', '2026-08-18T11:00:00Z'),
      ];
    });

    await expect(listDeployments(client, { environment: 'staging' })).resolves.toEqual([
      expect.objectContaining({ id: 2, sha: DEPLOYED_SHA }),
      expect.objectContaining({ id: 1, sha: MERGE_SHA }),
    ]);
  });

  it('uses the newest deployment status rather than an older success', async () => {
    const client = github(() => [
      deploymentStatus(1, 'success', 'https://staging.example.test/', '2026-08-18T10:00:00Z'),
      deploymentStatus(2, 'failure', null, '2026-08-18T11:00:00Z'),
    ]);

    const statuses = await listDeploymentStatuses(client, 42);
    expect(latestDeploymentStatus(statuses)).toMatchObject({ id: 2, state: 'failure' });
    expect(client.request).toHaveBeenCalledWith(
      'GET',
      '/repos/owner/name/deployments/42/statuses?per_page=100&page=1',
    );
  });

  it('rejects malformed top-level API payloads', async () => {
    const client = github(() => ({ deployments: [] }));
    await expect(listDeployments(client)).rejects.toThrow('Unexpected deployments payload');
  });
});

describe('resolveCommit', () => {
  it('short-circuits exact revisions without an API request', async () => {
    const client = github(() => {
      throw new Error('should not be called');
    });

    await expect(resolveCommit(client, MERGE_SHA, MERGE_SHA)).resolves.toMatchObject({
      relation: 'exact',
      containsRequiredCommit: true,
      additionalCommits: [],
    });
    expect(client.request).not.toHaveBeenCalled();
  });

  it('proves a descendant in the required-to-candidate compare direction', async () => {
    const client = github((_method, path) => {
      expect(path).toBe(`/repos/owner/name/compare/${MERGE_SHA}...${DEPLOYED_SHA}`);
      return {
        status: 'ahead',
        ahead_by: 2,
        total_commits: 2,
        commits: [{ sha: 'd'.repeat(40) }, { sha: DEPLOYED_SHA }],
      };
    });

    await expect(resolveCommit(client, MERGE_SHA, DEPLOYED_SHA)).resolves.toEqual({
      requiredSha: MERGE_SHA,
      candidateSha: DEPLOYED_SHA,
      relation: 'descendant',
      containsRequiredCommit: true,
      additionalCommits: ['d'.repeat(40), DEPLOYED_SHA],
      additionalCommitsTruncated: false,
    });
  });

  it('does not accept behind or diverged deployments', async () => {
    const client = github(() => ({ status: 'behind', ahead_by: 0, total_commits: 0, commits: [] }));
    await expect(resolveCommit(client, MERGE_SHA, DEPLOYED_SHA)).resolves.toMatchObject({
      relation: 'not-descendant',
      containsRequiredCommit: false,
    });
  });
});

describe('resolveQaTarget', () => {
  const pull = { number: 42, mergeSha: MERGE_SHA, headSha: HEAD_SHA };

  it('prefers a ready staging deployment that contains the merge commit', async () => {
    const client = github((_method, path) => {
      if (path.includes('/deployments?')) return [deployment(10)];
      if (path.includes('/deployments/10/statuses?')) return [deploymentStatus(20)];
      if (path.includes('/compare/')) {
        return {
          status: 'ahead',
          ahead_by: 1,
          total_commits: 1,
          commits: [{ sha: DEPLOYED_SHA }],
        };
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await resolveQaTarget(client, pull, qaConfig(), {
      fetchImpl: healthyFetch(),
      now: () => NOW,
    });

    expect(result).toMatchObject({
      status: 'resolved',
      target: {
        kind: 'staging-deployment',
        deployment_id: 10,
        deployment_status_id: 20,
        verdict_eligible: true,
        revision: {
          verified_against: 'merge',
          relation: 'descendant',
          observed_sha: DEPLOYED_SHA,
          contains_merge_sha: true,
        },
      },
    });
  });

  it('queries an exact dedicated deployment environment for the staging tier', async () => {
    const client = github((_method, path) => {
      if (path.includes('/deployments?') && path.includes('environment=web-staging')) {
        return [deployment(11, MERGE_SHA, 'web-staging')];
      }
      if (path.includes('/deployments/11/statuses?')) return [deploymentStatus(21)];
      throw new Error(`unexpected path ${path}`);
    });

    const result = await resolveQaTarget(
      client,
      pull,
      qaConfig({ deployment_environment: 'web-staging' }),
      { fetchImpl: healthyFetch(), now: () => NOW },
    );

    expect(result).toMatchObject({
      status: 'resolved',
      target: {
        kind: 'staging-deployment',
        environment: 'web-staging',
        deployment_id: 11,
        deployment_status_id: 21,
        verdict_eligible: true,
        revision: {
          verified_against: 'merge',
          relation: 'exact',
          observed_sha: MERGE_SHA,
        },
      },
    });
    expect(client.request).not.toHaveBeenCalledWith(
      'GET',
      expect.stringContaining('environment=staging&'),
    );
  });

  it('attributes a static fallback to the exact deployment selector', async () => {
    const client = github((_method, path) => {
      if (path.includes('/deployments?') && path.includes('environment=web-staging')) return [];
      throw new Error(`unexpected path ${path}`);
    });

    const result = await resolveQaTarget(
      client,
      pull,
      qaConfig({
        deployment_environment: 'web-staging',
        static_url: 'https://staging.example.test/app',
        preview_fallback: false,
      }),
      { fetchImpl: healthyFetch(), now: () => NOW },
    );

    expect(result).toMatchObject({
      status: 'resolved',
      target: {
        kind: 'staging-static',
        environment: 'web-staging',
        verdict_eligible: false,
      },
    });
  });

  it('uses a commit-probed static staging target before preview fallback', async () => {
    const client = github((_method, path) => {
      if (path.includes('/deployments?')) return [];
      if (path.includes('/compare/')) {
        return {
          status: 'ahead',
          ahead_by: 1,
          total_commits: 1,
          commits: [{ sha: DEPLOYED_SHA }],
        };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/version')) {
        return new Response(JSON.stringify({ build: { sha: DEPLOYED_SHA } }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const result = await resolveQaTarget(
      client,
      pull,
      qaConfig({
        static_url: 'https://staging.example.test/',
        commit_probe: { path: '/version', json_pointer: '/build/sha' },
      }),
      { fetchImpl, now: () => NOW },
    );

    expect(result.target).toMatchObject({
      kind: 'staging-static',
      verdict_eligible: true,
      revision: { method: 'static-probe', relation: 'descendant' },
    });
    expect(client.request).not.toHaveBeenCalledWith(
      'GET',
      expect.stringContaining(`sha=${HEAD_SHA}`),
    );
  });

  it('times out while a commit-probe body stalls after sending headers', async () => {
    const client = github(() => {
      throw new Error('an invalid probe response should not query GitHub');
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).endsWith('/version')) {
        return new Response('{}', { status: 200 });
      }
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"sha":"'));
          signal?.addEventListener(
            'abort',
            () => controller.error(signal.reason ?? new Error('request aborted')),
            { once: true },
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const result = await resolveQaTarget(
      client,
      pull,
      qaConfig({ commit_probe: { path: '/version', json_pointer: '/sha' } }),
      {
        explicitUrl: 'https://staging.example.test/app',
        fetchImpl,
        requestTimeoutMs: 20,
        now: () => NOW,
      },
    );

    expect(result.target).toMatchObject({
      kind: 'staging-static',
      verdict_eligible: false,
      revision: { relation: 'unverified' },
    });
    expect(result.diagnostics).toContain(
      'static target commit probe did not return a valid commit SHA',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects an oversized streamed commit-probe body', async () => {
    const client = github(() => {
      throw new Error('an invalid probe response should not query GitHub');
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const body = String(input).endsWith('/version')
        ? JSON.stringify({ sha: MERGE_SHA, padding: 'x'.repeat(70 * 1024) })
        : '{}';
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const result = await resolveQaTarget(
      client,
      pull,
      qaConfig({ commit_probe: { path: '/version', json_pointer: '/sha' } }),
      {
        explicitUrl: 'https://staging.example.test/app',
        fetchImpl,
        now: () => NOW,
      },
    );

    expect(result.target).toMatchObject({
      kind: 'staging-static',
      verdict_eligible: false,
      revision: { relation: 'unverified' },
    });
    expect(result.diagnostics).toContain(
      'static target commit probe did not return a valid commit SHA',
    );
  });

  it('falls back to an exact-head preview after the staging window', async () => {
    const client = github((_method, path) => {
      if (path.includes('/deployments?') && path.includes('environment=staging')) return [];
      if (path.includes('/deployments?') && path.includes(`sha=${HEAD_SHA}`)) {
        return [deployment(30, HEAD_SHA, 'preview-pr-42')];
      }
      if (path.includes('/deployments/30/statuses?')) {
        return [deploymentStatus(31, 'success', 'https://preview.example.test/')];
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await resolveQaTarget(client, pull, qaConfig(), {
      fetchImpl: healthyFetch(),
      now: () => NOW,
    });

    expect(result.target).toMatchObject({
      kind: 'preview-deployment',
      deployment_id: 30,
      verdict_eligible: true,
      revision: {
        verified_against: 'head',
        relation: 'exact',
        expected_sha: HEAD_SHA,
        contains_merge_sha: false,
      },
    });
  });

  it('downgrades a healthy unverified static target to advisory eligibility', async () => {
    const client = github((_method, path) => {
      if (path.includes('/deployments?')) return [];
      throw new Error(`unexpected path ${path}`);
    });

    const result = await resolveQaTarget(
      client,
      pull,
      qaConfig({
        static_url: 'https://staging.example.test/',
        preview_fallback: false,
      }),
      { fetchImpl: healthyFetch(), now: () => NOW },
    );

    expect(result.target).toMatchObject({
      kind: 'staging-static',
      verdict_eligible: false,
      revision: { relation: 'unverified', method: 'none' },
    });
  });

  it('honors an exact intentional readiness status for a static tombstone target', async () => {
    const client = github((_method, path) => {
      if (path.includes('/deployments?')) return [];
      throw new Error(`unexpected path ${path}`);
    });
    const fetchImpl = vi.fn(async () =>
      new Response('{"error":410}', { status: 410, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

    const result = await resolveQaTarget(
      client,
      pull,
      qaConfig({
        static_url: 'https://staging.example.test/retired',
        readiness_path: '/retired',
        readiness_statuses: [410],
        preview_fallback: false,
      }),
      { fetchImpl, now: () => NOW },
    );

    expect(result.target).toMatchObject({
      kind: 'staging-static',
      url: 'https://staging.example.test/retired',
      stability: 'unchecked',
    });
  });

  it('observes an accepted redirect status without following its Location', async () => {
    const client = github((_method, path) => {
      if (path.includes('/deployments?')) return [];
      throw new Error(`unexpected path ${path}`);
    });
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      return new Response(null, {
        status: 302,
        headers: { location: 'https://outside.example.test/login' },
      });
    }) as unknown as typeof fetch;

    const result = await resolveQaTarget(
      client,
      pull,
      qaConfig({
        static_url: 'https://staging.example.test/app',
        readiness_path: '/redirecting-readiness',
        readiness_statuses: [302],
        preview_fallback: false,
      }),
      { fetchImpl, now: () => NOW },
    );

    expect(result.target).toMatchObject({
      kind: 'staging-static',
      url: 'https://staging.example.test/app',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects URLs outside the trusted origin allowlist before fetching them', async () => {
    const client = github((_method, path) => {
      if (path.includes('/deployments?')) return [];
      throw new Error(`unexpected path ${path}`);
    });
    const fetchImpl = healthyFetch();

    const result = await resolveQaTarget(
      client,
      pull,
      qaConfig({ static_url: 'https://attacker.example/', preview_fallback: false }),
      { fetchImpl, now: () => NOW },
    );

    expect(result).toMatchObject({ target: null, status: 'timed_out' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.diagnostics).toContain(
      'static target URL was invalid or outside the trusted origin allowlist',
    );
  });

  it('rejects an explicit untrusted origin immediately without entering the poll loop', async () => {
    const client = github(() => { throw new Error('should not query GitHub'); });
    const fetchImpl = healthyFetch();
    const sleep = vi.fn();
    const result = await resolveQaTarget(client, pull, qaConfig({ wait_seconds: 900 }), {
      explicitUrl: 'https://attacker.example/',
      fetchImpl,
      sleep,
      now: () => NOW,
    });
    expect(result).toEqual({
      target: null,
      status: 'timed_out',
      diagnostics: ['explicit target URL was invalid or outside the trusted origin allowlist'],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('accepts an allowlisted HTTP target on Node-bracketed IPv6 loopback', async () => {
    const client = github(() => { throw new Error('should not query GitHub'); });
    const config = qaConfig({ wait_seconds: 0 });
    config.sandbox.allowed_origins = ['http://[::1]:4173'];
    const fetchImpl = healthyFetch();

    const result = await resolveQaTarget(client, pull, config, {
      explicitUrl: 'http://[::1]:4173/app',
      fetchImpl,
      now: () => NOW,
    });

    expect(result.target).toMatchObject({
      kind: 'staging-static',
      url: 'http://[::1]:4173/app',
      allowed_origin: 'http://[::1]:4173',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a manually injected HTTPS IP target before fetching it', async () => {
    const client = github(() => { throw new Error('should not query GitHub'); });
    const config = qaConfig({ wait_seconds: 0 });
    config.sandbox.allowed_origins = ['https://203.0.113.10'];
    const fetchImpl = healthyFetch();

    const result = await resolveQaTarget(client, pull, config, {
      explicitUrl: 'https://203.0.113.10/app',
      fetchImpl,
      now: () => NOW,
    });

    expect(result).toEqual({
      target: null,
      status: 'timed_out',
      diagnostics: ['explicit target URL was invalid or outside the trusted origin allowlist'],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    'https://user:password@staging.example.test/',
    'https://staging.example.test/?protection-bypass=secret',
    'https://staging.example.test/#secret-fragment',
  ])('rejects a credential-bearing explicit target URL before fetching: %s', async (explicitUrl) => {
    const client = github(() => { throw new Error('should not query GitHub'); });
    const fetchImpl = healthyFetch();
    const sleep = vi.fn();
    const result = await resolveQaTarget(client, pull, qaConfig({ wait_seconds: 900 }), {
      explicitUrl,
      fetchImpl,
      sleep,
      now: () => NOW,
    });

    expect(result).toEqual({
      target: null,
      status: 'timed_out',
      diagnostics: ['explicit target URL was invalid or outside the trusted origin allowlist'],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not use an older successful status after the deployment failed', async () => {
    const client = github((_method, path) => {
      if (path.includes('/deployments?') && path.includes('environment=staging')) {
        return [deployment(50, MERGE_SHA)];
      }
      if (path.includes('/deployments/50/statuses?')) {
        return [
          deploymentStatus(51, 'success', 'https://staging.example.test/', '2026-08-18T10:00:00Z'),
          deploymentStatus(52, 'failure', null, '2026-08-18T11:00:00Z'),
        ];
      }
      if (path.includes('/deployments?') && path.includes(`sha=${HEAD_SHA}`)) return [];
      throw new Error(`unexpected path ${path}`);
    });
    const fetchImpl = healthyFetch();

    const result = await resolveQaTarget(client, pull, qaConfig(), {
      fetchImpl,
      now: () => NOW,
    });

    expect(result).toMatchObject({ target: null, status: 'timed_out' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not attest an older staging record after the shared environment rolls back', async () => {
    const rolledBackSha = 'e'.repeat(40);
    const client = github((_method, path) => {
      if (path.includes('/deployments?') && path.includes('environment=staging')) {
        return [
          deployment(71, rolledBackSha, 'staging', '2026-08-18T11:30:00Z'),
          deployment(70, MERGE_SHA, 'staging', '2026-08-18T11:00:00Z'),
        ];
      }
      if (path.includes('/deployments/71/statuses?')) {
        return [deploymentStatus(81, 'success', 'https://staging.example.test/')];
      }
      if (path.includes('/deployments/70/statuses?')) {
        throw new Error('an older shared staging record must not be inspected');
      }
      if (path.includes(`/compare/${MERGE_SHA}...${rolledBackSha}`)) {
        return { status: 'behind', ahead_by: 0, total_commits: 0, commits: [] };
      }
      if (path.includes('/deployments?') && path.includes(`sha=${HEAD_SHA}`)) return [];
      throw new Error(`unexpected path ${path}`);
    });
    const fetchImpl = healthyFetch();

    const result = await resolveQaTarget(client, pull, qaConfig(), {
      fetchImpl,
      now: () => NOW,
    });

    expect(result).toMatchObject({ target: null, status: 'timed_out' });
    expect(client.request).not.toHaveBeenCalledWith(
      'GET',
      expect.stringContaining('/deployments/70/statuses'),
    );
  });

  it('honors cancellation before deployment or secret-bearing work starts', async () => {
    const client = github(() => {
      throw new Error('should not be called');
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      resolveQaTarget(client, pull, qaConfig(), { signal: controller.signal, now: () => NOW }),
    ).resolves.toEqual({ target: null, status: 'cancelled', diagnostics: [] });
    expect(client.request).not.toHaveBeenCalled();
  });

  it('fails closed instead of polling forever for an invalid wait duration', async () => {
    const client = github((_method, path) => {
      if (path.includes('/deployments?')) return [];
      throw new Error(`unexpected path ${path}`);
    });

    const result = await resolveQaTarget(
      client,
      pull,
      qaConfig({ wait_seconds: Number.NaN, preview_fallback: false }),
      { now: () => NOW },
    );

    expect(result).toMatchObject({ target: null, status: 'timed_out' });
  });

  it('does not reinterpret a staging deployment as an exact-head preview', async () => {
    const client = github((_method, path) => {
      if (path.includes('/deployments?') && path.includes('environment=staging')) return [];
      if (path.includes('/deployments?') && path.includes(`sha=${HEAD_SHA}`)) {
        return [deployment(60, HEAD_SHA, 'staging')];
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await resolveQaTarget(client, pull, qaConfig(), {
      fetchImpl: healthyFetch(),
      now: () => NOW,
    });

    expect(result).toMatchObject({ target: null, status: 'timed_out' });
    expect(client.request).not.toHaveBeenCalledWith(
      'GET',
      expect.stringContaining('/deployments/60/statuses'),
    );
  });

  it('does not reinterpret the dedicated staging deployment environment as a preview', async () => {
    const client = github((_method, path) => {
      if (path.includes('/deployments?') && path.includes('environment=web-staging')) return [];
      if (path.includes('/deployments?') && path.includes(`sha=${HEAD_SHA}`)) {
        return [deployment(62, HEAD_SHA, 'web-staging')];
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await resolveQaTarget(
      client,
      pull,
      qaConfig({ deployment_environment: 'web-staging' }),
      { fetchImpl: healthyFetch(), now: () => NOW },
    );

    expect(result).toMatchObject({ target: null, status: 'timed_out' });
    expect(client.request).not.toHaveBeenCalledWith(
      'GET',
      expect.stringContaining('/deployments/62/statuses'),
    );
  });

  it('does not reinterpret a non-transient production deployment as a preview', async () => {
    const client = github((_method, path) => {
      if (path.includes('/deployments?') && path.includes('environment=staging')) return [];
      if (path.includes('/deployments?') && path.includes(`sha=${HEAD_SHA}`)) {
        return [{ ...deployment(61, HEAD_SHA, 'production'), transient_environment: false }];
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await resolveQaTarget(client, pull, qaConfig(), {
      fetchImpl: healthyFetch(),
      now: () => NOW,
    });

    expect(result).toMatchObject({ target: null, status: 'timed_out' });
    expect(client.request).not.toHaveBeenCalledWith(
      'GET',
      expect.stringContaining('/deployments/61/statuses'),
    );
  });
});

describe('recheckQaTarget', () => {
  const pull = { number: 42, mergeSha: MERGE_SHA, headSha: HEAD_SHA };

  function protectedTargetFetch(observedSha: () => string): typeof fetch {
    return vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/version')) {
        return new Response(JSON.stringify({ sha: observedSha() }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('edge protection', { status: 403 });
    }) as unknown as typeof fetch;
  }

  it('rechecks a dedicated deployment environment instead of the staging tier name', async () => {
    const client = github((_method, path) => {
      if (path.includes('/deployments?') && path.includes('environment=web-staging')) {
        return [deployment(90, MERGE_SHA, 'web-staging')];
      }
      if (path.includes('/deployments/90/statuses?')) return [deploymentStatus(91)];
      throw new Error(`unexpected path ${path}`);
    });
    const config = qaConfig({ deployment_environment: 'web-staging' });
    const resolved = await resolveQaTarget(client, pull, config, {
      fetchImpl: healthyFetch(),
      now: () => NOW,
    });
    expect(resolved.target).not.toBeNull();
    client.request.mockClear();

    const current = await recheckQaTarget(client, pull, config, resolved.target!, {
      fetchImpl: healthyFetch(),
      now: () => NOW + 1_000,
    });

    expect(current).toMatchObject({ stable: true, current: { environment: 'web-staging' } });
    expect(client.request).toHaveBeenCalledWith(
      'GET',
      expect.stringContaining('environment=web-staging'),
    );
  });

  async function resolveProtectedExplicitTarget(
    client: DeploymentGitHubApi,
    fetchImpl: typeof fetch,
  ) {
    const config = qaConfig({
      commit_probe: { path: '/version', json_pointer: '/sha' },
    });
    const resolved = await resolveQaTarget(client, pull, config, {
      explicitUrl: 'https://staging.example.test/app',
      allowUnreadyExplicit: true,
      fetchImpl,
      now: () => NOW,
    });
    expect(resolved.target).toMatchObject({
      kind: 'staging-static',
      revision: { observed_sha: MERGE_SHA, relation: 'exact' },
    });
    return { config, target: resolved.target! };
  }

  it('preserves explicit readiness delegation while rechecking the commit probe', async () => {
    const client = github(() => {
      throw new Error('an exact revision should not query GitHub');
    });
    const fetchImpl = protectedTargetFetch(() => MERGE_SHA);
    const { config, target } = await resolveProtectedExplicitTarget(client, fetchImpl);

    const current = await recheckQaTarget(client, pull, config, target, {
      allowUnreadyExplicit: true,
      fetchImpl,
      now: () => NOW + 1_000,
    });

    expect(current).toMatchObject({
      stable: true,
      current: { revision: { observed_sha: MERGE_SHA, relation: 'exact' } },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetchImpl).mock.calls.every(([input]) => String(input).endsWith('/version')))
      .toBe(true);
  });

  it('still rejects revision drift when explicit readiness is delegated', async () => {
    let observedSha = MERGE_SHA;
    const client = github((_method, path) => {
      expect(path).toContain(`/compare/${MERGE_SHA}...${DEPLOYED_SHA}`);
      return { status: 'behind', ahead_by: 0, total_commits: 0, commits: [] };
    });
    const fetchImpl = protectedTargetFetch(() => observedSha);
    const { config, target } = await resolveProtectedExplicitTarget(client, fetchImpl);
    observedSha = DEPLOYED_SHA;

    const current = await recheckQaTarget(client, pull, config, target, {
      allowUnreadyExplicit: true,
      fetchImpl,
      now: () => NOW + 1_000,
    });

    expect(current).toEqual({
      stable: false,
      current: null,
      diagnostics: [
        'explicit revision-pinned target delegated readiness to the authoritative browser run',
        'static target revision is known not to contain the merge commit',
      ],
    });
  });

  it('still rejects origin drift when explicit readiness is delegated', async () => {
    const client = github(() => {
      throw new Error('an exact revision should not query GitHub');
    });
    const fetchImpl = protectedTargetFetch(() => MERGE_SHA);
    const { config, target } = await resolveProtectedExplicitTarget(client, fetchImpl);
    vi.mocked(fetchImpl).mockClear();

    const current = await recheckQaTarget(
      client,
      pull,
      config,
      { ...target, url: 'https://attacker.example/app' },
      {
        allowUnreadyExplicit: true,
        fetchImpl,
        now: () => NOW + 1_000,
      },
    );

    expect(current).toEqual({
      stable: false,
      current: null,
      diagnostics: ['static target URL was invalid or outside the trusted origin allowlist'],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
