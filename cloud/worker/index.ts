import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { encryptWorkspaceSecret } from './crypto';
import { appOrigins, createAuth, requireAdmin, requirePrincipal } from './auth';
import type { Env, Principal } from './env';
import { appendRunEvent } from './events';
import { createRun, detectJurorWorkflow, provisionInstallation } from './github-webhook';
import { githubApi } from './github';
import { discoverGitHubInstallations, installationProvisioningPayload } from './github-installations';
import { createBillingPortal, createCheckout, verifyStripeSignature } from './stripe';
import { verifyHmacHeader, createSignedToken, timingSafeEqual } from './crypto';
import { destroyRunSandbox, enqueueNextRepositoryQa, sweepQueuedQaAdmissions } from './workflows';
import { corpusExportResponse, runCorpusRetention, type QueueMessage } from './corpus';
import { processQueueBatch } from './queue';
import { reconcileStripeMeterEvents } from './billing';
import type { HostedReviewReportV1 } from '../../src/cloud/types';
import type { QaRunResult } from '../../src/qa/types';
import { unsafeQaOrigin } from './qa-security';
import { anyReviewPresetReady, qaProviderReady, reviewPresetReadiness } from './providers';
import { repositorySettingsSchema, resolveSecretHeadersCiphertext } from './repository-settings';
import { handleMcpRequest } from './mcp';
import { launchBrowserHostedReview, launchBrowserHostedRerun, ReviewServiceError } from './review-service';

export { ContainerProxy, JurorSandbox, QaSandbox, ReviewSandbox } from './sandbox';
export { HostedQaWorkflow, HostedReviewWorkflow } from './workflows';

type Variables = { requestId: string; principal: Principal };
type AppEnv = { Bindings: Env; Variables: Variables };
const app = new Hono<AppEnv>();

app.use('*', secureHeaders());
app.use('*', async (c, next) => {
  const requestId = c.req.header('cf-ray') ?? crypto.randomUUID();
  c.set('requestId', requestId);
  await next();
  c.header('x-request-id', requestId);
});
app.use('/api/*', async (c, next) => {
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method);
  const providerWebhook = c.req.path === '/api/github/webhooks' || c.req.path === '/api/stripe/webhooks';
  const origin = c.req.header('origin');
  const localOrigin = origin === 'http://localhost:4173' && c.env.APP_URL.startsWith('http://localhost:');
  if (mutating && !providerWebhook && origin && !appOrigins(c.env).includes(origin) && !localOrigin) {
    return c.json({ error: { code: 'origin_forbidden', message: 'The request origin is not trusted.' }, requestId: c.get('requestId') }, 403);
  }
  await next();
});
app.use('/api/auth/*', cors({ origin: (origin, c) => appOrigins(c.env).includes(origin) || (c.env.APP_URL.startsWith('http://localhost:') && origin === 'http://localhost:4173') ? origin : c.env.APP_URL, credentials: true }));
// Juror accepts RFC 7591 registration only for public MCP clients. Keeping this
// guard ahead of Better Auth prevents an unauthenticated caller from obtaining
// a client secret through the otherwise generic DCR endpoint.
app.post('/api/auth/oauth2/register', async (c) => {
  if (!c.req.header('content-type')?.toLowerCase().includes('application/json')) {
    return c.json({ error: 'invalid_client_metadata', error_description: 'Dynamic registration requires application/json.' }, 400, { 'cache-control': 'no-store' });
  }
  let registration: { token_endpoint_auth_method?: unknown; grant_types?: unknown; client_secret?: unknown };
  try { registration = await c.req.raw.clone().json(); }
  catch { return c.json({ error: 'invalid_client_metadata', error_description: 'Dynamic registration body must be valid JSON.' }, 400, { 'cache-control': 'no-store' }); }
  const codeOnly = registration.grant_types === undefined || (Array.isArray(registration.grant_types) && registration.grant_types.length === 1 && registration.grant_types[0] === 'authorization_code');
  if (registration.token_endpoint_auth_method !== 'none' || !codeOnly || registration.client_secret !== undefined) {
    return c.json({ error: 'invalid_client_metadata', error_description: 'Juror accepts public authorization-code clients with PKCE S256 only.' }, 400, { 'cache-control': 'no-store' });
  }
  return createAuth(c.env, c.req.url).handler(c.req.raw);
});
app.all('/api/auth/*', (c) => createAuth(c.env, c.req.url).handler(c.req.raw));
// These discovery routes must always reach the Worker; Wrangler routes them ahead of the SPA assets.
app.all('/.well-known/oauth-protected-resource', (c) => createAuth(c.env, c.req.url).handler(c.req.raw));
app.all('/.well-known/oauth-protected-resource/mcp', (c) => createAuth(c.env, c.req.url).handler(c.req.raw));
app.all('/.well-known/oauth-authorization-server/api/auth', (c) => createAuth(c.env, c.req.url).handler(c.req.raw));
// New remote listings use Streamable HTTP. The modern transport is POST-only;
// do not expose an SSE compatibility route.
app.post('/mcp', (c) => handleMcpRequest(c.env, c.req.raw));
app.get('/.well-known/glama.json', (c) => {
  const email = c.env.GLAMA_MAINTAINER_EMAIL;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.notFound();
  return c.json({ maintainers: [{ email }] });
});

app.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse();
  if (error instanceof ReviewServiceError) return c.json({ error: { code: error.code, message: error.message }, requestId: c.get('requestId') }, error.status);
  if (error instanceof z.ZodError) return c.json({ error: { code: 'invalid_request', message: 'The request payload is invalid.', issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) }, requestId: c.get('requestId') }, 400);
  if (error instanceof Response) return error;
  console.error(JSON.stringify({ requestId: c.get('requestId'), error: error instanceof Error ? error.message : String(error) }));
  return c.json({ error: { code: 'internal_error', message: 'The request could not be completed.' }, requestId: c.get('requestId') }, 500);
});

app.get('/api/health', (c) => c.json({ status: 'ok', service: 'juror-cloud', requestId: c.get('requestId') }));

function configured(value: string | undefined, placeholder?: string): boolean {
  return Boolean(value && value !== placeholder && value !== 'unconfigured' && !value.includes('replace_before_deploy'));
}

function positiveRate(value: string | undefined): boolean { return Number.isFinite(Number(value)) && Number(value) > 0; }

app.get('/api/readiness', (c) => {
  // Unauthenticated: report only whether each capability is usable, never which secret is unset.
  const reviewPresets = reviewPresetReadiness(c.env);
  const checks = {
    github: configured(c.env.GITHUB_APP_ID) && configured(c.env.GITHUB_APP_PRIVATE_KEY) && configured(c.env.GITHUB_WEBHOOK_SECRET) && configured(c.env.GITHUB_OAUTH_CLIENT_ID) && configured(c.env.GITHUB_OAUTH_CLIENT_SECRET) && configured(c.env.GITHUB_APP_SLUG),
    google: configured(c.env.GOOGLE_CLIENT_ID) && configured(c.env.GOOGLE_CLIENT_SECRET),
    reviews: anyReviewPresetReady(c.env),
    qa: qaProviderReady(c.env),
    billing: configured(c.env.STRIPE_SECRET_KEY) && configured(c.env.STRIPE_WEBHOOK_SECRET) && configured(c.env.STRIPE_PRICE_ID, 'unconfigured'),
    corpus: configured(c.env.CORPUS_MASTER_KEY_B64),
    costs: positiveRate(c.env.CONTAINER_CPU_MICRO_USD_PER_VCPU_SECOND) && positiveRate(c.env.CONTAINER_MEMORY_MICRO_USD_PER_GIB_SECOND) && positiveRate(c.env.CONTAINER_DISK_MICRO_USD_PER_GB_SECOND) && positiveRate(c.env.R2_STORAGE_MICRO_USD_PER_GB_MONTH),
  };
  return c.json({ data: { ready: checks.github && checks.reviews && checks.corpus && checks.costs, checks, reviewPresets }, requestId: c.get('requestId') });
});

async function authSession(c: Context<AppEnv>) {
  const session = await createAuth(c.env, c.req.url).api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new HTTPException(401, { message: 'Unauthorized' });
  return session;
}

