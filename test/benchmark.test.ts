import { describe, expect, it } from 'vitest';

import {
  evaluateBenchmark,
  parseBenchmarkCorpus,
  renderBenchmark,
} from '../src/benchmark.js';

const corpus = {
  version: 1,
  cases: [
    {
      id: 'example#1',
      expected: [
        { id: 'async', severity: 'P1', title: 'Promise is discarded' },
        { id: 'retry', severity: 'P2', title: 'Retry loops forever' },
        { id: 'nit', severity: 'P3', title: 'Optional cleanup' },
      ],
      runs: [
        {
          reviewer: 'Juror',
          cost_usd: 1.25,
          duration_ms: 125_000,
          findings: [
            { title: 'Promise is discarded', severity: 'P1', expected_id: 'async' },
            { title: 'Awaited promise is lost', severity: 'P1', expected_id: 'async' },
            { title: 'Incorrect speculation', severity: 'P2', expected_id: null },
          ],
        },
      ],
    },
  ],
};

describe('shadow benchmark', () => {
  it('measures recall, precision, duplicates, cost, latency, and misses', () => {
    const result = evaluateBenchmark(parseBenchmarkCorpus(corpus));
    const juror = result.reviewers[0];

    expect(juror).toMatchObject({
      reviewer: 'Juror',
      cases: 1,
      expected: 3,
      found: 1,
      p0ToP2Expected: 2,
      p0ToP2Found: 1,
      reports: 3,
      validReports: 2,
      duplicateReports: 1,
      costUsd: 1.25,
      costPartial: false,
      averageDurationMs: 125_000,
    });
    expect(juror?.recall).toBeCloseTo(1 / 3);
    expect(juror?.p0ToP2Recall).toBeCloseTo(1 / 2);
    expect(juror?.precision).toBeCloseTo(2 / 3);
    expect(juror?.duplicateRate).toBeCloseTo(1 / 2);
    expect(juror?.misses.map((miss) => miss.expectedId)).toEqual(['retry', 'nit']);

    const rendered = renderBenchmark(result);
    expect(rendered).toContain('P0–P2 recall');
    expect(rendered).toContain('50.0% (1/2)');
    expect(rendered).toContain('$1.25');
    expect(rendered).toContain('2m05s');
  });

  it('rejects unadjudicated links to unknown expected findings', () => {
    const invalid = structuredClone(corpus);
    invalid.cases[0]!.runs[0]!.findings[0]!.expected_id = 'not-in-gold-set';
    expect(() => parseBenchmarkCorpus(invalid)).toThrow(/expected_id/);
  });

  it('marks totals as partial when a reviewer cost is unavailable', () => {
    const partial = structuredClone(corpus);
    partial.cases[0]!.runs[0]!.cost_usd = null;
    const metrics = evaluateBenchmark(parseBenchmarkCorpus(partial)).reviewers[0];
    expect(metrics?.costPartial).toBe(true);
    expect(renderBenchmark({ cases: 1, reviewers: [metrics!] })).toContain('≥$0.00');
  });

  it('requires every case to include the same reviewers', () => {
    const mismatched = structuredClone(corpus);
    mismatched.cases.push({
      id: 'example#2',
      expected: [],
      runs: [],
    });
    expect(() => parseBenchmarkCorpus(mismatched)).toThrow(/same reviewers/);
  });
});
