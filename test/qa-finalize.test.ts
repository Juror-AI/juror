import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  finalizeQaEvidence,
  markQaInfrastructureError,
  normalizeQaArtifactUrl,
} from '../src/qa/finalize.js';
import { isQaRunResult } from '../src/qa/result-validator.js';
import { QA_RUN_RESULT_JSON_SCHEMA } from '../src/qa/schema.js';
import type { QaRunResult } from '../src/qa/types.js';

const root = resolve(import.meta.dirname, '..');
const fallbackScript = join(root, 'qa', 'finalize-fallback.mjs');

function secretBundle(value: string): string {
  return Buffer.from(JSON.stringify({ QA_CANARY: value })).toString('base64');
}

function result(): QaRunResult {
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
        verified_against: 'merge', expected_sha: 'a'.repeat(40), observed_sha: 'a'.repeat(40),
        relation: 'exact', method: 'deployment-sha', contains_merge_sha: true,
        additional_commits: [], additional_commits_truncated: false,
      },
      stability: 'stable', verdict_eligible: true,
      resolved_at: '2026-08-19T00:00:00.000Z', ready_at: '2026-08-19T00:00:01.000Z',
    },
    plan: {
      schema_version: 1, impact_assessment: 'The settings save flow changed.', testability: 'testable',
      no_testable_surface_reason: null, surfaces: ['Settings'],
      scenarios: [{
        id: 'save-settings', title: 'Save settings', rationale: 'Exercise the affected form.',
        viewport: { kind: 'desktop', width: 1000, height: 700, justification: 'Desktop form.' },
        preconditions: [], seeded_state: [],
        checkpoints: [{
          id: 'saved', description: 'The saved indicator appears.', expected: 'Saved',
          assertion: { kind: 'text', locator: { by: 'test_id', value: 'saved', name: null, exact: false, nth: null }, url_contains: null },
        }],
        allowed_mutations: ['none'], cleanup_expectations: [],
      }],
      risk_notes: [], blind_spots: [],
    },
    attempts: [{
      scenario_id: 'save-settings', attempt: 1, status: 'passed', started_at: '2026-08-19T00:00:00.000Z', duration_ms: 1,
      operations: [], checkpoints: [{ checkpoint_id: 'saved', status: 'passed', expected: 'Saved', observed: 'Saved' }],
      observations: [], evidence_artifact_ids: [],
    }],
    issues: [],
    cleanup: { status: 'not_required', summary: 'No browser state.', error: null },
    artifacts: [{
      id: 'artifact-1',
      kind: 'video',
      path: 'scenario.webm',
      sanitized: true,
      sha256: 'c'.repeat(64),
      retention_days: 14,
      upload: null,
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

function productIssueResult(): QaRunResult {
  const current = result();
  current.outcome = 'product_issue';
  current.conclusion = 'failure';
  current.attempts = [1, 2].map((attempt) => ({
    scenario_id: 'save-settings',
    attempt: attempt as 1 | 2,
    status: 'failed' as const,
    started_at: '2026-08-19T00:00:00.000Z',
    duration_ms: 1,
    operations: [],
    checkpoints: [{ checkpoint_id: 'saved', status: 'failed' as const, expected: 'Saved', observed: 'Not saved' }],
    observations: [],
    evidence_artifact_ids: [],
  }));
  current.issues = [{
    id: 'save-settings-saved',
    scenario_id: 'save-settings',
    checkpoint_id: 'saved',
    severity: 'P1',
    classification: 'verified',
    reproducible: true,
    title: 'Settings did not save',
    expected: 'Saved',
    actual: 'Not saved',
    attempt_numbers: [1, 2],
  }];
  return current;
}

function fallbackEnvironment(
  reportPath: string,
  summaryPath: string,
  outputPath: string,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    REPORT_PATH: reportPath,
    SUMMARY_PATH: summaryPath,
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_RUN_ID: '7',
    PR_NUMBER: '42',
    JUROR_QA_ACTION_PAYLOAD_DELIVERED: 'true',
    JUROR_QA_ACTION_READ_ONLY: 'false',
    JUROR_QA_ACTION_REQUIRE_INFRASTRUCTURE_ERROR: 'false',
    JUROR_QA_ACTION_FINALIZATION_ERROR: '',
    JUROR_QA_SECRETS_B64: '',
    ARTIFACT_NAME: 'juror-qa-evidence-pr-42-7',
    ARTIFACT_URL: 'https://github.com/owner/repo/actions/runs/7/artifacts/8',
    GITHUB_OUTPUT: outputPath,
    ...extra,
  };
}

function preflightEnvironment(
  reportPath: string,
  summaryPath: string,
  outputPath: string,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_RUN_ID: '7',
    PR_NUMBER: '42',
    REPORT_PATH: reportPath,
    GITHUB_STEP_SUMMARY: summaryPath,
    GITHUB_OUTPUT: outputPath,
    JUROR_QA_PREFLIGHT_MODE: 'true',
    JUROR_QA_PREFLIGHT_PHASE: 'image',
    JUROR_QA_PREFLIGHT_WRITE_REPORT: 'false',
    ...extra,
  };
}

