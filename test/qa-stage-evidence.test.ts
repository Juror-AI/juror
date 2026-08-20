import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { stageEvidencePayload } from '../qa/stage-evidence.mjs';
import type { QaArtifact, QaArtifactKind, QaPlan, QaRunResult } from '../src/qa/types.js';

function sha256(body: string | Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function artifact(id: string, kind: QaArtifactKind, path: string, body: string | Buffer): QaArtifact {
  return {
    id,
    kind,
    path,
    sanitized: true,
    sha256: sha256(body),
    retention_days: 7,
    upload: null,
  };
}

function result(artifacts: QaArtifact[], options: { noTestable?: boolean } = {}): QaRunResult {
  const startedAt = '2026-08-19T00:00:00.000Z';
  const noTestablePlan: QaPlan = {
    schema_version: 1,
    impact_assessment: 'The merged change has no browser-testable surface.',
    testability: 'no_testable_surface',
    no_testable_surface_reason: 'Only repository documentation changed.',
    surfaces: [],
    scenarios: [],
    risk_notes: [],
    blind_spots: [],
  };
  const browserPlan: QaPlan = {
    schema_version: 1,
    impact_assessment: 'The browser-visible control changed.',
    testability: 'testable',
    no_testable_surface_reason: null,
    surfaces: ['composer'],
    scenarios: [{
      id: 'composer-check',
      title: 'Composer remains visible',
      rationale: 'The changed control must remain available to users.',
      viewport: { kind: 'desktop', width: 1280, height: 720, justification: 'Default browser viewport.' },
      preconditions: [],
      seeded_state: [],
      checkpoints: [{
        id: 'composer-visible',
        description: 'Composer is visible',
        expected: 'Composer is visible',
        assertion: {
          kind: 'visible',
          locator: { by: 'role', value: 'textbox', name: 'Composer', exact: true, nth: null },
          url_contains: null,
        },
      }],
      allowed_mutations: ['none'],
      cleanup_expectations: [],
    }],
    risk_notes: [],
    blind_spots: [],
  };
  return {
    schema_version: 1,
    run_id: 'owner-repo-42-stage',
    repository: 'owner/repo',
    pr_number: 42,
    merge_sha: 'a'.repeat(40),
    base_resolution: 'exact',
    source_base_sha: 'b'.repeat(40),
    policy_base_shas: ['b'.repeat(40)],
    started_at: startedAt,
    completed_at: '2026-08-19T00:00:01.000Z',
    duration_ms: 1_000,
    outcome: options.noTestable ? 'no_testable_surface' : 'passed',
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
      resolved_at: startedAt,
      ready_at: '2026-08-19T00:00:01.000Z',
    },
    plan: options.noTestable ? noTestablePlan : browserPlan,
    attempts: options.noTestable ? [] : [{
      scenario_id: 'composer-check',
      attempt: 1,
      status: 'passed',
      started_at: startedAt,
      duration_ms: 1_000,
      operations: [],
      checkpoints: [{
        checkpoint_id: 'composer-visible',
        status: 'passed',
        expected: 'Composer is visible',
        observed: 'Composer is visible',
      }],
      observations: [],
      evidence_artifact_ids: [],
    }],
    issues: [],
    cleanup: { status: 'not_required', summary: 'No browser state was changed.', error: null },
    artifacts,
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

function writeRelative(root: string, relative: string, body: string | Buffer): void {
  const target = join(root, ...relative.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
}

function complete(root: string, report: QaRunResult): void {
  writeFileSync(join(root, 'payload-status.json'), JSON.stringify({
    schema_version: 1,
    report_present: true,
    runtime_status: 0,
  }));
  writeFileSync(join(root, 'report.json'), JSON.stringify(report));
}

function files(root: string, prefix = ''): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? files(join(root, entry.name), relative) : [relative];
  }).sort();
}