async function installationState(env: Env, userId: string): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + 10 * 60;
  const signature = await createSignedToken(env.EVIDENCE_SIGNING_SECRET, `github-install:${userId}:${expires}`);
  return btoa(JSON.stringify({ userId, expires, signature })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function linkedGithubAccessToken(env: Env, userId: string): Promise<string | null> {
  const account = await env.DB.prepare(`SELECT accessToken FROM account WHERE userId = ? AND providerId = 'github' ORDER BY updatedAt DESC LIMIT 1`).bind(userId).first<{ accessToken: string | null }>();
  return account?.accessToken ?? null;
}

app.get('/api/github/install-url', async (c) => {
  const session = await authSession(c);
  const state = await installationState(c.env, session.user.id);
  const appSlug = c.env.GITHUB_APP_SLUG;
  if (!appSlug || !/^[a-z0-9-]+$/i.test(appSlug)) return c.json({ error: { code: 'missing_app_slug', message: 'The GitHub App slug is not configured.' }, requestId: c.get('requestId') }, 503);
  return envelope(c, { url: `https://github.com/apps/${appSlug}/installations/new?state=${encodeURIComponent(state)}` });
});

app.get('/api/github/manage-url', async (c) => {
  const principal = await withPrincipal(c);
  const installation = await c.env.DB.prepare('SELECT github_installation_id FROM installation WHERE workspace_id = ?').bind(principal.workspaceId).first<{ github_installation_id: number }>();
  if (!installation) return c.json({ error: { code: 'installation_missing', message: 'No GitHub App installation is linked.' }, requestId: c.get('requestId') }, 404);
  return envelope(c, { url: `https://github.com/settings/installations/${installation.github_installation_id}` });
});

app.get('/api/onboarding/status', async (c) => {
  const session = await authSession(c);
  const [githubAccount, membership] = await Promise.all([
    c.env.DB.prepare(`SELECT 1 AS linked FROM account WHERE userId = ? AND providerId = 'github' LIMIT 1`).bind(session.user.id).first(),
    c.env.DB.prepare('SELECT workspace_id FROM membership WHERE user_id = ? ORDER BY created_at LIMIT 1').bind(session.user.id).first<{ workspace_id: string }>(),
  ]);
  return envelope(c, { hasGithub: Boolean(githubAccount), hasWorkspace: Boolean(membership), workspaceId: membership?.workspace_id ?? null });
});

app.get('/api/onboarding/installations', async (c) => {
  const session = await authSession(c);
  const accessToken = await linkedGithubAccessToken(c.env, session.user.id);
  if (!accessToken) return c.json({ error: { code: 'github_link_required', message: 'Link GitHub before choosing an installation.' }, requestId: c.get('requestId') }, 409);
  let installations;
  try {
    installations = await discoverGitHubInstallations(accessToken, c.env.GITHUB_APP_SLUG);
  } catch (error) {
    console.warn(JSON.stringify({ requestId: c.get('requestId'), event: 'github_installation_discovery_failed', error: error instanceof Error ? error.message : String(error) }));
    return c.json({ error: { code: 'installation_discovery_failed', message: 'GitHub could not load your Juror Cloud installations. Reconnect GitHub and try again.' }, requestId: c.get('requestId') }, 502);
  }
  return envelope(c, {
    state: await installationState(c.env, session.user.id),
    installations: installations.map((installation) => ({
      id: installation.id,
      accountLogin: installation.account.login,
      accountType: installation.account.type,
      repositorySelection: installation.repositorySelection,
      repositories: installation.repositories.map((repository) => ({ id: repository.id, fullName: repository.fullName, private: repository.private, archived: repository.archived, defaultBranch: repository.defaultBranch })),
    })),
  });
});

const claimInstallationSchema = z.object({ installationId: z.number().int().positive(), state: z.string().min(10) });
app.post('/api/onboarding/claim-installation', async (c) => {
  const session = await authSession(c);
  const input = claimInstallationSchema.parse(await c.req.json());
  let state: { userId: string; expires: number; signature: string };
  try {
    const normalized = input.state.replace(/-/g, '+').replace(/_/g, '/');
    state = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))) as typeof state;
  } catch { return c.json({ error: { code: 'invalid_state', message: 'Invalid installation state.' }, requestId: c.get('requestId') }, 400); }
  const expected = await createSignedToken(c.env.EVIDENCE_SIGNING_SECRET, `github-install:${session.user.id}:${state.expires}`);
  if (state.userId !== session.user.id || state.expires < Date.now() / 1000 || !timingSafeEqual(expected, state.signature)) return c.json({ error: { code: 'invalid_state', message: 'The installation request expired or belongs to another user.' }, requestId: c.get('requestId') }, 403);
  const accessToken = await linkedGithubAccessToken(c.env, session.user.id);
  if (!accessToken) return c.json({ error: { code: 'github_link_required', message: 'Link GitHub before claiming an installation.' }, requestId: c.get('requestId') }, 409);
  let installations;
  try { installations = await discoverGitHubInstallations(accessToken, c.env.GITHUB_APP_SLUG); }
  catch { return c.json({ error: { code: 'installation_verification_failed', message: 'GitHub could not verify this installation.' }, requestId: c.get('requestId') }, 403); }
  const installation = installations.find((candidate) => candidate.id === input.installationId);
  if (!installation) return c.json({ error: { code: 'installation_forbidden', message: 'This GitHub installation is not available to your account.' }, requestId: c.get('requestId') }, 403);
  // A setup callback can beat the installation webhook, returning users may have installed the
  // App before this deployment existed, and an earlier import may have stopped part-way through.
  // The linked GitHub identity has independently proved access, so idempotently reconcile the
  // verified payload on every claim. Existing settings skip optional Action detection.
  await provisionInstallation(c.env, installationProvisioningPayload(installation));
  const workspace = await c.env.DB.prepare('SELECT id FROM workspace WHERE github_installation_id = ?').bind(input.installationId).first<{ id: string }>();
  if (!workspace) return c.json({ error: { code: 'installation_pending', message: 'The GitHub webhook has not arrived yet. Try again in a moment.' }, requestId: c.get('requestId') }, 409);
  const existingMembers = await c.env.DB.prepare('SELECT COUNT(*) AS count FROM membership WHERE workspace_id = ?').bind(workspace.id).first<{ count: number }>();
  await c.env.DB.prepare('INSERT OR IGNORE INTO membership (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').bind(workspace.id, session.user.id, (existingMembers?.count ?? 0) === 0 ? 'admin' : 'member', new Date().toISOString()).run();
  return envelope(c, { workspaceId: workspace.id, role: (existingMembers?.count ?? 0) === 0 ? 'admin' : 'member' });
});

async function withPrincipal(c: Context<AppEnv>): Promise<Principal> {
  const principal = await requirePrincipal(c);
  c.set('principal', principal);
  return principal;
}

function envelope<T>(c: Context<AppEnv>, data: T) { return c.json({ data, requestId: c.get('requestId') }); }
function repositoryRef(row: any) { return { id: row.repository_id, owner: row.owner, name: row.name, fullName: row.full_name, private: Boolean(row.is_private) }; }
function runItem(row: any) {
  return {
    id: row.id, identity: row.identity, kind: row.kind, status: row.status, phase: row.phase,
    repository: repositoryRef(row), prNumber: row.pr_number, sha: row.revision_sha, findings: row.findings_count,
    costMicroUsd: row.billable_micro_usd, durationMs: row.duration_ms, startedAt: row.started_at ?? row.created_at,
    githubUrl: `https://github.com/${row.full_name}/pull/${row.pr_number}`,
  };
}
function findingItem(row: any) {
  return {
    id: row.id, fingerprint: row.fingerprint, title: row.title, status: row.status, source: row.source, severity: row.severity,
    repository: repositoryRef(row), prNumber: row.pr_number, pathOrCheckpoint: row.path_or_checkpoint, line: row.line,
    agreement: row.agreement_count === null ? null : { agreeing: row.agreement_count, total: row.agreement_total },
    reproducible: row.reproducible === null ? null : Boolean(row.reproducible),
    assignee: row.assignee_user_id ? { id: row.assignee_user_id, name: row.assignee_name ?? row.assignee_email } : null,
    firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at,
  };
}

app.get('/api/context', async (c) => {
  const principal = await withPrincipal(c);
  const [workspace, repositories, counts] = await Promise.all([
    c.env.DB.prepare(`SELECT w.id, w.name, w.slug, u.name AS user_name, u.image AS avatar_url FROM workspace w LEFT JOIN "user" u ON u.id = ? WHERE w.id = ?`).bind(principal.userId, principal.workspaceId).first<any>(),
    c.env.DB.prepare(`SELECT id, owner, name, full_name, is_private FROM repository WHERE workspace_id = ? AND github_access_state = 'active' ORDER BY full_name`).bind(principal.workspaceId).all<any>(),
    c.env.DB.prepare(`SELECT (SELECT COUNT(*) FROM finding WHERE workspace_id = ? AND status = 'open' AND severity IN ('P0','P1')) AS critical_open, (SELECT COUNT(*) FROM run WHERE workspace_id = ? AND status = 'running') AS live_runs, (SELECT COUNT(*) FROM repository_settings rs JOIN repository repo ON repo.id = rs.repository_id WHERE repo.workspace_id = ? AND rs.qa_enabled = 1) AS qa_enabled`).bind(principal.workspaceId, principal.workspaceId, principal.workspaceId).first<any>(),
  ]);
  if (!workspace) return c.json({ error: { code: 'not_found', message: 'Workspace not found.' }, requestId: c.get('requestId') }, 404);
  return envelope(c, { workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug, role: principal.role, avatarUrl: workspace.avatar_url, userName: workspace.user_name }, repositories: repositories.results.map((row) => repositoryRef({ ...row, repository_id: row.id })), criticalOpen: counts?.critical_open ?? 0, liveRuns: counts?.live_runs ?? 0, qaEnabled: counts?.qa_enabled ?? 0 });
});

