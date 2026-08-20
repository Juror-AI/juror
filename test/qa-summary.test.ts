import { describe, expect, it } from 'vitest';

import type { QaRunResult } from '../src/qa/types.js';
import {
  QA_STICKY_MARKER,
  renderQaMarkdownLink,
  renderQaPending,
  renderQaSummary,
} from '../src/render/qa-summary.js';

function qaResult(overrides: Partial<QaRunResult> = {}): QaRunResult {
  return {
    schema_version: 1,
    run_id: 'qa-owner-repo-42-abc123',
    repository: 'owner/repo',
    pr_number: 42,
    merge_sha: '0123456789abcdef0123456789abcdef01234567',
    base_resolution: 'exact',
    source_base_sha: 'a'.repeat(40),
    policy_base_shas: ['a'.repeat(40)],
    started_at: '2026-08-18T10:00:00.000Z',
    completed_at: '2026-08-18T10:00:12.400Z',
    duration_ms: 12_400,
    outcome: 'product_issue',
    conclusion: 'failure',
    target: {
      kind: 'staging-deployment',
      url: 'https://staging.example.test/',
      allowed_origin: 'https://staging.example.test',
      environment: 'staging',
      deployment_id: 100,
      deployment_status_id: 101,
      revision: {
        verified_against: 'merge',
        expected_sha: '0123456789abcdef0123456789abcdef01234567',
        observed_sha: '0123456789abcdef0123456789abcdef01234567',
        relation: 'exact',
        method: 'deployment-sha',
        contains_merge_sha: true,
        additional_commits: [],
        additional_commits_truncated: false,
      },
      stability: 'stable',
      verdict_eligible: true,
      resolved_at: '2026-08-18T10:00:00.000Z',
      ready_at: '2026-08-18T10:00:01.000Z',
    },
    plan: {
      schema_version: 1,
      impact_assessment: 'The composer toolbar changed at narrow widths.',
      testability: 'testable',
      no_testable_surface_reason: null,
      surfaces: ['chat composer'],
      scenarios: [{
        id: 'narrow-composer',
        title: 'Narrow composer remains usable',
        rationale: 'The PR changes responsive toolbar behavior.',
        viewport: {
          kind: 'mobile',
          width: 390,
          height: 844,
          justification: 'The affected breakpoint is mobile-sized.',
        },
        preconditions: ['Signed in'],
        seeded_state: [],
        checkpoints: [
          { id: 'toolbar-visible', description: 'Toolbar is visible', expected: 'Toolbar controls remain visible.' },
          { id: 'send-visible', description: 'Send is visible', expected: 'Send remains reachable.' },
        ],
        allowed_mutations: ['none'],
        cleanup_expectations: [],
      }],
      risk_notes: [],
      blind_spots: [],
    },
    attempts: [{
      scenario_id: 'narrow-composer',
      attempt: 1,
      status: 'failed',
      started_at: '2026-08-18T10:00:02.000Z',
      duration_ms: 9_000,
      operations: [],
      checkpoints: [
        {
          checkpoint_id: 'toolbar-visible',
          status: 'passed',
          expected: 'Toolbar controls remain visible.',
          observed: 'Toolbar controls were visible.',
        },
        {
          checkpoint_id: 'send-visible',
          status: 'failed',
          expected: 'Send remains reachable.',
          observed: 'Send was clipped outside the composer.',
        },
      ],
      observations: [],
      evidence_artifact_ids: ['video-1', 'trace-1'],
    }],
    issues: [{
      id: 'issue-1',
      scenario_id: 'narrow-composer',
      checkpoint_id: 'send-visible',
      severity: 'P1',
      classification: 'verified',
      reproducible: true,
      title: 'Send control is clipped',
      expected: 'Send remains reachable.',
      actual: 'Send was clipped outside the composer.',
      attempt_numbers: [1, 2],
    }],
    cleanup: { status: 'passed', summary: 'Dedicated tenant reset.', error: null },
    artifacts: [
      {
        id: 'video-1',
        kind: 'video',
        path: 'scenarios/narrow-composer/1/video.webm',
        sanitized: true,
        sha256: 'a'.repeat(64),
        retention_days: 14,
        upload: null,
      },
      {
        id: 'trace-1',
        kind: 'trace',
        path: 'scenarios/narrow-composer/1/trace.zip',
        sanitized: true,
        sha256: 'b'.repeat(64),
        retention_days: 14,
        upload: null,
      },
    ],
    runtime: {
      model_id: 'gpt-5.6-luna',
      model_version: null,
      browser_name: 'chromium',
      browser_version: '140.0.0',
    },
    cost: { usage: null, usd: null, source: 'unknown' },
    warnings: ['Staging included one later documentation commit.'],
    ...overrides,
  };
}