describe('stageEvidencePayload', () => {
  it('atomically stages only hash-verified report-ledger files', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-stage-evidence-normal-'));
    try {
      const evidence = join(scratch, 'evidence');
      const staged = join(scratch, 'staged');
      mkdirSync(evidence);
      const planBody = '{"schema_version":1}\n';
      const operationsBody = '{"sequence":1}\n';
      const videoBody = Buffer.from('playwright video fixture');
      const ledger = [
        artifact('artifact-1', 'plan', 'plan.json', planBody),
        artifact(
          'artifact-2',
          'ledger',
          'scenarios/smoke/attempt-1/operations.ndjson',
          operationsBody,
        ),
        artifact(
          'artifact-3',
          'video',
          'scenarios/smoke/attempt-1/page@0123456789abcdef0123456789abcdef.webm',
          videoBody,
        ),
      ];
      writeRelative(evidence, ledger[0]!.path, planBody);
      writeRelative(evidence, ledger[1]!.path, operationsBody);
      writeRelative(evidence, ledger[2]!.path, videoBody);
      writeFileSync(join(evidence, 'summary.md'), 'semantic summary must stay separate');
      writeFileSync(join(evidence, 'unregistered.txt'), 'not in the report ledger');
      complete(evidence, result(ledger));

      const stagedResult = await stageEvidencePayload(evidence, staged, {
        secretsB64: Buffer.from(JSON.stringify({ QA_PASSWORD: 'different-secret' })).toString('base64'),
      });

      expect(stagedResult.files).toEqual(ledger.map((entry) => entry.path));
      expect(files(staged)).toEqual([
        'plan.json',
        'scenarios/smoke/attempt-1/operations.ndjson',
        'scenarios/smoke/attempt-1/page@0123456789abcdef0123456789abcdef.webm',
      ]);
      expect(readFileSync(join(staged, 'plan.json'), 'utf8')).toBe(planBody);
      expect(files(staged)).not.toContain('payload-status.json');
      expect(files(staged)).not.toContain('report.json');
      expect(files(staged)).not.toContain('summary.md');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('accepts a completed no-testable-surface report with ledger evidence', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-stage-evidence-no-surface-'));
    try {
      const evidence = join(scratch, 'evidence');
      const staged = join(scratch, 'staged');
      mkdirSync(evidence);
      const planBody = JSON.stringify({ testability: 'no_testable_surface' });
      const planArtifact = artifact('artifact-1', 'plan', 'plan.json', planBody);
      writeRelative(evidence, planArtifact.path, planBody);
      complete(evidence, result([planArtifact], { noTestable: true }));

      await expect(stageEvidencePayload(evidence, staged)).resolves.toMatchObject({
        files: ['plan.json'],
      });
      expect(files(staged)).toEqual(['plan.json']);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('stages a static upload sentinel for a completed pre-browser result without artifacts', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-stage-evidence-empty-'));
    try {
      const evidence = join(scratch, 'evidence');
      const staged = join(scratch, 'staged');
      mkdirSync(evidence);
      const blocked = result([]);
      blocked.outcome = 'blocked';
      blocked.conclusion = 'failure';
      blocked.target = null;
      blocked.plan = null;
      blocked.attempts = [];
      complete(evidence, blocked);

      await expect(stageEvidencePayload(evidence, staged)).resolves.toMatchObject({
        files: ['payload-empty.json'],
      });
      expect(files(staged)).toEqual(['payload-empty.json']);
      expect(readFileSync(join(staged, 'payload-empty.json'), 'utf8')).toBe(
        '{"schema_version":1,"artifacts":[]}\n',
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('rejects a partial plan without a completed marker and report, leaving no staged payload', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-stage-evidence-partial-'));
    try {
      const evidence = join(scratch, 'evidence');
      const staged = join(scratch, 'staged');
      mkdirSync(evidence);
      mkdirSync(staged);
      writeFileSync(join(staged, 'stale.webm'), 'stale payload');
      writeFileSync(join(evidence, 'plan.json'), '{"partial":true}');
      writeFileSync(join(evidence, 'payload-status.json'), JSON.stringify({
        schema_version: 1,
        report_present: false,
        runtime_status: null,
      }));

      await expect(stageEvidencePayload(evidence, staged)).rejects.toThrow();
      expect(existsSync(staged)).toBe(false);

      writeFileSync(join(evidence, 'payload-status.json'), JSON.stringify({
        schema_version: 1,
        report_present: true,
        runtime_status: 1,
      }));
      writeFileSync(join(evidence, 'report.json'), '{"schema_version":1}');
      await expect(stageEvidencePayload(evidence, staged)).rejects.toThrow('invalid_report');
      expect(existsSync(staged)).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('rejects duplicate object keys in the completion marker and nested report data', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-stage-evidence-duplicate-json-'));
    try {
      const evidence = join(scratch, 'evidence');
      const staged = join(scratch, 'staged');
      mkdirSync(evidence);
      writeFileSync(
        join(evidence, 'payload-status.json'),
        '{"schema_version":1,"report_present":true,"runtime_status":0,"runtime_status":0}',
      );
      writeFileSync(join(evidence, 'report.json'), JSON.stringify(result([])));

      await expect(stageEvidencePayload(evidence, staged)).rejects.toThrow('invalid_payload_marker');
      expect(existsSync(staged)).toBe(false);

      writeFileSync(join(evidence, 'payload-status.json'), JSON.stringify({
        schema_version: 1,
        report_present: true,
        runtime_status: 0,
      }));
      const duplicateNestedKey = JSON.stringify(result([])).replace(
        '"cleanup":{"status":"not_required"',
        '"cleanup":{"status":"not_required","status":"not_required"',
      );
      writeFileSync(join(evidence, 'report.json'), duplicateNestedKey);

      await expect(stageEvidencePayload(evidence, staged)).rejects.toThrow('invalid_report');
      expect(existsSync(staged)).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('rejects a missing or hash-mismatched report-ledger file and stages nothing', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-stage-evidence-hash-'));
    try {
      const evidence = join(scratch, 'evidence');
      const staged = join(scratch, 'staged');
      mkdirSync(evidence);
      const expected = 'original operation\n';
      const operation = artifact(
        'artifact-1',
        'ledger',
        'scenarios/smoke/attempt-1/operations.ndjson',
        expected,
      );
      complete(evidence, result([operation]));

      await expect(stageEvidencePayload(evidence, staged)).rejects.toThrow('invalid_artifact_file');
      expect(existsSync(staged)).toBe(false);

      writeRelative(evidence, operation.path, 'tampered operation\n');
      await expect(stageEvidencePayload(evidence, staged)).rejects.toThrow('artifact_hash_mismatch');
      expect(existsSync(staged)).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('rejects an intermediate artifact-directory symlink that resolves inside evidence', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-stage-evidence-symlink-'));
    try {
      const evidence = join(scratch, 'evidence');
      const staged = join(scratch, 'staged');
      const scenarios = join(evidence, 'scenarios');
      const realAttempt = join(scenarios, 'real-smoke', 'attempt-1');
      mkdirSync(realAttempt, { recursive: true });
      const body = '{"sequence":1}\n';
      writeFileSync(join(realAttempt, 'operations.ndjson'), body);
      symlinkSync('real-smoke', join(scenarios, 'smoke'), 'dir');
      const operation = artifact(
        'artifact-1',
        'ledger',
        'scenarios/smoke/attempt-1/operations.ndjson',
        body,
      );
      complete(evidence, result([operation]));

      await expect(stageEvidencePayload(evidence, staged)).rejects.toThrow('invalid_artifact_file');
      expect(existsSync(staged)).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('rejects a correctly hashed artifact containing a configured canary', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'juror-stage-evidence-canary-'));
    try {
      const evidence = join(scratch, 'evidence');
      const staged = join(scratch, 'staged');
      mkdirSync(evidence);
      const canary = 'qa-secret-canary-123';
      // Place the canary across the stager's 64 KiB read boundary.
      const body = Buffer.concat([Buffer.alloc(65_530, 0x61), Buffer.from(canary), Buffer.from(' after')]);
      const operation = artifact(
        'artifact-1',
        'ledger',
        'scenarios/smoke/attempt-1/operations.ndjson',
        body,
      );
      writeRelative(evidence, operation.path, body);
      complete(evidence, result([operation]));

      await expect(stageEvidencePayload(evidence, staged, {
        secretsB64: Buffer.from(JSON.stringify({ QA_PASSWORD: canary })).toString('base64'),
      })).rejects.toThrow('artifact_contains_canary');
      expect(existsSync(staged)).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