describe('finalizeQaEvidence', () => {
  it.each([
    ['image', 'released QA image could not be verified'],
    ['runtime', 'isolated QA runtime could not be prepared'],
    ['policy', 'trusted QA policy could not be evaluated'],
  ])('publishes static preflight %s failure output without reflecting environment text', (phase, expected) => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-qa-preflight-'));
    try {
      const reportPath = join(scratch, 'report.json');
      const summaryPath = join(scratch, 'summary.md');
      const outputPath = join(scratch, 'output.txt');
      writeFileSync(summaryPath, '');
      writeFileSync(outputPath, '');
      const secret = 'preflight-secret-canary';
      const execution = spawnSync(process.execPath, [fallbackScript], {
        cwd: root,
        encoding: 'utf8',
        env: preflightEnvironment(reportPath, summaryPath, outputPath, {
          JUROR_QA_PREFLIGHT_PHASE: phase,
          JUROR_QA_ACTION_FINALIZATION_ERROR: secret,
          JUROR_QA_SECRETS_B64: secretBundle(secret),
        }),
      });

      expect(execution.status, execution.stderr).toBe(0);
      const summary = readFileSync(summaryPath, 'utf8');
      expect(summary).toContain('## 🛑 Juror QA — Setup failure');
      expect(summary).toContain(expected);
      expect(summary).not.toContain(secret);
      const output = readFileSync(outputPath, 'utf8');
      expect(output).toContain('outcome=infrastructure_error\n');
      expect(output).toContain('issues=0\n');
      expect(output).toContain('scenarios=0\n');
      expect(output).toContain('target-kind=none\n');
      expect(output).toContain('target-sha=unverified\n');
      expect(output).toContain('cost-usd=unknown\n');
      expect(output).toContain('artifact-url=\n');
      expect(output).toContain('report-path=\n');
      expect(output).toContain('exit-code=1\n');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('rejects an untrusted preflight phase without publishing arbitrary text', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-qa-preflight-invalid-'));
    try {
      const summaryPath = join(scratch, 'summary.md');
      const outputPath = join(scratch, 'output.txt');
      writeFileSync(summaryPath, '');
      writeFileSync(outputPath, '');
      const untrusted = 'image\nsecret-value';
      const execution = spawnSync(process.execPath, [fallbackScript], {
        cwd: root,
        encoding: 'utf8',
        env: preflightEnvironment(join(scratch, 'report.json'), summaryPath, outputPath, {
          JUROR_QA_PREFLIGHT_PHASE: untrusted,
        }),
      });
      expect(execution.status).toBe(1);
      expect(execution.stderr).not.toContain(untrusted);
      expect(readFileSync(summaryPath, 'utf8')).toBe('');
      expect(readFileSync(outputPath, 'utf8')).toBe('');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('creates a schema-valid synthetic preflight report only when requested', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-qa-preflight-report-'));
    try {
      const reportPath = join(scratch, 'report.json');
      const summaryPath = join(scratch, 'summary.md');
      const outputPath = join(scratch, 'output.txt');
      writeFileSync(summaryPath, '');
      writeFileSync(outputPath, '');
      const execution = spawnSync(process.execPath, [fallbackScript], {
        cwd: root,
        encoding: 'utf8',
        env: preflightEnvironment(reportPath, summaryPath, outputPath, {
          JUROR_QA_PREFLIGHT_PHASE: 'policy',
          JUROR_QA_PREFLIGHT_WRITE_REPORT: 'true',
        }),
      });
      expect(execution.status, execution.stderr).toBe(0);
      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as QaRunResult;
      expect(isQaRunResult(report)).toBe(true);
      expect(report.outcome).toBe('infrastructure_error');
      expect(readFileSync(outputPath, 'utf8')).toContain('report-path=\n');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('creates absent absolute GitHub control files beneath real directories', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-qa-preflight-controls-'));
    try {
      const outputPath = join(scratch, 'runner-output');
      const summaryPath = join(scratch, 'runner-summary');
      const execution = spawnSync(process.execPath, [fallbackScript], {
        cwd: root,
        encoding: 'utf8',
        env: preflightEnvironment(join(scratch, 'report.json'), summaryPath, outputPath),
      });

      expect(execution.status, execution.stderr).toBe(0);
      expect(existsSync(outputPath)).toBe(true);
      expect(existsSync(summaryPath)).toBe(true);
      expect(readFileSync(outputPath, 'utf8')).toContain('outcome=infrastructure_error\n');
      expect(readFileSync(summaryPath, 'utf8')).toContain('Setup failure');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it.each([
    'missing-output', 'missing-summary', 'relative-output', 'relative-summary',
    'symlink-parent', 'symlink-leaf', 'directory-leaf',
  ])(
    'rejects unsafe %s preflight control paths',
    (kind) => {
      const scratch = mkdtempSync(join(tmpdir(), 'juror-qa-preflight-unsafe-'));
      try {
        const outputPath = join(scratch, 'output');
        const summaryPath = join(scratch, 'summary');
        writeFileSync(outputPath, '');
        writeFileSync(summaryPath, '');
        const env: Record<string, string> = {};
        if (kind === 'missing-output') env.GITHUB_OUTPUT = '';
        if (kind === 'missing-summary') env.GITHUB_STEP_SUMMARY = '';
        if (kind === 'relative-output') env.GITHUB_OUTPUT = 'output.txt';
        if (kind === 'relative-summary') env.GITHUB_STEP_SUMMARY = 'summary.md';
        if (kind === 'symlink-parent') {
          const actual = join(scratch, 'actual');
          const linked = join(scratch, 'linked');
          mkdirSync(actual);
          symlinkSync(actual, linked);
          env.GITHUB_OUTPUT = join(linked, 'output');
        }
        if (kind === 'symlink-leaf') {
          const target = join(scratch, 'target-output');
          writeFileSync(target, '');
          rmSync(outputPath);
          symlinkSync(target, outputPath);
        }
        if (kind === 'directory-leaf') {
          rmSync(summaryPath);
          mkdirSync(summaryPath);
        }
        const execution = spawnSync(process.execPath, [fallbackScript], {
          cwd: root,
          encoding: 'utf8',
          env: preflightEnvironment(join(scratch, 'report.json'), summaryPath, outputPath, env),
        });
        expect(execution.status).toBe(1);
        expect(execution.stderr).toContain('could not safely publish its control output');
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );
  it('records successful artifact delivery without mutating the controller result', () => {
    const original = result();
    const finalized = finalizeQaEvidence(original, {
      artifactName: 'juror-qa-pr-42-7',
      artifactUrl: 'https://github.com/owner/repo/actions/runs/7/artifacts/8',
    });

    expect(finalized.outcome).toBe('passed');
    expect(finalized.artifacts[0]?.upload).toEqual({
      name: 'juror-qa-pr-42-7',
      url: 'https://github.com/owner/repo/actions/runs/7/artifacts/8',
    });
    expect(original.artifacts[0]?.upload).toBeNull();
  });

  it('makes upload failure an infrastructure error and clears planned metadata', () => {
    const original = result();
    original.artifacts[0]!.upload = {
      name: 'juror-qa-pr-42-7',
      url: 'https://github.com/owner/repo/actions/runs/7#artifacts',
    };

    const finalized = finalizeQaEvidence(original, { error: 'artifact service unavailable' });

    expect(finalized.outcome).toBe('infrastructure_error');
    expect(finalized.conclusion).toBe('failure');
    expect(finalized.artifacts[0]?.upload).toBeNull();
    expect(finalized.warnings).toContain(
      'Evidence upload failed after QA outcome passed: artifact service unavailable',
    );
    expect(original.outcome).toBe('passed');
  });

  it('rejects incomplete or non-HTTP successful upload metadata', () => {
    expect(() => finalizeQaEvidence(result(), { artifactName: 'artifact' })).toThrow(
      /requires an artifact name and URL/,
    );
    expect(() => finalizeQaEvidence(result(), {
      artifactName: 'artifact',
      artifactUrl: 'file:///tmp/evidence',
    })).toThrow(/must use HTTP/);
    expect(() => finalizeQaEvidence(result(), {
      artifactName: 'artifact',
      artifactUrl: 'https://token@github.com/owner/repo/artifact',
    })).toThrow(/must not contain credentials/);
    expect(() => normalizeQaArtifactUrl('https://user:password@example.test/artifact'))
      .toThrow(/must not contain credentials/);
  });

  it('preserves a delivered artifact when later publication fails', () => {
    const delivered = finalizeQaEvidence(result(), {
      artifactName: 'artifact',
      artifactUrl: 'https://github.com/owner/repo/actions/runs/7/artifacts/8',
    });

    const finalized = markQaInfrastructureError(delivered, 'QA result publication failed');

    expect(finalized.outcome).toBe('infrastructure_error');
    expect(finalized.artifacts[0]?.upload).toEqual(delivered.artifacts[0]?.upload);
    expect(finalized.warnings).toContain('QA result publication failed');
  });

  it('keeps infrastructure warnings inside the public 500-character result boundary', () => {
    const finalized = markQaInfrastructureError(result(), `failure: ${'x'.repeat(1_000)}`);

    expect(finalized.warnings.at(-1)).toHaveLength(500);
    expect(isQaRunResult(finalized)).toBe(true);
  });

  it('rejects contradictory semantic outcomes and conclusions', () => {
    const invalid = result();
    invalid.conclusion = 'failure';

    expect(isQaRunResult(invalid)).toBe(false);
    invalid.outcome = 'infrastructure_error';
    invalid.conclusion = 'success';
    expect(isQaRunResult(invalid)).toBe(false);
  });

  it('validates the assertion semantics sealed into persisted plans', () => {
    const valid = result();
    valid.plan = {
      schema_version: 1,
      impact_assessment: 'The settings save flow changed.',
      testability: 'testable',
      no_testable_surface_reason: null,
      surfaces: ['Settings'],
      scenarios: [{
        id: 'save-settings',
        title: 'Save settings',
        rationale: 'Exercise the affected form.',
        viewport: { kind: 'desktop', width: 1_000, height: 700, justification: 'Desktop form.' },
        preconditions: [],
        seeded_state: [],
        checkpoints: [{
          id: 'saved',
          description: 'The saved indicator appears.',
          expected: 'Saved',
          assertion: {
            kind: 'text',
            locator: { by: 'test_id', value: 'saved', name: null, exact: false, nth: null },
            url_contains: null,
          },
        }],
        allowed_mutations: ['none'],
        cleanup_expectations: [],
      }],
      risk_notes: [],
      blind_spots: [],
    };
    valid.attempts = [{
      scenario_id: 'save-settings', attempt: 1, status: 'passed', started_at: valid.started_at, duration_ms: 1,
      operations: [], checkpoints: [{ checkpoint_id: 'saved', status: 'passed', expected: 'Saved', observed: 'Saved' }],
      observations: [], evidence_artifact_ids: [],
    }];

    expect(isQaRunResult(valid)).toBe(true);
    valid.plan.scenarios[0]!.checkpoints[0]!.assertion.url_contains = '/unplanned';
    expect(isQaRunResult(valid)).toBe(false);
  });

  it('rewrites the persisted report and summary through the internal Action command', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-qa-finalize-'));
    try {
      const reportPath = join(scratch, 'report.json');
      const summaryPath = join(scratch, 'summary.md');
      writeFileSync(reportPath, JSON.stringify(result()));
      const execution = spawnSync(
        join(root, 'node_modules', '.bin', 'vite-node'),
        [
          join(root, 'src/cli.ts'),
          'qa-finalize',
          '--report',
          reportPath,
          '--markdown',
          summaryPath,
          '--repo',
          'owner/repo',
          '--pr',
          '42',
          '--artifact-name',
          'juror-qa-pr-42-7',
          '--artifact-url',
          'https://github.com/owner/repo/actions/runs/7/artifacts/8',
        ],
        { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
      );

      expect(execution.status, execution.stderr).toBe(0);
      const persisted = JSON.parse(readFileSync(reportPath, 'utf8')) as QaRunResult;
      expect(persisted.artifacts[0]?.upload?.url).toContain('/artifacts/8');
      expect(readFileSync(summaryPath, 'utf8')).toContain(
        '[View evidence &amp; video](https://github.com/owner/repo/actions/runs/7/artifacts/8)',
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('rejects a canary formed only by the finalized report trailing newline', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-qa-finalize-bytes-'));
    try {
      const reportPath = join(scratch, 'report.json');
      const summaryPath = join(scratch, 'summary.md');
      const original = result();
      const artifactName = 'juror-qa-pr-42-7';
      const artifactUrl = 'https://github.com/owner/repo/actions/runs/7/artifacts/8';
      const finalized = finalizeQaEvidence(original, { artifactName, artifactUrl });
      const finalBytes = `${JSON.stringify(finalized, null, 2)}\n`;
      const canary = finalBytes.slice(-8);
      const originalBytes = JSON.stringify(original);
      expect(canary).toHaveLength(8);
      expect(originalBytes).not.toContain(canary);
      writeFileSync(reportPath, originalBytes);

      const execution = spawnSync(
        join(root, 'node_modules', '.bin', 'vite-node'),
        [
          join(root, 'src/cli.ts'),
          'qa-finalize',
          '--report',
          reportPath,
          '--markdown',
          summaryPath,
          '--repo',
          'owner/repo',
          '--pr',
          '42',
          '--artifact-name',
          artifactName,
          '--artifact-url',
          artifactUrl,
        ],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            NO_COLOR: '1',
            JUROR_QA_SECRETS_B64: secretBundle(canary),
          },
        },
      );

      expect(execution.status).toBe(1);
      expect(execution.stderr).not.toContain(canary);
      expect(readFileSync(reportPath, 'utf8')).toBe(originalBytes);
      expect(existsSync(summaryPath)).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('persists an upload failure while reporting that the finalizer command completed', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-qa-finalize-error-'));
    try {
      const reportPath = join(scratch, 'report.json');
      const summaryPath = join(scratch, 'summary.md');
      writeFileSync(reportPath, JSON.stringify(result()));
      const execution = spawnSync(
        join(root, 'node_modules', '.bin', 'vite-node'),
        [
          join(root, 'src/cli.ts'),
          'qa-finalize',
          '--report',
          reportPath,
          '--markdown',
          summaryPath,
          '--repo',
          'owner/repo',
          '--pr',
          '42',
          '--artifact-upload-error',
          'artifact service unavailable',
        ],
        { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
      );

      expect(execution.status, execution.stderr).toBe(0);
      const persisted = JSON.parse(readFileSync(reportPath, 'utf8')) as QaRunResult;
      expect(persisted.outcome).toBe('infrastructure_error');
      expect(persisted.conclusion).toBe('failure');
      expect(isQaRunResult(persisted)).toBe(true);
      expect(readFileSync(summaryPath, 'utf8')).toContain('Juror QA — Infrastructure error');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('preserves delivered evidence when a later result-artifact phase fails', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-qa-finalize-later-error-'));
    try {
      const reportPath = join(scratch, 'report.json');
      const summaryPath = join(scratch, 'summary.md');
      const original = finalizeQaEvidence(result(), {
        artifactName: 'juror-qa-evidence-pr-42-7',
        artifactUrl: 'https://github.com/owner/repo/actions/runs/7/artifacts/8',
      });
      writeFileSync(reportPath, JSON.stringify(original));
      const execution = spawnSync(
        join(root, 'node_modules', '.bin', 'vite-node'),
        [
          join(root, 'src/cli.ts'),
          'qa-finalize',
          '--report',
          reportPath,
          '--markdown',
          summaryPath,
          '--repo',
          'owner/repo',
          '--pr',
          '42',
          '--finalization-error',
          'final QA report artifact upload failed',
        ],
        { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
      );

      expect(execution.status, execution.stderr).toBe(0);
      const persisted = JSON.parse(readFileSync(reportPath, 'utf8')) as QaRunResult;
      expect(persisted.outcome).toBe('infrastructure_error');
      expect(persisted.artifacts[0]?.upload).toEqual(original.artifacts[0]?.upload);
      expect(isQaRunResult(persisted)).toBe(true);
      expect(readFileSync(summaryPath, 'utf8')).toContain(
        '[View evidence &amp; video](https://github.com/owner/repo/actions/runs/7/artifacts/8)',
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('retains the payload link for a later failure with no registered browser artifacts', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-qa-finalize-empty-artifacts-'));
    try {
      const reportPath = join(scratch, 'report.json');
      const summaryPath = join(scratch, 'summary.md');
      const original = result();
      original.artifacts = [];
      original.outcome = 'blocked';
      original.conclusion = 'failure';
      writeFileSync(reportPath, JSON.stringify(original));
      const execution = spawnSync(
        join(root, 'node_modules', '.bin', 'vite-node'),
        [
          join(root, 'src/cli.ts'),
          'qa-finalize',
          '--report',
          reportPath,
          '--markdown',
          summaryPath,
          '--repo',
          'owner/repo',
          '--pr',
          '42',
          '--finalization-error',
          'final QA report artifact upload failed',
          '--artifact-name',
          'juror-qa-evidence-pr-42-7',
          '--artifact-url',
          'https://github.com/owner/repo/actions/runs/7/artifacts/8',
        ],
        { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
      );

      expect(execution.status, execution.stderr).toBe(0);
      const persisted = JSON.parse(readFileSync(reportPath, 'utf8')) as QaRunResult;
      expect(persisted.outcome).toBe('infrastructure_error');
      expect(persisted.artifacts).toEqual([]);
      expect(readFileSync(summaryPath, 'utf8')).toContain(
        '[View evidence](https://github.com/owner/repo/actions/runs/7/artifacts/8)',
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('separates a semantic product failure from finalizer command failure', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-qa-finalize-product-issue-'));
    try {
      const reportPath = join(scratch, 'report.json');
      const productIssue = productIssueResult();
      writeFileSync(reportPath, JSON.stringify(productIssue));
      const execution = spawnSync(
        join(root, 'node_modules', '.bin', 'vite-node'),
        [
          join(root, 'src/cli.ts'),
          'qa-finalize',
          '--report',
          reportPath,
          '--repo',
          'owner/repo',
          '--pr',
          '42',
          '--artifact-name',
          'juror-qa-evidence-pr-42-7',
          '--artifact-url',
          'https://github.com/owner/repo/actions/runs/7/artifacts/8',
        ],
        { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
      );

      expect(execution.status, execution.stderr).toBe(0);
      const persisted = JSON.parse(readFileSync(reportPath, 'utf8')) as QaRunResult;
      expect(persisted.outcome).toBe('product_issue');
      expect(persisted.conclusion).toBe('failure');
      expect(isQaRunResult(persisted)).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it.each([
    ['passed', 'success'],
    ['product_issue', 'failure'],
    ['cancelled', 'cancelled'],
  ] as const)('fails closed when finalization crashes after %s', (outcome, conclusion) => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-qa-finalize-fallback-'));
    try {
      const reportPath = join(scratch, 'report.json');
      const summaryPath = join(scratch, 'summary.md');
      const outputPath = join(scratch, 'output.txt');
      const original = outcome === 'product_issue' ? productIssueResult() : result();
      original.outcome = outcome;
      original.conclusion = conclusion;
      writeFileSync(reportPath, JSON.stringify(original));
      writeFileSync(summaryPath, 'old summary');
      writeFileSync(outputPath, '');

      const execution = spawnSync(process.execPath, [fallbackScript], {
        cwd: root,
        encoding: 'utf8',
        env: fallbackEnvironment(reportPath, summaryPath, outputPath, {
          JUROR_QA_ACTION_FINALIZATION_ERROR: 'QA finalization command crashed',
        }),
      });

      expect(execution.status, execution.stderr).toBe(0);
      const persisted = JSON.parse(readFileSync(reportPath, 'utf8')) as QaRunResult;
      expect(persisted.outcome).toBe('infrastructure_error');
      expect(persisted.conclusion).toBe('failure');
      expect(isQaRunResult(persisted)).toBe(true);
      expect(persisted.artifacts[0]?.upload).toEqual({
        name: 'juror-qa-evidence-pr-42-7',
        url: 'https://github.com/owner/repo/actions/runs/7/artifacts/8',
      });
      const summary = readFileSync(summaryPath, 'utf8');
      expect(summary).toContain('## 🛑 Juror QA — Infrastructure error');
      expect(summary).toContain('> [!CAUTION]');
      expect(summary).toContain('### Why QA stopped');
      expect(summary).toContain(
        '[View evidence](<https://github.com/owner/repo/actions/runs/7/artifacts/8>)',
      );
      expect(readFileSync(outputPath, 'utf8')).toContain('outcome=infrastructure_error\n');
      expect(readFileSync(outputPath, 'utf8')).toContain('exit-code=1\n');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('synthesizes a schema-shaped infrastructure report when the runtime report is missing', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-qa-finalize-missing-'));
    try {
      const reportPath = join(scratch, 'report.json');
      const summaryPath = join(scratch, 'summary.md');
      const outputPath = join(scratch, 'output.txt');
      writeFileSync(outputPath, '');

      const execution = spawnSync(process.execPath, [fallbackScript], {
        cwd: root,
        encoding: 'utf8',
        env: fallbackEnvironment(reportPath, summaryPath, outputPath, {
          JUROR_QA_ACTION_PAYLOAD_DELIVERED: 'false',
          JUROR_QA_ACTION_FINALIZATION_ERROR: 'QA runtime did not persist a report',
          ARTIFACT_NAME: '',
          ARTIFACT_URL: '',
        }),
      });

      expect(execution.status, execution.stderr).toBe(0);
      const persisted = JSON.parse(readFileSync(reportPath, 'utf8')) as QaRunResult;
      for (const required of QA_RUN_RESULT_JSON_SCHEMA.required) {
        expect(Object.hasOwn(persisted, required), required).toBe(true);
      }
      const policySchema = QA_RUN_RESULT_JSON_SCHEMA.properties['policy_base_shas'] as {
        minItems: number;
        maxItems: number;
        items: { pattern: string };
      };
      expect(persisted.policy_base_shas.length).toBeGreaterThanOrEqual(policySchema.minItems);
      expect(persisted.policy_base_shas.length).toBeLessThanOrEqual(policySchema.maxItems);
      for (const sha of persisted.policy_base_shas) {
        expect(sha).toMatch(new RegExp(policySchema.items.pattern));
      }
      expect(persisted.outcome).toBe('infrastructure_error');
      expect(persisted.conclusion).toBe('failure');
      expect(isQaRunResult(persisted)).toBe(true);
      expect(readFileSync(summaryPath, 'utf8')).toContain('Juror QA — Infrastructure error');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('deletes semantic files when an existing final byte sequence contains a configured canary', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-qa-finalize-fallback-existing-canary-'));
    try {
      const reportPath = join(scratch, 'report.json');
      const summaryPath = join(scratch, 'summary.md');
      const outputPath = join(scratch, 'output.txt');
      const original = finalizeQaEvidence(result(), {
        artifactName: 'juror-qa-evidence-pr-42-7',
        artifactUrl: 'https://github.com/owner/repo/actions/runs/7/artifacts/8',
      });
      const serialized = `${JSON.stringify(original, null, 2)}\n`;
      const canary = serialized.slice(-8);
      writeFileSync(reportPath, serialized);
      writeFileSync(summaryPath, 'final summary');
      writeFileSync(outputPath, '');

      const execution = spawnSync(process.execPath, [fallbackScript], {
        cwd: root,
        encoding: 'utf8',
        env: fallbackEnvironment(reportPath, summaryPath, outputPath, {
          JUROR_QA_ACTION_READ_ONLY: 'true',
          JUROR_QA_SECRETS_B64: secretBundle(canary),
        }),
      });

      expect(execution.status).toBe(1);
      expect(execution.stderr).not.toContain(canary);
      expect(existsSync(reportPath)).toBe(false);
      expect(existsSync(summaryPath)).toBe(false);
      expect(readFileSync(outputPath, 'utf8')).toBe('');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('deletes semantic files when fallback finalization would introduce a configured canary', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-qa-finalize-fallback-new-canary-'));
    try {
      const reportPath = join(scratch, 'report.json');
      const summaryPath = join(scratch, 'summary.md');
      const outputPath = join(scratch, 'output.txt');
      const canary = 'finalization';
      writeFileSync(reportPath, JSON.stringify(result()));
      writeFileSync(summaryPath, 'old summary');
      writeFileSync(outputPath, '');

      const execution = spawnSync(process.execPath, [fallbackScript], {
        cwd: root,
        encoding: 'utf8',
        env: fallbackEnvironment(reportPath, summaryPath, outputPath, {
          JUROR_QA_ACTION_FINALIZATION_ERROR: 'QA finalization command crashed',
          JUROR_QA_SECRETS_B64: secretBundle(canary),
        }),
      });

      expect(execution.status).toBe(1);
      expect(execution.stderr).not.toContain(canary);
      expect(existsSync(reportPath)).toBe(false);
      expect(existsSync(summaryPath)).toBe(false);
      expect(readFileSync(outputPath, 'utf8')).toBe('');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('replaces a parseable partial report instead of preserving an invalid v1 object', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-qa-finalize-partial-'));
    try {
      const reportPath = join(scratch, 'report.json');
      const summaryPath = join(scratch, 'summary.md');
      const outputPath = join(scratch, 'output.txt');
      const partial = result() as unknown as Record<string, unknown>;
      delete partial['merge_sha'];
      delete partial['cleanup'];
      partial['policy_base_shas'] = [];
      writeFileSync(reportPath, JSON.stringify(partial));
      writeFileSync(summaryPath, 'stale summary');
      writeFileSync(outputPath, '');

      const execution = spawnSync(process.execPath, [fallbackScript], {
        cwd: root,
        encoding: 'utf8',
        env: fallbackEnvironment(reportPath, summaryPath, outputPath, {
          JUROR_QA_ACTION_FINALIZATION_ERROR: `finalizer crashed: ${'x'.repeat(1_000)}`,
        }),
      });

      expect(execution.status, execution.stderr).toBe(0);
      const persisted = JSON.parse(readFileSync(reportPath, 'utf8')) as QaRunResult;
      expect(isQaRunResult(persisted)).toBe(true);
      expect(persisted.merge_sha).toBe('0'.repeat(40));
      expect(persisted.policy_base_shas).toEqual(['0'.repeat(40)]);
      expect(persisted.cleanup.status).toBe('not_required');
      expect(persisted.warnings.at(-1)).toHaveLength(500);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it.each([
    ['product_issue', 'failure', '1'],
    ['cancelled', 'cancelled', '130'],
  ] as const)('maps an immutable %s result without rewriting it', (outcome, conclusion, exitCode) => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-qa-finalize-readonly-'));
    try {
      const reportPath = join(scratch, 'report.json');
      const summaryPath = join(scratch, 'summary.md');
      const outputPath = join(scratch, 'output.txt');
      const original = finalizeQaEvidence(outcome === 'product_issue' ? productIssueResult() : result(), {
        artifactName: 'juror-qa-evidence-pr-42-7',
        artifactUrl: 'https://github.com/owner/repo/actions/runs/7/artifacts/8',
      });
      original.outcome = outcome;
      original.conclusion = conclusion;
      const serialized = `${JSON.stringify(original, null, 2)}\n`;
      writeFileSync(reportPath, serialized);
      writeFileSync(summaryPath, 'final summary');
      writeFileSync(outputPath, '');

      const execution = spawnSync(process.execPath, [fallbackScript], {
        cwd: root,
        encoding: 'utf8',
        env: fallbackEnvironment(reportPath, summaryPath, outputPath, {
          JUROR_QA_ACTION_READ_ONLY: 'true',
        }),
      });

      expect(execution.status, execution.stderr).toBe(0);
      expect(readFileSync(reportPath, 'utf8')).toBe(serialized);
      expect(readFileSync(summaryPath, 'utf8')).toBe('final summary');
      expect(readFileSync(outputPath, 'utf8')).toContain(`outcome=${outcome}\n`);
      expect(readFileSync(outputPath, 'utf8')).toContain(`exit-code=${exitCode}\n`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
