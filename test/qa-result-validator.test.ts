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
    outcome: 'blocked',
    conclusion: 'failure',
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
  it('rejects a green result without a target, plan, and executed checkpoints', () => {
    const invalid = persistedResult();
    invalid.outcome = 'passed';
    invalid.conclusion = 'success';
    invalid.target = null;
    expect(isQaRunResult(invalid)).toBe(false);
  });

  it('accepts trusted no-surface preflight results before target resolution', () => {
    const preflight = persistedResult();
    preflight.outcome = 'no_testable_surface';
    preflight.conclusion = 'success';
    preflight.target = null;
    preflight.plan = {
      schema_version: 1,
      impact_assessment: 'Only documentation changed.',
      testability: 'no_testable_surface',
      no_testable_surface_reason: 'No browser-visible files changed.',
      surfaces: [],
      scenarios: [],
      risk_notes: [],
      blind_spots: [],
    };
    preflight.attempts = [];
    preflight.issues = [];
    preflight.artifacts = [];

    expect(isQaRunResult(preflight)).toBe(true);

    const withStableTarget = structuredClone(preflight);
    withStableTarget.target = persistedResult().target;
    expect(isQaRunResult(withStableTarget)).toBe(true);

    const unchecked = structuredClone(withStableTarget);
    unchecked.target!.stability = 'unchecked';
    expect(isQaRunResult(unchecked)).toBe(false);

    const cleanupFailed = structuredClone(preflight);
    cleanupFailed.cleanup = { status: 'failed', summary: 'Cleanup failed.', error: 'reset failed' };
    expect(isQaRunResult(cleanupFailed)).toBe(false);
  });

  it('requires a reproduced verified finding for a product-issue verdict', () => {
    const empty = persistedResult();
    empty.outcome = 'product_issue';
    empty.conclusion = 'failure';
    empty.target = null;
    expect(isQaRunResult(empty)).toBe(false);

    const valid = persistedResult();
    valid.outcome = 'product_issue';
    valid.conclusion = 'failure';
    valid.plan = {
      schema_version: 1, impact_assessment: 'Changed control.', testability: 'testable', no_testable_surface_reason: null,
      surfaces: [], risk_notes: [], blind_spots: [], scenarios: [{
        id: 'check', title: 'Check', rationale: 'Changed control.',
        viewport: { kind: 'desktop', width: 1280, height: 720, justification: 'Default.' },
        preconditions: [], seeded_state: [], allowed_mutations: ['none'], cleanup_expectations: [], checkpoints: [{
          id: 'visible', description: 'Visible', expected: 'Visible',
          assertion: { kind: 'visible', locator: { by: 'role', value: 'button', name: 'Send', exact: true, nth: null }, url_contains: null },
        }],
      }],
    };
    valid.attempts = [1, 2].map((attempt) => ({
      scenario_id: 'check', attempt: attempt as 1 | 2, status: 'failed' as const,
      started_at: valid.started_at, duration_ms: 1, operations: [],
      checkpoints: [{ checkpoint_id: 'visible', status: 'failed' as const, expected: 'Visible', observed: 'Missing' }],
      observations: [], evidence_artifact_ids: [],
    }));
    valid.issues = [{
      id: 'verified-1', scenario_id: 'check', checkpoint_id: 'visible', severity: 'P1',
      classification: 'verified', reproducible: true, title: 'Control missing', expected: 'Visible', actual: 'Missing',
      attempt_numbers: [1, 2],
    }];

    expect(isQaRunResult(valid)).toBe(true);

    const advisoryOnly = structuredClone(valid);
    advisoryOnly.issues[0]!.classification = 'advisory';
    expect(isQaRunResult(advisoryOnly)).toBe(false);

    const conservative = structuredClone(valid);
    conservative.base_resolution = 'conservative';
    expect(isQaRunResult(conservative)).toBe(false);

    const ineligible = structuredClone(valid);
    ineligible.target!.verdict_eligible = false;
    expect(isQaRunResult(ineligible)).toBe(false);

    const unverified = structuredClone(valid);
    unverified.target!.revision = {
      verified_against: 'none', expected_sha: null, observed_sha: null, relation: 'unverified',
      method: 'none', contains_merge_sha: null, additional_commits: [], additional_commits_truncated: false,
    };
    expect(isQaRunResult(unverified)).toBe(false);

    const wrongMerge = structuredClone(valid);
    wrongMerge.target!.revision.expected_sha = 'd'.repeat(40);
    wrongMerge.target!.revision.observed_sha = 'd'.repeat(40);
    expect(isQaRunResult(wrongMerge)).toBe(false);

    const mixed = structuredClone(valid);
    mixed.issues.push({ ...mixed.issues[0]!, id: 'advisory-2', classification: 'advisory' });
    expect(isQaRunResult(mixed)).toBe(true);

    const retainedAfterInfrastructureFailure = structuredClone(valid);
    retainedAfterInfrastructureFailure.outcome = 'infrastructure_error';
    expect(isQaRunResult(retainedAfterInfrastructureFailure)).toBe(true);

    const unsupportedRetainedIssue = structuredClone(retainedAfterInfrastructureFailure);
    unsupportedRetainedIssue.attempts = [];
    unsupportedRetainedIssue.issues[0]!.reproducible = false;
    unsupportedRetainedIssue.issues[0]!.attempt_numbers = [1];
    expect(isQaRunResult(unsupportedRetainedIssue)).toBe(false);
  });
  it('accepts a clean passed run on an advisory target only with complete known evidence', () => {
    const valid = persistedResult();
    valid.outcome = 'passed';
    valid.conclusion = 'success';
    valid.target!.verdict_eligible = false;
    valid.plan = {
      schema_version: 1,
      impact_assessment: 'The control changed.',
      testability: 'testable',
      no_testable_surface_reason: null,
      surfaces: ['composer'],
      scenarios: [{
        id: 'composer-check', title: 'Composer remains visible', rationale: 'The control changed.',
        viewport: { kind: 'desktop', width: 1280, height: 720, justification: 'Default viewport.' },
        preconditions: [], seeded_state: [],
        checkpoints: [{
          id: 'composer-visible', description: 'Composer is visible', expected: 'Composer is visible',
          assertion: { kind: 'visible', locator: { by: 'role', value: 'textbox', name: 'Composer', exact: true, nth: null }, url_contains: null },
        }],
        allowed_mutations: ['none'], cleanup_expectations: [],
      }],
      risk_notes: [], blind_spots: [],
    };
    valid.attempts = [{
      scenario_id: 'composer-check', attempt: 1, status: 'passed', started_at: valid.started_at, duration_ms: 1,
      operations: [], checkpoints: [{ checkpoint_id: 'composer-visible', status: 'passed', expected: 'Composer is visible', observed: 'Composer is visible' }],
      observations: [], evidence_artifact_ids: [],
    }];

    expect(isQaRunResult(valid)).toBe(true);

    const empty = structuredClone(valid);
    empty.attempts = [];
    expect(isQaRunResult(empty)).toBe(false);

    const tampered = structuredClone(valid);
    tampered.attempts[0]!.scenario_id = 'unknown-scenario';
    expect(isQaRunResult(tampered)).toBe(false);

    const failedFinalCheckpoint = structuredClone(valid);
    failedFinalCheckpoint.attempts[0]!.checkpoints[0]!.status = 'failed';
    expect(isQaRunResult(failedFinalCheckpoint)).toBe(false);

    const extraCheckpoint = structuredClone(valid);
    extraCheckpoint.attempts[0]!.checkpoints.push({ checkpoint_id: 'unknown-check', status: 'passed', expected: 'Unknown', observed: 'Unknown' });
    expect(isQaRunResult(extraCheckpoint)).toBe(false);

    const expectedMismatch = structuredClone(valid);
    expectedMismatch.attempts[0]!.checkpoints[0]!.expected = 'Tampered expectation';
    expect(isQaRunResult(expectedMismatch)).toBe(false);

    const duplicateScenario = structuredClone(valid);
    duplicateScenario.plan!.scenarios.push(structuredClone(duplicateScenario.plan!.scenarios[0]!));
    expect(isQaRunResult(duplicateScenario)).toBe(false);

    const duplicateCheckpoint = structuredClone(valid);
    duplicateCheckpoint.plan!.scenarios[0]!.checkpoints.push(structuredClone(duplicateCheckpoint.plan!.scenarios[0]!.checkpoints[0]!));
    expect(isQaRunResult(duplicateCheckpoint)).toBe(false);

    for (const malformed of [null, 7]) {
      const malformedScenario = structuredClone(valid) as unknown as { plan: { scenarios: unknown[] } };
      malformedScenario.plan.scenarios = [malformed];
      expect(() => isQaRunResult(malformedScenario)).not.toThrow();
      expect(isQaRunResult(malformedScenario)).toBe(false);

      const malformedCheckpoint = structuredClone(valid) as unknown as { plan: { scenarios: Array<{ checkpoints: unknown[] }> } };
      malformedCheckpoint.plan.scenarios[0]!.checkpoints = [malformed];
      expect(() => isQaRunResult(malformedCheckpoint)).not.toThrow();
      expect(isQaRunResult(malformedCheckpoint)).toBe(false);
    }

    for (const mutate of [
      (candidate: QaRunResult) => { candidate.cleanup.status = 'failed'; },
      (candidate: QaRunResult) => { candidate.target!.stability = 'drifted'; },
    ]) {
      const untrustworthy = structuredClone(valid);
      mutate(untrustworthy);
      expect(isQaRunResult(untrustworthy)).toBe(false);
    }
  });

  it('rejects complete final checkpoints when the final scenario attempt failed', () => {
    const valid = persistedResult();
    valid.outcome = 'passed';
    valid.conclusion = 'success';
    valid.plan = {
      schema_version: 1, impact_assessment: 'Changed control.', testability: 'testable', no_testable_surface_reason: null,
      surfaces: [], risk_notes: [], blind_spots: [], scenarios: [{
        id: 'check', title: 'Check', rationale: 'Changed control.', viewport: { kind: 'desktop', width: 1280, height: 720, justification: 'Default.' },
        preconditions: [], seeded_state: [], allowed_mutations: ['none'], cleanup_expectations: [], checkpoints: [{
          id: 'visible', description: 'Visible', expected: 'Visible', assertion: { kind: 'visible', locator: { by: 'role', value: 'button', name: 'Send', exact: true, nth: null }, url_contains: null },
        }],
      }],
    };
    valid.attempts = [{
      scenario_id: 'check', attempt: 1, status: 'failed', started_at: valid.started_at, duration_ms: 1,
      operations: [], checkpoints: [{ checkpoint_id: 'visible', status: 'passed', expected: 'Visible', observed: 'Visible' }],
      observations: [], evidence_artifact_ids: [],
    }];

    expect(isQaRunResult(valid)).toBe(false);
  });

  it('requires sequenced, complete evidence for flaky and reproducible advisory evidence', () => {
    const base = persistedResult();
    base.outcome = 'passed'; base.conclusion = 'success';
    base.plan = {
      schema_version: 1, impact_assessment: 'Changed control.', testability: 'testable', no_testable_surface_reason: null,
      surfaces: [], risk_notes: [], blind_spots: [], scenarios: [{
        id: 'check', title: 'Check', rationale: 'Changed control.', viewport: { kind: 'desktop', width: 1280, height: 720, justification: 'Default.' },
        preconditions: [], seeded_state: [], allowed_mutations: ['none'], cleanup_expectations: [], checkpoints: [{
          id: 'visible', description: 'Visible', expected: 'Visible', assertion: { kind: 'visible', locator: { by: 'role', value: 'button', name: 'Send', exact: true, nth: null }, url_contains: null },
        }],
      }],
    };
    const first = { scenario_id: 'check', attempt: 1 as const, status: 'failed' as const, started_at: base.started_at, duration_ms: 1, operations: [], checkpoints: [{ checkpoint_id: 'visible', status: 'failed' as const, expected: 'Visible', observed: 'Missing' }], observations: [], evidence_artifact_ids: [] };
    const second = { ...first, attempt: 2 as const, status: 'passed' as const, checkpoints: [{ ...first.checkpoints[0], status: 'passed' as const, observed: 'Visible' }] };
    const flaky = structuredClone(base);
    flaky.outcome = 'flaky'; flaky.attempts = [first, second];
    expect(isQaRunResult(flaky)).toBe(true);
    const secondOnly = structuredClone(flaky); secondOnly.attempts = [second];
    expect(isQaRunResult(secondOnly)).toBe(false);
    const empty = structuredClone(flaky); empty.attempts = [];
    expect(isQaRunResult(empty)).toBe(false);

    const advisory = structuredClone(flaky);
    const secondFailure = { ...first, attempt: 2 as const, checkpoints: [{ ...first.checkpoints[0], observed: 'missing   control' }] };
    advisory.outcome = 'advisory'; advisory.attempts = [{ ...first, checkpoints: [{ ...first.checkpoints[0], observed: 'Missing control' }] }, secondFailure];
    advisory.issues = [{ id: 'advisory-1', scenario_id: 'check', checkpoint_id: 'visible', severity: 'P2', classification: 'advisory', reproducible: true, title: 'Limited', expected: 'Visible', actual: 'missing   control', attempt_numbers: [1, 2] }];
    expect(isQaRunResult(advisory)).toBe(true);

    const variants: Array<(candidate: QaRunResult) => void> = [
      (candidate) => { candidate.attempts = [candidate.attempts[0]!]; },
      (candidate) => { candidate.issues[0]!.reproducible = false; },
      (candidate) => { candidate.issues[0]!.attempt_numbers = [1]; },
      (candidate) => { candidate.attempts[1]!.checkpoints[0]!.status = 'passed'; },
      (candidate) => { candidate.attempts[1]!.checkpoints[0]!.observed = 'Different observation'; },
      (candidate) => { candidate.issues[0]!.actual = 'Different issue actual'; },
      (candidate) => { candidate.issues[0]!.expected = 'Different issue expected'; },
      (candidate) => { candidate.attempts[1]!.status = 'blocked'; },
      (candidate) => { candidate.attempts[1]!.status = 'infrastructure_error'; },
    ];
    for (const mutate of variants) {
      const invalid = structuredClone(advisory);
      mutate(invalid);
      expect(isQaRunResult(invalid)).toBe(false);
    }

    const targetIneligible = structuredClone(advisory);
    targetIneligible.target!.verdict_eligible = false;
    expect(isQaRunResult(targetIneligible)).toBe(true);
    const contradictoryProof = structuredClone(targetIneligible);
    contradictoryProof.target!.revision.expected_sha = 'd'.repeat(40);
    contradictoryProof.target!.revision.observed_sha = 'd'.repeat(40);
    contradictoryProof.target!.revision.contains_merge_sha = false;
    expect(isQaRunResult(contradictoryProof)).toBe(false);
    const policyLimited = structuredClone(advisory);
    policyLimited.base_resolution = 'conservative';
    expect(isQaRunResult(policyLimited)).toBe(false);
    policyLimited.target!.verdict_eligible = false;
    expect(isQaRunResult(policyLimited)).toBe(true);
  });
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
