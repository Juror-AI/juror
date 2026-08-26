import { canReserveWithinCap, maximumRunReservationMicroUsd } from '../../src/cloud/billing';
import type { ReviewPreset } from '../../src/types';
import type { Env, Principal } from './env';
import { createRun, currentCommitment, detectJurorWorkflow } from './github-webhook';
import { githubApi } from './github';
import { missingProviderSecrets } from './providers';

export type ReviewAction = 'start' | 'rerun';

export class ReviewServiceError extends Error {
  constructor(readonly code: string, readonly status: 403 | 404 | 409 | 502 | 503, message: string) {
    super(message);
  }
}

type RepositoryRow = {
  id: string; workspace_id: string; github_repository_id: number; full_name: string; owner: string; name: string;
  github_access_state: string; review_enabled: number; review_preset: ReviewPreset; github_installation_id: number;
};

type PullRequest = {
  id: number; number: number; state: string; html_url: string; created_at: string; base: { sha: string }; head: { sha: string; repo?: { fork?: boolean } }; user: { login: string };
};

export type ReviewPreflight = {
  action: ReviewAction;
  repository: { id: string; fullName: string };
  pullRequest: { number: number; sha: string; url: string };
  billing: { estimatedMicroUsd: number; capRemainingMicroUsd: number; trialOrBillingReady: boolean };
  intentId?: string;
  expiresAt?: string;
};

async function repositoryForPrincipal(env: Env, principal: Principal, repositoryId: string): Promise<RepositoryRow> {
  const repository = await env.DB.prepare(`SELECT repo.id, repo.workspace_id, repo.github_repository_id, repo.full_name, repo.owner, repo.name, repo.github_access_state,
    rs.review_enabled, rs.review_preset, i.github_installation_id
    FROM repository repo JOIN repository_settings rs ON rs.repository_id = repo.id
    JOIN installation i ON i.workspace_id = repo.workspace_id
    WHERE repo.id = ? AND repo.workspace_id = ?`)
    .bind(repositoryId, principal.workspaceId).first<RepositoryRow>();
  if (!repository) throw new ReviewServiceError('repository_not_found', 404, 'Repository not found in this workspace.');
  return repository;
}

async function currentPullRequest(env: Env, repository: RepositoryRow, prNumber: number): Promise<PullRequest> {
  const response = await githubApi(env, repository.github_installation_id, `/repos/${repository.full_name}/pulls/${prNumber}`);
  if (!response.ok) throw new ReviewServiceError('github_pr_unavailable', response.status === 404 ? 404 : 502, 'GitHub could not load that pull request.');
  return response.json<PullRequest>();
}

async function verifyHostedReviewPolicy(env: Env, repository: RepositoryRow, pr: PullRequest): Promise<void> {
  if (repository.github_access_state !== 'active') throw new ReviewServiceError('repository_access_inactive', 409, 'Repository access is no longer active.');
  if (!repository.review_enabled) throw new ReviewServiceError('cloud_review_disabled', 409, 'Hosted review is disabled for this repository.');
  if (pr.state !== 'open') throw new ReviewServiceError('pr_not_open', 409, 'Hosted reviews are available only for open pull requests.');

  const workflowDetection = await detectJurorWorkflow(env, repository.github_installation_id, repository.full_name, [pr.base.sha, pr.head.sha]);
  if (workflowDetection !== false) {
    await env.DB.prepare(`UPDATE repository_settings SET action_detected = 1, review_enabled = 0, qa_enabled = 0, qa_security_ready = 0, updated_at = ? WHERE repository_id = ?`)
      .bind(new Date().toISOString(), repository.id).run();
    throw new ReviewServiceError('juror_workflow_check_required', 409, workflowDetection
      ? 'Remove the existing Juror GitHub Action before starting a hosted review.'
      : 'Juror could not verify this repository workflow configuration. Try again after GitHub access recovers.');
  }

  if (missingProviderSecrets(env, 'review', repository.review_preset).length) {
    throw new ReviewServiceError('hosted_review_unavailable', 503, 'Hosted review is temporarily unavailable for this repository configuration.');
  }
}

