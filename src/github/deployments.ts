import { setTimeout as wait } from 'node:timers/promises';

import type { GitHubApi } from './client.js';
import type {
  QaConfig,
  QaRevisionProof,
  QaTarget,
  QaTargetKind,
} from '../qa/types.js';
import { isIpLiteralHostname, isLoopbackHostname } from '../util/url.js';

export type DeploymentGitHubApi = Pick<GitHubApi, 'repo' | 'request'>;

export const GITHUB_DEPLOYMENT_STATES = [
  'error',
  'failure',
  'inactive',
  'in_progress',
  'queued',
  'pending',
  'success',
] as const;
export type GitHubDeploymentState = (typeof GITHUB_DEPLOYMENT_STATES)[number];

export interface GitHubDeployment {
  id: number;
  sha: string;
  ref: string;
  environment: string;
  transient: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubDeploymentStatus {
  id: number;
  state: GitHubDeploymentState;
  environmentUrl: string | null;
  logUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListDeploymentsQuery {
  environment?: string;
  sha?: string;
  ref?: string;
}

export interface CommitResolution {
  requiredSha: string;
  candidateSha: string;
  relation: 'exact' | 'descendant' | 'not-descendant';
  containsRequiredCommit: boolean;
  additionalCommits: string[];
  additionalCommitsTruncated: boolean;
}

export interface QaPullRevision {
  number: number;
  mergeSha: string;
  headSha: string;
}

export interface ResolveQaTargetOptions {
  explicitUrl?: string;
  signal?: AbortSignal;
  /** Test/embedding hooks. Production callers should normally leave these unset. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  /** Browser-runtime fallback for edges that reject generic HTTP clients. */
  readinessFallback?: (
    url: string,
    timeoutMs: number,
    signal?: AbortSignal,
    expectedStatuses?: readonly number[] | null,
  ) => Promise<boolean>;
  /** Continue to the browser for an operator-supplied URL when its preflight is flaky. */
  allowUnreadyExplicit?: boolean;
}

export interface QaTargetResolution {
  target: QaTarget | null;
  status: 'resolved' | 'timed_out' | 'cancelled';
  diagnostics: string[];
}

export interface QaTargetStability {
  stable: boolean;
  current: QaTarget | null;
  diagnostics: string[];
}

const PER_PAGE = 100;
const MAX_PAGES = 10;
const MAX_DEPLOYMENTS_TO_INSPECT = 25;
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_DIAGNOSTICS = 100;
const MAX_REPORTED_ADDITIONAL_COMMITS = 50;
const MAX_COMMIT_PROBE_BYTES = 64 * 1024;
const SHA_RE = /^[0-9a-f]{40}$/i;

/** List deployments with bounded pagination and normalize only records safe to act upon. */
export async function listDeployments(
  client: DeploymentGitHubApi,
  query: ListDeploymentsQuery = {},
): Promise<GitHubDeployment[]> {
  const out: GitHubDeployment[] = [];
  const repo = repoPath(client.repo);

  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({ per_page: String(PER_PAGE), page: String(page) });
    if (query.environment) params.set('environment', query.environment);
    if (query.sha) params.set('sha', query.sha);
    if (query.ref) params.set('ref', query.ref);
    const path = `/repos/${repo}/deployments?${params.toString()}`;
    const raw = await client.request<unknown>('GET', path);
    if (!Array.isArray(raw)) throw new Error(`Unexpected deployments payload from ${path}`);

    for (const item of raw) {
      const deployment = parseDeployment(item);
      if (deployment) out.push(deployment);
    }
    if (raw.length < PER_PAGE) break;
  }

  return out.sort(newestFirst);
}

/** List a deployment's status history. GitHub's current status is the newest record. */
export async function listDeploymentStatuses(
  client: DeploymentGitHubApi,
  deploymentId: number,
): Promise<GitHubDeploymentStatus[]> {
  if (!Number.isSafeInteger(deploymentId) || deploymentId < 1) {
    throw new Error(`Invalid deployment id ${JSON.stringify(deploymentId)}`);
  }
  const out: GitHubDeploymentStatus[] = [];
  const repo = repoPath(client.repo);

  for (let page = 1; page <= MAX_PAGES; page++) {
    const path =
      `/repos/${repo}/deployments/${deploymentId}/statuses?` +
      `per_page=${PER_PAGE}&page=${page}`;
    const raw = await client.request<unknown>('GET', path);
    if (!Array.isArray(raw)) throw new Error(`Unexpected deployment-status payload from ${path}`);

    for (const item of raw) {
      const status = parseDeploymentStatus(item);
      if (status) out.push(status);
    }
    if (raw.length < PER_PAGE) break;
  }

  return out.sort(newestFirst);
}

export function latestDeploymentStatus(
  statuses: readonly GitHubDeploymentStatus[],
): GitHubDeploymentStatus | null {
  return [...statuses].sort(newestFirst)[0] ?? null;
}

/**
 * Prove whether `candidateSha` is the required commit or a descendant of it. The compare
 * direction is deliberate: GitHub compares `required...candidate`, so `ahead` means the
 * deployed candidate contains the required commit.
 */
export async function resolveCommit(
  client: DeploymentGitHubApi,
  requiredSha: string,
  candidateSha: string,
): Promise<CommitResolution> {
  const required = commitSha(requiredSha, 'required SHA');
  const candidate = commitSha(candidateSha, 'candidate SHA');
  if (required === candidate) {
    return {
      requiredSha: required,
      candidateSha: candidate,
      relation: 'exact',
      containsRequiredCommit: true,
      additionalCommits: [],
      additionalCommitsTruncated: false,
    };
  }

  const comparison = `${encodeURIComponent(required)}...${encodeURIComponent(candidate)}`;
  const path = `/repos/${repoPath(client.repo)}/compare/${comparison}`;
  const raw = record(await client.request<unknown>('GET', path));
  const status = stringValue(raw?.['status']);
  if (!status || !['ahead', 'behind', 'diverged', 'identical'].includes(status)) {
    throw new Error(`Unexpected commit-comparison payload from ${path}`);
  }

  const allAdditionalCommits = Array.isArray(raw?.['commits'])
    ? raw['commits']
        .map((item) => stringValue(record(item)?.['sha']))
        .filter((sha): sha is string => Boolean(sha && SHA_RE.test(sha)))
        .map((sha) => sha.toLowerCase())
    : [];
  const additionalCommits = allAdditionalCommits.slice(0, MAX_REPORTED_ADDITIONAL_COMMITS);
  const aheadBy = nonNegativeInteger(raw?.['ahead_by']);
  const totalCommits = nonNegativeInteger(raw?.['total_commits']);
  const expectedAdditional = Math.max(aheadBy ?? 0, totalCommits ?? 0);

  if (status === 'ahead') {
    return {
      requiredSha: required,
      candidateSha: candidate,
      relation: 'descendant',
      containsRequiredCommit: true,
      additionalCommits,
      additionalCommitsTruncated:
        expectedAdditional > additionalCommits.length ||
        allAdditionalCommits.length > additionalCommits.length,
    };
  }
  if (status === 'identical') {
    return {
      requiredSha: required,
      candidateSha: candidate,
      relation: 'exact',
      containsRequiredCommit: true,
      additionalCommits: [],
      additionalCommitsTruncated: false,
    };
  }
  return {
    requiredSha: required,
    candidateSha: candidate,
    relation: 'not-descendant',
    containsRequiredCommit: false,
    additionalCommits: [],
    additionalCommitsTruncated: false,
  };
}

/**
 * Resolve the highest-confidence live target allowed by trusted QA policy.
 *
 * Verified staging targets return immediately. Preview and unverified-static targets are held
 * as fallbacks until the staging wait window expires. An explicit URL bypasses deployment
 * discovery, but still has to pass origin, readiness, and optional revision checks.
 */
export async function resolveQaTarget(
  client: DeploymentGitHubApi,
  pull: QaPullRevision,
  config: QaConfig,
  options: ResolveQaTargetOptions = {},
): Promise<QaTargetResolution> {
  commitSha(pull.mergeSha, 'merge SHA');
  commitSha(pull.headSha, 'head SHA');
  if (!Number.isSafeInteger(pull.number) || pull.number < 1) throw new Error('PR number must be positive');

  const diagnostics: string[] = [];
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = positiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const requestTimeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const configuredWaitSeconds = config.target.wait_seconds;
  const waitMs =
    Number.isFinite(configuredWaitSeconds) && configuredWaitSeconds >= 0
      ? configuredWaitSeconds * 1_000
      : 0;
  const startedAt = now();
  const deadline = startedAt + waitMs;
  const allowedOrigins = normalizeAllowedOrigins(config.sandbox.allowed_origins);
  let fallback: QaTarget | null = null;

  if (options.explicitUrl) {
    if (!allowedTarget(options.explicitUrl, allowedOrigins)) {
      diagnostic(diagnostics, 'explicit target URL was invalid or outside the trusted origin allowlist');
      return { target: null, status: 'timed_out', diagnostics };
    }
    while (true) {
      if (options.signal?.aborted) return { target: null, status: 'cancelled', diagnostics };
      const inspected = await inspectStaticTarget({
        client,
        baseUrl: options.explicitUrl,
        pull,
        config,
        allowedOrigins,
        fetchImpl,
        requestTimeoutMs,
        signal: options.signal,
        readinessFallback: options.readinessFallback,
        acceptUnready: options.allowUnreadyExplicit === true,
        now,
        diagnostics,
      });
      if (inspected) return { target: inspected, status: 'resolved', diagnostics };
      if (now() >= deadline) return { target: null, status: 'timed_out', diagnostics };
      if (!(await pause(sleep, Math.min(pollIntervalMs, deadline - now()), options.signal))) {
        return { target: null, status: 'cancelled', diagnostics };
      }
    }
  }

  while (true) {
    if (options.signal?.aborted) return { target: null, status: 'cancelled', diagnostics };

    const staging = await inspectDeploymentTargets({
      client,
      query: { environment: config.target.environment },
      kind: 'staging-deployment',
      expectedSha: pull.mergeSha,
      verifiedAgainst: 'merge',
      pull,
      config,
      allowedOrigins,
      fetchImpl,
      requestTimeoutMs,
      signal: options.signal,
      readinessFallback: options.readinessFallback,
      now,
      diagnostics,
    });
    if (staging) return { target: staging, status: 'resolved', diagnostics };

    let staticCandidate: QaTarget | null = null;
    if (config.target.static_url) {
      staticCandidate = await inspectStaticTarget({
        client,
        baseUrl: config.target.static_url,
        pull,
        config,
        allowedOrigins,
        fetchImpl,
        requestTimeoutMs,
        signal: options.signal,
        readinessFallback: options.readinessFallback,
        now,
        diagnostics,
      });
      if (staticCandidate?.verdict_eligible) {
        return { target: staticCandidate, status: 'resolved', diagnostics };
      }
    }

    let preview: QaTarget | null = null;
    if (config.target.preview_fallback) {
      preview = await inspectDeploymentTargets({
        client,
        query: { sha: pull.headSha },
        kind: 'preview-deployment',
        expectedSha: pull.headSha,
        verifiedAgainst: 'head',
        pull,
        config,
        allowedOrigins,
        fetchImpl,
        requestTimeoutMs,
        signal: options.signal,
        readinessFallback: options.readinessFallback,
        now,
        diagnostics,
      });
    }
    fallback = preview ?? staticCandidate ?? fallback;

    if (now() >= deadline) {
      return fallback
        ? { target: fallback, status: 'resolved', diagnostics }
        : { target: null, status: 'timed_out', diagnostics };
    }
    if (!(await pause(sleep, Math.min(pollIntervalMs, deadline - now()), options.signal))) {
      return { target: null, status: 'cancelled', diagnostics };
    }
  }
}

/** Re-inspect the selected tier instead of re-running staging-first preference ordering. */
export async function recheckQaTarget(
  client: DeploymentGitHubApi,
  pull: QaPullRevision,
  config: QaConfig,
  selected: QaTarget,
  options: Pick<
    ResolveQaTargetOptions,
    | 'fetchImpl'
    | 'requestTimeoutMs'
    | 'readinessFallback'
    | 'allowUnreadyExplicit'
    | 'signal'
    | 'now'
  > = {},
): Promise<QaTargetStability> {
  const diagnostics: string[] = [];
  const allowedOrigins = normalizeAllowedOrigins(config.sandbox.allowed_origins);
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const now = options.now ?? Date.now;
  let current: QaTarget | null;

  if (selected.kind === 'staging-static') {
    current = await inspectStaticTarget({
      client,
      baseUrl: selected.url,
      pull,
      config,
      allowedOrigins,
      fetchImpl,
      requestTimeoutMs,
      signal: options.signal,
      readinessFallback: options.readinessFallback,
      acceptUnready: options.allowUnreadyExplicit === true,
      now,
      diagnostics,
    });
  } else {
    const preview = selected.kind === 'preview-deployment';
    current = await inspectDeploymentTargets({
      client,
      query: preview ? { sha: pull.headSha } : { environment: selected.environment ?? config.target.environment },
      kind: selected.kind,
      expectedSha: preview ? pull.headSha : pull.mergeSha,
      verifiedAgainst: preview ? 'head' : 'merge',
      pull,
      config,
      allowedOrigins,
      fetchImpl,
      requestTimeoutMs,
      signal: options.signal,
      readinessFallback: options.readinessFallback,
      now,
      diagnostics,
    });
  }

  return {
    stable: Boolean(current && sameTargetIdentity(selected, current)),
    current,
    diagnostics,
  };
}

function sameTargetIdentity(first: QaTarget, second: QaTarget): boolean {
  return first.kind === second.kind &&
    first.url === second.url &&
    first.deployment_id === second.deployment_id &&
    first.revision.observed_sha === second.revision.observed_sha &&
    first.revision.relation === second.revision.relation;
}

interface DeploymentInspectionOptions {
  client: DeploymentGitHubApi;
  query: ListDeploymentsQuery;
  kind: Extract<QaTargetKind, 'staging-deployment' | 'preview-deployment'>;
  expectedSha: string;
  verifiedAgainst: 'merge' | 'head';
  pull: QaPullRevision;
  config: QaConfig;
  allowedOrigins: Set<string>;
  fetchImpl: typeof fetch;
  requestTimeoutMs: number;
  signal?: AbortSignal;
  readinessFallback?: ResolveQaTargetOptions['readinessFallback'];
  now: () => number;
  diagnostics: string[];
}

async function inspectDeploymentTargets(o: DeploymentInspectionOptions): Promise<QaTarget | null> {
  let deployments: GitHubDeployment[];
  try {
    deployments = await listDeployments(o.client, o.query);
  } catch (error) {
    diagnostic(o.diagnostics, `deployment lookup failed: ${messageOf(error)}`);
    return null;
  }

  // A staging environment URL is commonly shared by every deployment record. Once a newer
  // deployment exists, an older record no longer proves what that URL serves (especially after
  // a rollback). Poll only the newest staging record; preview records have independent transient
  // URLs and can still be searched for an exact-head candidate.
  const candidates = o.kind === 'staging-deployment'
    ? deployments.slice(0, 1)
    : deployments.slice(0, MAX_DEPLOYMENTS_TO_INSPECT);
  for (const deployment of candidates) {
    // Some providers ignore the sha filter. A preview must be explicitly marked
    // transient by GitHub and must not be the configured staging environment;
    // otherwise an exact-head production deployment could be mutated as a preview.
    if (o.kind === 'preview-deployment' &&
        (!deployment.transient || deployment.environment === o.config.target.environment)) {
      continue;
    }
    let latest: GitHubDeploymentStatus | null;
    try {
      latest = latestDeploymentStatus(await listDeploymentStatuses(o.client, deployment.id));
    } catch (error) {
      diagnostic(o.diagnostics, `deployment ${deployment.id} status lookup failed: ${messageOf(error)}`);
      continue;
    }
    if (!latest || latest.state !== 'success' || !latest.environmentUrl) continue;
    const normalized = allowedTarget(latest.environmentUrl, o.allowedOrigins);
    if (!normalized) {
      diagnostic(o.diagnostics, `deployment ${deployment.id} URL was outside the trusted origin allowlist`);
      continue;
    }
    if (
      !(await isReady(
        normalized.url,
        o.config.target.readiness_path,
        o.config.target.readiness_statuses,
        o.allowedOrigins,
        o.fetchImpl,
        o.requestTimeoutMs,
        o.signal,
        o.readinessFallback,
      ))
    ) {
      diagnostic(o.diagnostics, `deployment ${deployment.id} did not pass readiness`);
      continue;
    }

    let resolved: CommitResolution;
    try {
      resolved = await resolveCommit(o.client, o.expectedSha, deployment.sha);
    } catch (error) {
      diagnostic(o.diagnostics, `deployment ${deployment.id} revision check failed: ${messageOf(error)}`);
      continue;
    }
    if (!resolved.containsRequiredCommit) continue;
    // A sha-filtered preview must be exact even if a provider ignores or broadens the filter.
    if (o.kind === 'preview-deployment' && resolved.relation !== 'exact') continue;

    const at = iso(o.now());
    return {
      kind: o.kind,
      url: normalized.url,
      allowed_origin: normalized.origin,
      environment: deployment.environment,
      deployment_id: deployment.id,
      deployment_status_id: latest.id,
      revision: revisionProof(
        resolved,
        o.verifiedAgainst,
        o.kind === 'preview-deployment' ? 'deployment-sha' : undefined,
        o.pull.mergeSha,
      ),
      stability: 'unchecked',
      verdict_eligible: true,
      resolved_at: at,
      ready_at: at,
    };
  }
  return null;
}

interface StaticInspectionOptions {
  client: DeploymentGitHubApi;
  baseUrl: string;
  pull: QaPullRevision;
  config: QaConfig;
  allowedOrigins: Set<string>;
  fetchImpl: typeof fetch;
  requestTimeoutMs: number;
  signal?: AbortSignal;
  readinessFallback?: ResolveQaTargetOptions['readinessFallback'];
  acceptUnready?: boolean;
  now: () => number;
  diagnostics: string[];
}

async function inspectStaticTarget(o: StaticInspectionOptions): Promise<QaTarget | null> {
  const normalized = allowedTarget(o.baseUrl, o.allowedOrigins);
  if (!normalized) {
    diagnostic(o.diagnostics, 'static target URL was invalid or outside the trusted origin allowlist');
    return null;
  }
  const ready = o.acceptUnready
    ? false
    : await isReady(
        normalized.url,
        o.config.target.readiness_path,
        o.config.target.readiness_statuses,
        o.allowedOrigins,
        o.fetchImpl,
        o.requestTimeoutMs,
        o.signal,
        o.readinessFallback,
      );
  if (!ready && !o.acceptUnready) {
    diagnostic(o.diagnostics, 'static target did not pass readiness');
    return null;
  }
  if (!ready) {
    diagnostic(o.diagnostics, 'explicit revision-pinned target delegated readiness to the authoritative browser run');
  }

  let proof: QaRevisionProof = {
    verified_against: 'none',
    expected_sha: null,
    observed_sha: null,
    relation: 'unverified',
    method: 'none',
    contains_merge_sha: null,
    additional_commits: [],
    additional_commits_truncated: false,
  };
  let verdictEligible = false;

  if (o.config.target.commit_probe) {
    const observed = await readCommitProbe(
      normalized.url,
      o.config.target.commit_probe.path,
      o.config.target.commit_probe.json_pointer,
      o.allowedOrigins,
      o.fetchImpl,
      o.requestTimeoutMs,
      o.signal,
    );
    if (observed) {
      try {
        const resolved = await resolveCommit(o.client, o.pull.mergeSha, observed);
        if (!resolved.containsRequiredCommit) {
          diagnostic(o.diagnostics, 'static target revision is known not to contain the merge commit');
          return null;
        }
        proof = revisionProof(resolved, 'merge', 'static-probe', o.pull.mergeSha);
        verdictEligible = true;
      } catch (error) {
        diagnostic(o.diagnostics, `static target revision check failed: ${messageOf(error)}`);
      }
    } else {
      diagnostic(o.diagnostics, 'static target commit probe did not return a valid commit SHA');
    }
  }

  const at = iso(o.now());
  return {
    kind: 'staging-static',
    url: normalized.url,
    allowed_origin: normalized.origin,
    environment: o.config.target.environment,
    deployment_id: null,
    deployment_status_id: null,
    revision: proof,
    stability: 'unchecked',
    verdict_eligible: verdictEligible,
    resolved_at: at,
    ready_at: at,
  };
}

function revisionProof(
  resolved: CommitResolution,
  verifiedAgainst: 'merge' | 'head',
  method: QaRevisionProof['method'] | undefined,
  mergeSha: string,
): QaRevisionProof {
  return {
    verified_against: verifiedAgainst,
    expected_sha: resolved.requiredSha,
    observed_sha: resolved.candidateSha,
    relation: resolved.relation === 'descendant' ? 'descendant' : 'exact',
    method: method ?? (resolved.relation === 'exact' ? 'deployment-sha' : 'github-compare'),
    contains_merge_sha:
      verifiedAgainst === 'merge'
        ? true
        : resolved.candidateSha.toLowerCase() === mergeSha.toLowerCase(),
    additional_commits: resolved.additionalCommits,
    additional_commits_truncated: resolved.additionalCommitsTruncated,
  };
}

function parseDeployment(value: unknown): GitHubDeployment | null {
  const item = record(value);
  const id = positiveSafeInteger(item?.['id']);
  const sha = stringValue(item?.['sha']);
  const environment = stringValue(item?.['environment']);
  const createdAt = isoString(item?.['created_at']);
  const updatedAt = isoString(item?.['updated_at']);
  if (id === null || !sha || !SHA_RE.test(sha) || !environment || !createdAt || !updatedAt) {
    return null;
  }
  return {
    id,
    sha: sha.toLowerCase(),
    ref: stringValue(item?.['ref']) ?? '',
    environment,
    transient: item?.['transient_environment'] === true,
    createdAt,
    updatedAt,
  };
}

function parseDeploymentStatus(value: unknown): GitHubDeploymentStatus | null {
  const item = record(value);
  const id = positiveSafeInteger(item?.['id']);
  const state = stringValue(item?.['state']);
  const createdAt = isoString(item?.['created_at']);
  const updatedAt = isoString(item?.['updated_at']);
  if (
    id === null ||
    !state ||
    !GITHUB_DEPLOYMENT_STATES.includes(state as GitHubDeploymentState) ||
    !createdAt ||
    !updatedAt
  ) {
    return null;
  }
  return {
    id,
    state: state as GitHubDeploymentState,
    environmentUrl: optionalHttpUrl(item?.['environment_url']),
    logUrl: optionalHttpUrl(item?.['log_url']),
    createdAt,
    updatedAt,
  };
}

async function isReady(
  baseUrl: string,
  readinessPath: string,
  readinessStatuses: readonly number[] | null,
  allowedOrigins: Set<string>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  signal?: AbortSignal,
  fallback?: ResolveQaTargetOptions['readinessFallback'],
): Promise<boolean> {
  const url = sameOriginUrl(baseUrl, readinessPath, allowedOrigins);
  if (!url) return false;
  try {
    const status = await boundedFetch(
      fetchImpl,
      url,
      timeoutMs,
      signal,
      (response) => response.status,
    );
    if (readinessAccepted(status, readinessStatuses)) return true;
  } catch {
    // Fall through to the representative browser-runtime probe when configured.
  }
  return fallback ? fallback(url, timeoutMs, signal, readinessStatuses) : false;
}

function readinessAccepted(status: number, expected: readonly number[] | null): boolean {
  return expected ? expected.includes(status) : status >= 200 && status < 400;
}

async function readCommitProbe(
  baseUrl: string,
  probePath: string,
  pointer: string,
  allowedOrigins: Set<string>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const url = sameOriginUrl(baseUrl, probePath, allowedOrigins);
  if (!url) return null;
  try {
    const selected = await boundedFetch(fetchImpl, url, timeoutMs, signal, async (response) => {
      if (!response.ok) return null;
      return jsonPointer(await readBoundedJson(response, MAX_COMMIT_PROBE_BYTES), pointer);
    });
    return typeof selected === 'string' && SHA_RE.test(selected) ? selected.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function boundedFetch<T>(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  outerSignal: AbortSignal | undefined,
  inspect: (response: Response) => Promise<T> | T,
): Promise<T> {
  const controller = new AbortController();
  let response: Response | undefined;
  const onAbort = () => controller.abort(outerSignal?.reason);
  if (outerSignal?.aborted) controller.abort(outerSignal.reason);
  else outerSignal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`GET ${url} timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      // Inspect the configured readiness status itself. Following a redirect
      // observes the destination instead, while `error` turns an intentionally
      // accepted 3xx response into an exception before policy can inspect it.
      // Manual mode also prevents a Location header from crossing the trusted
      // origin boundary.
      redirect: 'manual',
      credentials: 'omit',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    // Keep the same timeout and abort signal alive while callers inspect the
    // response. Fetch aborts an in-progress body read even after headers arrive.
    return await inspect(response);
  } finally {
    if (response?.body && !response.bodyUsed) void response.body.cancel().catch(() => undefined);
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onAbort);
  }
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new Error(`Commit probe response exceeds ${maxBytes} bytes`);
    }
  }

  if (!response.body) throw new Error('Commit probe response body was empty');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error(`Commit probe response exceeds ${maxBytes} bytes`);
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function jsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  if (!pointer.startsWith('/')) return undefined;
  let current = value;
  for (const encoded of pointer.slice(1).split('/')) {
    const segment = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) return undefined;
      current = current[Number(segment)];
      continue;
    }
    const object = record(current);
    if (!object || !Object.prototype.hasOwnProperty.call(object, segment)) return undefined;
    current = object[segment];
  }
  return current;
}

function allowedTarget(value: string, allowedOrigins: Set<string>): { url: string; origin: string } | null {
  try {
    const url = new URL(value);
    if (!secureProtocol(url) || url.username || url.password || url.search || url.hash) return null;
    if (!allowedOrigins.has(url.origin)) return null;
    return { url: url.toString(), origin: url.origin };
  } catch {
    return null;
  }
}

function sameOriginUrl(baseUrl: string, path: string, allowedOrigins: Set<string>): string | null {
  try {
    const base = new URL(baseUrl);
    const url = new URL(path, base);
    if (url.origin !== base.origin || !allowedOrigins.has(url.origin)) return null;
    if (url.username || url.password || !secureProtocol(url)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeAllowedOrigins(values: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const value of values) {
    try {
      const url = new URL(value);
      if (secureProtocol(url) && !url.username && !url.password) {
        out.add(url.origin);
      }
    } catch {
      // Configuration validation reports malformed origins; the resolver simply cannot use them.
    }
  }
  return out;
}

function optionalHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (!secureProtocol(url) || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function secureProtocol(url: URL): boolean {
  const local = isLoopbackHostname(url.hostname);
  return (
    (url.protocol === 'https:' && !isIpLiteralHostname(url.hostname)) ||
    (local && url.protocol === 'http:')
  );
}

function repoPath(repo: string): string {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error(`Expected repo as "owner/name", got ${JSON.stringify(repo)}`);
  return repo.split('/').map(encodeURIComponent).join('/');
}

function commitSha(value: string, label: string): string {
  if (!SHA_RE.test(value)) throw new Error(`${label} must be a full 40-character commit SHA`);
  return value.toLowerCase();
}

function newestFirst<T extends { createdAt: string; id: number }>(a: T, b: T): number {
  const byTime = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  return byTime || b.id - a.id;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isoString(value: unknown): string | null {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function diagnostic(out: string[], message: string): void {
  if (out.length >= MAX_DIAGNOSTICS || out[out.length - 1] === message) return;
  out.push(message);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  await wait(ms, undefined, signal ? { signal } : undefined);
}

async function pause(
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  ms: number,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await sleep(Math.max(0, ms), signal);
    return !signal?.aborted;
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) return false;
    throw error;
  }
}
