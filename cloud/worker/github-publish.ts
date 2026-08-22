import type { HostedReviewReportV1 } from '../../src/cloud/types';
import type { HostedClusterV1 } from '../../src/cloud/types';
import type { Env } from './env';
import { githubApi } from './github';

const SUMMARY_MARKER = '<!-- juror-cloud:summary:v1 -->';
const MAX_COMMENT_CHARS = 65_000;
const MAX_INLINE_COMMENTS = 20;
const SEVERITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 } as const;
const SECRET_PATTERNS = [
  /\bsk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/g,
  /\bsk-proj-[A-Za-z0-9_-]{20,}/g,
  /\bsk-or-v1-[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9]{32,}/g,
  /\bxai-[A-Za-z0-9]{20,}/g,
  /\bfw_[A-Za-z0-9]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /\bAIza[A-Za-z0-9_-]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

interface PublicationContext {
  repository: string;
  prNumber: number;
  revisionSha: string;
  installationId: number;
}

function safeModelText(value: string, maximum = 8_000): string {
  let safe = value.slice(0, maximum);
  for (const pattern of SECRET_PATTERNS) safe = safe.replace(pattern, '[redacted]');
  return safe
    .replace(/<!--/g, '&lt;!--')
    .replace(/<\/(details|summary)>/gi, '&lt;/$1&gt;')
    .replace(/@(?=[A-Za-z0-9_-])/g, '@\u200b')
    .trim();
}

function oneLine(value: string, maximum = 500): string {
  return safeModelText(value, maximum).replace(/`{3,}/g, '`').replace(/[\r\n]+/g, ' ').trim();
}

function code(value: string): string { return `\`${value.replace(/`/g, '\u02cb')}\``; }

function publishedClusters(report: HostedReviewReportV1): HostedClusterV1[] {
  const published = new Set(report.publishedFingerprints);
  return report.clusters
    .filter((cluster) => published.has(cluster.fingerprint))
    .sort((left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] || right.agreement - left.agreement || left.path.localeCompare(right.path) || left.line - right.line);
}

export function renderHostedSummary(report: HostedReviewReportV1, runUrl: string): string {
  const clusters = publishedClusters(report);
  const models = Math.max(1, report.models.filter((model) => !model.skipped).length);
  const findings = clusters.slice(0, 50).map((cluster) => {
    const location = cluster.path ? ` — ${code(`${cluster.path}:${cluster.line}`)}` : '';
    return `- **${cluster.severity} · ${oneLine(cluster.title)}**${location} · ${cluster.agreement}/${models} models`;
  });
  const omitted = clusters.length - findings.length;
  const cost = report.totals.usd === null ? 'partial receipt' : `$${report.totals.usd.toFixed(4)}`;
  const blocks = [
    `${SUMMARY_MARKER}\n### Juror Cloud review`,
    oneLine(report.summary.summary, 2_000) || 'The review completed without a model summary.',
    `**Merge confidence:** ${report.verdict.score}/5 · **Findings:** ${clusters.length} · **Cost:** ${cost}`,
  ];
  if (findings.length) blocks.push(`#### Findings\n\n${findings.join('\n')}${omitted > 0 ? `\n- ${omitted} additional finding${omitted === 1 ? '' : 's'} in Juror Cloud` : ''}`);
  else blocks.push('No publishable findings were reported.');
  blocks.push(`[Open the sanitized report in Juror Cloud](${runUrl})`);
  return blocks.join('\n\n').slice(0, MAX_COMMENT_CHARS);
}

function inlineBody(cluster: HostedClusterV1, modelCount: number): string {
  const marker = `<!-- juror:finding:${cluster.fingerprint.replace(/[^a-zA-Z0-9_-]/g, '')} -->`;
  const body = safeModelText(cluster.body, 6_000);
  const fences = body.match(/`{3,}/g)?.length ?? 0;
  const closedBody = fences % 2 === 0 ? body : `${body}\n\`\`\``;
  return `${marker}\n**${cluster.severity} · ${oneLine(cluster.title)}**\n\n${closedBody}\n\n<sub>${cluster.agreement}/${modelCount} models${cluster.verification && !cluster.verification.refuted ? ' · verified' : ''}</sub>`;
}

function repoPath(repository: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid publication repository');
  return repository.split('/').map(encodeURIComponent).join('/');
}

async function responseJson<T>(response: Response, operation: string): Promise<T> {
  if (!response.ok) throw new Error(`GitHub ${operation} failed (${response.status})`);
  return response.json<T>();
}

async function upsertSummary(env: Env, context: PublicationContext, body: string): Promise<void> {
  const path = repoPath(context.repository);
  for (let page = 1; page <= 5; page += 1) {
    const comments = await responseJson<Array<{ id: number; body?: string }>>(await githubApi(env, context.installationId, `/repos/${path}/issues/${context.prNumber}/comments?per_page=100&page=${page}`), 'comment listing');
    for (const comment of comments) {
      if (!comment.body?.includes(SUMMARY_MARKER)) continue;
      const updated = await githubApi(env, context.installationId, `/repos/${path}/issues/comments/${comment.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }) });
      if (updated.ok) return;
      if (updated.status !== 403 && updated.status !== 404) throw new Error(`GitHub summary update failed (${updated.status})`);
    }
    if (comments.length < 100) break;
  }
  await responseJson(await githubApi(env, context.installationId, `/repos/${path}/issues/${context.prNumber}/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }) }), 'summary creation');
}

