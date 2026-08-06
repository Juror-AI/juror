import { describe, expect, it } from 'vitest';
import { clusterFindings, jaccard } from '../src/merge/cluster.js';
import type { AttributedFinding } from '../src/types.js';

const OPTS = { lineWindow: 8, mergeThreshold: 0.55, distinctThreshold: 0.3 };

function finding(over: Partial<AttributedFinding> = {}): AttributedFinding {
  const line = over.line ?? 42;
  return {
    path: 'src/app.ts',
    line,
    end_line: null,
    severity: 'P1',
    title: 'Unawaited promise in shutdown handler',
    body: 'closeConnections() returns a promise that shutdown() never awaits, so the process exits before flush() completes and buffered writes are lost.',
    category: 'correctness',
    confidence: 0.8,
    convention: null,
    modelId: 'model-a',
    modelLabel: 'Model A',
    anchoredLine: over.anchoredLine ?? line,
    anchor: 'exact',
    anchorDrift: 0,
    ...over,
  };
}

describe('jaccard', () => {
  it('is 1 for identical text and 0 when either side is empty', () => {
    expect(jaccard('flushBuffer() is never awaited', 'flushBuffer() is never awaited')).toBe(1);
    expect(jaccard('', 'anything at all')).toBe(0);
    expect(jaccard('the and of', 'to in on')).toBe(0); // stopwords only
  });

  it('weighs identifiers twice as heavily as prose', () => {
    const shared = jaccard('the retryCount value', 'the retryCount limit');
    const prose = jaccard('the alpha value', 'the alpha limit');
    expect(shared).toBeGreaterThan(prose);
  });

  it('keeps negation, so opposite claims do not merge', () => {
    expect(jaccard('the token is checked here', 'the token is not checked here')).toBeLessThan(1);
  });

  it('scores unrelated findings below the distinct threshold', () => {
    const a = 'Unawaited promise in shutdown handler';
    const b = 'Missing index on tenant_id column';
    expect(jaccard(a, b)).toBeLessThan(OPTS.distinctThreshold);
  });
});

