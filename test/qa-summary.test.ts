import { describe, expect, it } from 'vitest';

import { isQaRunResult } from '../src/qa/result-validator.js';
import type { QaRunResult } from '../src/qa/types.js';
import {
  MAX_QA_COMMENT_CHARS,
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

  it('preserves renderer Markdown while redacting colliding dynamic prose and suppressing secret links', () => {
    const secret = 'details>';
    const base = qaResult();
    const result = qaResult({
      run_id: `run-${secret}`,
      plan: { ...base.plan!, impact_assessment: `Changed ${secret}` },
    });
    const pending = renderQaPending(result, { secrets: [secret], jobUrl: `https://example.test/${secret}` });
    const final = renderQaSummary(result, { secrets: [secret], artifactUrl: `https://example.test/${secret}` });

    for (const markdown of [pending, final]) {
      expect(markdown).toContain(QA_STICKY_MARKER);
      expect(markdown).toContain('<details><summary>Run details</summary>');
      expect(markdown).toContain('</details>');
      expect(markdown).not.toContain(`run-${secret}`);
    }
    expect(pending).not.toContain('[Open the QA workflow run]');
    expect(final).not.toContain('[View evidence');
    expect(renderQaMarkdownLink('secret', `https://example.test/sk-${'A'.repeat(36)}`)).toBeNull();
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
    expect(markdown).toContain('[View evidence &amp; video](https://github.com/owner/repo/actions/runs/7/artifacts/8)');
    expect(markdown).toContain('[Open workflow run](https://github.com/owner/repo/actions/runs/7)');
    expect(markdown).toContain('2 artifacts · 1 video');
    expect(markdown).toContain('- Run: qa-owner-repo-42-abc123');
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
    expect(renderQaMarkdownLink('oversized', `https://example.test/${'x'.repeat(4_096)}`)).toBeNull();
  });

  it('suppresses Unicode URLs that exceed the cap only after percent encoding', () => {
    const unicodeUrl = `https://example.test/${'é'.repeat(2_000)}`;
    expect(unicodeUrl.length).toBeLessThanOrEqual(4_096);
    expect(renderQaMarkdownLink('encoded', unicodeUrl)).toBeNull();

    const markdown = renderQaSummary(qaResult(), { jobUrl: unicodeUrl, artifactUrl: unicodeUrl });
    expect(markdown).not.toContain('[Open workflow run]');
    expect(markdown).not.toContain('[View evidence');
    expect(markdown.length).toBeLessThanOrEqual(MAX_QA_COMMENT_CHARS);
  });

  it('rechecks secrets after URL normalization changes host spelling and casing', () => {
    expect(renderQaMarkdownLink(
      'Evidence',
      'https://café.example/path',
      ['xn--caf-dma.example'],
    )).toBeNull();
    expect(renderQaMarkdownLink(
      'Evidence',
      'https://EXAMPLE.TEST/path',
      ['example.test'],
    )).toBeNull();
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
    expect(markdown).toContain('\\[redacted\\]');
    expect(markdown).toContain('&lt;\\!-- juror:qa:v1 --&gt;');
    expect(markdown).toContain('Break \\| table &lt;script&gt;alert\\(1\\)&lt;');
  });

  it('keeps redaction placeholders, GitHub references, and commit hashes inert', () => {
    const base = qaResult();
    const secret = `sk-${'A'.repeat(36)}`;
    const markdown = renderQaSummary(qaResult({
      plan: {
        ...base.plan!,
        impact_assessment: `${secret}: //evil.example/phish See ${secret}; review GH-67 and 2825e5e.`,
      },
    }));

    expect(markdown).not.toContain(secret);
    expect(markdown).not.toContain('[redacted]: //evil.example');
    expect(markdown).toContain('\\[redacted\\]: //evil.example');
    expect(markdown).not.toContain('GH-67');
    expect(markdown).toContain(`GH\u200B-67`);
    expect(markdown).not.toContain('2825e5e');
    expect(markdown).toContain(`2825e5\u200Be`);
  });

  it('makes exported link labels inert and redacts exact label secrets', () => {
    const hostile = renderQaMarkdownLink(
      'x](//evil.example)[x',
      'https://example.test/evidence',
    );
    const secret = 'label-secret';
    const redacted = renderQaMarkdownLink(
      `Evidence for ${secret}`,
      'https://example.test/evidence',
      [secret],
    );

    expect(hostile).not.toContain('](//evil.example');
    expect(hostile?.match(/\]\(/g)).toHaveLength(1);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain('\\[redacted\\]');

    const colliding = renderQaMarkdownLink('Evidence redacted', 'https://x.io/e', ['redacted']);
    const oneCharacter = renderQaMarkdownLink('a', 'https://x.io/e', ['a']);
    expect(colliding).not.toContain('redacted');
    expect(colliding).toContain('\\[secret removed\\]');
    expect(oneCharacter).not.toContain('a');
    expect(oneCharacter).toContain('\\[secret removed\\]');
  });

  it('redacts URL-encoded configured secrets from prose and link destinations', () => {
    const base = qaResult();
    const secret = 'alpha/beta';
    const markdown = renderQaSummary(qaResult({
      plan: { ...base.plan!, impact_assessment: 'Encoded alpha%2Fbeta remained in the page.' },
    }), { secrets: [secret] });

    expect(markdown).not.toContain(secret);
    expect(markdown).not.toContain('alpha%2Fbeta');
    expect(markdown).toContain('\\[redacted\\]');
    expect(renderQaMarkdownLink(
      'Evidence',
      'https://example.test/?q=alpha%2Fbeta',
      [secret],
    )).toBeNull();
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
    expect(markdown).toContain('\\[redacted\\]');
  });

  it('keeps root-route prose readable while redacting a meaningful target route echo', () => {
    const base = qaResult();
    const targetUrl = 'https://staging.example.test/account/settings';
    const markdown = renderQaSummary(qaResult({
      target: { ...base.target!, url: targetUrl },
      plan: { ...base.plan!, impact_assessment: 'Start at /, then follow the closing details and evidence links.' },
      warnings: [
        `The target route was ${targetUrl} and should not be exposed.`,
        'The same route appeared at https://mirror.example.test/account/settings.',
      ],
    }), {
      jobUrl: 'https://github.com/owner/repo/actions/runs/7',
      artifactUrl: 'https://github.com/owner/repo/actions/runs/7/artifacts/8',
    });

    expect(markdown).toContain('Start at /, then follow the closing details and evidence links.');
    expect(markdown).toContain('[View evidence &amp; video](https://github.com/owner/repo/actions/runs/7/artifacts/8)');
    expect(markdown).toContain('<details><summary>Run details</summary>');
    expect(markdown).not.toContain(targetUrl);
    expect(markdown).not.toContain('settings');
  });

  it('renders adversarial report prose as inert text and includes plan audit notes', () => {
    const base = qaResult();
    const hostile = '# heading\n> [!WARNING]\n- list\n+ list\n~~strike~~ ![image](https://bad.invalid/x) @person #12 <details><summary>x</summary>\n| a | b |';
    const markdown = renderQaSummary(qaResult({
      plan: { ...base.plan!, impact_assessment: hostile, risk_notes: [hostile], blind_spots: [hostile] },
      issues: [{ ...base.issues[0]!, title: hostile, expected: hostile, actual: hostile }],
      cleanup: { status: 'failed', summary: hostile, error: hostile },
      warnings: [hostile],
    }));

    expect(markdown).toContain('<details><summary>Plan risks and blind spots</summary>');
    expect(markdown).not.toContain('\n# heading');
    expect(markdown).not.toContain('[!WARNING]');
    expect(markdown).not.toContain('](https://bad.invalid');
    expect(markdown).not.toContain('@person');
    expect(markdown).not.toContain('#12');
    expect(markdown).not.toContain('\n- list');
    expect(markdown).not.toContain('\n+ list');
    expect(markdown).not.toContain('~~strike~~');
    expect(markdown).toContain('#### Risk notes');
    expect(markdown).toContain('#### Blind spots');
    expect(markdown.match(/<details>/g)?.length).toBe(markdown.match(/<\/details>/g)?.length);
  });

  it('defangs encoded mentions, ordered lists, lone carriage returns, and thematic breaks', () => {
    const base = qaResult();
    const markdown = renderQaSummary(qaResult({
      plan: { ...base.plan!, impact_assessment: '&commat;team &num;12 1. item\r2) item ---' },
    }));
    expect(markdown).toContain('&amp;commat;team &amp;num;12 1\\. item 2\\) item \\-\\-\\-');
  });

  it('redacts case-insensitive target hosts plus decoded route, query, fragment, and port echoes', () => {
    const base = qaResult();
    const markdown = renderQaSummary(qaResult({
      target: { ...base.target!, url: 'https://StAgInG.Example.Test:4173/Account%20Settings?Token=top%20secret#Private%20tab' },
      plan: { ...base.plan!, impact_assessment: 'STAGING.EXAMPLE.TEST:4173 /Account Settings Token=top secret Private tab' },
    }));
    expect(markdown).not.toMatch(/staging\.example\.test|4173|Account Settings|Token=top secret|Private tab/i);
    expect(markdown).toContain('\\[redacted\\]');
  });

  it('applies longer target redactions before contained secrets', () => {
    const base = qaResult();
    const hostname = 'api.top-secret.example.test';
    const markdown = renderQaSummary(qaResult({
      target: { ...base.target!, url: `https://${hostname}/` },
      plan: { ...base.plan!, impact_assessment: `Opened ${hostname} during browser QA.` },
    }), { secrets: ['secret'] });

    expect(markdown).not.toContain(hostname);
    expect(markdown).not.toContain('top-\\[redacted\\].example');
    expect(markdown).toContain('\\[redacted\\]');
  });

  it('redacts form-encoded target query values echoed with spaces', () => {
    const base = qaResult();
    const markdown = renderQaSummary(qaResult({
      target: { ...base.target!, url: 'https://staging.example.test/?token=top+secret' },
      plan: { ...base.plan!, impact_assessment: 'The browser echoed token=top secret.' },
    }));

    expect(markdown).not.toContain('top secret');
    expect(markdown).toContain('\\[redacted\\]');
  });

  it('redacts decoded routes and query values containing equals without over-redacting short prose', () => {
    const base = qaResult();
    const markdown = renderQaSummary(qaResult({
      target: {
        ...base.target!,
        url: 'https://staging.example.test/Account%20Settings?token=top=secret&a=b',
      },
      plan: {
        ...base.plan!,
        impact_assessment: 'Opened Account Settings with top=secret; a basic data=browser remains available.',
      },
    }));

    expect(markdown).not.toContain('Account Settings');
    expect(markdown).not.toContain('top=secret');
    expect(markdown).toContain('a basic data=browser remains available.');
    expect(markdown).toContain('\\[redacted\\]');
  });

  it('does not treat a one-character valueless target query as a global secret', () => {
    const base = qaResult();
    const markdown = renderQaSummary(qaResult({
      target: { ...base.target!, url: 'https://staging.example.test/?a' },
      plan: { ...base.plan!, impact_assessment: 'A basic browser remains available.' },
    }));

    expect(markdown).toContain('A basic browser remains available.');
  });

  it('redacts overlapping target components once without mangling the placeholder', () => {
    const base = qaResult();
    const markdown = renderQaSummary(qaResult({
      target: { ...base.target!, url: 'https://staging.example.test/?theme=red' },
      plan: {
        ...base.plan!,
        impact_assessment: 'The infrared themes remain readable; red theme is selected.',
      },
    }));

    expect(markdown).toContain('The infrared themes remain readable;');
    expect(markdown).toContain('\\[secret removed\\]');
    expect(markdown).not.toMatch(/\bred\b/);
    expect(markdown).not.toContain('[secret removed]acted');
    expect(markdown).not.toContain('[redacted]acted');
  });

  it('redacts equivalent percent-escape casing and form-encoded query topology', () => {
    const base = qaResult();
    const markdown = renderQaSummary(qaResult({
      target: {
        ...base.target!,
        url: 'https://staging.example.test/private%2Ftenant-9842?next=Account%20Settings',
      },
      plan: {
        ...base.plan!,
        impact_assessment: 'Opened private%2ftenant-9842 and next=Account+Settings.',
      },
    }));

    expect(markdown).not.toContain('private%2ftenant-9842');
    expect(markdown).not.toContain('next=Account+Settings');
    expect(markdown).toContain('\\[redacted\\]');
  });

  it('redacts encoded unreserved target bytes and full form-serialization equivalents', () => {
    const base = qaResult();
    const markdown = renderQaSummary(qaResult({
      target: {
        ...base.target!,
        url: 'https://staging.example.test/private/secret?q=tenant~9842&token=secret',
      },
      plan: {
        ...base.plan!,
        impact_assessment: 'Opened /private/%73ecret with q=tenant%7E9842 and token=%73ecret.',
      },
    }));

    expect(markdown).not.toContain('/private/%73ecret');
    expect(markdown).not.toContain('q=tenant%7E9842');
    expect(markdown).not.toContain('token=%73ecret');
    expect(markdown).toContain('\\[redacted\\]');
  });

  it('redacts target topology from pending text and suppresses links that embed it', () => {
    const base = qaResult();
    const targetUrl = 'https://staging.example.test/private/settings';
    const result = qaResult({
      run_id: `qa-${targetUrl}-42`,
      target: { ...base.target!, url: targetUrl },
    });
    const embeddedTargetLink = `https://logs.example.test/?target=${targetUrl}`;
    const pending = renderQaPending(result, { jobUrl: embeddedTargetLink });
    const final = renderQaSummary(result, {
      jobUrl: embeddedTargetLink,
      artifactUrl: embeddedTargetLink,
    });

    for (const markdown of [pending, final]) {
      expect(markdown).not.toContain(targetUrl);
      expect(markdown).not.toContain('staging.example.test');
      expect(markdown).toContain('\\[redacted\\]');
    }
    expect(pending).not.toContain('[Open the QA workflow run]');
    expect(final).not.toContain('[Open workflow run]');
    expect(final).not.toContain('[View evidence');
  });

  it('suppresses links whose normalized path introduces target topology', () => {
    const base = qaResult();
    const result = qaResult({
      target: { ...base.target!, url: 'https://staging.example.test/private/secret' },
    });
    const normalizedIntoTarget = 'https://logs.example.test/private/x/../secret';
    const markdown = renderQaSummary(result, {
      jobUrl: normalizedIntoTarget,
      artifactUrl: normalizedIntoTarget,
    });

    expect(markdown).not.toContain('[Open workflow run]');
    expect(markdown).not.toContain('[View evidence');
  });

  it('redacts the Unicode IDNA form of a punycode target host', () => {
    const base = qaResult();
    const markdown = renderQaSummary(qaResult({
      target: {
        ...base.target!,
        url: 'https://xn--caf-dma.example/private',
        allowed_origin: 'https://xn--caf-dma.example',
      },
      plan: { ...base.plan!, impact_assessment: 'Opened café.example during QA.' },
    }));

    expect(markdown).not.toContain('café.example');
    expect(markdown).toContain('\\[redacted\\]');
  });

  it('fails closed when a configured value exceeds the nested-decoding bound', () => {
    let deeplyEncoded = '\uE000';
    for (let index = 0; index < 10; index++) deeplyEncoded = encodeURIComponent(deeplyEncoded);

    expect(() => renderQaMarkdownLink(
      'Evidence',
      'https://example.test/evidence',
      [deeplyEncoded],
    )).toThrow('nested encoding limit');
  });

  it('uses valid table omission rows for unresolved checks and retry history', () => {
    const base = qaResult();
    const failedAttempts = Array.from({ length: 9 }, (_, index) => ({
      ...base.attempts[0]!, scenario_id: `scenario-${index}`, attempt: 1 as const, status: 'failed' as const,
    }));
    const blocked = renderQaSummary(qaResult({ outcome: 'blocked', issues: [], attempts: failedAttempts }));
    expect(blocked).toContain('| _1 unresolved check omitted from this comment._ | — | — | — | — |');

    const retries = Array.from({ length: 9 }, (_, index) => {
      const scenario_id = `scenario-${index}`;
      return [
        { ...base.attempts[0]!, scenario_id, attempt: 1 as const, status: 'failed' as const },
        {
          ...base.attempts[0]!, scenario_id, attempt: 2 as const, status: 'passed' as const,
          checkpoints: base.attempts[0]!.checkpoints.map((checkpoint) => ({ ...checkpoint, status: 'passed' as const })),
        },
      ];
    }).flat();
    const flaky = renderQaSummary(qaResult({ outcome: 'flaky', conclusion: 'success', issues: [], attempts: retries }));
    expect(flaky).toContain('| _1 retry failure omitted from this comment._ | — | — | — | — |');
    expect(flaky.match(/<details>/g)?.length).toBe(flaky.match(/<\/details>/g)?.length);
  });

  it('defensively bounds untrusted unplanned journeys with a valid table omission row', () => {
    const base = qaResult();
    const attempts = Array.from({ length: 10 }, (_, index) => ({
      ...base.attempts[0]!,
      scenario_id: `unplanned-${index}`,
      attempt: 1 as const,
      status: 'failed' as const,
    }));
    const result = qaResult({
      outcome: 'blocked',
      issues: [],
      attempts,
      plan: {
        ...base.plan!,
        scenarios: base.plan!.scenarios.map((scenario) => ({
          ...scenario,
          checkpoints: scenario.checkpoints.map((checkpoint) => ({
            ...checkpoint,
            assertion: {
              kind: 'visible',
              locator: { by: 'role', value: 'button', name: null, exact: true, nth: null },
              url_contains: null,
            },
          })),
        })),
      },
    });
    const markdown = renderQaSummary(result);

    expect(isQaRunResult(result)).toBe(false);
    expect(markdown).toContain('| _3 journeys omitted from this comment._ | — | — | — |');
    expect(markdown).toContain('### What Juror tested');
    expect(markdown).toContain('### Unresolved checks');
    expect(markdown.match(/<details>/g)?.length).toBe(markdown.match(/<\/details>/g)?.length);
    expect(markdown.length).toBeLessThanOrEqual(MAX_QA_COMMENT_CHARS);
  });

  it('keeps pipe-containing values inert in every QA table cell', () => {
    const base = qaResult();
    const title = 'Narrow | composer';
    const checkpointId = 'send | visible';
    const expected = 'Send | remains reachable';
    const observed = 'Send | was clipped';
    const blocked = renderQaSummary(qaResult({
      outcome: 'blocked',
      issues: [],
      plan: { ...base.plan!, scenarios: [{ ...base.plan!.scenarios[0]!, title }] },
      attempts: [{
        ...base.attempts[0]!,
        status: 'failed',
        checkpoints: [{
          ...base.attempts[0]!.checkpoints[1]!,
          checkpoint_id: checkpointId,
          expected,
          observed,
        }],
      }],
    }));
    const flaky = renderQaSummary(qaResult({
      outcome: 'flaky',
      conclusion: 'success',
      issues: [],
      plan: { ...base.plan!, scenarios: [{ ...base.plan!.scenarios[0]!, title }] },
      attempts: [
        {
          ...base.attempts[0]!,
          status: 'failed',
          checkpoints: [{ ...base.attempts[0]!.checkpoints[1]!, checkpoint_id: checkpointId, observed }],
        },
        {
          ...base.attempts[0]!,
          attempt: 2,
          status: 'passed',
          checkpoints: base.attempts[0]!.checkpoints.map((checkpoint) => ({ ...checkpoint, status: 'passed' as const })),
        },
      ],
    }));

    for (const markdown of [blocked, flaky]) {
      expect(markdown).toContain('Narrow \\| composer');
    }
    expect(blocked).toContain('send \\| visible');
    expect(blocked).toContain('Send \\| remains reachable');
    expect(blocked).toContain('Send \\| was clipped');
    expect(flaky).toContain('send \\| visible');
    expect(flaky).toContain('Send \\| was clipped');
  });

  it('defangs run and browser-version text in final and pending summaries', () => {
    const base = qaResult();
    const hostile = '- item ~~strike~~ [link](https://bad.invalid)';
    const result = qaResult({ run_id: hostile, runtime: { ...base.runtime, browser_version: hostile } });
    const final = renderQaSummary(result);
    const pending = renderQaPending(result);

    expect(final).not.toContain('~~strike~~');
    expect(final).not.toContain('](https://bad.invalid)');
    expect(pending).not.toContain('~~strike~~');
    expect(pending).not.toContain('](https://bad.invalid)');
  });

  it('bounds maximum schema-valid report presentation without truncating its structure', () => {
    const base = qaResult();
    const issues = Array.from({ length: 100 }, (_, index) => ({
      ...base.issues[0]!, id: `issue-${index}`, title: 'x'.repeat(500), expected: 'x'.repeat(4_000), actual: 'x'.repeat(4_000),
    }));
    const markdown = renderQaSummary(qaResult({
      issues,
      warnings: Array.from({ length: 100 }, () => 'x'.repeat(500)),
      plan: { ...base.plan!, risk_notes: Array.from({ length: 30 }, () => 'x'.repeat(500)), blind_spots: Array.from({ length: 30 }, () => 'x'.repeat(500)) },
    }));

    expect(markdown.length).toBeLessThanOrEqual(65_000);
    expect(markdown).toContain('92 issues omitted');
    expect(markdown).toContain('92 warnings omitted');
    expect(markdown.match(/<details>/g)?.length).toBe(markdown.match(/<\/details>/g)?.length);
  });

  it('uses a closed compact fallback for worst-case entity expansion', () => {
    const base = qaResult();
    const hostile = '&<'.repeat(2_000);
    const markdown = renderQaSummary(qaResult({
      plan: { ...base.plan!, impact_assessment: hostile, risk_notes: Array.from({ length: 30 }, () => hostile), blind_spots: Array.from({ length: 30 }, () => hostile) },
      issues: Array.from({ length: 100 }, (_, index) => ({ ...base.issues[0]!, id: `issue-${index}`, title: hostile.slice(0, 500), expected: hostile, actual: hostile })),
      warnings: Array.from({ length: 100 }, () => hostile.slice(0, 500)),
    }), { jobUrl: 'https://github.com/owner/repo/actions/runs/7' });

    expect(markdown.length).toBeLessThanOrEqual(MAX_QA_COMMENT_CHARS);
    expect(markdown).toContain(QA_STICKY_MARKER);
    expect(markdown).toContain('### Details omitted');
    expect(markdown).toContain('### Overview counts');
    expect(markdown).toContain('| Journeys | Attempts | Issues | Artifacts |');
    expect(markdown).toContain('[Open workflow run](https://github.com/owner/repo/actions/runs/7)');
    expect(markdown.match(/<details>/g)?.length).toBe(markdown.match(/<\/details>/g)?.length);
  });

  it('keeps critical findings before low-severity findings when issue detail is capped', () => {
    const base = qaResult();
    const issues: QaRunResult['issues'] = Array.from({ length: 8 }, (_, index) => ({ ...base.issues[0]!, id: `p3-${index}`, severity: 'P3' as const, title: `low-${index}` }));
    issues.push({ ...base.issues[0]!, id: 'p0-late', severity: 'P0', title: 'critical-late' });
    const markdown = renderQaSummary(qaResult({ issues }));
    expect(markdown.indexOf('critical-late')).toBeLessThan(markdown.indexOf('low-0'));
    expect(markdown).toContain('1 issue omitted');
  });

  it('uses a video-specific CTA only when video evidence exists', () => {
    const base = qaResult();
    const markdown = renderQaSummary(qaResult({
      artifacts: base.artifacts.filter((artifact) => artifact.kind !== 'video'),
    }), { artifactUrl: 'https://github.com/owner/repo/actions/runs/7/artifacts/8' });

    expect(markdown).toContain('[View evidence](https://github.com/owner/repo/actions/runs/7/artifacts/8)');
    expect(markdown).not.toContain('View evidence &amp; video');
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
