import { canReserveWithinCap, maximumRunReservationMicroUsd } from '../../src/cloud/billing';
import type { ReviewPreset } from '../../src/types';
import type { Env } from './env';
import { appendRunEvent } from './events';
import { githubApi } from './github';
import { missingProviderSecrets } from './providers';
import { initialRepositorySettings } from './repository-settings';

type JsonObject = Record<string, any>;

function id(prefix: string, value: string | number): string { return `${prefix}_${value}`; }
function now(): string { return new Date().toISOString(); }

async function detectActionWorkflow(env: Env, installationId: number, fullName: string): Promise<boolean> {
  const response = await githubApi(env, installationId, `/repos/${fullName}/contents/.github/workflows`);
  if (response.status === 404) return false;
  // Action detection only chooses a safe initial execution mode. A transient GitHub API error
  // must not prevent the installation webhook (or onboarding recovery) from importing the repo.
  // `false` still provisions it as unresolved and review-disabled, so no hosted run can start.
  if (!response.ok) {
    console.warn(JSON.stringify({ event: 'github_action_detection_unavailable', installationId, repository: fullName, status: response.status }));
    return false;
  }
  const files = await response.json<Array<{ type: string; name: string; path: string }>>();
  for (const file of files.filter((entry) => entry.type === 'file' && /\.ya?ml$/i.test(entry.name)).slice(0, 30)) {
    const fileResponse = await githubApi(env, installationId, `/repos/${fullName}/contents/${file.path}`);
    if (!fileResponse.ok) continue;
    const body = await fileResponse.json<{ content?: string; encoding?: string }>();
    if (body.encoding === 'base64' && body.content) {
      const decoded = atob(body.content.replace(/\s/g, ''));
      if (/uses:\s*['"]?Juror-AI\/juror\//i.test(decoded)) return true;
    }
  }
  return false;
}

async function upsertRepository(env: Env, installationId: number, repository: JsonObject, refreshActionDetection = false, reactivate = false): Promise<{ repositoryId: string; workspaceId: string }> {
  const workspace = await env.DB.prepare('SELECT id FROM workspace WHERE github_installation_id = ?').bind(installationId).first<{ id: string }>();
  if (!workspace) throw new Error('Installation has no workspace');
  const repositoryId = id('repo', repository.id);
  const timestamp = now();
  await env.DB.prepare(`INSERT INTO repository (id, workspace_id, github_repository_id, owner, name, full_name, default_branch, is_private, archived, github_access_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?) ON CONFLICT(github_repository_id) DO UPDATE SET owner = excluded.owner, name = excluded.name, full_name = excluded.full_name, default_branch = excluded.default_branch, is_private = excluded.is_private, archived = excluded.archived, github_access_state = CASE WHEN ? = 1 THEN 'active' ELSE repository.github_access_state END, updated_at = excluded.updated_at`)
    .bind(repositoryId, workspace.id, repository.id, repository.owner.login, repository.name, repository.full_name, repository.default_branch ?? 'main', repository.private ? 1 : 0, repository.archived ? 1 : 0, timestamp, timestamp, Number(reactivate)).run();
  const currentSettings = await env.DB.prepare('SELECT action_detected FROM repository_settings WHERE repository_id = ?')
    .bind(repositoryId).first<{ action_detected: number }>();
  const actionDetected = refreshActionDetection || !currentSettings
    ? await detectActionWorkflow(env, installationId, repository.full_name)
    : Boolean(currentSettings.action_detected);
  const defaults = initialRepositorySettings(actionDetected);
  await env.DB.prepare(`INSERT INTO repository_settings (repository_id, execution_mode, action_detected, review_enabled, review_preset, publish_mode, severity_floor, qa_enabled, qa_security_ready, updated_at) VALUES (?, ?, ?, ?, 'fast', 'all', 'P3', 0, 0, ?) ON CONFLICT(repository_id) DO UPDATE SET action_detected = excluded.action_detected, execution_mode = CASE WHEN excluded.action_detected = 1 AND repository_settings.execution_mode = 'cloud' THEN 'unresolved' ELSE repository_settings.execution_mode END, updated_at = excluded.updated_at`)
    .bind(repositoryId, defaults.executionMode, defaults.actionDetected ? 1 : 0, defaults.reviewEnabled ? 1 : 0, timestamp).run();
  return { repositoryId, workspaceId: workspace.id };
}

export async function provisionInstallation(env: Env, payload: JsonObject, refreshActionDetection = true): Promise<void> {
  const installation = payload.installation;
  const deleted = await env.DB.prepare('SELECT 1 AS deleted FROM deleted_installation WHERE github_installation_id = ?').bind(installation.id).first();
  if (deleted) return;
  const workspaceId = id('ws', installation.id);
  const installationRowId = id('inst', installation.id);
  const timestamp = now();
  const slugBase = String(installation.account.login).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO workspace (id, name, slug, github_installation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(workspaceId, installation.account.login, `${slugBase}-${installation.id}`, installation.id, timestamp, timestamp),
    env.DB.prepare(`INSERT INTO installation (id, workspace_id, github_installation_id, account_login, account_type, permissions_json, repository_selection, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(github_installation_id) DO UPDATE SET account_login = excluded.account_login, account_type = excluded.account_type, permissions_json = excluded.permissions_json, repository_selection = excluded.repository_selection, suspended_at = NULL, updated_at = excluded.updated_at`)
      .bind(installationRowId, workspaceId, installation.id, installation.account.login, installation.account.type, JSON.stringify(installation.permissions ?? {}), installation.repository_selection ?? 'selected', timestamp, timestamp),
  ]);
  for (const repository of payload.repositories ?? []) await upsertRepository(env, installation.id, repository, refreshActionDetection, true);
}

async function upsertPullRequest(env: Env, repositoryId: string, payload: JsonObject): Promise<string> {
  const pr = payload.pull_request;
  const prId = id('pr', pr.id);
  await env.DB.prepare(`INSERT INTO pull_request (id, repository_id, github_pr_id, number, state, base_sha, head_sha, merge_sha, is_fork, author_login, github_url, opened_at, merged_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(github_pr_id) DO UPDATE SET state = excluded.state, base_sha = excluded.base_sha, head_sha = excluded.head_sha, merge_sha = excluded.merge_sha, is_fork = excluded.is_fork, author_login = excluded.author_login, github_url = excluded.github_url, merged_at = excluded.merged_at, updated_at = excluded.updated_at`)
    .bind(prId, repositoryId, pr.id, pr.number, pr.state, pr.base.sha, pr.head.sha, pr.merge_commit_sha ?? null, pr.head.repo?.fork ? 1 : 0, pr.user.login, pr.html_url, pr.created_at, pr.merged_at ?? null, pr.updated_at).run();
  return prId;
}

async function currentCommitment(env: Env, workspaceId: string): Promise<{ cap: number; consumed: number; reserved: number; trialRemaining: number; billingReady: boolean }> {
  const start = new Date();
  start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  const row = await env.DB.prepare(`SELECT w.monthly_cap_micro_usd AS cap, w.trial_remaining_micro_usd AS trial_remaining, CASE WHEN w.billing_state = 'active' AND EXISTS (SELECT 1 FROM stripe_customer sc WHERE sc.workspace_id = w.id AND sc.payment_state = 'active') THEN 1 ELSE 0 END AS billing_ready, COALESCE((SELECT SUM(billable_micro_usd) FROM usage_ledger WHERE workspace_id = w.id AND created_at >= ?), 0) AS consumed, COALESCE((SELECT SUM(reserved_micro_usd) FROM run WHERE workspace_id = w.id AND status IN ('queued', 'running')), 0) AS reserved FROM workspace w WHERE w.id = ?`)
    .bind(start.toISOString(), workspaceId).first<{ cap: number; consumed: number; reserved: number; trial_remaining: number; billing_ready: number }>();
  if (!row) throw new Error('Workspace missing for cap reservation');
  return { cap: row.cap, consumed: row.consumed, reserved: row.reserved, trialRemaining: row.trial_remaining, billingReady: Boolean(row.billing_ready) };
}

export async function createRun(env: Env, input: { kind: 'review' | 'qa'; identity: string; workspaceId: string; repositoryId: string; pullRequestId: string; prNumber: number; sha: string }): Promise<string | null> {
  const settings = await env.DB.prepare('SELECT settings.review_preset, repository.github_access_state FROM repository_settings settings JOIN repository ON repository.id = settings.repository_id WHERE settings.repository_id = ?')
    .bind(input.repositoryId).first<{ review_preset: ReviewPreset; github_access_state: string }>();
  if (!settings) throw new Error('Repository settings are missing');
  if (settings.github_access_state !== 'active') {
    console.warn(JSON.stringify({ event: 'run_blocked_repository_access', kind: input.kind, repositoryId: input.repositoryId, accessState: settings.github_access_state }));
    return null;
  }
  // The runner starts the jury this preset names, so a deployment holding some other provider's
  // key cannot run it. Block before reserving capacity rather than after burning a Sandbox.
  const missingProviders = missingProviderSecrets(env, input.kind, settings.review_preset);
  if (missingProviders.length > 0) {
    console.warn(JSON.stringify({ event: 'run_blocked_provider_configuration', kind: input.kind, preset: settings.review_preset, missingSecrets: missingProviders }));
    const runId = id('run', crypto.randomUUID());
    const timestamp = now();
    const blocked = await env.DB.prepare(`INSERT OR IGNORE INTO run (id, identity, workspace_id, repository_id, pull_request_id, kind, status, phase, outcome, pr_number, revision_sha, reserved_micro_usd, created_at, updated_at)
      SELECT ?, ?, ?, provider_repository.id, ?, ?, 'blocked', 'preparing', 'provider_configuration', ?, ?, 0, ?, ? FROM repository provider_repository WHERE provider_repository.id = ? AND provider_repository.workspace_id = ? AND provider_repository.github_access_state = 'active'`)
      .bind(runId, input.identity, input.workspaceId, input.pullRequestId, input.kind, input.prNumber, input.sha, timestamp, timestamp, input.repositoryId, input.workspaceId).run();
    if (!blocked.meta.changes) return null;
    await appendRunEvent(env, runId, 'preparing', 'warning', input.kind === 'qa'
      ? 'Hosted QA is unavailable: this deployment has no credential for the QA model.'
      : `Hosted review is unavailable: this deployment has no credential for the ${settings.review_preset} preset's models.`);
    return runId;
  }
  const estimate = maximumRunReservationMicroUsd(input.kind, settings.review_preset);
  const commitment = await currentCommitment(env, input.workspaceId);
  const decision = canReserveWithinCap({ capMicroUsd: commitment.cap, consumedMicroUsd: commitment.consumed, reservedMicroUsd: commitment.reserved, estimateMicroUsd: estimate });
  const paymentAllowed = commitment.trialRemaining >= estimate || commitment.billingReady;
  const runId = id('run', crypto.randomUUID());
  const timestamp = now();
  const periodStart = new Date(); periodStart.setUTCDate(1); periodStart.setUTCHours(0, 0, 0, 0);
  const reservation = await env.DB.prepare(`INSERT OR IGNORE INTO run (id, identity, workspace_id, repository_id, pull_request_id, kind, status, phase, pr_number, revision_sha, reserved_micro_usd, created_at, updated_at)
    SELECT ?, ?, w.id, ?, ?, ?, 'queued', 'queued', ?, ?, ?, ?, ? FROM workspace w WHERE w.id = ?
      AND EXISTS (SELECT 1 FROM repository admission_repository WHERE admission_repository.id = ? AND admission_repository.workspace_id = w.id AND admission_repository.github_access_state = 'active')
      AND ? <= w.monthly_cap_micro_usd - COALESCE((SELECT SUM(billable_micro_usd) FROM usage_ledger WHERE workspace_id = w.id AND created_at >= ?), 0) - COALESCE((SELECT SUM(reserved_micro_usd) FROM run WHERE workspace_id = w.id AND status IN ('queued','running')), 0)
      AND (w.trial_remaining_micro_usd >= ? OR (w.billing_state = 'active' AND EXISTS (SELECT 1 FROM stripe_customer sc WHERE sc.workspace_id = w.id AND sc.payment_state = 'active')))`)
    .bind(runId, input.identity, input.repositoryId, input.pullRequestId, input.kind, input.prNumber, input.sha, estimate, timestamp, timestamp, input.workspaceId, input.repositoryId, estimate, periodStart.toISOString(), estimate).run();
  let allowed = Boolean(reservation.meta.changes);
  if (!allowed) {
    const duplicate = await env.DB.prepare('SELECT id FROM run WHERE identity = ?').bind(input.identity).first();
    if (duplicate) return null;
    const blocked = await env.DB.prepare(`INSERT OR IGNORE INTO run (id, identity, workspace_id, repository_id, pull_request_id, kind, status, phase, pr_number, revision_sha, reserved_micro_usd, created_at, updated_at)
      SELECT ?, ?, ?, blocked_repository.id, ?, ?, 'blocked', 'billing', ?, ?, 0, ?, ? FROM repository blocked_repository WHERE blocked_repository.id = ? AND blocked_repository.workspace_id = ? AND blocked_repository.github_access_state = 'active'`)
      .bind(runId, input.identity, input.workspaceId, input.pullRequestId, input.kind, input.prNumber, input.sha, timestamp, timestamp, input.repositoryId, input.workspaceId).run();
    if (!blocked.meta.changes) return null;
  }
  await appendRunEvent(env, runId, allowed ? 'queued' : 'billing', allowed ? 'pending' : 'warning', allowed ? 'Run accepted and capacity reserved.' : !paymentAllowed ? 'Trial credit cannot cover the reservation. Add a payment method to continue.' : !decision.allowed ? 'Monthly cap cannot reserve this run.' : 'Concurrent usage consumed the remaining monthly capacity.');
  if (!allowed) return runId;
  const workflow = input.kind === 'review' ? env.REVIEW_WORKFLOW : env.QA_WORKFLOW;
  const workflowClaim = input.kind === 'qa'
    ? await env.DB.prepare(`UPDATE run SET workflow_instance_id = ?, updated_at = ? WHERE id = ? AND status = 'queued' AND workflow_instance_id IS NULL AND EXISTS (SELECT 1 FROM repository admission_repository WHERE admission_repository.id = ? AND admission_repository.github_access_state = 'active') AND NOT EXISTS (SELECT 1 FROM run active WHERE active.repository_id = ? AND active.kind = 'qa' AND active.id != ? AND active.status IN ('queued', 'running') AND active.workflow_instance_id IS NOT NULL)`).bind(runId, now(), runId, input.repositoryId, input.repositoryId, runId).run()
    : await env.DB.prepare(`UPDATE run SET workflow_instance_id = ?, updated_at = ? WHERE id = ? AND status = 'queued' AND workflow_instance_id IS NULL AND EXISTS (SELECT 1 FROM repository admission_repository WHERE admission_repository.id = ? AND admission_repository.github_access_state = 'active')`).bind(runId, now(), runId, input.repositoryId).run();
  if (!workflowClaim.meta.changes) {
    if (input.kind === 'qa') await appendRunEvent(env, runId, 'queued', 'pending', 'Queued behind an active repository QA run to protect the staging identity.');
    return runId;
  }
  let workflowId = runId;
  try {
    const handle = await workflow.create({ id: runId, params: { runId }, retention: { successRetention: '30 days', errorRetention: '30 days' } });
    workflowId = handle.id;
  } catch (error) {
    const timestamp = now();
    const failed = await env.DB.prepare(`UPDATE run SET status = 'failed', phase = 'failed', outcome = 'infrastructure_error', reserved_micro_usd = 0, completed_at = ?, updated_at = ? WHERE id = ? AND status != 'cancelled'`)
      .bind(timestamp, timestamp, runId).run();
    if (failed.meta.changes) await appendRunEvent(env, runId, 'failed', 'failed', 'Juror could not start the isolated workflow.');
    throw error;
  }
  // A newer head or user cancellation may have raced the create call. The row was
  // pre-bound to the deterministic Workflow id, so cancellation remains possible
  // throughout creation and a final check closes the remaining create/terminate gap.
  try {
    const cancelled = await env.DB.prepare(`SELECT 1 AS cancelled FROM run WHERE id = ? AND status = 'cancelled'`).bind(runId).first();
    if (cancelled) await (await workflow.get(workflowId)).terminate();
  } catch { /* The Workflow itself also refuses a cancelled row before Sandbox admission. */ }
  return runId;
}

async function cancelOlderReviews(env: Env, repositoryId: string, prNumber: number, headSha: string): Promise<void> {
  const rows = await env.DB.prepare(`SELECT id, workflow_instance_id FROM run WHERE repository_id = ? AND pr_number = ? AND kind = 'review' AND revision_sha != ? AND status IN ('queued', 'running')`)
    .bind(repositoryId, prNumber, headSha).all<{ id: string; workflow_instance_id: string | null }>();
  for (const row of rows.results) {
    if (row.workflow_instance_id) {
      try { await (await env.REVIEW_WORKFLOW.get(row.workflow_instance_id)).terminate(); } catch { /* The workflow may already be terminal. */ }
    }
    await env.DB.prepare(`UPDATE run SET status = 'cancelled', phase = 'cancelled', outcome = 'cancelled', reserved_micro_usd = 0, completed_at = ?, updated_at = ? WHERE id = ?`).bind(now(), now(), row.id).run();
    await appendRunEvent(env, row.id, 'cancelled', 'cancelled', 'Superseded by a newer pull request head.');
  }
}

async function cancelRunsForAccessRevocation(env: Env, repositoryIds: string[]): Promise<void> {
  const terminationFailures: string[] = [];
  for (let offset = 0; offset < repositoryIds.length; offset += 50) {
    const chunk = repositoryIds.slice(offset, offset + 50);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await env.DB.prepare(`SELECT id, kind, status, workflow_instance_id FROM run WHERE repository_id IN (${placeholders}) AND (status IN ('queued', 'running') OR (status = 'cancelled' AND outcome = 'access_revoked' AND workflow_instance_id IS NOT NULL))`)
      .bind(...chunk).all<{ id: string; kind: 'review' | 'qa'; status: string; workflow_instance_id: string | null }>();
    if (!rows.results.length) continue;
    const timestamp = now();
    const cancellations = await env.DB.batch(rows.results.map((row) => env.DB.prepare(`UPDATE run SET status = 'cancelled', phase = 'cancelled', outcome = 'access_revoked', reserved_micro_usd = 0, completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ? AND (status IN ('queued', 'running') OR outcome = 'access_revoked')`).bind(timestamp, timestamp, row.id)));
    for (const [index, row] of rows.results.entries()) {
      if (!cancellations[index]?.meta.changes) continue;
      if (row.status !== 'cancelled') {
        try { await appendRunEvent(env, row.id, 'cancelled', 'cancelled', 'GitHub repository access was revoked.'); }
        catch (error) { console.warn(JSON.stringify({ event: 'access_revocation_event_failed', runId: row.id, error: error instanceof Error ? error.message : String(error) })); }
      }
      if (!row.workflow_instance_id) continue;
      const workflow = row.kind === 'review' ? env.REVIEW_WORKFLOW : env.QA_WORKFLOW;
      const instance = await workflow.get(row.workflow_instance_id);
      let clearWorkflowHandle = false;
      try {
        await instance.terminate();
        clearWorkflowHandle = true;
      } catch (error) {
        let status: string | null = null;
        try { status = (await instance.status()).status; } catch { /* Retain the handle so webhook delivery can retry termination. */ }
        if (status && ['complete', 'errored', 'terminated'].includes(status)) {
          clearWorkflowHandle = true;
          console.warn(JSON.stringify({ event: 'access_revocation_terminal_workflow', runId: row.id, status }));
        } else {
          terminationFailures.push(row.id);
          console.error(JSON.stringify({ event: 'access_revocation_termination_failed', runId: row.id, status, error: error instanceof Error ? error.message : String(error) }));
        }
      }
      if (clearWorkflowHandle) {
        await env.DB.prepare(`UPDATE run SET workflow_instance_id = NULL, updated_at = ? WHERE id = ? AND status = 'cancelled' AND outcome = 'access_revoked'`).bind(now(), row.id).run();
      }
    }
  }
  if (terminationFailures.length) throw new Error(`Could not terminate ${terminationFailures.length} access-revoked workflow(s); retrying delivery`);
}

async function handlePullRequest(env: Env, payload: JsonObject): Promise<void> {
  const installationId = payload.installation.id as number;
  const { repositoryId, workspaceId } = await upsertRepository(env, installationId, payload.repository);
  const pullRequestId = await upsertPullRequest(env, repositoryId, payload);
  const settings = await env.DB.prepare('SELECT execution_mode, review_enabled, qa_enabled, qa_security_ready FROM repository_settings WHERE repository_id = ?').bind(repositoryId).first<{ execution_mode: string; review_enabled: number; qa_enabled: number; qa_security_ready: number }>();
  if (!settings || settings.execution_mode !== 'cloud') return;
  const pr = payload.pull_request;
  if (['opened', 'reopened', 'synchronize'].includes(payload.action) && settings.review_enabled) {
    await cancelOlderReviews(env, repositoryId, pr.number, pr.head.sha);
    await createRun(env, { kind: 'review', identity: `review:${payload.repository.id}:${pr.number}:${pr.head.sha}`, workspaceId, repositoryId, pullRequestId, prNumber: pr.number, sha: pr.head.sha });
  }
  if (payload.action === 'closed' && pr.merged && pr.merge_commit_sha && settings.qa_enabled && settings.qa_security_ready) {
    await createRun(env, { kind: 'qa', identity: `qa:${payload.repository.id}:${pr.number}:${pr.merge_commit_sha}`, workspaceId, repositoryId, pullRequestId, prNumber: pr.number, sha: pr.merge_commit_sha });
  }
}

interface ResolvedThread { id: string; fingerprint: string }

function markerFromComments(comments: JsonObject[] | undefined): string | null {
  return comments?.map((comment) => String(comment.body ?? ''))
    .map((body) => body.match(/<!--\s*juror:finding:([0-9a-f]{12})\s*-->/i)?.[1] ?? null)
    .find(Boolean) ?? null;
}

async function resolvedJurorThreads(env: Env, payload: JsonObject): Promise<ResolvedThread[]> {
  const installationId = Number(payload.installation?.id);
  const owner = String(payload.repository?.owner?.login ?? '');
  const name = String(payload.repository?.name ?? '');
  const number = Number(payload.pull_request?.number);
  if (!Number.isSafeInteger(installationId) || !owner || !name || !Number.isSafeInteger(number)) return [];
  const query = `query JurorResolvedThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          nodes { id isResolved comments(first: 100) { nodes { body } } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }`;
  const resolved: ResolvedThread[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const response = await githubApi(env, installationId, '/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { owner, name, number, after } }),
    });
    if (!response.ok) throw new Error(`GitHub review-thread sync failed (${response.status})`);
    const result = await response.json<{ data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: Array<{ id: string; isResolved: boolean; comments: { nodes?: JsonObject[] } }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } } }; errors?: unknown[] }>();
    if (result.errors?.length) throw new Error('GitHub review-thread sync returned GraphQL errors');
    const connection = result.data?.repository?.pullRequest?.reviewThreads;
    if (!connection) return resolved;
    for (const thread of connection.nodes ?? []) {
      if (!thread.isResolved) continue;
      const fingerprint = markerFromComments(thread.comments.nodes);
      if (fingerprint) resolved.push({ id: thread.id, fingerprint });
    }
    if (!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor) break;
    after = connection.pageInfo.endCursor;
  }
  return resolved;
}

