/** Top-level post-merge QA controller. GitHub credentials and app secrets stop here. */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { GitHubApi, PullMeta } from '../github/client.js';
import { recheckQaTarget, resolveQaTarget } from '../github/deployments.js';
import { computeCost, loadPricing } from '../cost/compute.js';
import { redactWith } from '../util/log.js';
import { isLoopbackHostname } from '../util/url.js';
import { runQaAgent, type QaAgentResult } from './agent.js';
import {
  QaBrowserBroker,
  probeBrowserReadiness,
  type QaAuthStep as BrokerAuthStep,
  type QaAttemptRecord,
  type QaBrokerState,
  type QaLocatorInput,
} from './browser.js';
import { startQaRpcServer } from './rpc.js';
import { boundQaLongText } from './schema.js';
import { qaDeploymentEnvironment } from './config.js';
import { preflightQaTestability } from './testability.js';
import {
  QA_SCHEMA_VERSION,
  type QaArtifact,
  type QaArtifactKind,
  type QaAttempt,
  type QaAuthSecretHeader,
  type QaAuthSessionBootstrapConfig,
  type QaAuthStep,
  type QaBaseResolution,
  type QaCleanupResult,
  type QaConfig,
  type QaIssue,
  type QaJobConclusion,
  type QaLocator,
  type QaOutcome,
  type QaPlan,
  type QaResetConfig,
  type QaRunResult,
  type QaTarget,
} from './types.js';

export interface RunQaOptions {
  client: Pick<GitHubApi, 'repo' | 'request'>;
  pull: PullMeta;
  config: QaConfig;
  diffText: string;
  /** Topology-derived source attribution recorded in every persisted result. */
  baseResolution?: QaBaseResolution;
  sourceBaseSha?: string;
  policyBaseShas?: readonly string[];
  /** Complete changed-path manifest derived from the controller's bounded committed patch. */
  changedFiles?: readonly string[];
  /** Controller-authored attribution note for exact versus conservative merge ranges. */
  changeScopeNote?: string;
  sourceDir: string;
  /** Repository instructions loaded from the trusted pre-merge revision. */
  instructions?: string;
  evidenceDir: string;
  explicitTargetUrl?: string;
  explicitTargetSha?: string;
  storageStatePath?: string;
  headless?: boolean;
  keepScratch?: boolean;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
  runId?: string;
}

const MAX_DIFF_CHARS = 240_000;
const MAX_RESULT_WARNINGS = 100;
const MAX_RESULT_WARNING_CHARS = 500;
const MAX_ISSUE_TITLE_CHARS = 500;
const MAX_RESULT_LONG_TEXT_CHARS = 4_000;
const SEALED_CHECKPOINT_MATCHED = 'Authenticated checkpoint matched.';
const SEALED_CHECKPOINT_MISMATCH = 'Authenticated checkpoint did not match.';
const SEALED_CHECKPOINT_UNAVAILABLE = 'Authenticated checkpoint was unavailable.';
const QA_EVIDENCE_RESERVATION_FILE = 'payload-status.json';
// The composite action grants the container five seconds after SIGTERM. Keep
// bounded controller cleanup to at most 2.5s so partial report persistence and
// host-side resource removal retain their own cancellation budget.
const CANCEL_RPC_CLEANUP_MS = 1_000;
const CANCEL_BROWSER_CLEANUP_MS = 500;
const CANCEL_RESET_CLEANUP_MS = 1_000;

/** @internal Keep persisted results inside the public schema's warning bounds. */
export function boundQaWarnings(warnings: readonly string[], secrets: readonly string[]): string[] {
  const bounded = warnings
    .slice(0, MAX_RESULT_WARNINGS)
    .map((warning) => redactWith(warning, secrets).slice(0, MAX_RESULT_WARNING_CHARS));
  if (warnings.length > MAX_RESULT_WARNINGS) {
    const marker = ' [additional warnings omitted]';
    const last = bounded[MAX_RESULT_WARNINGS - 1] ?? '';
    bounded[MAX_RESULT_WARNINGS - 1] =
      `${last.slice(0, MAX_RESULT_WARNING_CHARS - marker.length)}${marker}`;
  }
  return bounded;
}

export interface QaEvidenceDirectory {
  /** Directory exclusively used for files produced by this QA run. */
  directory: string;
  /** True when a non-empty caller directory required a per-run child directory. */
  isolated: boolean;
}

