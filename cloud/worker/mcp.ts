import { requireMcpAuth } from '@better-auth/mcp';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { JWTPayload } from 'jose';
import { createAuth, mcpResourceUrl, oauthIssuerUrl } from './auth';
import type { Env, Principal } from './env';
import { ReviewServiceError, consumeReviewIntent, prepareHostedRerun, prepareHostedReview } from './review-service';
import type { HostedReviewReportV1 } from '../../src/cloud/types';

const REVIEW_CARD_URI = 'ui://juror/review-card.html';
const readSecurity = [{ type: 'oauth2', scopes: ['juror.read'] }];
const writeSecurity = [{ type: 'oauth2', scopes: ['juror.reviews.write'] }];
const readAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const writeTools = new Set(['juror_start_review', 'juror_rerun_review']);

type McpAuth = { userId: string; scopes: string[] };

function jsonText(data: unknown) { return JSON.stringify(data); }
function toolResult(data: unknown, summary: string, card = false) {
  return {
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: data,
    ...(card ? { _meta: { ui: { resourceUri: REVIEW_CARD_URI } } } : {}),
  };
}

function toolError(error: unknown) {
  const message = error instanceof ReviewServiceError ? error.message : 'Juror could not complete this request.';
  const code = error instanceof ReviewServiceError ? error.code : 'internal_error';
  return { isError: true, content: [{ type: 'text' as const, text: message }], structuredContent: { error: { code, message } } };
}

async function principalForWorkspace(env: Env, auth: McpAuth, workspaceId: string): Promise<Principal> {
  const membership = await env.DB.prepare('SELECT workspace_id, role FROM membership WHERE user_id = ? AND workspace_id = ?')
    .bind(auth.userId, workspaceId).first<{ workspace_id: string; role: 'admin' | 'member' }>();
  if (!membership) throw new ReviewServiceError('workspace_forbidden', 403, 'You do not have access to that workspace.');
  return { userId: auth.userId, workspaceId: membership.workspace_id, role: membership.role };
}

function reviewCardHtml() {
  // A deliberately small, read-only MCP Apps bridge. It implements the stable
  // ui/initialize and tool-result notifications so clients without UI support
  // can ignore this resource while compatible hosts render the same result.
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:14px ui-sans-serif,system-ui;color:#132033;background:#fff}main{border:1px solid #dbe4ef;border-radius:12px;padding:14px}.top{display:flex;justify-content:space-between;gap:12px}.muted{color:#5c6d80;font-size:12px}.pill{display:inline-block;border-radius:999px;padding:3px 8px;background:#eef3ff;color:#3548a8;font-size:12px;font-weight:600}a{color:#2946d3;text-decoration:none;font-weight:600}</style></head><body><main aria-live="polite"><div class="top"><strong id="title">Juror review</strong><span class="pill" id="status">Loading</span></div><p class="muted" id="detail">Review details are available in Juror Cloud.</p><a id="open" href="#">Open in Juror Cloud</a></main><script>(()=>{let nextId=1,ready=false;const send=(message)=>window.parent.postMessage(message,'*');const request=(method,params)=>{const id=nextId++;send({jsonrpc:'2.0',id,method,params});return id};const open=document.getElementById('open');const title=document.getElementById('title');const status=document.getElementById('status');const detail=document.getElementById('detail');const render=(result)=>{const data=result?.structuredContent||result||{};const item=data.run||data.finding||data;const repository=item.repository?.fullName;title.textContent=repository?(item.prNumber?'PR #'+item.prNumber+' · ':'')+repository:'Juror review';status.textContent=item.severity||item.status||'Ready';const agreement=item.agreement?item.agreement.agreeing+'/'+item.agreement.total+' models agree':null;const receipt=item.receipt?.totalMicroUsd===undefined?null:'Receipt '+(item.receipt.totalMicroUsd/1000000).toFixed(2)+' USD';detail.textContent=[item.sha?'Revision '+item.sha.slice(0,12):null,agreement,receipt,item.findings===undefined?null:item.findings+' findings'].filter(Boolean).join(' · ')||'Review details are available in Juror Cloud.';if(item.cloudUrl){open.href=item.cloudUrl;open.hidden=false}else{open.hidden=true}};window.addEventListener('message',(event)=>{const message=event.data;if(!message||message.jsonrpc!=='2.0')return;if(message.method==='ui/notifications/tool-result')render(message.params);if(message.method==='ui/notifications/host-context-changed'&&message.params?.theme)document.documentElement.dataset.theme=message.params.theme;if(message.id===1&&message.result){ready=true;send({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}})}});open.addEventListener('click',(event)=>{event.preventDefault();if(ready&&open.href)request('ui/open-link',{url:open.href})});request('ui/initialize',{appInfo:{name:'Juror review card',version:'1.0.0'},appCapabilities:{},protocolVersion:'2026-01-26'});})();</script></body></html>`;
}