async function resolveFindingForThread(env: Env, repositoryId: string, thread: ResolvedThread): Promise<void> {
  const finding = await env.DB.prepare(`SELECT id, status FROM finding WHERE repository_id = ? AND (github_thread_id = ? OR fingerprint = ?) AND status = 'open'`)
    .bind(repositoryId, thread.id, thread.fingerprint).first<{ id: string; status: string }>();
  if (!finding) return;
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE finding SET status = 'resolved', github_thread_id = ?, resolved_at = ?, last_seen_at = ? WHERE id = ?`).bind(thread.id, timestamp, timestamp, finding.id),
    env.DB.prepare(`INSERT INTO triage_event (id, finding_id, actor_user_id, source, from_status, to_status, reason, created_at) VALUES (?, ?, NULL, 'github', ?, 'resolved', 'GitHub review thread resolved', ?)`).bind(id('triage', crypto.randomUUID()), finding.id, finding.status, timestamp),
  ]);
}

async function handleReviewThread(env: Env, payload: JsonObject): Promise<void> {
  if (payload.action !== 'resolved') return;
  const repositoryId = payload.repository?.id ? id('repo', payload.repository.id) : null;
  if (!repositoryId) return;
  const webhookThread = payload.thread ?? payload.review_thread ?? {};
  const webhookComments = Array.isArray(webhookThread.comments) ? webhookThread.comments : webhookThread.comments?.nodes;
  const webhookFingerprint = markerFromComments(webhookComments);
  const webhookThreadId = String(webhookThread.id ?? '');
  const threads = webhookFingerprint && webhookThreadId
    ? [{ id: webhookThreadId, fingerprint: webhookFingerprint }]
    : await resolvedJurorThreads(env, payload);
  for (const thread of threads) await resolveFindingForThread(env, repositoryId, thread);
}

export async function processGitHubWebhook(env: Env, eventName: string, payload: JsonObject): Promise<void> {
  if (eventName === 'installation') {
    if (['created', 'new_permissions_accepted', 'unsuspend'].includes(payload.action)) await provisionInstallation(env, payload);
    if (payload.action === 'unsuspend') await env.DB.prepare(`UPDATE repository SET github_access_state = 'active', updated_at = ? WHERE workspace_id = (SELECT workspace_id FROM installation WHERE github_installation_id = ?)`).bind(now(), payload.installation.id).run();
    else if (payload.action === 'deleted' || payload.action === 'suspend') {
      const repositories = await env.DB.prepare(`SELECT id FROM repository WHERE workspace_id = (SELECT workspace_id FROM installation WHERE github_installation_id = ?)`).bind(payload.installation.id).all<{ id: string }>();
      const timestamp = now();
      await env.DB.batch([
        env.DB.prepare(`UPDATE installation SET suspended_at = ?, updated_at = ? WHERE github_installation_id = ?`).bind(payload.action === 'suspend' ? payload.installation.suspended_at ?? timestamp : timestamp, timestamp, payload.installation.id),
        env.DB.prepare(`UPDATE repository SET github_access_state = ?, updated_at = ? WHERE workspace_id = (SELECT workspace_id FROM installation WHERE github_installation_id = ?)`).bind(payload.action === 'deleted' ? 'removed' : 'suspended', timestamp, payload.installation.id),
      ]);
      await cancelRunsForAccessRevocation(env, repositories.results.map((repository) => repository.id));
    }
    return;
  }
  if (eventName === 'installation_repositories') {
    for (const repository of payload.repositories_added ?? []) await upsertRepository(env, payload.installation.id, repository, true, true);
    const removedIds = (payload.repositories_removed ?? []).map((repository: JsonObject) => id('repo', repository.id));
    for (const repository of payload.repositories_removed ?? []) await env.DB.prepare(`UPDATE repository SET github_access_state = 'removed', updated_at = ? WHERE github_repository_id = ?`).bind(now(), repository.id).run();
    await cancelRunsForAccessRevocation(env, removedIds);
    return;
  }
  if (eventName === 'pull_request') return handlePullRequest(env, payload);
  if (eventName === 'pull_request_review_thread') return handleReviewThread(env, payload);
  // deployment_status is intentionally acknowledged; active QA resolution polls the trusted deployment API.
}