const runJoin = `SELECT r.*, repo.id AS repository_id, repo.owner, repo.name, repo.full_name, repo.is_private FROM run r JOIN repository repo ON repo.id = r.repository_id`;
const findingJoin = `SELECT f.*, repo.id AS repository_id, repo.owner, repo.name, repo.full_name, repo.is_private, pr.number AS pr_number, u.name AS assignee_name, u.email AS assignee_email FROM finding f JOIN repository repo ON repo.id = f.repository_id LEFT JOIN finding_occurrence fo ON fo.finding_id = f.id AND fo.seen_at = f.last_seen_at LEFT JOIN run rr ON rr.id = fo.run_id LEFT JOIN pull_request pr ON pr.id = rr.pull_request_id LEFT JOIN "user" u ON u.id = f.assignee_user_id`;

app.get('/api/overview', async (c) => {
  const principal = await withPrincipal(c);
  const [metrics, attention, attentionRuns, running, recent] = await Promise.all([
    c.env.DB.prepare(`SELECT (SELECT COUNT(*) FROM finding WHERE workspace_id = ? AND status = 'open' AND severity IN ('P0','P1')) AS critical_open, (SELECT COUNT(*) FROM finding WHERE workspace_id = ? AND status = 'open' AND source = 'qa' AND reproducible = 1) AS qa_issues, (SELECT COALESCE(SUM(billable_micro_usd),0) FROM usage_ledger WHERE workspace_id = ? AND created_at >= datetime('now','start of month')) AS spend`).bind(principal.workspaceId, principal.workspaceId, principal.workspaceId).first<any>(),
    c.env.DB.prepare(`${findingJoin} WHERE f.workspace_id = ? AND f.status = 'open' AND ((f.severity IN ('P0','P1')) OR f.source = 'qa') GROUP BY f.id ORDER BY CASE f.severity WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END, f.last_seen_at DESC LIMIT 8`).bind(principal.workspaceId).all<any>(),
    c.env.DB.prepare(`${runJoin} WHERE r.workspace_id = ? AND (r.status IN ('failed','blocked') OR (r.kind = 'qa' AND r.outcome = 'blocked')) ORDER BY r.created_at DESC LIMIT 6`).bind(principal.workspaceId).all<any>(),
    c.env.DB.prepare(`${runJoin} WHERE r.workspace_id = ? AND r.status = 'running' ORDER BY r.started_at`).bind(principal.workspaceId).all<any>(),
    c.env.DB.prepare(`${runJoin} WHERE r.workspace_id = ? ORDER BY r.created_at DESC LIMIT 12`).bind(principal.workspaceId).all<any>(),
  ]);
  return envelope(c, { metrics: { criticalOpen: metrics?.critical_open ?? 0, qaProductIssues: metrics?.qa_issues ?? 0, currentSpendMicroUsd: metrics?.spend ?? 0 }, attention: attention.results.map(findingItem), attentionRuns: attentionRuns.results.map(runItem), running: running.results.map(runItem), recent: recent.results.map(runItem) });
});

app.get('/api/findings', async (c) => {
  const principal = await withPrincipal(c);
  const status = c.req.query('status'); const source = c.req.query('source'); const severity = c.req.query('severity');
  const values: unknown[] = [principal.workspaceId];
  const clauses = ['f.workspace_id = ?'];
  if (status && ['open', 'resolved', 'ignored'].includes(status)) { clauses.push('f.status = ?'); values.push(status); }
  if (source && ['review', 'qa'].includes(source)) { clauses.push('f.source = ?'); values.push(source); }
  if (severity && ['P0', 'P1', 'P2', 'P3'].includes(severity)) { clauses.push('f.severity = ?'); values.push(severity); }
  const result = await c.env.DB.prepare(`${findingJoin} WHERE ${clauses.join(' AND ')} GROUP BY f.id ORDER BY CASE f.severity WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END, f.last_seen_at DESC LIMIT 200`).bind(...values).all<any>();
  return envelope(c, result.results.map(findingItem));
});

app.get('/api/findings/:id', async (c) => {
  const principal = await withPrincipal(c);
  const row = await c.env.DB.prepare(`${findingJoin} WHERE f.workspace_id = ? AND f.id = ? GROUP BY f.id`).bind(principal.workspaceId, c.req.param('id')).first<any>();
  if (!row) return c.json({ error: { code: 'not_found', message: 'Finding not found' }, requestId: c.get('requestId') }, 404);
  const occurrence = await c.env.DB.prepare(`SELECT fo.details_json, r.report_r2_key, r.revision_sha FROM finding_occurrence fo JOIN run r ON r.id = fo.run_id WHERE fo.finding_id = ? ORDER BY fo.seen_at DESC LIMIT 1`).bind(row.id).first<any>();
  const details = occurrence ? JSON.parse(occurrence.details_json) : {};
  let body: string | null = null;
  let claim: Record<string, unknown> | null = null;
  let expected: string | null = null;
  let actual: string | null = null;
  let verification: unknown = null;
  let target: QaRunResult['target'] | null = null;
  let rawAttempts: Array<{ attempt: number; status: string; observed: string; screenshotArtifactId: string | null }> = [];
  if (occurrence?.report_r2_key) {
    const reportObject = await c.env.REPORTS.get(occurrence.report_r2_key);
    if (reportObject) {
      const report = JSON.parse(await reportObject.text()) as HostedReviewReportV1 | QaRunResult;
      if (row.source === 'review') {
        const cluster = (report as HostedReviewReportV1).clusters.find((candidate) => candidate.fingerprint === row.fingerprint);
        body = cluster?.body ?? null;
        claim = (cluster?.members[0]?.claim as unknown as Record<string, unknown> | undefined) ?? null;
        verification = cluster?.verification ?? null;
      } else {
        const qaReport = report as QaRunResult;
        const issue = qaReport.issues.find((candidate) => candidate.scenario_id === details.scenarioId && candidate.checkpoint_id === details.checkpointId);
        body = issue ? `Scenario ${issue.scenario_id} failed checkpoint ${issue.checkpoint_id}.` : null;
        expected = issue?.expected ?? null;
        actual = issue?.actual ?? null;
        target = qaReport.target;
        if (issue) {
          const artifacts = new Map(qaReport.artifacts.map((artifact) => [artifact.id, artifact]));
          rawAttempts = qaReport.attempts.filter((attempt) => attempt.scenario_id === issue.scenario_id && issue.attempt_numbers.includes(attempt.attempt)).map((attempt) => {
            const checkpoint = attempt.checkpoints.find((candidate) => candidate.checkpoint_id === issue.checkpoint_id);
            const screenshot = attempt.evidence_artifact_ids.map((artifactId) => artifacts.get(artifactId)).find((artifact) => artifact?.kind === 'screenshot' && artifact.upload);
            return { attempt: attempt.attempt, status: checkpoint?.status ?? attempt.status, observed: checkpoint?.observed ?? issue.actual, screenshotArtifactId: screenshot?.upload?.name ?? null };
          });
        }
      }
    }
  }
  const expires = Math.floor(Date.now() / 1000) + 300;
  const attempts = await Promise.all(rawAttempts.map(async (attempt) => {
    if (!attempt.screenshotArtifactId) return attempt;
    const signature = await createSignedToken(c.env.EVIDENCE_SIGNING_SECRET, `${principal.workspaceId}:${attempt.screenshotArtifactId}:${expires}`);
    return { ...attempt, screenshotUrl: `/api/artifacts/${attempt.screenshotArtifactId}/content?expires=${expires}&signature=${signature}`, screenshotArtifactId: undefined };
  }));
  const targetRevision = target?.revision ?? null;
  const revision = targetRevision ? { expectedSha: targetRevision.expected_sha, observedSha: targetRevision.observed_sha, relation: targetRevision.relation, method: targetRevision.method } : null;
  return envelope(c, { ...findingItem(row), body: body ?? 'The retained detail report has expired.', claim, expected, actual, attempts, targetUrl: target?.url ?? null, targetRevision: revision, verification, githubUrl: `https://github.com/${row.full_name}/pull/${row.pr_number}`, diff: null });
});

