import { describe, expect, it } from 'vitest';

import { isQaRunResult } from '../src/qa/result-validator.js';
import { QA_RUN_RESULT_JSON_SCHEMA } from '../src/qa/schema.js';
import type { QaRunResult } from '../src/qa/types.js';

function persistedResult(): QaRunResult {
  return {
    schema_version: 1,
    run_id: 'owner-repo-42-1',
    repository: 'owner/repo',
    pr_number: 42,
    merge_sha: 'a'.repeat(40),
    base_resolution: 'exact',
    source_base_sha: 'b'.repeat(40),
    policy_base_shas: ['b'.repeat(40)],
    started_at: '2026-08-19T00:00:00.000Z',
    completed_at: '2026-08-19T00:00:01.000Z',
    duration_ms: 1_000,
    outcome: 'passed',
    conclusion: 'success',
    target: {
      kind: 'staging-deployment',
      url: 'https://staging.example.test/',
      allowed_origin: 'https://staging.example.test',
      environment: 'staging',
      deployment_id: 1,
      deployment_status_id: 2,
      revision: {
        verified_against: 'merge',
        expected_sha: 'a'.repeat(40),
        observed_sha: 'a'.repeat(40),
        relation: 'exact',
        method: 'deployment-sha',
        contains_merge_sha: true,
        additional_commits: [],
        additional_commits_truncated: false,
      },
      stability: 'stable',
      verdict_eligible: true,
      resolved_at: '2026-08-19T00:00:00.000Z',
      ready_at: '2026-08-19T00:00:01.000Z',
    },
    plan: null,
    attempts: [],
    issues: [],
    cleanup: { status: 'not_required', summary: 'No browser state.', error: null },
    artifacts: [{
      id: 'artifact-1',
      kind: 'video',
      path: 'scenario.webm',
      sanitized: true,
      sha256: 'c'.repeat(64),
      retention_days: 14,
      upload: {
        name: 'juror-qa-evidence',
        url: 'https://github.com/owner/repo/actions/runs/7/artifacts/8',
      },
    }],
    runtime: {
      model_id: 'gpt-5.5',
      model_version: null,
      browser_name: 'chromium',
      browser_version: '140',
    },
    cost: { usage: null, usd: null, source: 'unknown' },
    warnings: [],
  };
}

describe('persisted QA result URL validation', () => {
  it('accepts credential-free HTTP and HTTPS target and upload URLs', () => {
    const https = persistedResult();
    expect(isQaRunResult(https)).toBe(true);

    const http = persistedResult();
    http.target!.url = 'http://localhost:4173/a(b)[c]';
    http.target!.allowed_origin = 'http://localhost:4173';
    http.artifacts[0]!.upload!.url = 'http://localhost:4173/artifact';
    expect(isQaRunResult(http)).toBe(true);
  });

  it.each([
    'file:///tmp/evidence',
    'javascript:alert(1)',
    'data:text/plain,evidence',
    'ftp://example.test/evidence',
  ])('rejects a non-HTTP target or upload URL: %s', (url) => {
    const target = persistedResult();
    target.target!.url = url;
    expect(isQaRunResult(target)).toBe(false);

    const upload = persistedResult();
    upload.artifacts[0]!.upload!.url = url;
    expect(isQaRunResult(upload)).toBe(false);
  });

  it('rejects credentials in target URLs, allowed origins, and upload URLs', () => {
    const target = persistedResult();
    target.target!.url = 'https://user:password@staging.example.test/';
    expect(isQaRunResult(target)).toBe(false);

    const origin = persistedResult();
    origin.target!.allowed_origin = 'https://user@staging.example.test';
    expect(isQaRunResult(origin)).toBe(false);

    const upload = persistedResult();
    upload.artifacts[0]!.upload!.url = 'https://token@github.com/owner/repo/artifact';
    expect(isQaRunResult(upload)).toBe(false);
  });

  it('publishes the HTTP-only, credential-free URL constraint in the JSON schema', () => {
    interface UrlSchema {
      format: string;
      pattern: string;
      not: { pattern: string };
    }
    const definitions = QA_RUN_RESULT_JSON_SCHEMA.$defs!;
    const target = definitions['target'] as {
      properties: { url: UrlSchema; allowed_origin: UrlSchema };
    };
    const artifact = definitions['artifact'] as {
      properties: {
        upload: { oneOf: [unknown, { properties: { url: UrlSchema } }] };
      };
    };
    const targetUrl = target.properties.url;
    const originUrl = target.properties.allowed_origin;
    const uploadUrl = artifact.properties.upload.oneOf[1].properties.url;

    for (const schema of [targetUrl, originUrl, uploadUrl]) {
      expect(schema.format).toBe('uri');
      expect(schema.pattern).toContain('[Hh][Tt][Tt][Pp]');
      expect(schema.not.pattern).toContain('@');
    }
  });
});