function cloudRunUrl(env: Env, runId: string) { return new URL(`/runs/${encodeURIComponent(runId)}`, env.APP_URL).toString(); }
function cloudFindingUrl(env: Env, findingId: string) { return new URL(`/findings/${encodeURIComponent(findingId)}`, env.APP_URL).toString(); }
function runSummary(row: any, env: Env) {
  return { id: row.id, kind: row.kind, status: row.status, phase: row.phase, prNumber: row.pr_number, sha: row.revision_sha, findings: row.findings_count, startedAt: row.started_at ?? row.created_at,
    repository: { id: row.repository_id, fullName: row.full_name }, cloudUrl: cloudRunUrl(env, row.id) };
}

async function findingDetail(env: Env, principal: Principal, findingId: string) {
  const finding = await env.DB.prepare(`SELECT f.id, f.fingerprint, f.title, f.severity, f.status, f.source, f.path_or_checkpoint, f.line, f.agreement_count, f.agreement_total, repo.full_name
    FROM finding f JOIN repository repo ON repo.id = f.repository_id WHERE f.id = ? AND f.workspace_id = ?`).bind(findingId, principal.workspaceId).first<any>();
  if (!finding) throw new ReviewServiceError('finding_not_found', 404, 'Finding not found in this workspace.');
  const occurrence = await env.DB.prepare(`SELECT r.report_r2_key FROM finding_occurrence fo JOIN run r ON r.id = fo.run_id WHERE fo.finding_id = ? ORDER BY fo.seen_at DESC LIMIT 1`).bind(finding.id).first<{ report_r2_key: string | null }>();
  let body: string | null = null;
  let claim: Record<string, unknown> | null = null;
  if (occurrence?.report_r2_key) {
    const object = await env.REPORTS.get(occurrence.report_r2_key);
    if (object && finding.source === 'review') {
      const report = JSON.parse(await object.text()) as HostedReviewReportV1;
      const cluster = report.clusters.find((candidate) => candidate.fingerprint === finding.fingerprint);
      body = cluster?.body ?? null;
      claim = (cluster?.members[0]?.claim as Record<string, unknown> | undefined) ?? null;
    }
  }
  return { id: finding.id, title: finding.title, severity: finding.severity, status: finding.status, repository: { fullName: finding.full_name }, pathOrCheckpoint: finding.path_or_checkpoint, line: finding.line, agreement: finding.agreement_count === null ? null : { agreeing: finding.agreement_count, total: finding.agreement_total }, cloudUrl: cloudFindingUrl(env, finding.id), body: body ?? 'The retained finding detail is unavailable.', claim };
}