const triageSchema = z.object({ status: z.enum(['open', 'resolved', 'ignored']), assigneeUserId: z.string().nullable().optional(), reason: z.string().max(240).optional() });
app.patch('/api/findings/:id', async (c) => {
  const principal = await withPrincipal(c);
  const input = triageSchema.parse(await c.req.json());
  const finding = await c.env.DB.prepare('SELECT status FROM finding WHERE id = ? AND workspace_id = ?').bind(c.req.param('id'), principal.workspaceId).first<{ status: string }>();
  if (!finding) return c.json({ error: { code: 'not_found', message: 'Finding not found' }, requestId: c.get('requestId') }, 404);
  const timestamp = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE finding SET status = ?, assignee_user_id = COALESCE(?, assignee_user_id), resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE NULL END, ignored_at = CASE WHEN ? = 'ignored' THEN ? ELSE NULL END WHERE id = ?`).bind(input.status, input.assigneeUserId ?? null, input.status, timestamp, input.status, timestamp, c.req.param('id')),
    c.env.DB.prepare(`INSERT INTO triage_event (id, finding_id, actor_user_id, source, from_status, to_status, reason, created_at) VALUES (?, ?, ?, 'dashboard', ?, ?, ?, ?)`).bind(`triage_${crypto.randomUUID()}`, c.req.param('id'), principal.userId, finding.status, input.status, input.reason ?? null, timestamp),
  ]);
  return envelope(c, { id: c.req.param('id'), status: input.status });
});

function parsePatch(patch: string) {
  const lines: Array<{ kind: 'context' | 'addition' | 'deletion'; oldLine: number | null; newLine: number | null; content: string }> = [];
  let oldLine = 0; let newLine = 0; let oldStart = 0; let newStart = 0;
  for (const raw of patch.split('\n')) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); oldStart ||= oldLine; newStart ||= newLine; continue; }
    if (raw.startsWith('+') && !raw.startsWith('+++')) { lines.push({ kind: 'addition', oldLine: null, newLine: newLine++, content: raw.slice(1) }); continue; }
    if (raw.startsWith('-') && !raw.startsWith('---')) { lines.push({ kind: 'deletion', oldLine: oldLine++, newLine: null, content: raw.slice(1) }); continue; }
    if (raw.startsWith(' ')) { lines.push({ kind: 'context', oldLine: oldLine++, newLine: newLine++, content: raw.slice(1) }); }
  }
  return { oldStart, newStart, lines };
}

app.get('/api/findings/:id/diff', async (c) => {
  const principal = await withPrincipal(c);
  const row = await c.env.DB.prepare(`SELECT f.path_or_checkpoint, f.line, repo.full_name, pr.number AS pr_number, i.github_installation_id FROM finding f JOIN repository repo ON repo.id = f.repository_id JOIN installation i ON i.workspace_id = f.workspace_id JOIN finding_occurrence fo ON fo.finding_id = f.id JOIN run r ON r.id = fo.run_id JOIN pull_request pr ON pr.id = r.pull_request_id WHERE f.id = ? AND f.workspace_id = ? ORDER BY fo.seen_at DESC LIMIT 1`).bind(c.req.param('id'), principal.workspaceId).first<any>();
  if (!row) return c.json({ error: { code: 'not_found', message: 'Finding not found' }, requestId: c.get('requestId') }, 404);
  let file: { filename: string; previous_filename?: string; patch?: string } | undefined;
  for (let page = 1; page <= 30 && !file; page += 1) {
    const response = await githubApi(c.env, row.github_installation_id, `/repos/${row.full_name}/pulls/${row.pr_number}/files?per_page=100&page=${page}`);
    if (!response.ok) throw new Error(`GitHub diff request failed (${response.status})`);
    const files = await response.json<Array<{ filename: string; previous_filename?: string; patch?: string }>>();
    file = files.find((candidate) => candidate.filename === row.path_or_checkpoint);
    if (files.length < 100) break;
  }
  if (!file?.patch) return envelope(c, null);
  return envelope(c, { oldPath: file.previous_filename ?? file.filename, newPath: file.filename, ...parsePatch(file.patch) });
});

app.get('/api/runs', async (c) => {
  const principal = await withPrincipal(c);
  const kind = c.req.query('kind');
  const query = kind && ['review', 'qa'].includes(kind) ? `${runJoin} WHERE r.workspace_id = ? AND r.kind = ? ORDER BY r.created_at DESC LIMIT 200` : `${runJoin} WHERE r.workspace_id = ? ORDER BY r.created_at DESC LIMIT 200`;
  const result = kind && ['review', 'qa'].includes(kind) ? await c.env.DB.prepare(query).bind(principal.workspaceId, kind).all<any>() : await c.env.DB.prepare(query).bind(principal.workspaceId).all<any>();
  return envelope(c, result.results.map(runItem));
});

app.get('/api/runs/:id', async (c) => {
  const principal = await withPrincipal(c);
  const row = await c.env.DB.prepare(`${runJoin} WHERE r.workspace_id = ? AND r.id = ?`).bind(principal.workspaceId, c.req.param('id')).first<any>();
  if (!row) return c.json({ error: { code: 'not_found', message: 'Run not found' }, requestId: c.get('requestId') }, 404);
  const events = await c.env.DB.prepare('SELECT sequence, timestamp, phase, status, message, metrics_json FROM run_event WHERE run_id = ? ORDER BY sequence').bind(row.id).all<any>();
  const eventItems = events.results.map((event) => ({ sequence: event.sequence, timestamp: event.timestamp, phase: event.phase, status: event.status, message: event.message, ...JSON.parse(event.metrics_json) }));
  const receipt = [{ label: 'Models', amountMicroUsd: row.provider_micro_usd }, { label: 'Sandbox', amountMicroUsd: row.sandbox_micro_usd }, { label: 'Evidence storage', amountMicroUsd: row.storage_micro_usd }, { label: 'Juror service fee', amountMicroUsd: row.service_fee_micro_usd }];
  const receiptSubtotal = receipt.reduce((sum, item) => sum + item.amountMicroUsd, 0);
  if (receiptSubtotal > row.billable_micro_usd) receipt.push({ label: 'Juror infrastructure credit', amountMicroUsd: row.billable_micro_usd - receiptSubtotal });
  return envelope(c, { ...runItem(row), events: eventItems, warnings: eventItems.filter((event) => event.status === 'warning').map((event) => event.message), receipt, terminal: eventItems.map((event) => ({ timestamp: event.timestamp, level: event.status === 'failed' ? 'error' : event.status === 'warning' ? 'warn' : 'info', message: event.message })) });
});

app.get('/api/runs/:id/events', async (c) => {
  const principal = await withPrincipal(c);
  const run = await c.env.DB.prepare('SELECT id FROM run WHERE id = ? AND workspace_id = ?').bind(c.req.param('id'), principal.workspaceId).first();
  if (!run) return c.json({ error: { code: 'not_found', message: 'Run not found' }, requestId: c.get('requestId') }, 404);
  const initialSequence = Number.parseInt(c.req.header('last-event-id') ?? c.req.query('after') ?? '0', 10) || 0;
  return streamSSE(c, async (stream) => {
    let sequence = initialSequence;
    while (!stream.closed && !c.req.raw.signal.aborted) {
      const events = await c.env.DB.prepare('SELECT sequence, timestamp, phase, status, message, metrics_json FROM run_event WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT 50').bind(c.req.param('id'), sequence).all<any>();
      for (const event of events.results) {
        sequence = event.sequence;
        await stream.writeSSE({ id: String(event.sequence), event: 'run-event', data: JSON.stringify({ ...event, metrics: JSON.parse(event.metrics_json) }) });
      }
      const status = await c.env.DB.prepare('SELECT status FROM run WHERE id = ?').bind(c.req.param('id')).first<{ status: string }>();
      if (status && !['queued', 'running'].includes(status.status) && events.results.length === 0) { await stream.writeSSE({ event: 'complete', data: JSON.stringify({ status: status.status }) }); break; }
      await stream.sleep(1_000);
    }
  });
});

async function authorizeRun(c: Context<AppEnv>) {
  const principal = await withPrincipal(c);
  const row = await c.env.DB.prepare('SELECT * FROM run WHERE id = ? AND workspace_id = ?').bind(c.req.param('id'), principal.workspaceId).first<any>();
  if (!row) throw new HTTPException(404, { message: 'Run not found' });
  return row;
}

app.post('/api/runs/:id/cancel', async (c) => {
  const run = await authorizeRun(c);
  if (!['queued', 'running'].includes(run.status)) return c.json({ error: { code: 'not_cancellable', message: 'Run is already terminal' }, requestId: c.get('requestId') }, 409);
  await destroyRunSandbox(c.env, run.kind, run.id);
  if (run.workflow_instance_id) {
    const workflow = run.kind === 'review' ? c.env.REVIEW_WORKFLOW : c.env.QA_WORKFLOW;
    try { await (await workflow.get(run.workflow_instance_id)).terminate(); } catch { /* Terminal races are resolved by the conditional update. */ }
  }
  const timestamp = new Date().toISOString();
  await c.env.DB.prepare(`UPDATE run SET status = 'cancelled', phase = 'cancelled', outcome = 'cancelled', reserved_micro_usd = 0, completed_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued','running')`).bind(timestamp, timestamp, run.id).run();
  await appendRunEvent(c.env, run.id, 'cancelled', 'cancelled', 'Cancelled by a workspace member.');
  if (run.kind === 'qa') try { await enqueueNextRepositoryQa(c.env, run.id); } catch { await appendRunEvent(c.env, run.id, 'cancelled', 'warning', 'The next queued QA run will be recovered by the admission sweep.'); }
  return envelope(c, { id: run.id, status: 'cancelled' });
});