describe('renderQaSummary', () => {
  it('exact-redacts configured QA values from every rendered summary field', () => {
    const secret = 'qa-summary-secret';
    const base = qaResult();
    const result = qaResult({
      plan: base.plan ? {
        ...base.plan,
        impact_assessment: `Changed ${secret}`,
      } : null,
      issues: base.issues.map((issue) => ({
        ...issue,
        title: secret,
        expected: `Expected ${secret}`,
        actual: `Observed ${secret}`,
      })),
      warnings: [`Warning ${secret}`],
    });

    const markdown = renderQaSummary(result, {
      jobUrl: `https://example.test/${secret}`,
      secrets: [secret],
    });

    expect(markdown).not.toContain(secret);
  });

  it('renders a self-contained issue report with scenario and evidence details', () => {
    const markdown = renderQaSummary(qaResult(), {
      jobUrl: 'https://github.com/owner/repo/actions/runs/7',
      artifactUrl: 'https://github.com/owner/repo/actions/runs/7/artifacts/8',
    });

    expect(markdown.startsWith(`${QA_STICKY_MARKER}\n## ❌ Juror QA — Product issue found`)).toBe(true);
    expect(markdown).toContain('Juror reproduced a user-visible issue');
    expect(markdown).toContain('- Change scope: exact · source base `aaaaaaaaaaaa`');
    expect(markdown).not.toContain('https://staging.example.test');
    expect(markdown).toContain('`0123456789ab` (exact)');
    expect(markdown).toContain('verdict eligible yes');
    expect(markdown).toContain('### What changed\n\nThe composer toolbar changed at narrow widths.');
    expect(markdown).toContain('| Narrow composer remains usable | ❌ Failed | 1/2 | 1 |');
    expect(markdown).toContain('#### P1 · Send control is clipped');
    expect(markdown).toContain('**Reproduced:** attempts 1 and 2 · verified');
    expect(markdown).toContain('[View evidence & video](https://github.com/owner/repo/actions/runs/7/artifacts/8)');
    expect(markdown).toContain('[Open workflow run](https://github.com/owner/repo/actions/runs/7)');
    expect(markdown).toContain('2 artifacts · 1 video');
    expect(markdown).toContain('- Run: `qa-owner-repo-42-abc123`');
    expect(markdown).toContain('- Cleanup: passed — Dedicated tenant reset.');
    expect(markdown).toContain('Warnings (1)');
    expect(markdown).toContain('Staging included one later documentation commit.');
  });

  it('prominently marks conservative source ranges and advisory attribution', () => {
    const base = qaResult();
    const markdown = renderQaSummary(qaResult({
      base_resolution: 'conservative',
      source_base_sha: 'b'.repeat(40),
      policy_base_shas: ['c'.repeat(40), 'b'.repeat(40)],
      outcome: 'advisory',
      conclusion: 'success',
      target: { ...base.target!, verdict_eligible: false },
    }));

    expect(markdown).toContain('| conservative |');
    expect(markdown).toContain('2 policy-base candidates');
    expect(markdown).toContain('target, range, or policy limitations');
    expect(markdown).toContain('The tested range can include changes older than this PR, so findings are advisory.');
    expect(markdown).toContain('### Advisory findings');
    expect(markdown).not.toContain('### Product issues');
  });

  it('falls back to the job link and handles plural attempt/video counts', () => {
    const base = qaResult();
    const markdown = renderQaSummary(qaResult({
      outcome: 'flaky',
      conclusion: 'success',
      attempts: [
        ...base.attempts,
        {
          ...base.attempts[0]!,
          attempt: 2,
          status: 'passed',
          checkpoints: base.attempts[0]!.checkpoints.map((checkpoint) => ({
            ...checkpoint,
            status: 'passed' as const,
            observed: checkpoint.expected,
          })),
        },
      ],
      artifacts: [
        ...base.artifacts,
        { ...base.artifacts[0]!, id: 'video-2', path: 'scenarios/narrow-composer/2/video.webm' },
      ],
      issues: [],
      warnings: [],
    }), { jobUrl: 'https://github.com/owner/repo/actions/runs/7' });

    expect(markdown).toContain('## ⚠️ Juror QA — Passed on retry');
    expect(markdown).toContain('[Open workflow run](https://github.com/owner/repo/actions/runs/7)');
    expect(markdown).toContain('| Narrow composer remains usable | ✅ Passed | 2/2 | 2 |');
    expect(markdown).toContain('3 artifacts · 2 videos');
    expect(markdown).not.toContain('### Why QA stopped');
    expect(markdown).not.toContain('### Unresolved checks');
    expect(markdown).toContain('<details><summary>Retry history</summary>');
    expect(markdown).toContain('Send was clipped outside the composer.');
  });

  it('reports the configured video retention instead of a fixed duration', () => {
    const base = qaResult();
    const markdown = renderQaSummary(qaResult({
      artifacts: base.artifacts.map((artifact) => ({ ...artifact, retention_days: 3 })),
    }));

    expect(markdown).toContain('videos retained for 3 days');
    expect(markdown).not.toContain('videos retained for 14 days');
  });

  it('explains no-testable-surface results without inventing a scenario table', () => {
    const markdown = renderQaSummary(qaResult({
      outcome: 'no_testable_surface',
      conclusion: 'success',
      target: null,
      plan: {
        schema_version: 1,
        impact_assessment: 'Only a build-time type declaration changed.',
        testability: 'no_testable_surface',
        no_testable_surface_reason: 'No user-observable browser behavior changed.',
        surfaces: [],
        scenarios: [],
        risk_notes: [],
        blind_spots: [],
      },
      attempts: [],
      issues: [],
      artifacts: [],
      cleanup: { status: 'not_required', summary: 'Nothing mutated.', error: null },
      warnings: [],
    }));

    expect(markdown).toContain('## ➖ Juror QA — Browser QA not applicable');
    expect(markdown).toContain('Neutral — not scored. No browser was launched');
    expect(markdown).toContain('No user-observable browser behavior changed.');
    expect(markdown).toContain('| exact | not resolved | 0 | Not run |');
    expect(markdown).not.toContain('### What Juror tested');
    expect(markdown).toContain('- Attempts: 0 · artifacts: 0');
  });

  it('marks unverified static targets as advisory', () => {
    const base = qaResult();
    const markdown = renderQaSummary(qaResult({
      outcome: 'advisory',
      conclusion: 'success',
      target: {
        ...base.target!,
        kind: 'staging-static',
        verdict_eligible: false,
        revision: {
          ...base.target!.revision,
          observed_sha: null,
          relation: 'unverified',
          method: 'none',
          contains_merge_sha: null,
        },
      },
    }));

    expect(markdown).toContain('## ℹ️ Juror QA — Advisory findings');
    expect(markdown).toContain('staging-static · unverified (unverified)');
    expect(markdown).toContain('verdict eligible no');
  });

  it('never renders the target URL, including an adversarial one', () => {
    const base = qaResult();
    const injected =
      'https://staging.example.test/)[OPEN-EVIDENCE](https://evil.test/phish[a](b)';
    const markdown = renderQaSummary(qaResult({
      target: { ...base.target!, url: injected },
    }), {
      artifactUrl: 'javascript:alert(1)',
      jobUrl: 'https://user:password@github.com/owner/repo/actions/runs/7',
    });

    expect(markdown).toContain('Target revision');
    expect(markdown).not.toContain('staging.example.test');
    expect(markdown).not.toContain('evil.test');
    expect(markdown).not.toContain('javascript:');
    expect(markdown).not.toContain('user:password');
    expect(markdown).not.toContain('View evidence');
    expect(markdown).not.toContain('Open workflow run');
  });

  it('does not activate invalid target, artifact, workflow, or pending URLs', () => {
    const base = qaResult();
    const markdown = renderQaSummary(qaResult({
      target: { ...base.target!, url: 'file:///tmp/fake-target' },
    }), {
      artifactUrl: 'data:text/plain,fake-evidence',
      jobUrl: 'not a URL',
    });
    const pending = renderQaPending(qaResult(), { jobUrl: 'javascript:alert(1)' });

    expect(markdown).toContain('- Target: staging-deployment ·');
    expect(markdown).not.toContain('file:///');
    expect(markdown).not.toContain('data:text');
    expect(markdown).not.toContain('[Open workflow run]');
    expect(pending).not.toContain('[Open the QA workflow run]');
    expect(renderQaMarkdownLink('unsafe', 'https://user:pass@example.test/')).toBeNull();
  });

  it('preserves IPv6 authority brackets while encoding path delimiters', () => {
    expect(renderQaMarkdownLink('local', 'http://[::1]:4173/a[b](c)')).toBe(
      '[local](http://[::1]:4173/a%5Bb%5D%28c%29)',
    );
    expect(renderQaMarkdownLink('query', 'https://example.test/?value=\\')).toBe(
      '[query](https://example.test/?value=%5C)',
    );
  });

  it('defangs model-authored markdown and redacts secret-shaped strings', () => {
    const base = qaResult();
    const secret = `sk-${'A'.repeat(36)}`;
    const markerInjection = `${QA_STICKY_MARKER} </details> \`\`\``;
    const markdown = renderQaSummary(qaResult({
      plan: {
        ...base.plan!,
        impact_assessment: `${markerInjection} ${secret}`,
        scenarios: [{
          ...base.plan!.scenarios[0]!,
          title: 'Break | table\n<script>alert(1)</script>',
        }],
      },
      issues: [{
        ...base.issues[0]!,
        title: markerInjection,
        actual: secret,
      }],
      warnings: [markerInjection],
    }));

    expect(markdown.match(/<!-- juror:qa:v1 -->/g)).toHaveLength(1);
    expect(markdown).not.toContain(secret);
    expect(markdown).toContain('[redacted]');
    expect(markdown).toContain('&lt;!-- juror:qa:v1 --> &lt;/details&gt; `');
    expect(markdown).toContain('Break \\| table &lt;script>alert(1)&lt;/script>');
  });

  it('explains blocked checkpoints and aggregates retries into one journey row', () => {
    const base = qaResult();
    const blocked = {
      ...base.attempts[0]!,
      status: 'blocked' as const,
      checkpoints: base.attempts[0]!.checkpoints.map((checkpoint, index) => ({
        ...checkpoint,
        status: index === 0 ? 'passed' as const : 'blocked' as const,
        observed: index === 0 ? 'Toolbar controls were visible.' : 'Authenticated checkpoint was unavailable.',
      })),
    };
    const failed = {
      ...blocked,
      attempt: 2 as const,
      status: 'failed' as const,
      checkpoints: blocked.checkpoints.map((checkpoint, index) => ({
        ...checkpoint,
        status: index === 0 ? 'passed' as const : 'failed' as const,
        observed: index === 0 ? checkpoint.observed : 'Authenticated checkpoint did not match.',
      })),
    };
    const markdown = renderQaSummary(qaResult({
      outcome: 'blocked',
      issues: [],
      attempts: [blocked, failed],
    }));

    expect(markdown).toContain('No product verdict was produced');
    expect(markdown).toContain('| Narrow composer remains usable | ❌ Failed | 1/2 | 2 |');
    expect(markdown.match(/\| Narrow composer remains usable \| ❌ Failed/g)).toHaveLength(1);
    expect(markdown).toContain('### Why QA stopped');
    expect(markdown).toContain('The final attempt left 1 planned check unresolved.');
    expect(markdown).toContain('### Unresolved checks');
    expect(markdown).toContain('Authenticated checkpoint did not match.');
  });

  it('redacts the target URL and origin when free-text fields echo them', () => {
    const base = qaResult();
    const targetUrl = base.target!.url;
    const targetOrigin = base.target!.allowed_origin;
    const markdown = renderQaSummary(qaResult({
      plan: {
        ...base.plan!,
        impact_assessment: `Changed ${targetUrl}`,
      },
      attempts: base.attempts.map((attempt) => ({
        ...attempt,
        checkpoints: attempt.checkpoints.map((checkpoint) => ({
          ...checkpoint,
          observed: `Observed at ${targetOrigin}`,
        })),
      })),
      issues: base.issues.map((issue) => ({
        ...issue,
        expected: targetUrl,
        actual: targetOrigin,
      })),
      cleanup: { ...base.cleanup, summary: `Reset ${targetUrl}` },
      warnings: [`Target ${targetOrigin} was advisory.`],
    }));

    expect(markdown).not.toContain(targetUrl);
    expect(markdown).not.toContain(targetOrigin);
    expect(markdown).toContain('[redacted]');
  });

  it('uses a video-specific CTA only when video evidence exists', () => {
    const base = qaResult();
    const markdown = renderQaSummary(qaResult({
      artifacts: base.artifacts.filter((artifact) => artifact.kind !== 'video'),
    }), { artifactUrl: 'https://github.com/owner/repo/actions/runs/7/artifacts/8' });

    expect(markdown).toContain('[View evidence](https://github.com/owner/repo/actions/runs/7/artifacts/8)');
    expect(markdown).not.toContain('View evidence & video');
  });

  it('does not present retained findings as a product verdict after infrastructure failure', () => {
    const markdown = renderQaSummary(qaResult({ outcome: 'infrastructure_error' }));

    expect(markdown).toContain('### Retained browser findings');
    expect(markdown).not.toContain('### Product issues');
  });

  it.each([
    ['passed', '✅', 'Passed'],
    ['blocked', '⛔', 'QA blocked'],
    ['infrastructure_error', '🛑', 'Infrastructure error'],
    ['cancelled', '⏹️', 'Cancelled'],
  ] as const)('labels the %s terminal outcome', (outcome, icon, label) => {
    const markdown = renderQaSummary(qaResult({ outcome }));
    expect(markdown).toContain(`## ${icon} Juror QA — ${label}`);
    if (outcome === 'cancelled') expect(markdown).toContain('### Why QA stopped');
  });
});