async function publishInlineFindings(env: Env, context: PublicationContext, report: HostedReviewReportV1): Promise<void> {
  const path = repoPath(context.repository);
  const seen = new Set<string>();
  for (let page = 1; page <= 100; page += 1) {
    const previous = await responseJson<Array<{ body?: string }>>(await githubApi(env, context.installationId, `/repos/${path}/pulls/${context.prNumber}/comments?per_page=100&page=${page}`), 'review comment listing');
    for (const comment of previous) for (const match of comment.body?.matchAll(/<!-- juror:finding:([a-zA-Z0-9_-]+) -->/g) ?? []) if (match[1]) seen.add(match[1]);
    if (previous.length < 100) break;
  }
  const changedLines = new Map(report.diff.files.map((file) => [file.path, new Set(file.changedLines)]));
  const modelCount = Math.max(1, report.models.filter((model) => !model.skipped).length);
  const comments = publishedClusters(report)
    .filter((cluster) => !seen.has(cluster.fingerprint) && changedLines.get(cluster.path)?.has(cluster.line))
    .slice(0, MAX_INLINE_COMMENTS)
    .map((cluster) => ({ path: cluster.path, line: cluster.line, side: 'RIGHT', body: inlineBody(cluster, modelCount) }));
  if (!comments.length) return;
  const response = await githubApi(env, context.installationId, `/repos/${path}/pulls/${context.prNumber}/reviews`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commit_id: context.revisionSha, event: 'COMMENT', body: '', comments }),
  });
  // A summary remains useful when GitHub considers a line outside the current diff.
  if (!response.ok && response.status !== 422) throw new Error(`GitHub inline review failed (${response.status})`);
}

async function upsertCheck(env: Env, runId: string, context: PublicationContext, report: HostedReviewReportV1): Promise<void> {
  const path = repoPath(context.repository);
  const listed = await responseJson<{ check_runs: Array<{ id: number; external_id?: string }> }>(await githubApi(env, context.installationId, `/repos/${path}/commits/${context.revisionSha}/check-runs?check_name=Juror%20Cloud&per_page=100`), 'check listing');
  const existing = listed.check_runs.find((check) => check.external_id === runId);
  const urgent = report.verdict.confirmed.P0 + report.verdict.confirmed.P1;
  const payload = {
    name: 'Juror Cloud', head_sha: context.revisionSha, external_id: runId, status: 'completed',
    conclusion: urgent > 0 ? 'neutral' : 'success', details_url: `${env.APP_URL}/runs/${encodeURIComponent(runId)}`,
    output: { title: urgent > 0 ? `${urgent} P0/P1 finding${urgent === 1 ? '' : 's'} need attention` : 'Review complete', summary: oneLine(report.summary.summary, 1_000) || 'Open Juror Cloud for the sanitized review report.' },
  };
  const endpoint = existing ? `/repos/${path}/check-runs/${existing.id}` : `/repos/${path}/check-runs`;
  const response = await githubApi(env, context.installationId, endpoint, { method: existing ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`GitHub check publication failed (${response.status})`);
}

export async function publishHostedReview(env: Env, runId: string, report: HostedReviewReportV1): Promise<{ published: boolean; stale: boolean }> {
  const context = await env.DB.prepare(`SELECT repo.full_name AS repository, r.pr_number, r.revision_sha, i.github_installation_id FROM run r JOIN repository repo ON repo.id = r.repository_id JOIN installation i ON i.workspace_id = r.workspace_id WHERE r.id = ?`)
    .bind(runId).first<{ repository: string; pr_number: number; revision_sha: string; github_installation_id: number }>();
  if (!context) throw new Error('Review publication context is missing');
  const publication: PublicationContext = { repository: context.repository, prNumber: context.pr_number, revisionSha: context.revision_sha, installationId: context.github_installation_id };
  const path = repoPath(publication.repository);
  const pull = await responseJson<{ head: { sha: string }; base: { sha: string } }>(await githubApi(env, publication.installationId, `/repos/${path}/pulls/${publication.prNumber}`), 'pull request freshness check');
  if (pull.head.sha !== publication.revisionSha || report.diff.headSha !== publication.revisionSha || pull.base.sha !== report.diff.baseSha) return { published: false, stale: true };
  const runUrl = `${env.APP_URL}/runs/${encodeURIComponent(runId)}`;
  await publishInlineFindings(env, publication, report);
  await upsertSummary(env, publication, renderHostedSummary(report, runUrl));
  await upsertCheck(env, runId, publication, report);
  return { published: true, stale: false };
}