async function hasInitialEvidenceReservation(directory: string, entries: readonly string[]): Promise<boolean> {
  if (entries.length !== 1 || entries[0] !== QA_EVIDENCE_RESERVATION_FILE) return false;
  const reservation = path.join(directory, QA_EVIDENCE_RESERVATION_FILE);
  try {
    const info = await lstat(reservation);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1_024) return false;
    const parsed: unknown = JSON.parse(await readFile(reservation, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const marker = parsed as Record<string, unknown>;
    const keys = Object.keys(marker);
    return keys.length === 3 &&
      keys.every((key) => ['schema_version', 'report_present', 'runtime_status'].includes(key)) &&
      marker['schema_version'] === 1 &&
      marker['report_present'] === false &&
      marker['runtime_status'] === null;
  } catch {
    return false;
  }
}

/**
 * Resolve a controller-owned evidence directory without ever treating an arbitrary,
 * non-empty caller directory as disposable run output. Fresh and empty directories, plus
 * an Action directory containing only its strict initial reservation marker, keep their
 * existing layout; repeated/local runs receive a predictable isolated child.
 */
export async function prepareQaEvidenceDirectory(
  requestedDirectory: string,
  runId: string,
): Promise<QaEvidenceDirectory> {
  const requested = path.resolve(requestedDirectory);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const info = await lstat(requested);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('QA evidence output must be a real directory, not a file or symbolic link');
  }

  const entries = await readdir(requested);
  if (entries.length === 0 || await hasInitialEvidenceReservation(requested, entries)) {
    return { directory: requested, isolated: false };
  }

  const safeRunId = runId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'run';
  const preferred = path.join(requested, `run-${safeRunId}`);
  try {
    await mkdir(preferred, { mode: 0o700 });
    return { directory: preferred, isolated: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return {
    directory: await mkdtemp(`${preferred}-`),
    isolated: true,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function conclusion(outcome: QaOutcome): QaJobConclusion {
  if (outcome === 'cancelled') return 'cancelled';
  return ['product_issue', 'blocked', 'infrastructure_error'].includes(outcome)
    ? 'failure'
    : 'success';
}

function template(): string {
  const candidates = [
    new URL('../prompts/qa.md', import.meta.url),
    new URL('../../src/prompts/qa.md', import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(fileURLToPath(candidate), 'utf8');
    } catch {
      // Try source-tree fallback after compiled layout.
    }
  }
  throw new Error('Juror QA prompt is missing from the installation');
}

function promptJson(value: unknown): string {
  // Keep data from closing the explicit prompt boundary even when a title or filename contains
  // markup. JSON also escapes embedded newlines in paths instead of turning them into directives.
  return JSON.stringify(value, null, 2)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');
}

/** @internal Render the planner prompt with attacker-authored metadata in escaped data blocks. */
export function renderQaPrompt(options: RunQaOptions, target: QaTarget): string {
  const diff = options.diffText.length > MAX_DIFF_CHARS
    ? `${options.diffText.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated by Juror QA]`
    : options.diffText;
  const values: Record<string, string> = {
    PR_METADATA: promptJson({
      repository: options.client.repo,
      number: options.pull.number,
      title: options.pull.title,
      description: options.pull.body || null,
      source_base_sha: options.sourceBaseSha ?? options.pull.baseSha,
      head_sha: options.pull.headSha,
      merge_sha: options.pull.mergeCommitSha ?? options.pull.headSha,
      base_resolution: options.baseResolution ?? 'exact',
      policy_base_shas: options.policyBaseShas ?? [options.pull.baseSha],
    }),
    TARGET_URL: target.url,
    TARGET_KIND: target.kind,
    TARGET_SHA: target.revision.observed_sha ?? '(unverified)',
    TARGET_PROOF: `${target.revision.method}/${target.revision.relation}`,
    SOURCE_DIR: options.sourceDir,
    INSTRUCTIONS: options.instructions ?? '(No trusted repository QA instructions were found.)',
    CHANGE_SCOPE: options.changeScopeNote ?? 'Exact pre-merge base resolved from merge topology.',
    CHANGED_FILES: promptJson(options.changedFiles ?? []),
    DIFF: diff,
  };
  return template().replace(/\{\{([A-Z0-9_]+)\}\}/g, (whole, key: string) => values[key] ?? whole);
}

export function decodeQaSecrets(encoded: string | undefined): Record<string, string> {
  if (!encoded?.trim()) return {};
  let parsed: unknown;
  try {
    const raw = Buffer.from(encoded.trim(), 'base64');
    if (raw.length > 128 * 1024) throw new Error('decoded payload is too large');
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    // JSON parser errors can echo slices of malformed input. At this boundary
    // the redactor does not exist yet, so never interpolate the parse error.
    throw new Error('JUROR_QA_SECRETS_B64 is not a valid base64 JSON map');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JUROR_QA_SECRETS_B64 must decode to a JSON object');
  }
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.length < 8) {
      throw new Error('JUROR_QA_SECRETS_B64 contains an invalid logical key or a value shorter than 8 characters');
    }
    secrets[key] = value;
  }
  return secrets;
}

function brokerLocator(locator: QaLocator): QaLocatorInput {
  if (locator.by === 'role') return { role: locator.role, name: locator.name };
  if (locator.by === 'label') return { label: locator.value };
  if (locator.by === 'placeholder') return { placeholder: locator.value };
  if (locator.by === 'text') return { text: locator.value };
  return { test_id: locator.value };
}

function brokerAuthSteps(steps: QaAuthStep[]): BrokerAuthStep[] {
  return steps.map((step): BrokerAuthStep => {
    if (step.type === 'goto') return { action: 'navigate', url: step.path };
    if (step.type === 'fill') return { action: 'fill', ...brokerLocator(step.locator), secret: step.secret_ref };
    if (step.type === 'click') return { action: 'click', ...brokerLocator(step.locator) };
    return {
      action: 'wait',
      ...brokerLocator(step.locator),
      state: step.state,
      ...(step.timeout_seconds ? { timeout_ms: step.timeout_seconds * 1000 } : {}),
    };
  });
}

function brokerSessionBootstrap(
  bootstrap: QaAuthSessionBootstrapConfig | null,
): { url: string; secret: string; targetOrigin: string; readyStorageKey: string } | undefined {
  if (!bootstrap) return undefined;
  return {
    url: bootstrap.url,
    secret: bootstrap.secret_ref,
    targetOrigin: bootstrap.target_origin,
    readyStorageKey: bootstrap.ready_storage_key,
  };
}

function brokerSecretHeaders(
  headers: readonly QaAuthSecretHeader[],
): Array<{ name: string; secret: string; origins: string[] }> {
  return headers.map((header) => ({
    name: header.name,
    secret: header.secret_ref,
    origins: [...header.origins],
  }));
}

/**
 * Keep support-session authentication on the canonical staging surface. The
 * trusted configuration parser rejects a non-staging security tier, while this
 * runtime check binds an optional deployment selector and the canonical origin
 * to the target that was actually resolved.
 */
export function stagingAuthTargetProblem(config: QaConfig, target: QaTarget): string | null {
  const bootstrap = config.auth.session_bootstrap;
  const secretHeaders = config.auth.browser_secret_headers;
  if (!bootstrap && secretHeaders.length === 0) return null;
  if (config.target.environment !== 'staging') {
    return 'trusted session bootstrap is available only for the staging environment';
  }
  if (config.target.preview_fallback) {
    return 'trusted staging authentication requires preview fallback to be disabled';
  }
  if (target.kind === 'preview-deployment') {
    return 'trusted session bootstrap is not available for preview deployments';
  }
  if (target.environment !== qaDeploymentEnvironment(config.target)) {
    return 'the resolved deployment is not the configured staging deployment environment';
  }
  const staticUrl = config.target.static_url;
  if (!staticUrl) {
    return 'trusted staging authentication requires a canonical qa.target.static_url';
  }
  const canonicalOrigin = bootstrap?.target_origin ?? new URL(staticUrl).origin;
  if (new URL(staticUrl).origin !== canonicalOrigin) {
    return 'qa.target.static_url does not match the trusted staging authentication origin';
  }
  if (target.allowed_origin !== canonicalOrigin) {
    return 'the resolved staging origin does not match the trusted canonical staging origin';
  }
  return null;
}

/** @internal Fail before model startup when trusted staging-auth inputs are incomplete. */
export function stagingAuthSecretProblem(
  config: QaConfig,
  secrets: Readonly<Record<string, string>>,
): string | null {
  const required = new Set<string>();
  if (config.auth.session_bootstrap) required.add(config.auth.session_bootstrap.secret_ref);
  for (const header of config.auth.browser_secret_headers) required.add(header.secret_ref);
  if (required.size === 0) return null;
  if ([...required].some((name) => !secrets[name])) {
    return 'trusted staging authentication credentials are unavailable';
  }
  const sessionRef = config.auth.session_bootstrap?.secret_ref;
  if (sessionRef && (secrets[sessionRef]?.length ?? 0) < 32) {
    return 'trusted staging session credential does not meet the minimum token length';
  }
  return null;
}

/** @internal Executes the trusted reset hook with controller cancellation and timeout bounds. */
export async function resetSandbox(
  reset: QaResetConfig | null,
  target: QaTarget,
  secrets: Record<string, string>,
  allowedOrigins: readonly string[],
  runId: string,
  scenarioId?: string,
  attempt?: 1 | 2,
  execution: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<QaCleanupResult> {
  if (!reset) return { status: 'not_required', summary: 'No reset hook is configured.', error: null };
  const url = new URL(reset.url, target.url);
  const local = isLoopbackHostname(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    return { status: 'failed', summary: 'Reset URL must use HTTPS unless it is localhost.', error: 'cleartext reset denied' };
  }
  const allowed = new Set([target.allowed_origin, ...allowedOrigins.map((value) => new URL(value).origin)]);
  if (!allowed.has(url.origin)) {
    return { status: 'failed', summary: 'Reset URL is outside the resolved target origin.', error: 'origin denied' };
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Juror-QA-Run': runId,
  };
  for (const header of reset.secret_headers) {
    const secret = secrets[header.secret_ref];
    if (!secret) {
      return {
        status: 'failed',
        summary: `Reset secret ${header.secret_ref} is unavailable.`,
        error: 'missing reset secret',
      };
    }
    headers[header.name] = header.format === 'bearer' ? `Bearer ${secret}` : secret;
  }
  const controller = new AbortController();
  const configuredTimeoutMs = (reset.timeout_seconds ?? 15) * 1000;
  const timeoutMs = Math.max(1, Math.min(configuredTimeoutMs, execution.timeoutMs ?? configuredTimeoutMs));
  const onAbort = () => controller.abort();
  if (execution.signal?.aborted) controller.abort();
  else execution.signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: reset.method,
      headers,
      body: JSON.stringify({ run_id: runId, scenario_id: scenarioId ?? null, attempt: attempt ?? null }),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!reset.expected_statuses.includes(response.status)) {
      return {
        status: 'failed',
        summary: `Reset returned unexpected HTTP ${response.status}.`,
        error: `unexpected status ${response.status}`,
      };
    }
    return { status: 'passed', summary: 'Synthetic QA state was reset.', error: null };
  } catch (error) {
    return { status: 'failed', summary: 'Synthetic QA state reset failed.', error: errorMessage(error) };
  } finally {
    clearTimeout(timeout);
    execution.signal?.removeEventListener('abort', onAbort);
  }
}

async function resolveTarget(options: RunQaOptions, config: QaConfig): Promise<{
  target: QaTarget | null;
  diagnostics: string[];
  status: 'resolved' | 'timed_out' | 'cancelled';
}> {
  const mergeSha = options.pull.mergeCommitSha ?? options.pull.headSha;
  const resolved = await resolveQaTarget(
    options.client,
    { number: options.pull.number, mergeSha, headSha: options.pull.headSha },
    config,
    {
      ...(options.explicitTargetUrl ? { explicitUrl: options.explicitTargetUrl } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      readinessFallback: probeBrowserReadiness,
      allowUnreadyExplicit: Boolean(options.explicitTargetUrl && options.explicitTargetSha),
    },
  );
  if (!resolved.target || !options.explicitTargetSha) return resolved;
  const observed = resolved.target.revision.observed_sha;
  if (!observed) {
    resolved.target = {
      ...resolved.target,
      revision: {
        ...resolved.target.revision,
        // Preserve what the operator expected while leaving observed_sha,
        // verified_against, and verdict_eligible untouched. A claim is useful
        // diagnostic context but is never promoted to deployment proof.
        expected_sha: options.explicitTargetSha.toLowerCase(),
      },
    };
    resolved.diagnostics.push(
      'the explicit target SHA was not independently exposed by the target; the target remains advisory',
    );
    return resolved;
  }
  if (observed !== options.explicitTargetSha.toLowerCase()) {
    return {
      target: null,
      status: 'timed_out',
      diagnostics: [...resolved.diagnostics, 'the explicit target SHA does not match the target commit probe'],
    };
  }
  return resolved;
}

function sameCheckpointFailures(attempts: QaAttemptRecord[]): Array<{
  scenarioId: string;
  checkpoint: string;
  first: QaAttemptRecord;
  second: QaAttemptRecord;
}> {
  const out: Array<{ scenarioId: string; checkpoint: string; first: QaAttemptRecord; second: QaAttemptRecord }> = [];
  const scenarioIds = new Set(attempts.map((attempt) => attempt.scenarioId));
  for (const scenarioId of scenarioIds) {
    const first = attempts.find((attempt) => attempt.scenarioId === scenarioId && attempt.attempt === 1);
    const second = attempts.find((attempt) => attempt.scenarioId === scenarioId && attempt.attempt === 2);
    if (!first || !second || first.status !== 'failed' || second.status !== 'failed') continue;
    const firstFailed = new Map(
      first.assertions
        .filter((item) => !item.passed && credibleAssertionFailure(item))
        .map((item) => [item.checkpoint, item]),
    );
    for (const assertion of second.assertions.filter((item) => !item.passed && credibleAssertionFailure(item))) {
      const initial = firstFailed.get(assertion.checkpoint);
      if (initial && equivalentFailure(initial, assertion)) {
        out.push({ scenarioId, checkpoint: assertion.checkpoint, first, second });
      }
    }
  }
  return out;
}

function credibleAssertionFailure(assertion: QaAttemptRecord['assertions'][number]): boolean {
  if (assertion.failureReason !== undefined) {
    return assertion.failureReason === 'observed_mismatch';
  }
  return !/(?:timeout|locator|strict mode|target closed|browser has been closed|page\.|getby\w*\()/i.test(assertion.actual);
}

function equivalentFailure(
  first: QaAttemptRecord['assertions'][number],
  second: QaAttemptRecord['assertions'][number],
): boolean {
  if (first.kind !== second.kind) return false;
  const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
  return normalize(first.actual) === normalize(second.actual);
}

function safeQaText(
  value: string,
  secrets: readonly string[],
  maxLength: number,
  fallback: string,
): string {
  return redactWith(value, secrets).slice(0, maxLength) || fallback;
}

/** @internal Exact-redact every model-authored prose/matcher field while preserving plan enums and IDs. */
export function redactQaPlan(plan: QaPlan | null, secrets: readonly string[]): QaPlan | null {
  if (!plan) return null;
  const short = (value: string) => safeQaText(value, secrets, MAX_ISSUE_TITLE_CHARS, '(redacted)');
  const long = (value: string) => safeQaText(value, secrets, MAX_RESULT_LONG_TEXT_CHARS, '(redacted)');
  return {
    ...plan,
    impact_assessment: long(plan.impact_assessment),
    no_testable_surface_reason: plan.no_testable_surface_reason === null
      ? null
      : long(plan.no_testable_surface_reason),
    surfaces: plan.surfaces.map(short),
    scenarios: plan.scenarios.map((scenario) => ({
      ...scenario,
      title: short(scenario.title),
      rationale: long(scenario.rationale),
      viewport: { ...scenario.viewport, justification: short(scenario.viewport.justification) },
      preconditions: scenario.preconditions.map(short),
      seeded_state: scenario.seeded_state.map(short),
      checkpoints: scenario.checkpoints.map((checkpoint) => ({
        ...checkpoint,
        description: short(checkpoint.description),
        expected: long(checkpoint.expected),
        assertion: {
          ...checkpoint.assertion,
          locator: checkpoint.assertion.locator === null
            ? null
            : {
                ...checkpoint.assertion.locator,
                value: long(checkpoint.assertion.locator.value),
                name: checkpoint.assertion.locator.name === null
                  ? null
                  : short(checkpoint.assertion.locator.name),
              },
          url_contains: checkpoint.assertion.url_contains === null
            ? null
            : long(checkpoint.assertion.url_contains),
        },
      })),
      cleanup_expectations: scenario.cleanup_expectations.map(short),
    })),
    risk_notes: plan.risk_notes.map(short),
    blind_spots: plan.blind_spots.map(short),
  };
}

function policyLimitedFailure(failure: {
  first: QaAttemptRecord;
  second: QaAttemptRecord;
}): boolean {
  return failure.first.policyDenials.length > 0 || failure.second.policyDenials.length > 0;
}

export function classifyQaOutcome(
  state: QaBrokerState,
  target: QaTarget,
  agent: QaAgentResult,
  cleanup: QaCleanupResult,
  cancelled = false,
): QaOutcome {
  if (cancelled) return 'cancelled';
  if (agent.timedOut || agent.exitCode !== 0 || !agent.completed || !state.plan || !state.agentFinish) {
    return 'infrastructure_error';
  }
  if (target.stability === 'drifted' || cleanup.status === 'failed') return 'blocked';
  if (state.plan.testability === 'no_testable_surface') return 'no_testable_surface';
  // A planned scenario that could not complete makes the run incomplete. Do not
  // let a non-blocking advisory finding turn that incomplete run green.
  if (state.attempts.some((attempt) => attempt.status === 'blocked')) return 'blocked';
  const reproducible = sameCheckpointFailures(state.attempts);
  if (reproducible.length > 0) {
    // A blocked third-party resource may be unrelated analytics, but it can also
    // be a missing dependency. Keep that individual finding advisory without
    // downgrading a separate, cleanly reproduced product failure.
    const hasVerifiedFailure = target.verdict_eligible && reproducible.some(
      (failure) => !policyLimitedFailure(failure),
    );
    return hasVerifiedFailure ? 'product_issue' : 'advisory';
  }
  const initiallyFailed = state.attempts.filter(
    (attempt) => attempt.status === 'failed' && attempt.attempt === 1,
  );
  if (initiallyFailed.length > 0) {
    const retries = initiallyFailed.map((attempt) => state.attempts.find(
      (other) => other.scenarioId === attempt.scenarioId && other.attempt === 2,
    ));
    if (retries.some((retry) => !retry || retry.status !== 'passed')) return 'blocked';
    return 'flaky';
  }
  // Sensitive-state attempt 2 is mandatory even after a passing first attempt.
  // A second-only failure is inconclusive, never a green run.
  if (state.attempts.some((attempt) => attempt.status === 'failed')) return 'blocked';
  return 'passed';
}

export function buildIssues(
  state: QaBrokerState,
  target: QaTarget,
  outcome: QaOutcome,
  secrets: readonly string[] = [],
): QaIssue[] {
  if (!state.plan || (outcome !== 'product_issue' && outcome !== 'advisory')) return [];
  const agentIssues = state.agentFinish?.issues ?? [];
  return sameCheckpointFailures(state.attempts).map((failure, index) => {
    const planScenario = state.plan?.scenarios.find((scenario) => scenario.id === failure.scenarioId);
    const planCheckpoint = planScenario?.checkpoints.find((checkpoint) => checkpoint.id === failure.checkpoint);
    const authored = agentIssues.find(
      (issue) => issue.scenario_id === failure.scenarioId && issue.checkpoint === failure.checkpoint,
    );
    const observed = failure.second.assertions.find(
      (assertion) => assertion.checkpoint === failure.checkpoint && !assertion.passed,
    );
    return {
      id: `qa-${failure.scenarioId}-${failure.checkpoint}-${index + 1}`,
      scenario_id: failure.scenarioId,
      checkpoint_id: failure.checkpoint,
      severity: authored?.severity ?? 'P1',
      classification: target.verdict_eligible && !policyLimitedFailure(failure) ? 'verified' : 'advisory',
      reproducible: true,
      title: safeQaText(
        authored?.title ?? `Checkpoint failed twice: ${planCheckpoint?.description ?? failure.checkpoint}`,
        secrets,
        MAX_ISSUE_TITLE_CHARS,
        'Checkpoint failed twice',
      ),
      // Expected behavior is sealed in the accepted plan and observed behavior
      // comes from the broker assertion. Model-authored qa_finish prose can add
      // a title/severity, but can never rewrite controller evidence.
      expected: safeQaText(
        planCheckpoint?.expected ?? observed?.expected ?? 'Expected checkpoint to pass',
        secrets,
        MAX_RESULT_LONG_TEXT_CHARS,
        'Expected checkpoint to pass',
      ),
      actual: safeQaText(
        observed?.actual ?? 'Checkpoint failed on both attempts',
        secrets,
        MAX_RESULT_LONG_TEXT_CHARS,
        'Checkpoint failed on both attempts',
      ),
      attempt_numbers: [1, 2],
    };
  });
}

/** @internal Normalize broker diagnostics before they cross the public result boundary. */
export function convertAttempts(
  state: QaBrokerState,
  artifacts: QaArtifact[],
  evidenceRoot: string,
  secrets: readonly string[] = [],
): QaAttempt[] {
  const observation = (
    kind: 'console' | 'network' | 'policy',
    summary: string,
    observedAt: string,
  ) => ({
    kind,
    summary: boundQaLongText(redactWith(summary, secrets)) || '(empty diagnostic)',
    observed_at: observedAt,
  });
  return state.attempts.map((attempt) => {
    if (attempt.sensitiveOutput) {
      const scenario = state.plan?.scenarios.find((item) => item.id === attempt.scenarioId);
      const assertions = new Map(attempt.assertions.map((assertion) => [assertion.checkpoint, assertion]));
      return {
        scenario_id: attempt.scenarioId,
        attempt: attempt.attempt,
        status: attempt.status,
        // Admission time is controller input; all page/auth/close-derived
        // timing and conditional diagnostics remain private.
        started_at: attempt.startedAt,
        duration_ms: 0,
        operations: [],
        checkpoints: (scenario?.checkpoints ?? []).map((checkpoint) => {
          const assertion = assertions.get(checkpoint.id);
          const status = assertion?.passed
            ? 'passed'
            : assertion?.failureReason === 'observed_mismatch'
              ? 'failed'
              : 'blocked';
          return {
            checkpoint_id: checkpoint.id,
            status,
            expected: safeQaText(
              checkpoint.expected,
              secrets,
              MAX_RESULT_LONG_TEXT_CHARS,
              'Expected checkpoint to pass',
            ),
            observed: status === 'passed'
              ? SEALED_CHECKPOINT_MATCHED
              : status === 'failed'
                ? SEALED_CHECKPOINT_MISMATCH
                : SEALED_CHECKPOINT_UNAVAILABLE,
          };
        }),
        observations: [],
        evidence_artifact_ids: [],
      };
    }
    const relativeEvidence = path.relative(evidenceRoot, attempt.evidenceDir).replaceAll('\\', '/');
    const artifactIds = artifacts
      .filter((artifact) => artifact.path.startsWith(`${relativeEvidence}/`))
      .map((artifact) => artifact.id);
    return {
      scenario_id: attempt.scenarioId,
      attempt: attempt.attempt,
      status: attempt.status,
      started_at: attempt.startedAt,
      duration_ms: attempt.durationMs,
      operations: attempt.operations.map((operation) => ({
        ...operation,
        summary: safeQaText(
          operation.summary,
          secrets,
          MAX_RESULT_LONG_TEXT_CHARS,
          '(empty operation)',
        ),
        error: operation.error === null
          ? null
          : safeQaText(operation.error, secrets, MAX_RESULT_LONG_TEXT_CHARS, '(redacted error)'),
      })),
      checkpoints: attempt.assertions.map((assertion) => ({
        checkpoint_id: assertion.checkpoint,
        status: assertion.passed ? 'passed' : 'failed',
        // Preserve the exact runtime comparator. The higher-level planned outcome
        // remains available in result.plan and must never be substituted here.
        expected: safeQaText(
          assertion.expected,
          secrets,
          MAX_RESULT_LONG_TEXT_CHARS,
          'Expected checkpoint to pass',
        ),
        observed: safeQaText(
          assertion.actual,
          secrets,
          MAX_RESULT_LONG_TEXT_CHARS,
          '(empty observation)',
        ),
      })),
      observations: [
        ...attempt.console.map((summary) => observation('console', summary, attempt.finishedAt)),
        ...attempt.failedRequests.map((summary) => observation('network', summary, attempt.finishedAt)),
        ...attempt.policyDenials.map((summary) => observation('policy', summary, attempt.finishedAt)),
      ],
      evidence_artifact_ids: artifactIds,
    };
  });
}

function artifactKind(relative: string): QaArtifactKind {
  const name = path.basename(relative);
  if (name.endsWith('.webm')) return 'video';
  if (name === 'trace.zip') return 'trace';
  if (name.endsWith('.png')) return 'screenshot';
  if (name.includes('console')) return 'console';
  if (name.includes('request')) return 'network';
  if (name.includes('plan')) return 'plan';
  return 'ledger';
}

const TEXT_EVIDENCE = new Set([
  'agent-events.ndjson',
  'agent-result.json',
  'attempt.json',
  'console.json',
  'failed-requests.json',
  'operations.ndjson',
  'plan.json',
]);

function admittedEvidence(relative: string): boolean {
  const name = path.basename(relative);
  return TEXT_EVIDENCE.has(name) || name === 'trace.zip' || name === 'final.png' || name.endsWith('.webm');
}

/** @internal Exported so the evidence safety boundary can be regression-tested directly. */
export async function collectQaArtifacts(
  root: string,
  retentionDays: number,
  secrets: readonly string[],
  sensitiveBrowserState: boolean,
  warnings: string[],
): Promise<QaArtifact[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  await visit(root);
  const admitted: Array<{ file: string; body: Buffer }> = [];
  for (const file of files.sort()) {
    const relative = path.relative(root, file).replaceAll(path.sep, '/');
    // The composite Action writes this exact controller-owned reservation before starting
    // cancellable work. It belongs in the payload artifact, not the semantic artifact ledger.
    if (relative === QA_EVIDENCE_RESERVATION_FILE) continue;
    if (sensitiveBrowserState && relative.startsWith('scenarios/')) {
      // Defense in depth for partial/older/compromised browser output. The
      // presence, filename, contents, and media type of any per-attempt file can
      // be page-dependent, so remove it without a conditional public warning.
      await rm(file, { force: true });
      continue;
    }
    if (!admittedEvidence(relative)) {
      // The collector is not a directory cleaner. Unknown files are excluded from the
      // manifest, but preserving them avoids deleting data that was not registered as
      // an artifact by this run.
      warnings.push(`evidence file outside the controller allowlist was ignored: ${relative}`);
      continue;
    }
    const kind = artifactKind(relative);
    if (sensitiveBrowserState && (kind === 'video' || kind === 'screenshot' || kind === 'trace')) {
      await rm(file, { force: true });
      continue;
    }
    let body = await readFile(file);
    if (TEXT_EVIDENCE.has(path.basename(relative))) {
      const sanitized = redactWith(body.toString('utf8'), secrets);
      body = Buffer.from(sanitized);
      await writeFile(file, body, { mode: 0o600 });
    }
    const leaked = secrets.find((secret) => secret.length > 0 && body.includes(Buffer.from(secret)));
    if (leaked) {
      await rm(file, { force: true });
      warnings.push(`evidence file containing a configured secret canary was removed: ${relative}`);
      continue;
    }
    admitted.push({ file, body });
  }
  return admitted.map(({ file, body }, index): QaArtifact => {
    const relative = path.relative(root, file).replaceAll(path.sep, '/');
    return {
      id: `artifact-${index + 1}`,
      kind: artifactKind(relative),
      path: relative,
      sanitized: true,
      sha256: createHash('sha256').update(body).digest('hex'),
      retention_days: retentionDays,
      upload: null,
    };
  });
}

function runResultBase(
  options: RunQaOptions,
  runId: string,
  startedAt: number,
  target: QaTarget | null,
  outcome: QaOutcome,
  warnings: string[],
  secrets: readonly string[] = [],
): QaRunResult {
  const completed = Date.now();
  return {
    schema_version: QA_SCHEMA_VERSION,
    run_id: runId,
    repository: options.client.repo,
    pr_number: options.pull.number,
    merge_sha: options.pull.mergeCommitSha ?? options.pull.headSha,
    base_resolution: options.baseResolution ?? 'exact',
    source_base_sha: options.sourceBaseSha ?? options.pull.baseSha,
    policy_base_shas: [...(options.policyBaseShas ?? [options.pull.baseSha])],
    started_at: new Date(startedAt).toISOString(),
    completed_at: new Date(completed).toISOString(),
    duration_ms: completed - startedAt,
    outcome,
    conclusion: conclusion(outcome),
    target,
    plan: null,
    attempts: [],
    issues: [],
    cleanup: { status: 'not_required', summary: 'No browser state was created.', error: null },
    artifacts: [],
    runtime: { model_id: options.config.model.id, model_version: null, browser_name: 'chromium', browser_version: 'unknown' },
    cost: { usage: null, usd: null, source: 'unknown' },
    warnings: boundQaWarnings(warnings, secrets),
  };
}

/** Sanitize teardown diagnostics before they enter stdout or persisted evidence. */
export function redactQaCleanup(
  cleanup: QaCleanupResult,
  secrets: readonly string[],
): QaCleanupResult {
  return {
    status: cleanup.status,
    summary: safeQaText(
      cleanup.summary,
      secrets,
      MAX_RESULT_LONG_TEXT_CHARS,
      '(empty cleanup diagnostic)',
    ),
    error: cleanup.error === null
      ? null
      : safeQaText(cleanup.error, secrets, MAX_RESULT_LONG_TEXT_CHARS, '(redacted error)'),
  };
}

function containsQaSecretCanary(value: unknown, secrets: readonly string[], seen: WeakSet<object>): boolean {
  if (typeof value === 'string') {
    return secrets.some((secret) => secret.length > 0 && value.includes(secret));
  }
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => containsQaSecretCanary(item, secrets, seen));
  }
  return Object.values(value as Record<string, unknown>)
    .some((item) => containsQaSecretCanary(item, secrets, seen));
}

/** @internal Fail closed if an exact configured QA value survives semantic sanitation. */
export function assertNoQaSecretCanaries(value: unknown, secrets: readonly string[]): void {
  if (containsQaSecretCanary(value, secrets, new WeakSet<object>())) {
    throw new Error('QA semantic output still contained a configured secret canary');
  }
}

/** @internal Check the exact text bytes a CLI/file boundary is about to emit. */
export function checkedQaOutput(contents: string, secrets: readonly string[]): string {
  assertNoQaSecretCanaries(contents, secrets);
  return contents;
}

/** @internal Canonical persisted report bytes, including the final line delimiter. */
export function serializeQaReport(result: QaRunResult, secrets: readonly string[]): string {
  // A collision in a schema-constrained identifier cannot be replaced without
  // invalidating the contract. Scan both semantic values and the final serialized
  // bytes so JSON punctuation or the trailing newline cannot form a canary.
  assertNoQaSecretCanaries(result, secrets);
  return checkedQaOutput(`${JSON.stringify(result, null, 2)}\n`, secrets);
}

async function writeQaReport(
  evidenceDir: string,
  result: QaRunResult,
  secrets: readonly string[],
): Promise<void> {
  await writeFile(
    path.join(evidenceDir, 'report.json'),
    serializeQaReport(result, secrets),
    { mode: 0o600 },
  );
}

/** Lower-bound model round trips: each completed MCP call requires another model response. */
export function estimateQaAgentRounds(events: string): number {
  let completedTools = 0;
  for (const line of events.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const event = JSON.parse(line) as { type?: unknown; item?: { type?: unknown } };
      if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call') completedTools++;
    } catch {
      // Ignore diagnostic/non-protocol lines.
    }
  }
  return Math.max(1, completedTools + 1);
}