app.post('/api/runs/:id/rerun', async (c) => {
  const principal = await withPrincipal(c);
  return envelope(c, await launchBrowserHostedRerun(c.env, principal, c.req.param('id')));
});

app.get('/api/repositories', async (c) => {
  const principal = await withPrincipal(c);
  const result = await c.env.DB.prepare(`SELECT repo.*, rs.*, r.id AS latest_run_id, r.kind AS latest_run_kind, r.status AS latest_run_status, r.phase AS latest_run_phase, r.pr_number AS latest_pr_number, r.revision_sha AS latest_revision_sha, r.findings_count AS latest_findings_count, r.billable_micro_usd AS latest_cost, r.duration_ms AS latest_duration, r.started_at AS latest_started, r.created_at AS latest_created FROM repository repo JOIN repository_settings rs ON rs.repository_id = repo.id LEFT JOIN run r ON r.id = (SELECT id FROM run WHERE repository_id = repo.id ORDER BY created_at DESC LIMIT 1) WHERE repo.workspace_id = ? ORDER BY repo.full_name`).bind(principal.workspaceId).all<any>();
  return envelope(c, result.results.map((row) => ({ ...repositoryRef(row), defaultBranch: row.default_branch, connectionStatus: row.github_access_state !== 'active' ? 'suspended' : row.action_detected ? 'attention' : 'healthy', hostedAutomationBlocked: Boolean(row.action_detected), reviewEnabled: Boolean(row.review_enabled), reviewPreset: row.review_preset, publishMode: row.publish_mode, severityFloor: row.severity_floor, qaEnabled: Boolean(row.qa_enabled), qaReady: Boolean(row.qa_security_ready), qaTarget: row.qa_target_url, allowedOrigins: JSON.parse(row.qa_allowed_origins_json), hasSessionBootstrap: Boolean(row.qa_session_bootstrap_ciphertext), hasSecretHeaders: Boolean(row.qa_secret_headers_ciphertext), hasResetHook: Boolean(row.qa_reset_hook_ciphertext), evidencePolicy: JSON.parse(row.qa_evidence_policy_json), latestRun: row.latest_run_id ? runItem({ id: row.latest_run_id, identity: '', kind: row.latest_run_kind, status: row.latest_run_status, phase: row.latest_run_phase, repository_id: row.id, owner: row.owner, name: row.name, full_name: row.full_name, is_private: row.is_private, pr_number: row.latest_pr_number, revision_sha: row.latest_revision_sha, findings_count: row.latest_findings_count, billable_micro_usd: row.latest_cost, duration_ms: row.latest_duration, started_at: row.latest_started, created_at: row.latest_created }) : null })));
});

app.post('/api/repositories/:id/review-now', async (c) => {
  const principal = await withPrincipal(c);
  const input = z.object({ prNumber: z.number().int().positive() }).parse(await c.req.json());
  return envelope(c, await launchBrowserHostedReview(c.env, principal, c.req.param('id'), input.prNumber));
});

app.patch('/api/repositories/:id', async (c) => {
  const principal = await withPrincipal(c); requireAdmin(principal);
  const input = repositorySettingsSchema.parse(await c.req.json());
  const row = await c.env.DB.prepare(`SELECT repo.id, repo.full_name, installation.github_installation_id, rs.* FROM repository repo JOIN installation ON installation.workspace_id = repo.workspace_id JOIN repository_settings rs ON rs.repository_id = repo.id WHERE repo.id = ? AND repo.workspace_id = ?`).bind(c.req.param('id'), principal.workspaceId).first<any>();
  if (!row) return c.json({ error: { code: 'not_found', message: 'Repository not found' }, requestId: c.get('requestId') }, 404);
  const enablingHostedAutomation = input.reviewEnabled === true || input.qaEnabled === true;
  if (enablingHostedAutomation) {
    const workflowDetection = await detectJurorWorkflow(c.env, row.github_installation_id, row.full_name);
    if (workflowDetection !== false) {
      await c.env.DB.prepare(`UPDATE repository_settings SET action_detected = 1, review_enabled = 0, qa_enabled = 0, qa_security_ready = 0, updated_at = ? WHERE repository_id = ?`).bind(new Date().toISOString(), row.id).run();
      return c.json({ error: { code: 'juror_workflow_check_required', message: workflowDetection ? 'Remove the existing Juror workflow before enabling hosted automation.' : 'Juror could not verify this repository workflow configuration. Try again after GitHub access recovers.' }, requestId: c.get('requestId') }, 409);
    }
  }
  const target = input.qaTarget === undefined ? row.qa_target_url : input.qaTarget;
  const allowedOrigins = input.allowedOrigins ?? JSON.parse(row.qa_allowed_origins_json);
  const nextQaEnabled = input.qaEnabled === undefined ? Boolean(row.qa_enabled) : input.qaEnabled;
  let qaReady = nextQaEnabled ? 1 : 0;
  const normalizedOrigins = allowedOrigins.map((origin: string) => new URL(origin).origin);
  if (unsafeQaOrigin(normalizedOrigins, c.env.APP_URL)) return c.json({ error: { code: 'qa_origin_reserved', message: 'QA origins must be public HTTPS hosts and cannot overlap Juror, GitHub, or model-provider endpoints.' }, requestId: c.get('requestId') }, 409);
  if (nextQaEnabled && (!target || new URL(target).protocol !== 'https:' || !normalizedOrigins.includes(new URL(target).origin))) return c.json({ error: { code: 'qa_security_incomplete', message: 'QA requires an HTTPS target included in the exact-origin allowlist.' }, requestId: c.get('requestId') }, 409);
  if (input.sessionBootstrap) {
    if (!target || new URL(input.sessionBootstrap.targetOrigin).origin !== new URL(target).origin || !normalizedOrigins.includes(new URL(input.sessionBootstrap.url).origin)) return c.json({ error: { code: 'qa_bootstrap_scope_invalid', message: 'Session bootstrap and target origins must be explicitly allowlisted.' }, requestId: c.get('requestId') }, 409);
  }
  if (input.secretHeaders?.some((header) => header.origins.some((origin) => !normalizedOrigins.includes(new URL(origin).origin)))) return c.json({ error: { code: 'qa_header_scope_invalid', message: 'Every secret header origin must be explicitly allowlisted.' }, requestId: c.get('requestId') }, 409);
  if (input.resetHook && !normalizedOrigins.includes(new URL(input.resetHook.url).origin)) return c.json({ error: { code: 'qa_reset_scope_invalid', message: 'The reset hook origin must be explicitly allowlisted.' }, requestId: c.get('requestId') }, 409);
  const secretHeadersCiphertext = await resolveSecretHeadersCiphertext(input.secretHeaders, row.qa_secret_headers_ciphertext, (plaintext) => encryptWorkspaceSecret(c.env, principal.workspaceId, plaintext));
  const resetCiphertext = input.resetHook ? await encryptWorkspaceSecret(c.env, principal.workspaceId, JSON.stringify(input.resetHook)) : input.resetHook === null ? null : row.qa_reset_hook_ciphertext;
  const sessionBootstrapJson = input.sessionBootstrap === undefined ? row.qa_session_bootstrap_json : input.sessionBootstrap === null ? null : JSON.stringify({ url: input.sessionBootstrap.url, secret_ref: 'JUROR_HOSTED_SESSION', target_origin: new URL(input.sessionBootstrap.targetOrigin).origin, ready_storage_key: input.sessionBootstrap.readyStorageKey });
  const sessionBootstrapCiphertext = input.sessionBootstrap === undefined ? row.qa_session_bootstrap_ciphertext : input.sessionBootstrap === null ? null : await encryptWorkspaceSecret(c.env, principal.workspaceId, input.sessionBootstrap.secret);
  const timestamp = new Date().toISOString();
  await c.env.DB.prepare(`UPDATE repository_settings SET execution_mode = 'cloud', action_detected = ?, review_enabled = ?, review_preset = ?, publish_mode = ?, severity_floor = ?, qa_enabled = ?, qa_security_ready = ?, qa_target_url = ?, qa_allowed_origins_json = ?, qa_session_bootstrap_json = ?, qa_session_bootstrap_ciphertext = ?, qa_secret_headers_ciphertext = ?, qa_reset_hook_ciphertext = ?, qa_evidence_policy_json = ?, settings_version = settings_version + 1, updated_by_user_id = ?, updated_at = ? WHERE repository_id = ?`)
    .bind(enablingHostedAutomation ? 0 : row.action_detected, input.reviewEnabled === undefined ? row.review_enabled : Number(input.reviewEnabled), input.reviewPreset ?? row.review_preset, input.publishMode ?? row.publish_mode, input.severityFloor ?? row.severity_floor, Number(nextQaEnabled), qaReady, target, JSON.stringify(normalizedOrigins), sessionBootstrapJson, sessionBootstrapCiphertext, secretHeadersCiphertext, resetCiphertext, input.evidencePolicy ? JSON.stringify({ ...JSON.parse(row.qa_evidence_policy_json), ...input.evidencePolicy, retention_days: 90 }) : row.qa_evidence_policy_json, principal.userId, timestamp, row.id).run();
  return envelope(c, { id: row.id, updatedAt: timestamp });
});