async function billingPreflight(env: Env, workspaceId: string, preset: ReviewPreset): Promise<ReviewPreflight['billing']> {
  const estimatedMicroUsd = maximumRunReservationMicroUsd('review', preset);
  const commitment = await currentCommitment(env, workspaceId);
  const cap = canReserveWithinCap({ capMicroUsd: commitment.cap, consumedMicroUsd: commitment.consumed, reservedMicroUsd: commitment.reserved, estimateMicroUsd: estimatedMicroUsd });
  const trialOrBillingReady = commitment.trialRemaining >= estimatedMicroUsd || commitment.billingReady;
  if (!cap.allowed || !trialOrBillingReady) throw new ReviewServiceError('billing_insufficient', 409, 'The workspace cannot reserve capacity for this hosted review.');
  return { estimatedMicroUsd, capRemainingMicroUsd: Math.max(0, commitment.cap - commitment.consumed - commitment.reserved), trialOrBillingReady };
}

export async function validateHostedReview(env: Env, principal: Principal, input: { repositoryId: string; prNumber: number; action: ReviewAction }): Promise<ReviewPreflight> {
  const repository = await repositoryForPrincipal(env, principal, input.repositoryId);
  const pr = await currentPullRequest(env, repository, input.prNumber);
  await verifyHostedReviewPolicy(env, repository, pr);
  const billing = await billingPreflight(env, principal.workspaceId, repository.review_preset);
  return {
    action: input.action,
    repository: { id: repository.id, fullName: repository.full_name },
    pullRequest: { number: pr.number, sha: pr.head.sha, url: pr.html_url },
    billing,
  };
}

async function createIntent(env: Env, principal: Principal, preflight: ReviewPreflight, runId?: string): Promise<ReviewPreflight> {
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const intentId = `intent_${crypto.randomUUID()}`;
  await env.DB.prepare(`INSERT INTO review_intent (id, user_id, workspace_id, repository_id, run_id, pr_number, revision_sha, action, expires_at, consumed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
    .bind(intentId, principal.userId, principal.workspaceId, preflight.repository.id, runId ?? null, preflight.pullRequest.number, preflight.pullRequest.sha, preflight.action, expiresAt, new Date().toISOString()).run();
  return { ...preflight, intentId, expiresAt };
}

export async function prepareHostedReview(env: Env, principal: Principal, repositoryId: string, prNumber: number): Promise<ReviewPreflight> {
  return createIntent(env, principal, await validateHostedReview(env, principal, { repositoryId, prNumber, action: 'start' }));
}

export async function prepareHostedRerun(env: Env, principal: Principal, runId: string): Promise<ReviewPreflight> {
  const run = await env.DB.prepare(`SELECT id, repository_id, pr_number, kind FROM run WHERE id = ? AND workspace_id = ?`).bind(runId, principal.workspaceId).first<{ id: string; repository_id: string; pr_number: number; kind: string }>();
  if (!run || run.kind !== 'review') throw new ReviewServiceError('run_not_found', 404, 'Hosted review run not found in this workspace.');
  return createIntent(env, principal, await validateHostedReview(env, principal, { repositoryId: run.repository_id, prNumber: run.pr_number, action: 'rerun' }), run.id);
}

async function persistPullRequest(env: Env, repositoryId: string, pr: PullRequest): Promise<string> {
  const pullRequestId = `pr_${pr.id}`;
  const timestamp = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO pull_request (id, repository_id, github_pr_id, number, state, base_sha, head_sha, merge_sha, is_fork, author_login, github_url, opened_at, merged_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(github_pr_id) DO UPDATE SET state = excluded.state, base_sha = excluded.base_sha, head_sha = excluded.head_sha, is_fork = excluded.is_fork, github_url = excluded.github_url, updated_at = excluded.updated_at`)
    .bind(pullRequestId, repositoryId, pr.id, pr.number, pr.state, pr.base.sha, pr.head.sha, pr.head.repo?.fork ? 1 : 0, pr.user.login, pr.html_url, pr.created_at, timestamp).run();
  return pullRequestId;
}