export async function runQa(options: RunQaOptions): Promise<QaRunResult> {
  const startedAt = Date.now();
  const runId = options.runId ?? `${options.pull.number}-${startedAt}`;
  const warnings: string[] = options.changeScopeNote ? [options.changeScopeNote] : [];
  const preparedEvidence = await prepareQaEvidenceDirectory(options.evidenceDir, runId);
  const evidenceDir = preparedEvidence.directory;
  if (preparedEvidence.isolated) {
    warnings.push(
      `The requested evidence directory was non-empty; this run was isolated in ${path.basename(evidenceDir)}.`,
    );
  }
  if (options.explicitTargetSha && !options.explicitTargetUrl) {
    throw new Error('explicitTargetSha requires explicitTargetUrl');
  }
  if (options.signal?.aborted) {
    const result = runResultBase(options, runId, startedAt, null, 'cancelled', warnings);
    await writeQaReport(evidenceDir, result, []);
    return result;
  }
  const preflightPlan = preflightQaTestability(
    options.changedFiles,
    options.config.testability.early_exit_paths,
  );
  if (preflightPlan) {
    warnings.push(
      'trusted changed-path preflight exited before deployment resolution, secret loading, model startup, or browser launch',
    );
    await writeFile(
      path.join(evidenceDir, 'plan.json'),
      `${JSON.stringify(preflightPlan, null, 2)}\n`,
      { mode: 0o600 },
    );
    const artifacts = await collectQaArtifacts(
      evidenceDir,
      options.config.evidence.retention_days,
      [],
      false,
      warnings,
    );
    const result = runResultBase(
      options,
      runId,
      startedAt,
      null,
      'no_testable_surface',
      warnings,
    );
    result.plan = preflightPlan;
    result.artifacts = artifacts;
    result.cost = { usage: null, usd: 0, source: 'estimated' };
    await writeQaReport(evidenceDir, result, []);
    return result;
  }
  const targetConfig: QaConfig = structuredClone(options.config);
  const resolution = await resolveTarget(options, targetConfig);
  warnings.push(...resolution.diagnostics);
  if (resolution.target && options.baseResolution === 'conservative') {
    // A conservative source range can contain older base-branch changes. Even when the live
    // deployment is proven, browser evidence cannot safely attribute a repeated failure to this
    // one PR, so findings remain advisory.
    resolution.target.verdict_eligible = false;
  }
  let secrets: Record<string, string>;
  try {
    secrets = decodeQaSecrets(options.env['JUROR_QA_SECRETS_B64']);
  } catch {
    // The bundle itself is not a usable redaction source, and parser errors can
    // echo malformed secret bytes. Persist only a fixed controller diagnostic so
    // the caller still receives a report/summary without reflecting the payload.
    warnings.push('QA runtime: JUROR_QA_SECRETS_B64 could not be decoded or validated');
    const result = runResultBase(
      options,
      runId,
      startedAt,
      resolution.target,
      'infrastructure_error',
      warnings,
    );
    await writeQaReport(evidenceDir, result, []);
    return result;
  }
  const secretValues = Object.values(secrets);
  if (!resolution.target) {
    const outcome: QaOutcome = resolution.status === 'cancelled' ? 'cancelled' : 'blocked';
    const result = runResultBase(options, runId, startedAt, null, outcome, warnings, secretValues);
    await writeQaReport(evidenceDir, result, secretValues);
    return result;
  }
  const target = resolution.target;
  const stagingAuthProblem = stagingAuthTargetProblem(targetConfig, target);
  const stagingCredentialProblem = stagingAuthSecretProblem(targetConfig, secrets);
  if (stagingAuthProblem || stagingCredentialProblem) {
    warnings.push(stagingAuthProblem ?? stagingCredentialProblem!);
    const result = runResultBase(
      options,
      runId,
      startedAt,
      target,
      'blocked',
      warnings,
      secretValues,
    );
    await writeQaReport(evidenceDir, result, secretValues);
    return result;
  }
  if (!targetConfig.sandbox.reset) {
    warnings.push(
      'trusted reset is not configured; the agent is limited to navigation, snapshots, waits, and assertions',
    );
  }
  // Reset-only or otherwise unused controller secrets never enter Playwright.
  // Suppress rich browser evidence only when the browser itself is authenticated.
  const sensitiveBrowserState = targetConfig.auth.steps.length > 0
    || targetConfig.auth.session_bootstrap !== null
    || targetConfig.auth.browser_secret_headers.length > 0
    || Boolean(options.storageStatePath);
  if (sensitiveBrowserState && [targetConfig.evidence.video, targetConfig.evidence.trace, targetConfig.evidence.screenshot].some((mode) => mode !== 'off')) {
    warnings.push('visual browser evidence was omitted because authenticated state cannot be reliably redacted from pixels or trace archives');
  }
  const scratch = await mkdtemp(path.join(tmpdir(), 'juror-qa-'));
  const socketPath = path.join(scratch, 'broker.sock');
  let broker: QaBrowserBroker | null = null;
  let rpc: Awaited<ReturnType<typeof startQaRpcServer>> | null = null;
  let browserVersion = 'unknown';
  let agent: QaAgentResult = {
    completed: false,
    finalText: '',
    usage: null,
    diagnostics: [],
    durationMs: 0,
    timedOut: false,
    exitCode: null,
    events: '',
  };
  let state: QaBrokerState = { plan: null, attempts: [], operationCount: 0, agentFinish: null };
  let cleanup: QaCleanupResult = { status: 'not_required', summary: 'No reset hook is configured.', error: null };
  let sandboxTouched = false;

  try {
    broker = new QaBrowserBroker({
      targetUrl: target.url,
      evidenceDir,
      allowedOrigins: targetConfig.sandbox.allowed_origins,
      maxScenarios: targetConfig.limits.max_scenarios,
      maxOperations: targetConfig.limits.max_browser_operations,
      timeoutMs: targetConfig.limits.timeout_seconds * 1000,
      mobileWhenRelevant: targetConfig.limits.mobile_when_relevant,
      allowMutations: Boolean(targetConfig.sandbox.reset),
      headless: options.headless ?? true,
      video: sensitiveBrowserState ? 'off' : targetConfig.evidence.video,
      trace: sensitiveBrowserState ? 'off' : targetConfig.evidence.trace,
      screenshot: sensitiveBrowserState ? 'off' : targetConfig.evidence.screenshot,
      authSteps: brokerAuthSteps(targetConfig.auth.steps),
      sessionBootstrap: brokerSessionBootstrap(targetConfig.auth.session_bootstrap),
      browserSecretHeaders: brokerSecretHeaders(targetConfig.auth.browser_secret_headers),
      secrets,
      ...(options.storageStatePath ? { storageState: options.storageStatePath } : {}),
      beforeAttempt: async (scenarioId, attempt, signal) => {
        sandboxTouched = true;
        const reset = await resetSandbox(
          targetConfig.sandbox.reset,
          target,
          secrets,
          targetConfig.sandbox.allowed_origins,
          runId,
          scenarioId,
          attempt,
          { signal },
        );
        if (reset.status === 'failed') throw new Error(reset.summary);
      },
    });
    await broker.initialize();
    browserVersion = broker.browserVersion();
    rpc = await startQaRpcServer(socketPath, (method, params) => broker?.handle(method, params) ?? Promise.reject(new Error('QA broker unavailable')));
    agent = await runQaAgent({
      repoDir: options.sourceDir,
      scratchDir: scratch,
      socketPath,
      model: targetConfig.model.id,
      reasoningEffort: targetConfig.model.reasoning_effort,
      prompt: renderQaPrompt(options, target),
      timeoutMs: targetConfig.limits.timeout_seconds * 1000,
      env: options.env,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    state = broker.state();
    warnings.push(...agent.diagnostics);
  } catch (error) {
    warnings.push(`QA runtime: ${errorMessage(error)}`);
  } finally {
    const cancelled = options.signal?.aborted ?? false;
    if (broker) browserVersion = broker.browserVersion();
    // Normal completion drains every admitted request before browser teardown.
    // Cancellation instead rejects queued calls and closes Playwright first so
    // the active operation cannot consume its full per-action timeout.
    if (rpc) {
      await rpc.close(cancelled ? {
        cancelPending: true,
        beforeDrain: () => broker?.interrupt(CANCEL_BROWSER_CLEANUP_MS) ?? Promise.resolve(),
        timeoutMs: CANCEL_RPC_CLEANUP_MS,
      } : {}).catch((error) => warnings.push(`broker socket cleanup: ${errorMessage(error)}`));
    }
    if (broker) {
      await broker.close(cancelled ? { timeoutMs: CANCEL_BROWSER_CLEANUP_MS } : {})
        .catch((error) => warnings.push(`browser cleanup: ${errorMessage(error)}`));
      // close() converts an interrupted active scenario into a controller-owned
      // blocked attempt. Capture state only after that evidence is finalized.
      state = broker.state();
    }
    const browserStarted = broker?.startedBrowser() ?? false;
    cleanup = browserStarted || sandboxTouched
      ? await resetSandbox(
          targetConfig.sandbox.reset,
          target,
          secrets,
          targetConfig.sandbox.allowed_origins,
          runId,
          undefined,
          undefined,
          cancelled ? { timeoutMs: CANCEL_RESET_CLEANUP_MS } : {},
        )
      : { status: 'not_required', summary: 'No browser or synthetic state was created.', error: null };
    if (!options.keepScratch) await rm(scratch, { recursive: true, force: true });
    else warnings.push(`QA scratch kept at ${scratch}`);
  }

  if (options.signal?.aborted) {
    warnings.push('QA execution was cancelled by the caller');
  } else {
    try {
      const current = await recheckQaTarget(
        options.client,
        {
          number: options.pull.number,
          mergeSha: options.pull.mergeCommitSha ?? options.pull.headSha,
          headSha: options.pull.headSha,
        },
        targetConfig,
        target,
        {
          ...(options.signal ? { signal: options.signal } : {}),
          readinessFallback: probeBrowserReadiness,
          allowUnreadyExplicit: Boolean(options.explicitTargetUrl && options.explicitTargetSha),
        },
      );
      target.stability = current.stable ? 'stable' : 'drifted';
      if (!current.stable) {
        warnings.push(
          current.current
            ? 'QA target changed during execution; results are blocked pending a fresh run'
            : 'QA target could not be re-verified after execution; results are blocked',
        );
      }
      warnings.push(...current.diagnostics.filter((item) => !warnings.includes(item)));
    } catch (error) {
      target.stability = 'drifted';
      warnings.push(`QA target stability check failed: ${errorMessage(error)}`);
    }
  }

  if (state.plan) {
    await writeFile(path.join(evidenceDir, 'plan.json'), JSON.stringify(state.plan, null, 2), { mode: 0o600 });
  }
  const safeAgentResult = {
    completed: agent.completed,
    exit_code: agent.exitCode,
    timed_out: agent.timedOut,
    duration_ms: agent.durationMs,
    usage: agent.usage,
    final_response: redactWith(agent.finalText, secretValues).slice(0, 16_000),
    diagnostics: agent.diagnostics.map((item) => redactWith(item, secretValues)),
  };
  await writeFile(
    path.join(evidenceDir, 'agent-result.json'),
    JSON.stringify(safeAgentResult, null, 2),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(evidenceDir, 'agent-events.ndjson'),
    redactWith(agent.events, secretValues),
    { mode: 0o600 },
  );
  if (!state.plan && safeAgentResult.final_response) {
    warnings.push(`Codex final response: ${safeAgentResult.final_response.slice(0, 2_000)}`);
  }
  const artifacts = await collectQaArtifacts(
    evidenceDir,
    targetConfig.evidence.retention_days,
    secretValues,
    sensitiveBrowserState,
    warnings,
  );
  const safeCleanup = redactQaCleanup(cleanup, secretValues);
  const outcome = classifyQaOutcome(
    state,
    target,
    agent,
    safeCleanup,
    options.signal?.aborted ?? false,
  );
  const estimatedCost = computeCost({
    pricingKey: targetConfig.model.id,
    usage: agent.usage,
    reportedCostUsd: null,
    pricing: loadPricing(),
    turns: estimateQaAgentRounds(agent.events),
  });
  if (estimatedCost.note) warnings.push(`QA cost: ${estimatedCost.note}`);
  const completedAt = Date.now();
  const result: QaRunResult = {
    schema_version: QA_SCHEMA_VERSION,
    run_id: runId,
    repository: options.client.repo,
    pr_number: options.pull.number,
    merge_sha: options.pull.mergeCommitSha ?? options.pull.headSha,
    base_resolution: options.baseResolution ?? 'exact',
    source_base_sha: options.sourceBaseSha ?? options.pull.baseSha,
    policy_base_shas: [...(options.policyBaseShas ?? [options.pull.baseSha])],
    started_at: new Date(startedAt).toISOString(),
    completed_at: new Date(completedAt).toISOString(),
    duration_ms: completedAt - startedAt,
    outcome,
    conclusion: conclusion(outcome),
    target,
    plan: redactQaPlan(state.plan, secretValues),
    attempts: convertAttempts(state, artifacts, evidenceDir, secretValues),
    issues: buildIssues(state, target, outcome, secretValues),
    cleanup: safeCleanup,
    artifacts,
    runtime: {
      model_id: targetConfig.model.id,
      model_version: null,
      browser_name: 'chromium',
      browser_version: browserVersion,
    },
    cost: { usage: agent.usage, usd: estimatedCost.usd, source: estimatedCost.source },
    warnings: boundQaWarnings(warnings, secretValues),
  };
  await writeQaReport(evidenceDir, result, secretValues);
  return result;
}