app.get('/api/usage', async (c) => {
  const principal = await withPrincipal(c);
  const [workspace, totals, invoices] = await Promise.all([
    c.env.DB.prepare('SELECT w.trial_remaining_micro_usd, w.monthly_cap_micro_usd, w.billing_state, EXISTS(SELECT 1 FROM stripe_customer sc WHERE sc.workspace_id = w.id) AS has_billing_customer FROM workspace w WHERE w.id = ?').bind(principal.workspaceId).first<any>(),
    c.env.DB.prepare(`SELECT COALESCE(SUM(ul.billable_micro_usd),0) AS spend, COALESCE(SUM(CASE WHEN r.kind = 'review' THEN ul.provider_micro_usd ELSE 0 END),0) AS review, COALESCE(SUM(CASE WHEN r.kind = 'qa' THEN ul.provider_micro_usd ELSE 0 END),0) AS qa, COALESCE(SUM(ul.sandbox_micro_usd),0) AS sandbox, COALESCE(SUM(ul.storage_micro_usd),0) AS storage, COALESCE(SUM(ul.service_fee_micro_usd),0) AS fee FROM usage_ledger ul JOIN run r ON r.id = ul.run_id WHERE ul.workspace_id = ? AND ul.created_at >= datetime('now','start of month')`).bind(principal.workspaceId).first<any>(),
    c.env.DB.prepare('SELECT id, period_start, amount_micro_usd, status, hosted_invoice_url FROM invoice WHERE workspace_id = ? ORDER BY period_start DESC LIMIT 24').bind(principal.workspaceId).all<any>(),
  ]);
  const reserved = await c.env.DB.prepare(`SELECT COALESCE(SUM(reserved_micro_usd),0) AS amount FROM run WHERE workspace_id = ? AND status IN ('queued','running')`).bind(principal.workspaceId).first<{ amount: number }>();
  const spend = totals?.spend ?? 0; const part = (value: number) => spend ? Math.round(value / spend * 100) : 0;
  const today = new Date(); const day = Math.max(1, today.getUTCDate()); const daysInMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate();
  const projected = Math.max(spend, Math.round(spend / day * daysInMonth));
  return envelope(c, { role: principal.role, billingState: workspace?.billing_state ?? 'trial', hasBillingCustomer: Boolean(workspace?.has_billing_customer), trialRemainingMicroUsd: workspace?.trial_remaining_micro_usd ?? 0, currentSpendMicroUsd: spend, reservedMicroUsd: reserved?.amount ?? 0, capMicroUsd: workspace?.monthly_cap_micro_usd ?? 100_000_000, projectedInvoiceMicroUsd: projected, warningAt80Percent: spend + (reserved?.amount ?? 0) >= (workspace?.monthly_cap_micro_usd ?? 100_000_000) * .8, breakdown: [{ kind: 'review', amountMicroUsd: totals?.review ?? 0, percentage: part(totals?.review ?? 0) }, { kind: 'qa', amountMicroUsd: totals?.qa ?? 0, percentage: part(totals?.qa ?? 0) }, { kind: 'sandbox', amountMicroUsd: totals?.sandbox ?? 0, percentage: part(totals?.sandbox ?? 0) }, { kind: 'storage', amountMicroUsd: totals?.storage ?? 0, percentage: part(totals?.storage ?? 0) }, { kind: 'service_fee', amountMicroUsd: totals?.fee ?? 0, percentage: part(totals?.fee ?? 0) }], invoices: invoices.results.map((invoice) => ({ id: invoice.id, period: invoice.period_start, amountMicroUsd: invoice.amount_micro_usd, status: invoice.status, url: invoice.hosted_invoice_url })) });
});

app.patch('/api/usage/cap', async (c) => {
  const principal = await withPrincipal(c); requireAdmin(principal);
  const input = z.object({ capMicroUsd: z.number().int().min(1_000_000).max(10_000_000_000) }).parse(await c.req.json());
  await c.env.DB.prepare('UPDATE workspace SET monthly_cap_micro_usd = ?, updated_at = ? WHERE id = ?').bind(input.capMicroUsd, new Date().toISOString(), principal.workspaceId).run();
  return envelope(c, { capMicroUsd: input.capMicroUsd });
});

app.get('/api/settings', async (c) => {
  const principal = await withPrincipal(c);
  const [workspace, members, corpusPolicy, corpusRepositories, corpusJob] = await Promise.all([
    c.env.DB.prepare('SELECT id, name, slug FROM workspace WHERE id = ?').bind(principal.workspaceId).first<any>(),
    c.env.DB.prepare(`SELECT u.id, u.name, u.email, u.image, m.role FROM membership m JOIN "user" u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY CASE m.role WHEN 'admin' THEN 0 ELSE 1 END, u.name`).bind(principal.workspaceId).all<any>(),
    c.env.DB.prepare(`SELECT mode, consent_version, retention_days, include_pr_body, include_paths, consented_at, stored_objects, stored_bytes, last_ingested_at FROM workspace_corpus_policy WHERE workspace_id = ?`).bind(principal.workspaceId).first<any>(),
    c.env.DB.prepare(`SELECT repo.id, repo.full_name, rs.training_enabled FROM repository repo JOIN repository_settings rs ON rs.repository_id = repo.id WHERE repo.workspace_id = ? AND repo.github_access_state = 'active' ORDER BY repo.full_name`).bind(principal.workspaceId).all<any>(),
    c.env.DB.prepare(`SELECT id, kind, status, object_count, error, created_at, completed_at FROM corpus_job WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1`).bind(principal.workspaceId).first<any>(),
  ]);
  if (!workspace) return c.json({ error: { code: 'not_found', message: 'Workspace not found.' }, requestId: c.get('requestId') }, 404);
  return envelope(c, { workspace, role: principal.role, members: members.results, training: {
    mode: corpusPolicy?.mode ?? 'off', consentVersion: corpusPolicy?.consent_version ?? (c.env.CORPUS_CONSENT_VERSION ?? '2026-08-21.v1'), retentionDays: corpusPolicy?.retention_days ?? 365,
    includePrBody: Boolean(corpusPolicy?.include_pr_body), includePaths: Boolean(corpusPolicy?.include_paths), consentedAt: corpusPolicy?.consented_at ?? null,
    storedObjects: corpusPolicy?.stored_objects ?? 0, storedBytes: corpusPolicy?.stored_bytes ?? 0, lastIngestedAt: corpusPolicy?.last_ingested_at ?? null,
    repositories: corpusRepositories.results.map((repository) => ({ id: repository.id, fullName: repository.full_name, enabled: Boolean(repository.training_enabled) })),
    latestJob: corpusJob ? { id: corpusJob.id, kind: corpusJob.kind, status: corpusJob.status, objectCount: corpusJob.object_count, error: corpusJob.error, createdAt: corpusJob.created_at, completedAt: corpusJob.completed_at } : null,
  } });
});

const trainingPolicySchema = z.object({
  mode: z.enum(['off', 'workspace_private', 'shared']), retentionDays: z.number().int().min(30).max(3650), includePrBody: z.boolean(), includePaths: z.boolean(),
  repositoryIds: z.array(z.string().min(1)).max(500), acknowledgement: z.boolean(),
});

app.patch('/api/settings/training', async (c) => {
  const principal = await withPrincipal(c); requireAdmin(principal);
  const input = trainingPolicySchema.parse(await c.req.json());
  if (input.mode !== 'off' && !input.acknowledgement) return c.json({ error: { code: 'consent_required', message: 'Explicit training-data consent is required.' }, requestId: c.get('requestId') }, 409);
  const available = await c.env.DB.prepare(`SELECT id FROM repository WHERE workspace_id = ? AND github_access_state = 'active'`).bind(principal.workspaceId).all<{ id: string }>();
  const allowed = new Set(available.results.map((repository) => repository.id));
  if (input.repositoryIds.some((repositoryId) => !allowed.has(repositoryId))) return c.json({ error: { code: 'repository_forbidden', message: 'A selected repository is not available in this workspace.' }, requestId: c.get('requestId') }, 403);
  const timestamp = new Date().toISOString();
  const consentedAt = input.mode === 'off' ? null : timestamp;
  await c.env.DB.prepare(`INSERT INTO workspace_corpus_policy (workspace_id, mode, consent_version, retention_days, include_pr_body, include_paths, consented_by_user_id, consented_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET mode = excluded.mode, consent_version = excluded.consent_version, retention_days = excluded.retention_days, include_pr_body = excluded.include_pr_body, include_paths = excluded.include_paths, consented_by_user_id = excluded.consented_by_user_id, consented_at = excluded.consented_at, updated_at = excluded.updated_at`)
    .bind(principal.workspaceId, input.mode, c.env.CORPUS_CONSENT_VERSION ?? '2026-08-21.v1', input.retentionDays, Number(input.includePrBody), Number(input.includePaths), input.mode === 'off' ? null : principal.userId, consentedAt, timestamp).run();
  const selected = new Set(input.mode === 'off' ? [] : input.repositoryIds);
  if (available.results.length) await c.env.DB.batch(available.results.map((repository) => c.env.DB.prepare('UPDATE repository_settings SET training_enabled = ?, updated_at = ? WHERE repository_id = ?').bind(Number(selected.has(repository.id)), timestamp, repository.id)));
  return envelope(c, { mode: input.mode, enabledRepositories: selected.size, consentedAt });
});