async function launchReview(env: Env, principal: Principal, repositoryId: string, prNumber: number, action: ReviewAction, rerunOf?: string): Promise<{ id: string; status: string }> {
  const repository = await repositoryForPrincipal(env, principal, repositoryId);
  const pr = await currentPullRequest(env, repository, prNumber);
  await verifyHostedReviewPolicy(env, repository, pr);
  await billingPreflight(env, principal.workspaceId, repository.review_preset);
  const pullRequestId = await persistPullRequest(env, repository.id, pr);
  const identity = action === 'rerun' ? `rerun:${rerunOf}:${crypto.randomUUID()}` : `review:${repository.github_repository_id}:${pr.number}:${pr.head.sha}`;
  const runId = await createRun(env, { kind: 'review', identity, workspaceId: principal.workspaceId, repositoryId: repository.id, pullRequestId, prNumber: pr.number, sha: pr.head.sha });
  if (!runId) throw new ReviewServiceError(action === 'rerun' ? 'rerun_conflict' : 'already_reviewed', 409, action === 'rerun' ? 'A matching rerun already exists.' : 'This pull request revision already has a run.');
  const run = await env.DB.prepare('SELECT status FROM run WHERE id = ? AND workspace_id = ?').bind(runId, principal.workspaceId).first<{ status: string }>();
  return { id: runId, status: run?.status ?? 'queued' };
}

export async function launchBrowserHostedReview(env: Env, principal: Principal, repositoryId: string, prNumber: number): Promise<{ id: string; status: string }> {
  return launchReview(env, principal, repositoryId, prNumber, 'start');
}

export async function launchBrowserHostedRerun(env: Env, principal: Principal, runId: string): Promise<{ id: string; status: string }> {
  const run = await env.DB.prepare('SELECT id, repository_id, pr_number, kind FROM run WHERE id = ? AND workspace_id = ?').bind(runId, principal.workspaceId).first<{ id: string; repository_id: string; pr_number: number; kind: string }>();
  if (!run || run.kind !== 'review') throw new ReviewServiceError('run_not_found', 404, 'Hosted review run not found in this workspace.');
  return launchReview(env, principal, run.repository_id, run.pr_number, 'rerun', run.id);
}

export async function consumeReviewIntent(env: Env, principal: Principal, intentId: string, action: ReviewAction): Promise<{ id: string; status: string }> {
  const now = new Date().toISOString();
  const consumed = await env.DB.prepare(`UPDATE review_intent SET consumed_at = ? WHERE id = ? AND user_id = ? AND workspace_id = ? AND action = ? AND consumed_at IS NULL AND expires_at > ?`)
    .bind(now, intentId, principal.userId, principal.workspaceId, action, now).run();
  if (!consumed.meta.changes) throw new ReviewServiceError('review_intent_invalid', 409, 'The review confirmation expired, was already used, or does not belong to this user.');
  const intent = await env.DB.prepare('SELECT repository_id, run_id, pr_number, revision_sha FROM review_intent WHERE id = ? AND user_id = ? AND workspace_id = ?').bind(intentId, principal.userId, principal.workspaceId).first<{ repository_id: string; run_id: string | null; pr_number: number; revision_sha: string }>();
  if (!intent) throw new ReviewServiceError('review_intent_invalid', 409, 'The review confirmation is unavailable.');
  const preflight = await validateHostedReview(env, principal, { repositoryId: intent.repository_id, prNumber: intent.pr_number, action });
  if (preflight.pullRequest.sha !== intent.revision_sha) throw new ReviewServiceError('pull_request_changed', 409, 'The pull request changed after confirmation. Prepare a new review before starting it.');
  return launchReview(env, principal, intent.repository_id, intent.pr_number, action, intent.run_id ?? undefined);
}
