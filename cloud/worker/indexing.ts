import type { HostedReviewReportV1 } from '../../src/cloud/types';
import type { QaRunResult } from '../../src/qa/types';
import type { Env } from './env';

const encoder = new TextEncoder();

async function shortHash(material: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(material));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

export async function indexReviewFindings(env: Env, runId: string, report: HostedReviewReportV1): Promise<number> {
  const run = await env.DB.prepare('SELECT workspace_id, repository_id, pr_number, revision_sha FROM run WHERE id = ?').bind(runId).first<{ workspace_id: string; repository_id: string; pr_number: number; revision_sha: string }>();
  if (!run) throw new Error('Run missing while indexing review');
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  const published = new Set(report.publishedFingerprints);
  const publishedClusters = report.clusters.filter((cluster) => published.has(cluster.fingerprint));
  for (const cluster of publishedClusters) {
    const findingId = `finding_${run.repository_id}_${cluster.fingerprint}`;
    statements.push(env.DB.prepare(`INSERT INTO finding (id, workspace_id, repository_id, fingerprint, source, severity, status, title, body, path_or_checkpoint, line, claim_json, agreement_count, agreement_total, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, 'review', ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, repository_id, source, fingerprint) DO UPDATE SET severity = excluded.severity, title = excluded.title, body = excluded.body, path_or_checkpoint = excluded.path_or_checkpoint, line = excluded.line, claim_json = excluded.claim_json, agreement_count = excluded.agreement_count, agreement_total = excluded.agreement_total, last_seen_at = excluded.last_seen_at, status = CASE WHEN finding.status = 'resolved' THEN 'open' ELSE finding.status END, resolved_at = CASE WHEN finding.status = 'resolved' THEN NULL ELSE finding.resolved_at END`)
      .bind(findingId, run.workspace_id, run.repository_id, cluster.fingerprint, cluster.severity, cluster.title, '', cluster.path, cluster.line, null, cluster.modelIds.length, report.models.length, now, now));
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO finding_occurrence (finding_id, run_id, pr_number, revision_sha, details_json, seen_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(findingId, runId, run.pr_number, run.revision_sha, '{}', now));
  }
  if (statements.length > 0) await env.DB.batch(statements);
  await env.DB.prepare('UPDATE run SET findings_count = ?, updated_at = ? WHERE id = ?').bind(publishedClusters.length, now, runId).run();
  return publishedClusters.length;
}

export async function indexQaFindings(env: Env, runId: string, report: QaRunResult): Promise<number> {
  const run = await env.DB.prepare('SELECT workspace_id, repository_id, pr_number, revision_sha FROM run WHERE id = ?').bind(runId).first<{ workspace_id: string; repository_id: string; pr_number: number; revision_sha: string }>();
  if (!run) throw new Error('Run missing while indexing QA');
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const issue of report.issues) {
    const fingerprint = await shortHash(`${run.repository_id}\n${issue.scenario_id}\n${issue.checkpoint_id}\n${issue.expected}`);
    const findingId = `finding_${run.repository_id}_${fingerprint}`;
    statements.push(env.DB.prepare(`INSERT INTO finding (id, workspace_id, repository_id, fingerprint, source, severity, status, title, body, path_or_checkpoint, expected, actual, reproducible, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, 'qa', ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, repository_id, source, fingerprint) DO UPDATE SET severity = excluded.severity, title = excluded.title, body = excluded.body, expected = excluded.expected, actual = excluded.actual, reproducible = excluded.reproducible, last_seen_at = excluded.last_seen_at, status = CASE WHEN finding.status = 'resolved' THEN 'open' ELSE finding.status END, resolved_at = CASE WHEN finding.status = 'resolved' THEN NULL ELSE finding.resolved_at END`)
      .bind(findingId, run.workspace_id, run.repository_id, fingerprint, issue.severity, issue.title, '', `${issue.scenario_id} / ${issue.checkpoint_id}`, null, null, issue.reproducible ? 1 : 0, now, now));
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO finding_occurrence (finding_id, run_id, pr_number, revision_sha, details_json, seen_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(findingId, runId, run.pr_number, run.revision_sha, JSON.stringify({ scenarioId: issue.scenario_id, checkpointId: issue.checkpoint_id }), now));
  }
  if (statements.length > 0) await env.DB.batch(statements);
  await env.DB.prepare('UPDATE run SET findings_count = ?, updated_at = ? WHERE id = ?').bind(report.issues.length, now, runId).run();
  return report.issues.length;
}
