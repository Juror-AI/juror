import { describe, expect, it } from 'vitest';
import { buildCluster, clusterFindings, jaccard } from '../src/merge/cluster.js';
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
    sourceId: over.sourceId ?? `${over.modelId ?? 'model-a'}:1`,
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
    expect(cluster?.mergedBy).toEqual(['exact']);
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

  it('uses similarity only to route possible duplicates to the referee', () => {
    const a = finding({ modelId: 'model-a' });
    const b = finding({
      modelId: 'model-b',
      modelLabel: 'Model B',
      line: 43,
      anchoredLine: 43,
      title: 'Different defect entirely',
      body: 'The tenant_id column has no index, so the dashboard query scans the whole table.',
    });
    // Below the distinct threshold: two clusters, nothing for the referee.
    const distinct = clusterFindings([a, b], OPTS);
    expect(distinct.clusters).toHaveLength(2);
    expect(distinct.ambiguousPairs).toHaveLength(0);

    // Lowering the routing floor sends the pair to the referee.
    const banded = clusterFindings([a, b], {
      ...OPTS,
      distinctThreshold: 0,
      mergeThreshold: 1,
    });
    expect(banded.clusters).toHaveLength(2);
    expect(banded.ambiguousPairs).toHaveLength(1);

    // Even a score above the configured merge threshold is only a candidate. Lexical
    // similarity never silently combines two non-identical defects.
    const high = clusterFindings([a, b], {
      ...OPTS,
      distinctThreshold: 0,
      mergeThreshold: 0,
    });
    expect(high.clusters).toHaveLength(2);
    expect(high.ambiguousPairs).toHaveLength(1);
  });

  it('routes a non-identical high-similarity report instead of merging it', () => {
    const a = finding({ modelId: 'model-a' });
    const b = finding({
      modelId: 'model-b',
      modelLabel: 'Model B',
      line: 43,
      anchoredLine: 43,
      body: `${a.body} The caller also logs the failure.`,
    });

    const { clusters, ambiguousPairs } = clusterFindings([a, b], {
      ...OPTS,
      distinctThreshold: 0,
    });
    expect(clusters).toHaveLength(2);
    expect(ambiguousPairs).toHaveLength(1);
  });

  it('routes a systemic duplicate anchored in different files to the referee', () => {
    const hook = finding({
      path: 'apps/packages/conversation/hooks/useActiveConversation.ts',
      title: 'Duplicated ZenoChat modules land without consumers',
      body:
        'All added files are copies of existing live modules, yet nothing imports the new copies, creating two drifting sources of truth.',
    });
    const util = finding({
      sourceId: 'model-b:1',
      modelId: 'model-b',
      modelLabel: 'Model B',
      path: 'apps/packages/conversation/utils/zenochat/conversationResumeContext.ts',
      title: 'PR duplicates existing live modules with no consumer',
      body: 'This violates the repo reuse-before-create convention.',
    });

    const { clusters, ambiguousPairs } = clusterFindings([hook, util], OPTS);
    expect(clusters).toHaveLength(2);
    expect(ambiguousPairs).toHaveLength(1);
  });

  it('does not compare unrelated cross-file findings on generic prose alone', () => {
    const promise = finding({ path: 'src/shutdown.ts' });
    const query = finding({
      sourceId: 'model-b:1',
      modelId: 'model-b',
      modelLabel: 'Model B',
      path: 'src/query.ts',
      title: 'Dashboard query scans every tenant row',
      body: 'The tenant_id column lacks an index, so each request scans the complete table.',
    });

    expect(clusterFindings([promise, query], OPTS).ambiguousPairs).toHaveLength(0);
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
    const claim = {
      trigger: 'shutdown begins with buffered writes',
      mechanism: 'shutdown() does not await closeConnections()',
      consequence: 'the process exits before flush() completes',
      fix: 'await closeConnections() before exiting',
    };
    const findings = [
      finding({
        modelId: 'model-a',
        severity: 'P2',
        confidence: 0.95,
        title: 'Lower severity wording',
        claim,
        line: 42,
        anchoredLine: 42,
        anchor: 'exact',
      }),
      finding({
        modelId: 'model-b',
        modelLabel: 'Model B',
        line: 43,
        anchoredLine: 43,
        severity: 'P0',
        confidence: 0.6,
        title: 'Unawaited promise in shutdown handler',
        claim,
        category: 'concurrency',
        convention: 'AGENTS.md',
        anchor: 'outside-diff',
      }),
    ];

    const { clusters } = clusterFindings(findings, OPTS);
    const cluster = clusters[0];

    expect(cluster?.severity).toBe('P0');
    expect(cluster?.title).toBe('Unawaited promise in shutdown handler');
    expect(cluster?.category).toBe('concurrency');
    expect(cluster?.convention).toBe('AGENTS.md');
    expect(cluster?.line).toBe(42);
    expect(cluster?.anchor).toBe('exact');
    expect(cluster?.maxConfidence).toBeCloseTo(0.95);
  });

  it('keeps a cross-file anchor line attached to the file that supplied it', () => {
    const strongest = finding({
      path: 'src/summary.ts',
      line: 900,
      anchoredLine: 900,
      severity: 'P0',
      anchor: 'outside-diff',
    });
    const located = finding({
      sourceId: 'model-b:1',
      modelId: 'model-b',
      modelLabel: 'Model B',
      path: 'src/implementation.ts',
      line: 42,
      anchoredLine: 42,
      severity: 'P2',
      anchor: 'exact',
    });

    const cluster = buildCluster([strongest, located], ['referee']);

    expect(cluster).toMatchObject({ path: 'src/implementation.ts', line: 42, anchor: 'exact' });
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