describe('clusterFindings', () => {
  it('collapses identical findings from three models into one cluster with agreement 3', () => {
    const findings = [
      finding({ modelId: 'model-a', modelLabel: 'Model A' }),
      finding({ modelId: 'model-b', modelLabel: 'Model B', line: 44, anchoredLine: 44 }),
      finding({ modelId: 'model-c', modelLabel: 'Model C', line: 45, anchoredLine: 45 }),
    ];

    const { clusters, ambiguousPairs } = clusterFindings(findings, OPTS);

    expect(clusters).toHaveLength(1);
    const cluster = clusters[0];
    expect(cluster?.agreement).toBe(3);
    expect(cluster?.modelIds).toEqual(['model-a', 'model-b', 'model-c']);
    expect(cluster?.members).toHaveLength(3);
    expect(cluster?.mergedBy).toEqual(['jaccard']);
    expect(ambiguousPairs).toHaveLength(0);
  });

  it('does not let one model inflate agreement by repeating itself', () => {
    const findings = [
      finding({ modelId: 'model-a', modelLabel: 'Model A' }),
      finding({ modelId: 'model-a', modelLabel: 'Model A', line: 43, anchoredLine: 43 }),
      finding({ modelId: 'model-a', modelLabel: 'Model A', line: 44, anchoredLine: 44 }),
      finding({ modelId: 'model-b', modelLabel: 'Model B', line: 45, anchoredLine: 45 }),
    ];

    const { clusters } = clusterFindings(findings, OPTS);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.members).toHaveLength(4);
    expect(clusters[0]?.agreement).toBe(2);
    expect(clusters[0]?.modelIds).toEqual(['model-a', 'model-b']);
  });

  it('keeps findings on the same file but outside the line window apart', () => {
    const findings = [
      finding({ modelId: 'model-a', line: 10, anchoredLine: 10 }),
      finding({ modelId: 'model-b', modelLabel: 'Model B', line: 400, anchoredLine: 400 }),
    ];

    const { clusters } = clusterFindings(findings, OPTS);
    expect(clusters).toHaveLength(2);
    expect(clusters.every((c) => c.agreement === 1)).toBe(true);
  });

  it('splits the band: merge above, distinct below, ambiguous in between', () => {
    const a = finding({ modelId: 'model-a' });
    const b = finding({
      modelId: 'model-b',
      modelLabel: 'Model B',
      line: 43,
      anchoredLine: 43,
      title: 'Different defect entirely',
      body: 'The tenant_id column has no index, so the dashboard query scans the whole table.',
    });
    const score = jaccard(`${a.title} ${a.body}`, `${b.title} ${b.body}`);

    // Below the distinct threshold: two clusters, nothing for the referee.
    const distinct = clusterFindings([a, b], OPTS);
    expect(score).toBeLessThan(OPTS.distinctThreshold);
    expect(distinct.clusters).toHaveLength(2);
    expect(distinct.ambiguousPairs).toHaveLength(0);

    // Same pair, thresholds moved so the score lands inside the band.
    const banded = clusterFindings([a, b], {
      ...OPTS,
      distinctThreshold: Math.max(0, score - 0.01),
      mergeThreshold: score + 0.01,
    });
    expect(banded.clusters).toHaveLength(2);
    expect(banded.ambiguousPairs).toHaveLength(1);
    expect(banded.ambiguousPairs[0]?.jaccard).toBeCloseTo(score, 10);

    // Same pair again, now above the merge threshold.
    const merged = clusterFindings([a, b], { ...OPTS, mergeThreshold: score - 0.01 });
    expect(merged.clusters).toHaveLength(1);
    expect(merged.ambiguousPairs).toHaveLength(0);
  });

  it('treats a score exactly on a threshold as ambiguous, never as a merge', () => {
    const a = finding({ modelId: 'model-a' });
    const b = finding({ modelId: 'model-b', modelLabel: 'Model B', line: 43, anchoredLine: 43 });
    const score = jaccard(`${a.title} ${a.body}`, `${b.title} ${b.body}`);

    const { clusters, ambiguousPairs } = clusterFindings([a, b], {
      ...OPTS,
      mergeThreshold: score,
      distinctThreshold: score,
    });
    expect(clusters).toHaveLength(2);
    expect(ambiguousPairs).toHaveLength(1);
  });

  it('merges transitively through a shared middle finding', () => {
    const a = finding({ modelId: 'model-a', line: 10, anchoredLine: 10 });
    const b = finding({ modelId: 'model-b', modelLabel: 'Model B', line: 16, anchoredLine: 16 });
    const c = finding({ modelId: 'model-c', modelLabel: 'Model C', line: 22, anchoredLine: 22 });

    // 10 and 22 are more than lineWindow apart, but 16 chains them into one block.
    const { clusters } = clusterFindings([a, c, b], OPTS);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.agreement).toBe(3);
  });

  it('takes canonical fields from the most severe member and keeps the best anchor', () => {
    const findings = [
      finding({
        modelId: 'model-a',
        severity: 'P2',
        confidence: 0.95,
        title: 'Lower severity wording',
        anchor: 'outside-diff',
      }),
      finding({
        modelId: 'model-b',
        modelLabel: 'Model B',
        line: 43,
        anchoredLine: 43,
        severity: 'P0',
        confidence: 0.6,
        title: 'Unawaited promise in shutdown handler',
        category: 'concurrency',
        convention: 'AGENTS.md',
        anchor: 'snapped',
      }),
    ];

    const { clusters } = clusterFindings(findings, OPTS);
    const cluster = clusters[0];

    expect(cluster?.severity).toBe('P0');
    expect(cluster?.title).toBe('Unawaited promise in shutdown handler');
    expect(cluster?.category).toBe('concurrency');
    expect(cluster?.convention).toBe('AGENTS.md');
    expect(cluster?.line).toBe(43);
    expect(cluster?.anchor).toBe('snapped');
    expect(cluster?.maxConfidence).toBeCloseTo(0.95);
  });

  it('gives the same id to the same finding across runs and different ids across files', () => {
    const one = clusterFindings([finding()], OPTS).clusters[0];
    const two = clusterFindings([finding({ confidence: 0.1 })], OPTS).clusters[0];
    const other = clusterFindings([finding({ path: 'src/other.ts' })], OPTS).clusters[0];

    expect(one?.id).toBe(two?.id);
    expect(one?.id).not.toBe(other?.id);
  });

  it('marks a lone finding as a singleton and leaves it unverified', () => {
    const { clusters } = clusterFindings([finding()], OPTS);
    expect(clusters[0]?.mergedBy).toEqual(['singleton']);
    expect(clusters[0]?.agreement).toBe(1);
    expect(clusters[0]?.verification).toBeNull();
    expect(clusters[0]?.published).toBe(false);
    expect(clusters[0]?.suppressedReason).toBeNull();
  });

  it('returns nothing for no findings', () => {
    expect(clusterFindings([], OPTS)).toEqual({ clusters: [], ambiguousPairs: [] });
  });
});