function createJurorServer(env: Env, auth: McpAuth) {
  const server = new McpServer({ name: 'Juror', version: '1.0.0' });
  server.registerResource('juror-review-card', REVIEW_CARD_URI, { title: 'Juror review card', mimeType: 'text/html;profile=mcp-app', _meta: { ui: { prefersBorder: true } } } as any,
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/html;profile=mcp-app', text: reviewCardHtml() }] }));

  server.registerTool('juror_list_workspaces', {
    title: 'List Juror workspaces', description: 'List the Juror Cloud workspaces available to the signed-in user. Use this before every workspace-scoped Juror call.',
    inputSchema: z.object({}), annotations: readAnnotations, _meta: { securitySchemes: readSecurity },
  }, async () => {
    const rows = await env.DB.prepare(`SELECT w.id, w.name, w.slug, m.role FROM membership m JOIN workspace w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY w.name`).bind(auth.userId).all<any>();
    const workspaces = rows.results.map((row) => ({ id: row.id, name: row.name, slug: row.slug, role: row.role }));
    return toolResult({ workspaces }, `Found ${workspaces.length} accessible Juror workspace${workspaces.length === 1 ? '' : 's'}.`);
  });

  server.registerTool('juror_overview', {
    title: 'Get Juror workspace overview', description: 'Get concise run and finding counts for one explicitly selected Juror workspace.',
    inputSchema: z.object({ workspace_id: z.string().min(1) }), annotations: readAnnotations, _meta: { securitySchemes: readSecurity },
  }, async ({ workspace_id }) => {
    try {
      const principal = await principalForWorkspace(env, auth, workspace_id);
      const metrics = await env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM finding WHERE workspace_id = ? AND status = 'open' AND severity IN ('P0','P1')) AS high_priority_open,
        (SELECT COUNT(*) FROM run WHERE workspace_id = ? AND status = 'running') AS running_runs,
        (SELECT COUNT(*) FROM run WHERE workspace_id = ? AND created_at >= datetime('now','-30 days')) AS recent_runs`).bind(principal.workspaceId, principal.workspaceId, principal.workspaceId).first<any>();
      return toolResult({ workspaceId: principal.workspaceId, role: principal.role, overview: metrics }, 'Juror workspace overview.');
    } catch (error) { return toolError(error); }
  });

  server.registerTool('juror_list_repositories', {
    title: 'List Juror repositories', description: 'List active repositories in one selected Juror workspace, without repository credentials or configuration secrets.',
    inputSchema: z.object({ workspace_id: z.string().min(1) }), annotations: readAnnotations, _meta: { securitySchemes: readSecurity },
  }, async ({ workspace_id }) => {
    try {
      const principal = await principalForWorkspace(env, auth, workspace_id);
      const rows = await env.DB.prepare(`SELECT repo.id, repo.full_name, repo.github_access_state, rs.review_enabled, rs.action_detected
        FROM repository repo JOIN repository_settings rs ON rs.repository_id = repo.id WHERE repo.workspace_id = ? ORDER BY repo.full_name LIMIT 200`).bind(principal.workspaceId).all<any>();
      const repositories = rows.results.map((row) => ({ id: row.id, fullName: row.full_name, accessState: row.github_access_state, reviewEnabled: Boolean(row.review_enabled), hostedReviewBlocked: Boolean(row.action_detected) }));
      return toolResult({ workspaceId: principal.workspaceId, repositories }, `Found ${repositories.length} repository entries.`);
    } catch (error) { return toolError(error); }
  });

  server.registerTool('juror_list_findings', {
    title: 'List Juror findings', description: 'List concise findings for one selected workspace. Use Juror finding detail only after the user names a specific finding.',
    inputSchema: z.object({ workspace_id: z.string().min(1), severity: z.enum(['P0', 'P1', 'P2', 'P3']).optional(), status: z.enum(['open', 'resolved', 'ignored']).optional(), limit: z.number().int().min(1).max(100).default(50) }), annotations: readAnnotations, _meta: { securitySchemes: readSecurity },
  }, async ({ workspace_id, severity, status, limit }) => {
    try {
      const principal = await principalForWorkspace(env, auth, workspace_id);
      const where = ['f.workspace_id = ?']; const values: unknown[] = [principal.workspaceId];
      if (severity) { where.push('f.severity = ?'); values.push(severity); }
      if (status) { where.push('f.status = ?'); values.push(status); }
      values.push(limit);
      const rows = await env.DB.prepare(`SELECT f.id, f.title, f.severity, f.status, f.source, f.path_or_checkpoint, f.line, f.agreement_count, f.agreement_total, repo.full_name
        FROM finding f JOIN repository repo ON repo.id = f.repository_id WHERE ${where.join(' AND ')} ORDER BY CASE f.severity WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END, f.last_seen_at DESC LIMIT ?`).bind(...values).all<any>();
      const findings = rows.results.map((row) => ({ id: row.id, title: row.title, severity: row.severity, status: row.status, source: row.source, repository: { fullName: row.full_name }, pathOrCheckpoint: row.path_or_checkpoint, line: row.line, agreement: row.agreement_count === null ? null : { agreeing: row.agreement_count, total: row.agreement_total } }));
      return toolResult({ workspaceId: principal.workspaceId, findings }, `Found ${findings.length} findings. Finding bodies are withheld until a specific finding is requested.`);
    } catch (error) { return toolError(error); }
  });

  server.registerTool('juror_get_finding_detail', {
    title: 'Get one retained Juror finding detail', description: 'Return the retained body and claim for one explicitly requested finding. Never use this for broad discovery.',
    inputSchema: z.object({ workspace_id: z.string().min(1), finding_id: z.string().min(1) }), annotations: readAnnotations, _meta: { securitySchemes: readSecurity },
  }, async ({ workspace_id, finding_id }) => {
    try {
      const principal = await principalForWorkspace(env, auth, workspace_id);
      const detail = await findingDetail(env, principal, finding_id);
      return toolResult({ finding: detail }, 'Retained detail for the requested finding.', true);
    } catch (error) { return toolError(error); }
  });

  server.registerTool('juror_list_runs', {
    title: 'List Juror review runs', description: 'List concise hosted review runs for one selected Juror workspace.',
    inputSchema: z.object({ workspace_id: z.string().min(1), limit: z.number().int().min(1).max(100).default(50) }), annotations: readAnnotations, _meta: { securitySchemes: readSecurity },
  }, async ({ workspace_id, limit }) => {
    try {
      const principal = await principalForWorkspace(env, auth, workspace_id);
      const rows = await env.DB.prepare(`SELECT r.*, repo.id AS repository_id, repo.full_name FROM run r JOIN repository repo ON repo.id = r.repository_id WHERE r.workspace_id = ? AND r.kind = 'review' ORDER BY r.created_at DESC LIMIT ?`).bind(principal.workspaceId, limit).all<any>();
      const runs = rows.results.map((row) => runSummary(row, env));
      return toolResult({ workspaceId: principal.workspaceId, runs }, `Found ${runs.length} hosted review runs.`);
    } catch (error) { return toolError(error); }
  });

  server.registerTool('juror_get_run', {
    title: 'Get a Juror review run', description: 'Get a concise status, finding count, and receipt summary for one selected hosted review run.',
    inputSchema: z.object({ workspace_id: z.string().min(1), run_id: z.string().min(1) }), annotations: readAnnotations, _meta: { securitySchemes: readSecurity },
  }, async ({ workspace_id, run_id }) => {
    try {
      const principal = await principalForWorkspace(env, auth, workspace_id);
      const row = await env.DB.prepare(`SELECT r.*, repo.id AS repository_id, repo.full_name FROM run r JOIN repository repo ON repo.id = r.repository_id WHERE r.workspace_id = ? AND r.id = ? AND r.kind = 'review'`).bind(principal.workspaceId, run_id).first<any>();
      if (!row) throw new ReviewServiceError('run_not_found', 404, 'Hosted review run not found in this workspace.');
      const receipt = { providerMicroUsd: row.provider_micro_usd, sandboxMicroUsd: row.sandbox_micro_usd, storageMicroUsd: row.storage_micro_usd, serviceFeeMicroUsd: row.service_fee_micro_usd, totalMicroUsd: row.billable_micro_usd };
      const run = { ...runSummary(row, env), receipt };
      return toolResult({ run }, 'Juror hosted review run.', true);
    } catch (error) { return toolError(error); }
  });

  server.registerTool('juror_prepare_review', {
    title: 'Prepare a Juror hosted review', description: 'Preflight one open pull request and create a five-minute confirmation intent. Show the repository, PR, SHA, and billing warning to the user before calling start.',
    inputSchema: z.object({ workspace_id: z.string().min(1), repository_id: z.string().min(1), pr_number: z.number().int().positive() }), annotations: readAnnotations, _meta: { securitySchemes: readSecurity },
  }, async ({ workspace_id, repository_id, pr_number }) => {
    try {
      const principal = await principalForWorkspace(env, auth, workspace_id);
      const preflight = await prepareHostedReview(env, principal, repository_id, pr_number);
      return toolResult({ review: preflight, confirmationRequired: true }, `Prepared ${preflight.repository.fullName} PR #${preflight.pullRequest.number} at ${preflight.pullRequest.sha.slice(0, 12)}. Ask the user to confirm before starting the hosted, billable review.`);
    } catch (error) { return toolError(error); }
  });

  server.registerTool('juror_start_review', {
    title: 'Start a confirmed Juror hosted review', description: 'Start the hosted review represented by a just-confirmed five-minute intent. Call only after the user has seen and explicitly confirmed the prepared PR, SHA, repository, and billing warning.',
    inputSchema: z.object({ workspace_id: z.string().min(1), review_intent_id: z.string().min(1) }), annotations: writeAnnotations, _meta: { securitySchemes: writeSecurity },
  }, async ({ workspace_id, review_intent_id }) => {
    try {
      const principal = await principalForWorkspace(env, auth, workspace_id);
      const run = await consumeReviewIntent(env, principal, review_intent_id, 'start');
      return toolResult({ run: { ...run, cloudUrl: cloudRunUrl(env, run.id) } }, `Started hosted Juror review ${run.id}.`);
    } catch (error) { return toolError(error); }
  });

  server.registerTool('juror_prepare_rerun', {
    title: 'Prepare a Juror hosted review rerun', description: 'Preflight a rerun of one existing hosted review and create a five-minute confirmation intent. Show the current PR SHA and billing warning before rerunning.',
    inputSchema: z.object({ workspace_id: z.string().min(1), run_id: z.string().min(1) }), annotations: readAnnotations, _meta: { securitySchemes: readSecurity },
  }, async ({ workspace_id, run_id }) => {
    try {
      const principal = await principalForWorkspace(env, auth, workspace_id);
      const preflight = await prepareHostedRerun(env, principal, run_id);
      return toolResult({ review: preflight, confirmationRequired: true }, `Prepared rerun for ${preflight.repository.fullName} PR #${preflight.pullRequest.number} at ${preflight.pullRequest.sha.slice(0, 12)}. Ask the user to confirm before starting.`);
    } catch (error) { return toolError(error); }
  });

  server.registerTool('juror_rerun_review', {
    title: 'Rerun a confirmed Juror hosted review', description: 'Rerun the hosted review represented by a just-confirmed five-minute intent. Call only after explicit user confirmation.',
    inputSchema: z.object({ workspace_id: z.string().min(1), review_intent_id: z.string().min(1) }), annotations: writeAnnotations, _meta: { securitySchemes: writeSecurity },
  }, async ({ workspace_id, review_intent_id }) => {
    try {
      const principal = await principalForWorkspace(env, auth, workspace_id);
      const run = await consumeReviewIntent(env, principal, review_intent_id, 'rerun');
      return toolResult({ run: { ...run, cloudUrl: cloudRunUrl(env, run.id) } }, `Started hosted Juror rerun ${run.id}.`);
    } catch (error) { return toolError(error); }
  });
  return server;
}

