/**
 * Lossless post-merge accounting.
 *
 * Atomic review findings are the unit of recall. Clustering may change how many comments
 * are rendered, but it must never make one of those units disappear. This module proves
 * that every source id belongs to exactly one final cluster and records whether that
 * cluster was published or explicitly suppressed.
 */

import type {
  AttributedFinding,
  Cluster,
  FindingCoverage,
  FindingDisposition,
} from '../types.js';

export interface MembershipAudit {
  complete: boolean;
  accountedFor: number;
  problems: string[];
}

export function auditClusterMembership(
  findings: readonly AttributedFinding[],
  clusters: readonly Cluster[],
): MembershipAudit {
  const expected = new Map<string, AttributedFinding>();
  const problems: string[] = [];

  for (const finding of findings) {
    if (expected.has(finding.sourceId)) {
      problems.push(`duplicate raw source id ${finding.sourceId}`);
    } else {
      expected.set(finding.sourceId, finding);
    }
  }

  const counts = new Map<string, number>();
  for (const cluster of clusters) {
    for (const member of cluster.members) {
      if (!expected.has(member.sourceId)) {
        problems.push(`cluster ${cluster.id} contains unknown source id ${member.sourceId}`);
        continue;
      }
      counts.set(member.sourceId, (counts.get(member.sourceId) ?? 0) + 1);
    }
  }

  let accountedFor = 0;
  for (const id of expected.keys()) {
    const count = counts.get(id) ?? 0;
    if (count === 1) accountedFor++;
    else if (count === 0) problems.push(`raw finding ${id} is missing from every cluster`);
    else problems.push(`raw finding ${id} appears in ${count} clusters`);
  }

  return {
    complete: problems.length === 0 && accountedFor === findings.length,
    accountedFor,
    problems,
  };
}

export function buildFindingCoverage(
  findings: readonly AttributedFinding[],
  clusters: readonly Cluster[],
): FindingCoverage {
  const audit = auditClusterMembership(findings, clusters);
  const owner = new Map<string, Cluster>();
  for (const cluster of clusters) {
    for (const member of cluster.members) {
      if (!owner.has(member.sourceId)) owner.set(member.sourceId, cluster);
    }
  }

  const dispositions: FindingDisposition[] = [];
  for (const finding of findings) {
    const cluster = owner.get(finding.sourceId);
    if (!cluster) continue;
    dispositions.push({
      sourceId: finding.sourceId,
      modelId: finding.modelId,
      modelLabel: finding.modelLabel,
      path: finding.path,
      line: finding.anchoredLine,
      title: finding.title,
      clusterId: cluster.id,
      outcome: cluster.published ? 'published' : 'suppressed',
      reason: cluster.published ? null : suppressionReason(cluster),
    });
  }

  return {
    complete: audit.complete,
    rawFindings: findings.length,
    accountedFor: audit.accountedFor,
    uniqueFindings: clusters.length,
    dispositions,
    problems: audit.problems,
  };
}

function suppressionReason(cluster: Cluster): string {
  if (cluster.verification?.refuted) {
    const detail = cluster.verification.reason.trim();
    return detail ? `refuted on verification: ${detail}` : 'refuted on verification';
  }
  return cluster.suppressedReason ?? 'suppressed by publish rules';
}