app.post('/api/settings/training/export', async (c) => {
  const principal = await withPrincipal(c); requireAdmin(principal);
  const expires = Math.floor(Date.now() / 1000) + 300;
  const signature = await createSignedToken(c.env.EVIDENCE_SIGNING_SECRET, `corpus-export:${principal.workspaceId}:${expires}`);
  return envelope(c, { url: `/api/settings/training/export/content?expires=${expires}&signature=${signature}`, expiresAt: new Date(expires * 1000).toISOString() });
});

app.get('/api/settings/training/export/content', async (c) => {
  const principal = await withPrincipal(c); requireAdmin(principal);
  const expires = Number(c.req.query('expires')); const signature = c.req.query('signature') ?? '';
  if (!Number.isInteger(expires) || expires < Date.now() / 1000 || expires > Date.now() / 1000 + 310) return new Response('Expired', { status: 403 });
  const expected = await createSignedToken(c.env.EVIDENCE_SIGNING_SECRET, `corpus-export:${principal.workspaceId}:${expires}`);
  if (!timingSafeEqual(expected, signature)) return new Response('Invalid signature', { status: 403 });
  return corpusExportResponse(c.env, principal.workspaceId);
});

app.post('/api/settings/training/delete', async (c) => {
  const principal = await withPrincipal(c); requireAdmin(principal);
  const input = z.object({ confirm: z.string() }).parse(await c.req.json());
  const workspace = await c.env.DB.prepare('SELECT slug FROM workspace WHERE id = ?').bind(principal.workspaceId).first<{ slug: string }>();
  if (!workspace || input.confirm !== workspace.slug) return c.json({ error: { code: 'confirmation_mismatch', message: 'Enter the workspace slug to confirm deletion.' }, requestId: c.get('requestId') }, 409);
  const jobId = `corpus_delete_${crypto.randomUUID()}`; const timestamp = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO corpus_job (id, workspace_id, kind, status, requested_by_user_id, created_at) VALUES (?, ?, 'delete', 'queued', ?, ?)`).bind(jobId, principal.workspaceId, principal.userId, timestamp),
    c.env.DB.prepare(`INSERT INTO workspace_corpus_policy (workspace_id, mode, consent_version, updated_at) VALUES (?, 'off', ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET mode = 'off', consented_by_user_id = NULL, consented_at = NULL, updated_at = excluded.updated_at`).bind(principal.workspaceId, c.env.CORPUS_CONSENT_VERSION ?? '2026-08-21.v1', timestamp),
    c.env.DB.prepare(`UPDATE repository_settings SET training_enabled = 0, updated_at = ? WHERE repository_id IN (SELECT id FROM repository WHERE workspace_id = ?)`).bind(timestamp, principal.workspaceId),
  ]);
  try {
    await c.env.CORPUS_QUEUE.send({ kind: 'corpus_delete', workspaceId: principal.workspaceId, jobId }, { contentType: 'json' });
  } catch (error) {
    await c.env.DB.prepare(`UPDATE corpus_job SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`)
      .bind(error instanceof Error ? error.message.slice(0, 500) : 'Queue unavailable', new Date().toISOString(), jobId).run();
    return c.json({ error: { code: 'queue_unavailable', message: 'Corpus deletion could not be queued. Collection remains disabled.' }, requestId: c.get('requestId') }, 503);
  }
  return envelope(c, { jobId, status: 'queued' });
});

app.patch('/api/settings/workspace', async (c) => {
  const principal = await withPrincipal(c); requireAdmin(principal);
  const input = z.object({ name: z.string().trim().min(2).max(80), slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).min(2).max(63) }).parse(await c.req.json());
  const conflict = await c.env.DB.prepare('SELECT id FROM workspace WHERE slug = ? AND id != ?').bind(input.slug, principal.workspaceId).first();
  if (conflict) return c.json({ error: { code: 'slug_taken', message: 'That workspace slug is already in use.' }, requestId: c.get('requestId') }, 409);
  await c.env.DB.prepare('UPDATE workspace SET name = ?, slug = ?, updated_at = ? WHERE id = ?').bind(input.name, input.slug, new Date().toISOString(), principal.workspaceId).run();
  return envelope(c, input);
});

app.post('/api/settings/workspace/delete', async (c) => {
  const principal = await withPrincipal(c); requireAdmin(principal);
  const input = z.object({ confirm: z.string() }).parse(await c.req.json());
  const workspace = await c.env.DB.prepare('SELECT slug, github_installation_id, deletion_requested_at FROM workspace WHERE id = ?')
    .bind(principal.workspaceId).first<{ slug: string; github_installation_id: number; deletion_requested_at: string | null }>();
  if (!workspace || input.confirm !== workspace.slug) return c.json({ error: { code: 'confirmation_mismatch', message: 'Enter the workspace identifier to confirm deletion.' }, requestId: c.get('requestId') }, 409);
  if (workspace.deletion_requested_at) return envelope(c, { status: 'queued' });
  const jobId = `workspace_delete_${crypto.randomUUID()}`;
  const timestamp = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO workspace_deletion_job (id, workspace_id, github_installation_id, status, requested_by_user_id, created_at) VALUES (?, ?, ?, 'queued', ?, ?)`).bind(jobId, principal.workspaceId, workspace.github_installation_id, principal.userId, timestamp),
    c.env.DB.prepare(`UPDATE workspace SET deletion_requested_at = ?, billing_state = 'paused', updated_at = ? WHERE id = ?`).bind(timestamp, timestamp, principal.workspaceId),
    c.env.DB.prepare(`UPDATE repository_settings SET review_enabled = 0, qa_enabled = 0, qa_security_ready = 0, training_enabled = 0, updated_at = ? WHERE repository_id IN (SELECT id FROM repository WHERE workspace_id = ?)`).bind(timestamp, principal.workspaceId),
    c.env.DB.prepare(`UPDATE workspace_corpus_policy SET mode = 'off', consented_by_user_id = NULL, consented_at = NULL, updated_at = ? WHERE workspace_id = ?`).bind(timestamp, principal.workspaceId),
    c.env.DB.prepare(`UPDATE run SET status = 'cancelled', phase = 'cancelled', outcome = 'cancelled', reserved_micro_usd = 0, completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE workspace_id = ? AND status IN ('queued','running')`).bind(timestamp, timestamp, principal.workspaceId),
  ]);
  try {
    await c.env.CORPUS_QUEUE.send({ kind: 'workspace_delete', workspaceId: principal.workspaceId, jobId }, { contentType: 'json' });
  } catch (error) {
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE workspace SET deletion_requested_at = NULL, updated_at = ? WHERE id = ?`).bind(new Date().toISOString(), principal.workspaceId),
      c.env.DB.prepare(`UPDATE workspace_deletion_job SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`).bind(error instanceof Error ? error.message.slice(0, 500) : 'Queue unavailable', new Date().toISOString(), jobId),
    ]);
    return c.json({ error: { code: 'queue_unavailable', message: 'Workspace deletion could not be queued. Automated runs remain disabled for safety.' }, requestId: c.get('requestId') }, 503);
  }
  return envelope(c, { jobId, status: 'queued' });
});

app.post('/api/settings/members', async (c) => {
  const principal = await withPrincipal(c); requireAdmin(principal);
  const input = z.object({ email: z.string().email(), role: z.enum(['admin', 'member']).default('member') }).parse(await c.req.json());
  const user = await c.env.DB.prepare(`SELECT id FROM "user" WHERE lower(email) = lower(?)`).bind(input.email).first<{ id: string }>();
  if (!user) return c.json({ error: { code: 'account_required', message: 'That person must sign in to Juror Cloud once before they can be added.' }, requestId: c.get('requestId') }, 409);
  await c.env.DB.prepare('INSERT INTO membership (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role').bind(principal.workspaceId, user.id, input.role, new Date().toISOString()).run();
  return envelope(c, { userId: user.id, role: input.role });
});

app.patch('/api/settings/members/:userId', async (c) => {
  const principal = await withPrincipal(c); requireAdmin(principal);
  const input = z.object({ role: z.enum(['admin', 'member']) }).parse(await c.req.json());
  if (c.req.param('userId') === principal.userId && input.role !== 'admin') return c.json({ error: { code: 'self_demote', message: 'Another admin must change your role.' }, requestId: c.get('requestId') }, 409);
  const result = await c.env.DB.prepare('UPDATE membership SET role = ? WHERE workspace_id = ? AND user_id = ?').bind(input.role, principal.workspaceId, c.req.param('userId')).run();
  if (!result.meta.changes) return c.json({ error: { code: 'not_found', message: 'Member not found.' }, requestId: c.get('requestId') }, 404);
  return envelope(c, { userId: c.req.param('userId'), role: input.role });
});

app.post('/api/billing/portal', async (c) => { const principal = await withPrincipal(c); requireAdmin(principal); return envelope(c, { url: await createBillingPortal(c.env, principal) }); });
app.post('/api/billing/checkout', async (c) => { const principal = await withPrincipal(c); requireAdmin(principal); return envelope(c, { url: await createCheckout(c.env, principal) }); });

app.get('/api/artifacts/:id/url', async (c) => {
  const principal = await withPrincipal(c);
  const artifact = await c.env.DB.prepare(`SELECT a.id FROM artifact_metadata a JOIN run r ON r.id = a.run_id WHERE a.id = ? AND r.workspace_id = ? AND a.expires_at > ?`).bind(c.req.param('id'), principal.workspaceId, new Date().toISOString()).first();
  if (!artifact) return c.json({ error: { code: 'not_found', message: 'Evidence expired or unavailable' }, requestId: c.get('requestId') }, 404);
  const expires = Math.floor(Date.now() / 1000) + 300;
  const signature = await createSignedToken(c.env.EVIDENCE_SIGNING_SECRET, `${principal.workspaceId}:${c.req.param('id')}:${expires}`);
  return envelope(c, { url: `/api/artifacts/${c.req.param('id')}/content?expires=${expires}&signature=${signature}`, expiresAt: new Date(expires * 1000).toISOString() });
});

app.get('/api/artifacts/:id/content', async (c) => {
  const principal = await withPrincipal(c);
  const expires = Number(c.req.query('expires')); const signature = c.req.query('signature') ?? '';
  if (!Number.isInteger(expires) || expires < Date.now() / 1000 || expires > Date.now() / 1000 + 310) return new Response('Expired', { status: 403 });
  const expected = await createSignedToken(c.env.EVIDENCE_SIGNING_SECRET, `${principal.workspaceId}:${c.req.param('id')}:${expires}`);
  if (!timingSafeEqual(expected, signature)) return new Response('Invalid signature', { status: 403 });
  const artifact = await c.env.DB.prepare(`SELECT a.r2_key, a.content_type FROM artifact_metadata a JOIN run r ON r.id = a.run_id WHERE a.id = ? AND r.workspace_id = ? AND a.expires_at > ?`).bind(c.req.param('id'), principal.workspaceId, new Date().toISOString()).first<{ r2_key: string; content_type: string }>();
  if (!artifact) return new Response('Not found', { status: 404 });
  const object = await c.env.REPORTS.get(artifact.r2_key);
  if (!object) return new Response('Not found', { status: 404 });
  return new Response(object.body, { headers: { 'content-type': artifact.content_type, 'cache-control': 'private, no-store', 'content-security-policy': "default-src 'none'; sandbox" } });
});

app.post('/api/github/webhooks', async (c) => {
  const body = await c.req.text();
  if (!c.env.GITHUB_WEBHOOK_SECRET || !await verifyHmacHeader(c.env.GITHUB_WEBHOOK_SECRET, body, c.req.header('x-hub-signature-256') ?? null)) return c.json({ error: { code: 'invalid_signature', message: 'Invalid GitHub signature' }, requestId: c.get('requestId') }, 401);
  const delivery = c.req.header('x-github-delivery'); const eventName = c.req.header('x-github-event');
  if (!delivery || !eventName) return c.json({ error: { code: 'missing_headers', message: 'Missing GitHub delivery headers' }, requestId: c.get('requestId') }, 400);
  const payload = JSON.parse(body);
  const timestamp = new Date().toISOString();
  const inserted = await c.env.DB.prepare(`INSERT OR IGNORE INTO webhook_delivery (provider, delivery_id, event_name, received_at, queued_at, status) VALUES ('github', ?, ?, ?, ?, 'queued')`).bind(delivery, eventName, timestamp, timestamp).run();
  if (!inserted.meta.changes) {
    const prior = await c.env.DB.prepare(`SELECT status FROM webhook_delivery WHERE provider = 'github' AND delivery_id = ?`).bind(delivery).first<{ status: string }>();
    if (prior?.status !== 'failed') return c.json({ accepted: true, duplicate: true }, 202);
    await c.env.DB.prepare(`UPDATE webhook_delivery SET status = 'queued', queued_at = ?, error = NULL WHERE provider = 'github' AND delivery_id = ?`).bind(timestamp, delivery).run();
  }
  try { await c.env.WEBHOOK_QUEUE.send({ kind: 'provider_webhook', provider: 'github', deliveryId: delivery, eventName, receivedAt: timestamp, payload }, { contentType: 'json' }); }
  catch (error) { await c.env.DB.prepare(`UPDATE webhook_delivery SET status = 'failed', error = ? WHERE provider = 'github' AND delivery_id = ?`).bind(error instanceof Error ? error.message.slice(0, 500) : 'Queue unavailable', delivery).run(); return c.json({ error: { code: 'queue_unavailable', message: 'Webhook delivery could not be queued.' }, requestId: c.get('requestId') }, 503); }
  return c.json({ accepted: true }, 202);
});

app.post('/api/stripe/webhooks', async (c) => {
  const body = await c.req.text();
  if (!c.env.STRIPE_WEBHOOK_SECRET || !await verifyStripeSignature(c.env.STRIPE_WEBHOOK_SECRET, body, c.req.header('stripe-signature') ?? null)) return c.json({ error: { code: 'invalid_signature', message: 'Invalid Stripe signature' }, requestId: c.get('requestId') }, 401);
  const event = JSON.parse(body);
  const timestamp = new Date().toISOString();
  const inserted = await c.env.DB.prepare(`INSERT OR IGNORE INTO webhook_delivery (provider, delivery_id, event_name, received_at, queued_at, status) VALUES ('stripe', ?, ?, ?, ?, 'queued')`).bind(event.id, event.type, timestamp, timestamp).run();
  if (!inserted.meta.changes) {
    const prior = await c.env.DB.prepare(`SELECT status FROM webhook_delivery WHERE provider = 'stripe' AND delivery_id = ?`).bind(event.id).first<{ status: string }>();
    if (prior?.status !== 'failed') return c.json({ received: true, duplicate: true });
    await c.env.DB.prepare(`UPDATE webhook_delivery SET status = 'queued', queued_at = ?, error = NULL WHERE provider = 'stripe' AND delivery_id = ?`).bind(timestamp, event.id).run();
  }
  try { await c.env.WEBHOOK_QUEUE.send({ kind: 'provider_webhook', provider: 'stripe', deliveryId: event.id, eventName: event.type, receivedAt: timestamp, payload: event }, { contentType: 'json' }); }
  catch (error) { await c.env.DB.prepare(`UPDATE webhook_delivery SET status = 'failed', error = ? WHERE provider = 'stripe' AND delivery_id = ?`).bind(error instanceof Error ? error.message.slice(0, 500) : 'Queue unavailable', event.id).run(); return c.json({ error: { code: 'queue_unavailable', message: 'Webhook delivery could not be queued.' }, requestId: c.get('requestId') }, 503); }
  return c.json({ received: true });
});

async function runRetention(env: Env): Promise<void> {
  const expiredArtifacts = await env.DB.prepare(`SELECT id, r2_key FROM artifact_metadata WHERE expires_at <= ? LIMIT 500`).bind(new Date().toISOString()).all<{ id: string; r2_key: string }>();
  for (const artifact of expiredArtifacts.results) await env.REPORTS.delete(artifact.r2_key);
  if (expiredArtifacts.results.length) await env.DB.batch(expiredArtifacts.results.map((artifact) => env.DB.prepare('DELETE FROM artifact_metadata WHERE id = ?').bind(artifact.id)));
  const reportCutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  const expiredReports = await env.DB.prepare('SELECT id, report_r2_key FROM run WHERE completed_at < ? AND report_r2_key IS NOT NULL LIMIT 500').bind(reportCutoff).all<{ id: string; report_r2_key: string }>();
  for (const run of expiredReports.results) await env.REPORTS.delete(run.report_r2_key);
  if (expiredReports.results.length) await env.DB.batch(expiredReports.results.map((run) => env.DB.prepare('UPDATE run SET report_r2_key = NULL WHERE id = ?').bind(run.id)));
  await env.DB.prepare(`DELETE FROM finding WHERE status IN ('resolved','ignored') AND last_seen_at < ?`).bind(reportCutoff).run();
  await runCorpusRetention(env);
  await reconcileStripeMeterEvents(env);
}

export type AppType = typeof app;

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<QueueMessage>, env: Env) { await processQueueBatch(batch, env); },
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sweepQueuedQaAdmissions(env));
    if (controller.cron === '17 3 * * *') ctx.waitUntil(runRetention(env));
  },
} satisfies ExportedHandler<Env, QueueMessage>;