function oauthChallenge(env: Env, scope: string) {
  const resourceMetadata = new URL('/.well-known/oauth-protected-resource', env.APP_URL).toString();
  return new Response(jsonText({ jsonrpc: '2.0', error: { code: -32001, message: 'Insufficient OAuth scope.' }, id: null }), {
    status: 403, headers: { 'content-type': 'application/json', 'www-authenticate': `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${resourceMetadata}"` },
  });
}

function invalidTokenChallenge(env: Env) {
  const resourceMetadata = new URL('/.well-known/oauth-protected-resource', env.APP_URL).toString();
  return new Response(jsonText({ jsonrpc: '2.0', error: { code: -32001, message: 'OAuth session is no longer active.' }, id: null }), {
    status: 401, headers: { 'content-type': 'application/json', 'www-authenticate': `Bearer error="invalid_token", resource_metadata="${resourceMetadata}"` },
  });
}

function requestedToolName(request: Request): Promise<string | null> {
  return request.clone().json().then((payload: any) => payload?.method === 'tools/call' && typeof payload?.params?.name === 'string' ? payload.params.name : null).catch(() => null);
}

function authInfo(claims: JWTPayload, resource: string) {
  const scope = typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : [];
  return { token: '', clientId: typeof claims.client_id === 'string' ? claims.client_id : '', scopes: scope, expiresAt: typeof claims.exp === 'number' ? claims.exp : undefined, resource: new URL(resource), extra: { userId: claims.sub } };
}

