import { describe, expect, it } from 'vitest';
import {
  boundRunEventMessage,
  MAX_RUN_EVENT_MESSAGE_LENGTH,
  sanitizeHostedReviewResult,
} from '../src/cloud/types.js';
import type { ReviewResult } from '../src/types.js';

function reviewFixture(): ReviewResult {
  const cluster = {
    id: 'cluster-1',
    path: 'src/checkout.ts',
    line: 42,
    endLine: null,
    severity: 'P1' as const,
    category: 'correctness' as const,
    title: 'Retries charge the card twice',
    body: 'The retry path repeats the charge.',
    convention: null,
    modelIds: ['model-1'],
    modelLabels: ['Model One'],
    agreement: 1,
    members: [],
    anchor: 'exact' as const,
    maxConfidence: 0.94,
    mergedBy: ['singleton' as const],
    verification: null,
    published: true,
    suppressedReason: null,
  };
  return {
    diff: {
      patch: 'SECRET SOURCE PATCH',
      files: [{
        path: 'src/checkout.ts',
        previousPath: null,
        status: 'modified',
        additions: 4,
        deletions: 1,
        hunks: [{ oldStart: 40, oldLines: 2, newStart: 40, newLines: 5 }],
        changedLines: [42],
        positionByLine: new Map([[42, 8]]),
        ignored: false,
      }],
      baseSha: 'base',
      headSha: 'head',
      sinceSha: null,
      totalAdditions: 4,
      totalDeletions: 1,
      ignoredPaths: [],
      truncated: false,
    },
    runs: [{
      modelId: 'model-1',
      modelLabel: 'Model One',
      harness: 'codex',
      harnessLabel: 'Codex',
      pricingKey: 'model-1',
      ok: true,
      skipped: false,
      skipReason: null,
      result: {
        report: {
          merge_confidence: 0.8,
          confidence_reason: 'Looks safe',
          summary: 'One issue',
          highlights: [],
          file_overviews: [],
          async_contracts: [],
          sequence_diagram: null,
          findings: [],
        },
        usage: { uncachedIn: 10, cacheRead: 0, cacheWrite: 0, out: 4 },
        reportedCostUsd: 0.02,
        turns: 2,
        truncated: false,
        rawText: 'PRIVATE MODEL SCRATCH',
        diagnostics: ['PRIVATE HARNESS STDERR'],
      },
      cost: { usd: 0.02, source: 'reported', longContext: false },
      durationMs: 200,
      error: 'PRIVATE PROCESS ERROR',
    }],
    clusters: [cluster],
    published: [cluster],
    suppressed: [],
    coverage: { complete: true, rawFindings: 1, accountedFor: 1, uniqueFindings: 1, dispositions: [], problems: [] },
    verdict: { base: 0.8, penalty: 0.2, score: 0.6, votes: [], confirmed: { P0: 0, P1: 1, P2: 0, P3: 0 } },
    summary: { summary: 'One issue', highlights: [], fileOverviews: [], sequenceDiagram: null, confidenceReason: 'Looks safe' },
    totals: { rows: [], usage: { uncachedIn: 10, cacheRead: 0, cacheWrite: 0, out: 4 }, usd: 0.02, partial: false, modelsRun: 1 },
    durationMs: 250,
    warnings: [],
  };
}

describe('hosted report contract', () => {
  it('drops source patches, diff positions, and raw model text', () => {
    const report = sanitizeHostedReviewResult(reviewFixture());
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain('SECRET SOURCE PATCH');
    expect(serialized).not.toContain('PRIVATE MODEL SCRATCH');
    expect(serialized).not.toContain('PRIVATE HARNESS STDERR');
    expect(serialized).not.toContain('PRIVATE PROCESS ERROR');
    expect(serialized).not.toContain('positionByLine');
    expect(report.clusters[0]?.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(report.publishedFingerprints).toEqual([report.clusters[0]?.fingerprint]);
  });

  it('normalizes and bounds progress messages', () => {
    const message = boundRunEventMessage(`  checking\n${'x'.repeat(300)}  `);
    expect(message).toHaveLength(MAX_RUN_EVENT_MESSAGE_LENGTH);
    expect(message).not.toContain('\n');
    expect(message.endsWith('…')).toBe(true);
  });
});
