import { describe, expect, it } from 'vitest';

import { buildCluster } from '../src/merge/cluster.js';
import { auditClusterMembership, buildFindingCoverage } from '../src/merge/coverage.js';
import type { AttributedFinding, Cluster } from '../src/types.js';

function finding(sourceId: string, over: Partial<AttributedFinding> = {}): AttributedFinding {
  return {
    sourceId,
    path: 'src/app.ts',
    line: 42,
    end_line: null,
    severity: 'P1',
    title: `Finding ${sourceId}`,
    body: 'A reachable defect has an observable consequence.',
    category: 'correctness',
    confidence: 0.8,
    convention: null,
    modelId: sourceId.split(':')[0] ?? 'model',
    modelLabel: sourceId.split(':')[0] ?? 'model',
    anchoredLine: 42,
    anchor: 'exact',
    anchorDrift: 0,
    ...over,
  };
}

function published(cluster: Cluster): Cluster {
  return { ...cluster, published: true };
}

describe('post-merge finding coverage', () => {
  it('accounts for every raw finding through one published merged cluster', () => {
    const raw = [finding('a:1'), finding('b:1')];
    const cluster = published(buildCluster(raw, ['referee']));

    const coverage = buildFindingCoverage(raw, [cluster]);

    expect(coverage).toMatchObject({
      complete: true,
      rawFindings: 2,
      accountedFor: 2,
      uniqueFindings: 1,
    });
    expect(coverage.dispositions).toHaveLength(2);
    expect(coverage.dispositions.every((item) => item.outcome === 'published')).toBe(true);
    expect(new Set(coverage.dispositions.map((item) => item.clusterId)).size).toBe(1);
  });

  it('records an explicit reason for every suppressed source finding', () => {
    const raw = [finding('a:1')];
    const cluster = {
      ...buildCluster(raw, ['singleton']),
      suppressedReason: 'below agreement threshold',
    };

    const coverage = buildFindingCoverage(raw, [cluster]);

    expect(coverage.complete).toBe(true);
    expect(coverage.dispositions[0]).toMatchObject({
      sourceId: 'a:1',
      outcome: 'suppressed',
      reason: 'below agreement threshold',
    });
  });

  it('fails when a raw finding disappears during merging', () => {
    const kept = finding('a:1');
    const missing = finding('b:1');
    const audit = auditClusterMembership([kept, missing], [buildCluster([kept], ['singleton'])]);

    expect(audit.complete).toBe(false);
    expect(audit.accountedFor).toBe(1);
    expect(audit.problems).toContain('raw finding b:1 is missing from every cluster');
  });

  it('fails when a raw finding is assigned to more than one cluster', () => {
    const raw = finding('a:1');
    const audit = auditClusterMembership(
      [raw],
      [buildCluster([raw], ['singleton']), buildCluster([raw], ['singleton'])],
    );

    expect(audit.complete).toBe(false);
    expect(audit.accountedFor).toBe(0);
    expect(audit.problems).toContain('raw finding a:1 appears in 2 clusters');
  });
});