async function hasActiveMcpSession(env: Env, claims: JWTPayload): Promise<boolean> {
  if (typeof claims.sub !== 'string' || typeof claims.sid !== 'string') return false;
  const session = await env.DB.prepare('SELECT "userId", "expiresAt" FROM "session" WHERE id = ?').bind(claims.sid).first<{ userId: string; expiresAt: number }>();
  return Boolean(session && session.userId === claims.sub && session.expiresAt > Date.now());
}

export async function handleMcpRequest(env: Env, request: Request): Promise<Response> {
  const resource = mcpResourceUrl(env);
  const handler = createMcpHandler((context) => {
    const userId = context.authInfo?.extra?.userId;
    return createJurorServer(env, { userId: typeof userId === 'string' ? userId : '', scopes: context.authInfo?.scopes ?? [] });
  }, { legacy: 'reject' });
  const protectedHandler = requireMcpAuth(createAuth(env, request.url), async (protectedRequest, claims) => {
    if (!await hasActiveMcpSession(env, claims)) return invalidTokenChallenge(env);
    const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : [];
    const name = await requestedToolName(protectedRequest);
    const requiredScope = name ? (writeTools.has(name) ? 'juror.reviews.write' : 'juror.read') : undefined;
    if (requiredScope && !scopes.includes(requiredScope)) return oauthChallenge(env, requiredScope);
    return handler.fetch(protectedRequest, { authInfo: authInfo(claims, resource) });
  }, { resource, issuer: oauthIssuerUrl(env), jwksUrl: new URL('/api/auth/jwks', env.APP_URL).toString(), challengeScopes: ['juror.read', 'juror.reviews.write'] });
  return protectedHandler(request);
}
