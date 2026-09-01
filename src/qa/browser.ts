/** Trusted, budget-enforcing Playwright broker used by the QA MCP adapter. */

import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type LaunchOptions,
  type Locator,
  type Page,
} from 'playwright';

import { redactWith } from '../util/log.js';
import { isIpLiteralHostname, isLoopbackHostname } from '../util/url.js';
import { qaBrowserSecretHeaderName } from './config.js';
import { parseQaPlan } from './schema.js';
import type {
  QaBrokerOperation,
  QaCheckpointAssertion,
  QaCheckpointLocator,
  QaEvidenceMode,
  QaPlan,
} from './types.js';

export type QaViewport = 'desktop' | 'mobile';

export interface QaBrowserViewport {
  kind: QaViewport;
  width: number;
  height: number;
}

export interface QaBrokerCheckpoint {
  id: string;
  expected: string;
  assertion: QaCheckpointAssertion;
}

export interface QaBrokerScenario {
  id: string;
  title: string;
  rationale: string;
  viewport: QaBrowserViewport;
  preconditions: string[];
  checkpoints: QaBrokerCheckpoint[];
  allowedMutations: string[];
}

export interface QaBrokerPlan {
  impact_summary: string;
  affected_surfaces: string[];
  no_testable_surface: boolean;
  no_testable_reason: string | null;
  scenarios: QaBrokerScenario[];
}

export interface QaLocatorInput {
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  placeholder?: string;
  test_id?: string;
  css?: string;
  exact?: boolean;
  nth?: number;
}

export type QaAuthStep =
  | { action: 'navigate'; url: string }
  | ({ action: 'fill'; value?: string; secret?: string } & QaLocatorInput)
  | ({ action: 'click' } & QaLocatorInput)
  | ({ action: 'press'; key: string } & QaLocatorInput)
  | ({ action: 'wait'; text?: string; url_contains?: string; state?: 'visible' | 'hidden'; timeout_ms?: number } & QaLocatorInput);

export interface QaAssertionRecord {
  checkpoint: string;
  kind: 'visible' | 'hidden' | 'text' | 'url' | 'value' | 'status';
  expected: string;
  actual: string;
  passed: boolean;
  failureReason?: 'none' | 'observed_mismatch' | 'tool_error';
}

export interface QaAttemptRecord {
  scenarioId: string;
  scenarioTitle: string;
  attempt: 1 | 2;
  status: 'passed' | 'failed' | 'blocked';
  summary: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  assertions: QaAssertionRecord[];
  operations: QaBrokerOperation[];
  console: string[];
  failedRequests: string[];
  policyDenials: string[];
  operationCount: number;
  evidenceDir: string;
  /** Raw diagnostics in this record are controller-private and need a sealed public projection. */
  sensitiveOutput?: boolean;
}

export interface QaAgentIssueInput {
  title: string;
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  scenario_id: string;
  checkpoint: string;
  expected: string;
  actual: string;
}

export interface QaAgentFinish {
  summary: string;
  issues: QaAgentIssueInput[];
}

export interface QaBrokerState {
  plan: QaPlan | null;
  attempts: QaAttemptRecord[];
  operationCount: number;
  agentFinish: QaAgentFinish | null;
  /** Fixed controller-owned category; never contains browser or page error text. */
  infrastructureFailure?: 'chromium_launch_failed' | null;
}

export interface QaBrowserBrokerOptions {
  targetUrl: string;
  evidenceDir: string;
  allowedOrigins: string[];
  maxScenarios: number;
  maxOperations: number;
  timeoutMs: number;
  mobileWhenRelevant?: boolean;
  /** True only when trusted policy provides a reset hook for attempts and teardown. */
  allowMutations?: boolean;
  /** Admit semantic actions while blocking write-capable traffic after the first action. */
  allowReadOnlyInteractions?: boolean;
  headless?: boolean;
  /** Test harness escape hatch for hosts that cannot provide Chromium's Linux sandbox. */
  chromiumSandbox?: boolean;
  video?: QaEvidenceMode;
  trace?: QaEvidenceMode;
  screenshot?: QaEvidenceMode;
  authSteps?: QaAuthStep[];
  secrets?: Record<string, string>;
  /** Trusted controller endpoint that mints one fixed staging support session. */
  sessionBootstrap?: {
    url: string;
    /** Logical key into `secrets`; the raw bearer is never exposed to the browser. */
    secret: string;
    /** Exact browser origin to which the one-time redirect must resolve. */
    targetOrigin: string;
    /** Web Storage key checked in both localStorage and sessionStorage after redemption. */
    readyStorageKey: string;
  };
  /** Exact-origin headers used only to pass staging browser access gates. */
  browserSecretHeaders?: Array<{
    name: string;
    /** Logical key into `secrets`. */
    secret: string;
    origins: string[];
  }>;
  /** Trusted, controller-supplied Playwright storage state for fast local iteration. */
  storageState?: string;
  beforeAttempt?: (scenarioId: string, attempt: 1 | 2, signal: AbortSignal) => Promise<void>;
  /** @internal Browser launcher override used only by Playwright broker tests. */
  launchBrowser?: (options: LaunchOptions) => Promise<Browser>;
  /** @internal Shorter fixed setup window used only by the Playwright broker tests. */
  sensitiveSetupWindowMs?: number;
}

export interface QaBrowserCloseOptions {
  /** Bound Playwright artifact/close operations during caller cancellation. */
  timeoutMs?: number;
}

interface ActiveScenario {
  scenario: QaBrokerScenario;
  attempt: 1 | 2;
  context: BrowserContext | null;
  page: Page | null;
  /** Absorbing private state used when authenticated setup failed or timed out. */
  setupBlocked: boolean;
  startedAt: number;
  operationStart: number;
  assertions: QaAssertionRecord[];
  operations: QaBrokerOperation[];
  console: string[];
  failedRequests: string[];
  policyDenials: string[];
  /** Denials that make the exercised journey incomplete, not optional telemetry noise. */
  blockingPolicyDenials: string[];
  /** Shared with network routes so the first semantic action arms the write barrier. */
  readOnlyInteractionGuard: { armed: boolean };
  evidenceDir: string;
  tracing: boolean;
  lastNavigationStatus: number | null;
}

const MAX_SNAPSHOT_CHARS = 30_000;
const MAX_RESULT_TEXT_CHARS = 4_000;
const MAX_STORAGE_STATE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_BOOTSTRAP_RESPONSE_BYTES = 64 * 1024;
const MAX_SUPPORT_SESSION_LIFETIME_MS = 60 * 60 * 1_000;
const SUPPORT_SESSION_CLOCK_TOLERANCE_MS = 30_000;
const SENSITIVE_SETUP_WINDOW_MS = 10_000;
const SENSITIVE_SETUP_DEADLINE_MARGIN_MS = 250;
const BROWSER_LAUNCH_TIMEOUT_MS = 30_000;
const AUTH_TEXT_OMITTED = 'Authenticated browser text omitted by policy.';
const AUTH_URL_OMITTED = 'Authenticated browser URL omitted by policy.';
const AUTH_BROWSER_ERROR_OMITTED = 'Authenticated browser operation failed; page-controlled details were omitted.';
const AUTH_ASSERTION_MATCHED = 'Authenticated checkpoint matched.';
const AUTH_ASSERTION_NOT_MATCHED = 'Authenticated checkpoint did not match.';
const AUTH_CONSOLE_OMITTED = 'Browser console text omitted because authenticated state is active.';
const AUTH_NETWORK_OMITTED = 'Failed-request text omitted because authenticated state is active.';
const AUTH_POLICY_URL_OMITTED = 'A browser request was denied by the origin policy; its URL was omitted because authenticated state is active.';
const READ_ONLY_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SEALED_ATTEMPT_SUMMARY = 'Authenticated attempt completed; the controller sealed its outcome.';
const SENSITIVE_OPERATION_WINDOWS_MS: Readonly<Record<string, number>> = {
  snapshot: 250,
  navigate: 8_000,
  click: 1_000,
  fill: 1_000,
  press: 1_000,
  select: 1_000,
  check: 1_000,
  wait: 1_000,
  assert: 750,
};

function sealedAcknowledgement(): { accepted: true; observation: 'sealed' } {
  return { accepted: true, observation: 'sealed' };
}

async function padSealedOperation(name: string, startedAt: number): Promise<void> {
  const windowMs = SENSITIVE_OPERATION_WINDOWS_MS[name] ?? 1_000;
  const remaining = windowMs - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

class SafeBrokerError extends Error {}

interface NormalizedSessionBootstrap {
  url: URL;
  secret: string;
  targetOrigin: string;
  readyStorageKey: string;
}

interface NormalizedBrowserSecretHeader {
  name: string;
  lowerName: string;
  secret: string;
  origins: Set<string>;
}

async function bestEffortBeforeDeadline(
  operation: () => Promise<unknown>,
  deadline?: number,
): Promise<void> {
  if (deadline === undefined) {
    await Promise.resolve().then(operation).catch(() => {});
    return;
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) return;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(operation).catch(() => {}),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, remaining);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function launchOptions(headless: boolean, chromiumSandbox = true): LaunchOptions {
  const rawProxy = process.env['JUROR_QA_BROWSER_PROXY']?.trim();
  let proxy: LaunchOptions['proxy'] | undefined;
  if (rawProxy) {
    const url = new URL(rawProxy);
    if (url.protocol !== 'http:' || url.username || url.password) {
      throw new Error('JUROR_QA_BROWSER_PROXY must be an unauthenticated HTTP proxy URL');
    }
    proxy = { server: url.toString() };
  }
  return {
    headless,
    // The full Chromium build includes the Linux sandbox; headless-shell does not.
    channel: 'chromium',
    chromiumSandbox,
    env: qaBrowserEnvironment(),
    ...(proxy ? { proxy } : {}),
  };
}

const BROWSER_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'FONTCONFIG_PATH',
  'FONTCONFIG_FILE',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'PLAYWRIGHT_BROWSERS_PATH',
  'CHROME_DEVEL_SANDBOX',
] as const;

/** @internal Build the browser child environment without controller credentials. */
export function qaBrowserEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of BROWSER_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

/**
 * Probe through the same Chromium network stack used by the QA run. This is a
 * fallback for deployments that admit real browsers but reset generic fetch
 * clients at their edge. All subresource and WebSocket traffic is still
 * constrained to the target origin.
 */
export async function probeBrowserReadiness(
  rawUrl: string,
  timeoutMs: number,
  signal?: AbortSignal,
  expectedStatuses?: readonly number[] | null,
): Promise<boolean> {
  if (signal?.aborted) return false;
  const target = new URL(rawUrl);
  const local = isLoopbackHostname(target.hostname);
  if (target.protocol !== 'https:' && !(local && target.protocol === 'http:')) return false;
  const browser = await chromium.launch(launchOptions(true));
  const onAbort = () => { void browser.close(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', async (route) => {
      try {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.origin === target.origin || /^(?:data:|blob:|about:)/.test(requestUrl.protocol)) {
          await route.continue();
        } else {
          await route.abort('blockedbyclient');
        }
      } catch {
        await route.abort('blockedbyclient');
      }
    });
    await context.routeWebSocket('**/*', async (route) => {
      const url = new URL(route.url());
      const origin = `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`;
      if (origin === target.origin) route.connectToServer();
      else await route.close({ code: 1008, reason: 'Origin blocked by Juror QA readiness policy' });
    });
    for (let attempt = 1; attempt <= 6; attempt++) {
      const page = await context.newPage();
      try {
        const response = await page.goto(target.toString(), {
          waitUntil: 'domcontentloaded',
          timeout: Math.max(1_000, timeoutMs),
        });
        if (
          response &&
          (expectedStatuses
            ? expectedStatuses.includes(response.status())
            : response.status() >= 200 && response.status() < 400)
        ) return true;
      } catch (error) {
        if (!transientNavigationError(error) || attempt === 6) return false;
      } finally {
        await page.close().catch(() => {});
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 200));
    }
    return false;
  } catch {
    return false;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await browser.close().catch(() => {});
  }
}

function transientNavigationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /net::ERR_(?:CONNECTION_RESET|CONNECTION_CLOSED|NETWORK_CHANGED|TIMED_OUT)/.test(message);
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringOf(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value.trim();
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function boolOf(record: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${key} must be true or false`);
  return value;
}

function finiteInt(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function safeId(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'scenario';
}

function cleanUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value.slice(0, 1000);
  }
}

function isSecureOrLoopbackHttp(url: URL): boolean {
  return url.protocol === 'https:'
    || (url.protocol === 'http:' && isLoopbackHostname(url.hostname));
}

function secureEndpointUrl(raw: string, label: string): URL {
  if (!raw || raw !== raw.trim() || /[\r\n]/.test(raw)) {
    throw new Error(`${label} must be an absolute secure URL`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute secure URL`);
  }
  if (
    !isSecureOrLoopbackHttp(url)
    || !url.hostname
    || url.hostname.includes('*')
    || (url.protocol === 'https:' && isIpLiteralHostname(url.hostname))
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error(`${label} must use HTTPS (or loopback HTTP) without credentials, query, or fragment`);
  }
  return url;
}

function secureExactOrigin(raw: string, label: string): string {
  const url = secureEndpointUrl(raw, label);
  if (url.pathname !== '/') throw new Error(`${label} must be an exact origin without a path`);
  return url.origin;
}

async function readBoundedBootstrapBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_SESSION_BOOTSTRAP_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw new SafeBrokerError('Staging session response exceeded its fixed size limit');
    }
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_SESSION_BOOTSTRAP_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new SafeBrokerError('Staging session response exceeded its fixed size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(combined);
  } catch {
    throw new SafeBrokerError('Staging session response was not valid UTF-8');
  }
}

function locatorInput(record: Record<string, unknown>): QaLocatorInput {
  const input: QaLocatorInput = {};
  for (const key of ['role', 'name', 'label', 'text', 'placeholder', 'test_id', 'css'] as const) {
    const value = optionalString(record, key);
    if (value) input[key] = value;
  }
  if (typeof record['exact'] === 'boolean') input.exact = record['exact'];
  if (record['nth'] !== undefined && record['nth'] !== null) {
    input.nth = finiteInt(record['nth'], 'nth', 0, 10_000);
  }
  return input;
}

function canonicalCheckpointLocator(record: Record<string, unknown>): QaCheckpointLocator | null {
  const selectors = [
    ['role', 'role'],
    ['label', 'label'],
    ['text', 'text'],
    ['placeholder', 'placeholder'],
    ['test_id', 'test_id'],
    ['css', 'css'],
  ] as const;
  const selected = selectors.flatMap(([key, by]) => {
    const value = optionalString(record, key);
    return value ? [{ by, value }] : [];
  });
  if (selected.length > 1) throw new Error('An assertion must provide exactly one planned locator strategy');
  if (selected.length === 0) {
    if (optionalString(record, 'name')) throw new Error('A locator name requires a role locator');
    return null;
  }
  const { by, value } = selected[0]!;
  const name = optionalString(record, 'name') ?? null;
  if (by !== 'role' && name !== null) throw new Error('A locator name is valid only for a role locator');
  return {
    by,
    value,
    name,
    exact: boolOf(record, 'exact', false),
    nth: record['nth'] === undefined || record['nth'] === null
      ? null
      : finiteInt(record['nth'], 'nth', 0, 10_000),
  };
}

function assertionMatches(
  planned: QaCheckpointAssertion,
  actual: QaCheckpointAssertion,
): boolean {
  return JSON.stringify(planned) === JSON.stringify(actual);
}

export class QaBrowserBroker {
  readonly #options: QaBrowserBrokerOptions;
  readonly #target: URL;
  readonly #allowedOrigins: Set<string>;
  readonly #secretValues: string[];
  readonly #sessionBootstrap: NormalizedSessionBootstrap | null;
  readonly #browserSecretHeaders: NormalizedBrowserSecretHeader[];
  readonly #sensitiveBrowserState: boolean;
  readonly #startedAt = Date.now();
  readonly #interruptController = new AbortController();
  #browser: Browser | null = null;
  #browserStarted = false;
  #infrastructureFailure: QaBrokerState['infrastructureFailure'] = null;
  #pendingSetupContext: BrowserContext | null = null;
  #storageState: string | undefined;
  #plan: QaBrokerPlan | null = null;
  #persistedPlan: QaPlan | null = null;
  #active: ActiveScenario | null = null;
  #attempts: QaAttemptRecord[] = [];
  readonly #setupAdmissions = new Set<string>();
  /** Exact one-time login URLs stay registered after first use so browser retries are aborted. */
  readonly #oneTimeBootstrapAdmissions = new Map<string, 'pending' | 'consumed'>();
  #operationCount = 0;
  #agentFinish: QaAgentFinish | null = null;

  constructor(options: QaBrowserBrokerOptions) {
    this.#options = options;
    this.#target = new URL(options.targetUrl);
    if (this.#target.protocol !== 'https:' && !isLoopbackHostname(this.#target.hostname)) {
      throw new Error('QA target must use HTTPS unless it is localhost');
    }
    this.#allowedOrigins = new Set([this.#target.origin]);
    for (const raw of options.allowedOrigins) this.#allowedOrigins.add(new URL(raw).origin);
    this.#sessionBootstrap = null;
    if (options.sessionBootstrap) {
      const url = secureEndpointUrl(options.sessionBootstrap.url, 'QA session bootstrap URL');
      const targetOrigin = secureExactOrigin(
        options.sessionBootstrap.targetOrigin,
        'QA session bootstrap target origin',
      );
      if (targetOrigin !== this.#target.origin) {
        throw new Error('QA target origin must exactly match the session bootstrap target origin');
      }
      if (!this.#allowedOrigins.has(url.origin)) {
        throw new Error('QA session bootstrap URL origin must be explicitly allowlisted');
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.sessionBootstrap.secret)) {
        throw new Error('QA session bootstrap secret must be an environment-style logical reference');
      }
      if (
        options.sessionBootstrap.readyStorageKey.length < 1
        || options.sessionBootstrap.readyStorageKey.length > 128
        || !/^[\x21-\x7e]+$/.test(options.sessionBootstrap.readyStorageKey)
      ) {
        throw new Error('QA session bootstrap ready storage key must contain 1-128 visible ASCII characters');
      }
      this.#sessionBootstrap = {
        url,
        secret: options.sessionBootstrap.secret,
        targetOrigin,
        readyStorageKey: options.sessionBootstrap.readyStorageKey,
      };
    }
    this.#browserSecretHeaders = [];
    if ((options.browserSecretHeaders?.length ?? 0) > 20) {
      throw new Error('QA browser secret headers must contain at most 20 entries');
    }
    const headerBindings = new Set<string>();
    for (const header of options.browserSecretHeaders ?? []) {
      const name = qaBrowserSecretHeaderName(header.name);
      if (!name) {
        throw new Error('QA browser secret header names must be X-* HTTP token names or standard Cloudflare Access service-token headers');
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(header.secret)) {
        throw new Error('QA browser header secret must be an environment-style logical reference');
      }
      if (!Array.isArray(header.origins) || header.origins.length < 1 || header.origins.length > 10) {
        throw new Error('QA browser secret header must list 1-10 exact origins');
      }
      const origins = new Set(header.origins.map((origin) =>
        secureExactOrigin(origin, 'QA browser secret header origin')));
      for (const origin of origins) {
        if (!this.#allowedOrigins.has(origin)) {
          throw new Error('QA browser secret header origin must be explicitly allowlisted');
        }
        if (origin !== this.#target.origin) {
          throw new Error('QA browser secret header origin must exactly match the QA target origin');
        }
        const binding = `${name.toLowerCase()}\n${origin}`;
        if (headerBindings.has(binding)) {
          throw new Error('QA browser secret header has a duplicate name and origin binding');
        }
        headerBindings.add(binding);
      }
      this.#browserSecretHeaders.push({
        name,
        lowerName: name.toLowerCase(),
        secret: header.secret,
        origins,
      });
    }
    this.#secretValues = [
      ...Object.values(options.secrets ?? {}),
      ...(options.authSteps ?? []).flatMap((step) =>
        step.action === 'fill' && step.value !== undefined ? [step.value] : []),
    ].filter((value) => value.length >= 1);
    this.#sensitiveBrowserState = (options.authSteps?.length ?? 0) > 0
      || this.#sessionBootstrap !== null
      || this.#browserSecretHeaders.length > 0
      || Boolean(options.storageState);
    this.#storageState = options.storageState;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#options.evidenceDir, { recursive: true });
    if (this.#storageState) {
      const storageState = await lstat(this.#storageState).catch(() => null);
      if (
        !storageState
        || !storageState.isFile()
        || storageState.isSymbolicLink()
        || storageState.size > MAX_STORAGE_STATE_FILE_BYTES
      ) {
        throw new Error('Playwright storage state must be a regular file no larger than 4 MiB');
      }
    }
  }

  async #ensureBrowser(timeoutMs?: number): Promise<void> {
    if (this.#browser) return;
    if (this.#infrastructureFailure === 'chromium_launch_failed') {
      throw new SafeBrokerError('Chromium could not start on the QA runner');
    }
    this.#throwIfInterrupted();
    this.#browserStarted = true;
    let browser: Browser;
    try {
      const launchBrowser = this.#options.launchBrowser
        ?? ((options: LaunchOptions) => chromium.launch(options));
      browser = await launchBrowser({
        ...launchOptions(
          this.#options.headless ?? true,
          this.#options.chromiumSandbox ?? true,
        ),
        ...(timeoutMs === undefined ? {} : { timeout: Math.max(1, timeoutMs) }),
      });
    } catch {
      this.#infrastructureFailure = 'chromium_launch_failed';
      throw new SafeBrokerError('Chromium could not start on the QA runner');
    }
    if (this.#interruptController.signal.aborted) {
      await browser.close().catch(() => {});
      this.#throwIfInterrupted();
    }
    this.#browser = browser;
  }

  state(): QaBrokerState {
    return {
      plan: this.#persistedPlan ? structuredClone(this.#persistedPlan) : null,
      attempts: structuredClone(this.#attempts),
      operationCount: this.#operationCount,
      agentFinish: this.#agentFinish ? structuredClone(this.#agentFinish) : null,
      infrastructureFailure: this.#infrastructureFailure,
    };
  }

  browserVersion(): string {
    return this.#browser?.version() ?? 'unknown';
  }

  startedBrowser(): boolean {
    return this.#browserStarted;
  }

  async handle(method: string, params: unknown): Promise<unknown> {
    this.#throwIfInterrupted();
    this.#checkTime();
    try {
      switch (method) {
        case 'qa_status': return this.#status();
        case 'submit_plan': return this.#submitPlan(params);
        case 'start_scenario': return await this.#startScenario(params);
        case 'snapshot': return await this.#browserOperation('snapshot', params, (active) => this.#snapshot(active));
        case 'navigate': return await this.#browserOperation('navigate', params, (active) => this.#navigate(params, active));
        case 'click': return await this.#browserOperation('click', params, (active) => this.#click(params, active));
        case 'fill': return await this.#browserOperation('fill', params, (active) => this.#fill(params, active));
        case 'press': return await this.#browserOperation('press', params, (active) => this.#press(params, active));
        case 'select': return await this.#browserOperation('select', params, (active) => this.#select(params, active));
        case 'check': return await this.#browserOperation('check', params, (active) => this.#check(params, active));
        case 'wait': return await this.#browserOperation('wait', params, (active) => this.#wait(params, active));
        case 'assert': return await this.#browserOperation('assert', params, (active) => this.#assert(params, active));
        case 'finish_scenario': return await this.#finishScenario(params);
        case 'finish': return this.#finish(params);
        default: throw new Error(`Unknown QA broker method ${JSON.stringify(method)}`);
      }
    } catch (error) {
      if (method === 'start_scenario' && this.#sensitiveBrowserState) {
        if (this.#interruptController.signal.aborted) this.#throwIfInterrupted();
        throw new Error(AUTH_BROWSER_ERROR_OMITTED);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(this.#redact(message));
    }
  }

  async interrupt(timeoutMs = 2_000): Promise<void> {
    this.#interruptController.abort();
    const activeContext = this.#active?.context;
    const pendingSetupContext = this.#pendingSetupContext;
    const browser = this.#browser;
    const deadline = Date.now() + Math.max(1, timeoutMs);
    await bestEffortBeforeDeadline(
      async () => {
        await Promise.allSettled([
          activeContext?.close(),
          pendingSetupContext?.close(),
          browser?.close(),
        ]);
      },
      deadline,
    );
    if (this.#browser === browser) this.#browser = null;
  }

  async close(options: QaBrowserCloseOptions = {}): Promise<void> {
    const deadline = options.timeoutMs === undefined
      ? undefined
      : Date.now() + Math.max(1, options.timeoutMs);
    if (this.#active) {
      await this.#closeActive(
        'blocked',
        'Controller closed the active scenario.',
        deadline,
      ).catch(() => {});
    }
    const browser = this.#browser;
    await bestEffortBeforeDeadline(() => browser?.close() ?? Promise.resolve(), deadline);
    this.#browser = null;
  }

  #redact(value: string): string {
    return redactWith(value, this.#secretValues);
  }

  #checkTime(): void {
    if (Date.now() - this.#startedAt > this.#options.timeoutMs) {
      throw new Error('QA execution exceeded its wall-clock budget');
    }
  }

  #throwIfInterrupted(): void {
    if (this.#interruptController.signal.aborted) {
      throw new Error('QA browser broker was interrupted by caller cancellation');
    }
  }

  #status(): unknown {
    return {
      target: this.#target.toString(),
      plan_submitted: this.#plan !== null,
      active_scenario: this.#active
        ? { id: this.#active.scenario.id, attempt: this.#active.attempt }
        : null,
      scenarios_started: new Set(this.#attempts.map((attempt) => attempt.scenarioId)).size,
      operations_used: this.#operationCount,
      operations_remaining: Math.max(0, this.#options.maxOperations - this.#operationCount),
      max_scenarios: this.#options.maxScenarios,
      interactive_actions_allowed: Boolean(
        this.#options.allowMutations || this.#options.allowReadOnlyInteractions,
      ),
      mutating_actions_allowed: Boolean(this.#options.allowMutations),
      interaction_policy: this.#options.allowMutations
        ? 'resettable'
        : this.#options.allowReadOnlyInteractions ? 'read_only' : 'disabled',
      browser_output_policy: this.#sensitiveBrowserState
        ? 'sealed_authenticated_checkpoints'
        : 'sanitized_browser_observations',
      attempts: this.#attempts.map((attempt) => this.#sensitiveBrowserState
        ? {
            scenario_id: attempt.scenarioId,
            attempt: attempt.attempt,
            outcome: 'sealed',
          }
        : {
            scenario_id: attempt.scenarioId,
            attempt: attempt.attempt,
            status: attempt.status,
            failed_checkpoints: attempt.assertions.filter((item) => !item.passed).map((item) => item.checkpoint),
          }),
    };
  }

  #submitPlan(params: unknown): unknown {
    if (this.#plan) throw new Error('The QA plan has already been submitted');
    this.#persistedPlan = parseQaPlan(params, {
      max_scenarios: Math.min(this.#options.maxScenarios, 6),
      max_checkpoints_per_scenario: 20,
    });
    if (!this.#options.mobileWhenRelevant && this.#persistedPlan.scenarios.some((scenario) => scenario.viewport.kind === 'mobile')) {
      this.#persistedPlan = null;
      throw new Error('The trusted QA policy does not allow mobile scenarios');
    }
    if (!this.#options.allowMutations && this.#persistedPlan.scenarios.some(
      (scenario) => scenario.allowed_mutations.some((mutation) => mutation !== 'none'),
    )) {
      this.#persistedPlan = null;
      throw new Error('The trusted QA policy has no reset hook, so mutating scenarios are not allowed');
    }
    const twoAttemptMinimum = this.#persistedPlan.scenarios.reduce(
      // Each prompt-mandated attempt needs one navigation, one snapshot, and
      // every accepted checkpoint assertion.
      (total, scenario) => total + (2 * (2 + scenario.checkpoints.length)),
      0,
    );
    if (twoAttemptMinimum > this.#options.maxOperations) {
      this.#persistedPlan = null;
      throw new Error(
        `The accepted plan needs at least ${twoAttemptMinimum} browser operations for two navigations, snapshots, and every checkpoint; the trusted budget allows ${this.#options.maxOperations}`,
      );
    }
    this.#plan = {
      impact_summary: this.#persistedPlan.impact_assessment,
      affected_surfaces: this.#persistedPlan.surfaces,
      no_testable_surface: this.#persistedPlan.testability === 'no_testable_surface',
      no_testable_reason: this.#persistedPlan.no_testable_surface_reason,
      scenarios: this.#persistedPlan.scenarios.map((scenario) => ({
        id: scenario.id,
        title: scenario.title,
        rationale: scenario.rationale,
        viewport: {
          kind: scenario.viewport.kind,
          width: scenario.viewport.width,
          height: scenario.viewport.height,
        },
        preconditions: scenario.preconditions,
        checkpoints: scenario.checkpoints.map((checkpoint) => ({
          id: checkpoint.id,
          expected: checkpoint.expected,
          assertion: structuredClone(checkpoint.assertion),
        })),
        allowedMutations: scenario.allowed_mutations,
      })),
    };
    return {
      accepted: true,
      no_testable_surface: this.#plan.no_testable_surface,
      scenario_ids: this.#plan.scenarios.map((scenario) => scenario.id),
      browser_unlocked: !this.#plan.no_testable_surface,
    };
  }

  async #startScenario(params: unknown): Promise<unknown> {
    if (!this.#plan) throw new Error('Submit a valid QA plan before using the browser');
    if (this.#plan.no_testable_surface) throw new Error('The accepted plan has no testable browser surface');
    if (this.#active) throw new Error('Finish the active scenario before starting another');
    const value = recordOf(params, 'start_scenario input');
    const scenarioId = stringOf(value, 'scenario_id');
    const attempt = finiteInt(value['attempt'], 'attempt', 1, 2) as 1 | 2;
    const scenario = this.#plan.scenarios.find((candidate) => candidate.id === scenarioId);
    if (!scenario) throw new Error(`Scenario ${JSON.stringify(scenarioId)} is not in the accepted plan`);

    const previous = this.#attempts.filter((item) => item.scenarioId === scenarioId);
    const admissionKey = `${scenarioId}:${attempt}`;
    if (attempt === 1 && previous.length > 0) throw new Error(`Scenario ${scenarioId} already has an initial attempt`);
    if (attempt === 2) {
      const first = previous.find((item) => item.attempt === 1);
      if (!first || (!this.#sensitiveBrowserState && first.status !== 'failed')) {
        throw new Error(this.#sensitiveBrowserState
          ? 'Attempt 2 is allowed only after the sealed initial attempt is complete'
          : 'Attempt 2 is allowed only after a failed initial attempt');
      }
      if (previous.some((item) => item.attempt === 2)) throw new Error(`Scenario ${scenarioId} already has a retry`);
    }
    if (this.#setupAdmissions.has(admissionKey)) {
      throw new Error(`Scenario ${scenarioId} attempt ${attempt} setup has already been admitted`);
    }

    // Admission is consumed before reset, browser launch, context creation, or
    // authentication. A failing setup cannot be replayed indefinitely against
    // a real login or reset endpoint.
    const setupWindowMs = this.#sensitiveSetupWindowMs();
    if (this.#sensitiveBrowserState) {
      const remainingRunMs = this.#options.timeoutMs - (Date.now() - this.#startedAt);
      if (remainingRunMs < setupWindowMs + SENSITIVE_SETUP_DEADLINE_MARGIN_MS) {
        throw new Error('The remaining QA run budget cannot cover one sealed scenario setup window');
      }
    }
    this.#setupAdmissions.add(admissionKey);
    const evidenceDir = path.join(
      this.#options.evidenceDir,
      'scenarios',
      safeId(scenarioId),
      `attempt-${attempt}`,
    );
    await mkdir(evidenceDir, { recursive: true });

    if (!this.#sensitiveBrowserState) {
      this.#active = await this.#prepareScenario(
        scenario,
        attempt,
        evidenceDir,
        this.#interruptController.signal,
      );
      return { started: true, scenario_id: scenario.id, attempt, viewport: scenario.viewport };
    }

    // Chromium startup is credential-free and page-independent, so it does not
    // belong inside the constant-time authentication envelope. DinD runners can
    // legitimately need longer than that envelope to launch a healthy browser.
    // Keep launch bounded by both its own cap and the remaining overall run budget.
    const browserLaunchBudgetMs = Math.min(
      BROWSER_LAUNCH_TIMEOUT_MS,
      this.#options.timeoutMs - (Date.now() - this.#startedAt)
        - setupWindowMs - SENSITIVE_SETUP_DEADLINE_MARGIN_MS,
    );
    if (browserLaunchBudgetMs < 1) {
      throw new SafeBrokerError('The remaining QA run budget cannot start Chromium and authenticate safely');
    }
    await this.#ensureBrowser(browserLaunchBudgetMs);
    const remainingRunMs = this.#options.timeoutMs - (Date.now() - this.#startedAt);
    if (remainingRunMs < setupWindowMs + SENSITIVE_SETUP_DEADLINE_MARGIN_MS) {
      throw new SafeBrokerError('Chromium startup left too little QA run budget for sealed authentication');
    }

    const setupStartedAt = Date.now();
    const setupDeadlineAt = setupStartedAt + setupWindowMs - SENSITIVE_SETUP_DEADLINE_MARGIN_MS;
    const setupController = new AbortController();
    const forwardCancellation = () => setupController.abort();
    this.#interruptController.signal.addEventListener('abort', forwardCancellation, { once: true });
    let deadline: NodeJS.Timeout | undefined;
    try {
      this.#active = await Promise.race([
        this.#prepareScenario(
          scenario,
          attempt,
          evidenceDir,
          setupController.signal,
          setupDeadlineAt,
          setupStartedAt,
        ),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => {
            setupController.abort();
            void this.#pendingSetupContext?.close().catch(() => {});
            reject(new SafeBrokerError('Authenticated scenario setup exceeded its sealed deadline'));
          }, setupWindowMs - SENSITIVE_SETUP_DEADLINE_MARGIN_MS);
        }),
      ]);
    } catch {
      setupController.abort();
      await bestEffortBeforeDeadline(
        () => this.#pendingSetupContext?.close() ?? Promise.resolve(),
        setupStartedAt + setupWindowMs - 50,
      );
      if (this.#interruptController.signal.aborted) this.#throwIfInterrupted();
      this.#active = this.#blockedSetupScenario(scenario, attempt, evidenceDir, setupStartedAt);
    } finally {
      if (deadline) clearTimeout(deadline);
      this.#interruptController.signal.removeEventListener('abort', forwardCancellation);
    }
    const remaining = setupWindowMs - (Date.now() - setupStartedAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    return sealedAcknowledgement();
  }

  #sensitiveSetupWindowMs(): number {
    const configured = this.#options.sensitiveSetupWindowMs ?? SENSITIVE_SETUP_WINDOW_MS;
    if (!Number.isInteger(configured) || configured < 1_000 || configured > SENSITIVE_SETUP_WINDOW_MS) {
      throw new Error(`sensitiveSetupWindowMs must be an integer from 1000 to ${SENSITIVE_SETUP_WINDOW_MS}`);
    }
    return configured;
  }

  #blockedSetupScenario(
    scenario: QaBrokerScenario,
    attempt: 1 | 2,
    evidenceDir: string,
    startedAt: number,
  ): ActiveScenario {
    return {
      scenario,
      attempt,
      context: null,
      page: null,
      setupBlocked: true,
      startedAt,
      operationStart: this.#operationCount,
      assertions: [],
      operations: [],
      console: [],
      failedRequests: [],
      policyDenials: ['Authenticated scenario setup was blocked; details were sealed by policy.'],
      blockingPolicyDenials: ['Authenticated scenario setup was blocked.'],
      readOnlyInteractionGuard: { armed: false },
      evidenceDir,
      tracing: false,
      lastNavigationStatus: null,
    };
  }

  async #prepareScenario(
    scenario: QaBrokerScenario,
    attempt: 1 | 2,
    evidenceDir: string,
    signal: AbortSignal,
    setupDeadlineAt?: number,
    publicStartedAt?: number,
  ): Promise<ActiveScenario> {
    await this.#options.beforeAttempt?.(scenario.id, attempt, signal);
    if (signal.aborted) throw new SafeBrokerError('Scenario setup was cancelled');
    await this.#ensureBrowser(setupDeadlineAt === undefined ? undefined : setupDeadlineAt - Date.now());
    if (signal.aborted) throw new SafeBrokerError('Scenario setup was cancelled');
    const policyDenials: string[] = [];
    const blockingPolicyDenials: string[] = [];
    const readOnlyInteractionGuard = { armed: false };
    let context: BrowserContext | null = null;
    try {
      context = await this.#newContext(
        scenario.viewport,
        !this.#sensitiveBrowserState && (this.#options.video ?? 'all') !== 'off',
        evidenceDir,
        policyDenials,
        blockingPolicyDenials,
        readOnlyInteractionGuard,
      );
      this.#pendingSetupContext = context;
      if (signal.aborted) throw new SafeBrokerError('Scenario setup was cancelled');
      const tracing = !this.#sensitiveBrowserState && (this.#options.trace ?? 'failure') !== 'off';
      if (tracing) {
        await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      }
      const page = await context.newPage();
      const consoleMessages: string[] = [];
      const failedRequests: string[] = [];
      page.on('console', (message) => {
        if (consoleMessages.length >= 200) return;
        if (this.#sensitiveBrowserState) {
          if (!consoleMessages.includes(AUTH_CONSOLE_OMITTED)) consoleMessages.push(AUTH_CONSOLE_OMITTED);
        } else {
          consoleMessages.push(this.#redact(`${message.type()}: ${message.text()}`));
        }
      });
      page.on('pageerror', (error) => {
        if (consoleMessages.length >= 200) return;
        if (this.#sensitiveBrowserState) {
          if (!consoleMessages.includes(AUTH_CONSOLE_OMITTED)) consoleMessages.push(AUTH_CONSOLE_OMITTED);
        } else {
          consoleMessages.push(this.#redact(`pageerror: ${error.message}`));
        }
      });
      page.on('requestfailed', (request) => {
        if (failedRequests.length >= 200) return;
        if (this.#sensitiveBrowserState) {
          if (!failedRequests.includes(AUTH_NETWORK_OMITTED)) failedRequests.push(AUTH_NETWORK_OMITTED);
        } else {
          failedRequests.push(this.#redact(`${request.method()} ${cleanUrl(request.url())}: ${request.failure()?.errorText ?? 'failed'}`));
        }
      });

      // Authenticate inside the attempt context. This avoids serializing
      // unbounded page-controlled IndexedDB state and preserves all browser
      // state naturally for the scenario that immediately follows.
      await this.#runAuthRecipe(page, signal);
      if (signal.aborted) throw new SafeBrokerError('Scenario setup was cancelled');

      return {
        scenario,
        attempt,
        context,
        page,
        setupBlocked: false,
        // For sensitive state, expose only the controller admission time. Raw
        // authentication completion timing stays private.
        startedAt: publicStartedAt ?? Date.now(),
        operationStart: this.#operationCount,
        assertions: [],
        operations: [],
        console: consoleMessages,
        failedRequests,
        policyDenials,
        blockingPolicyDenials,
        readOnlyInteractionGuard,
        evidenceDir,
        tracing,
        lastNavigationStatus: null,
      };
    } catch (error) {
      await context?.close().catch(() => {});
      if (error instanceof SafeBrokerError) throw error;
      throw error;
    } finally {
      if (this.#pendingSetupContext === context) this.#pendingSetupContext = null;
    }
  }

  async #newContext(
    viewport: QaBrowserViewport,
    video: boolean,
    evidenceDir?: string,
    policyDenials?: string[],
    blockingPolicyDenials?: string[],
    readOnlyInteractionGuard?: { armed: boolean },
  ): Promise<BrowserContext> {
    if (!this.#browser) throw new Error('QA browser is not initialized');
    const browserSecretHeaders = this.#browserSecretHeaders.map((header) => {
      const value = this.#options.secrets?.[header.secret];
      if (!value) throw new SafeBrokerError('A required staging browser credential is unavailable');
      return { ...header, value };
    });
    const secretHeaderNames = new Set(browserSecretHeaders.map((header) => header.lowerName));
    const size = { width: viewport.width, height: viewport.height };
    const context = await this.#browser.newContext({
      baseURL: this.#target.toString(),
      viewport: size,
      serviceWorkers: 'block',
      acceptDownloads: false,
      ...(this.#storageState ? { storageState: this.#storageState } : {}),
      ...(video && evidenceDir ? { recordVideo: { dir: evidenceDir, size } } : {}),
    });
    await context.route('**/*', async (route) => {
      const raw = route.request().url();
      const fetchSingleHop = async (headers?: Record<string, string>): Promise<void> => {
        try {
          const response = await route.fetch({
            ...(headers ? { headers } : {}),
            maxRedirects: 0,
            maxRetries: 0,
          });
          await route.fulfill({ response });
        } catch {
          // Convert controller-side fetch failures into an ordinary browser
          // request failure without letting a rejected route handler escape.
          await route.abort('failed').catch(() => {});
        }
      };
      const oneTimeAdmission = this.#oneTimeBootstrapAdmissions.get(raw);
      if (oneTimeAdmission === 'consumed') {
        await route.abort('blockedbyclient');
        return;
      }
      if (oneTimeAdmission === 'pending') {
        // Consume before the first await. Chromium may retry a reset navigation,
        // but no second request carrying this one-time token may reach the wire.
        this.#oneTimeBootstrapAdmissions.set(raw, 'consumed');
      }
      const forceSingleNetworkAttempt = oneTimeAdmission === 'pending';
      if (!this.#urlAllowed(raw)) {
        if (policyDenials && policyDenials.length < 200) {
          policyDenials.push(this.#sensitiveBrowserState
            ? AUTH_POLICY_URL_OMITTED
            : this.#redact(`HTTP ${cleanUrl(raw)} was denied by the origin policy`));
        }
        await route.abort('blockedbyclient');
      } else {
        const requestMethod = route.request().method().toUpperCase();
        if (
          readOnlyInteractionGuard?.armed
          && !READ_ONLY_HTTP_METHODS.has(requestMethod)
        ) {
          const denial = this.#sensitiveBrowserState
            ? 'A write-capable browser request was denied by the read-only interaction policy.'
            : this.#redact(
              `${requestMethod} ${cleanUrl(raw)} was denied by the read-only interaction policy`,
            );
          if (policyDenials && policyDenials.length < 200) policyDenials.push(denial);
          if (blockingPolicyDenials && blockingPolicyDenials.length < 200) {
            blockingPolicyDenials.push(denial);
          }
          await route.abort('blockedbyclient');
          return;
        }
        if (browserSecretHeaders.length === 0) {
          if (forceSingleNetworkAttempt) {
            await fetchSingleHop();
          } else {
            await route.continue();
          }
          return;
        }
        const requestUrl = new URL(raw);
        const headers = { ...route.request().headers() };
        // Playwright header overrides can otherwise survive an HTTP redirect.
        // Strip every protected name first, then add back only bindings for the
        // exact current request origin.
        let strippedProtectedHeader = false;
        for (const name of Object.keys(headers)) {
          if (secretHeaderNames.has(name.toLowerCase())) {
            delete headers[name];
            strippedProtectedHeader = true;
          }
        }
        let credentialed = false;
        for (const header of browserSecretHeaders) {
          if (header.origins.has(requestUrl.origin)) {
            headers[header.name] = header.value;
            credentialed = true;
          }
        }
        if (credentialed || strippedProtectedHeader || forceSingleNetworkAttempt) {
          // `route.continue({ headers })` applies overrides to every redirect
          // hop. Fetch exactly one protected-header hop, then let Chromium
          // issue the next request through this origin policy again. Ordinary
          // uncredentialed traffic remains streaming instead of being buffered.
          await fetchSingleHop(headers);
        } else {
          await route.continue();
        }
      }
    });
    await context.routeWebSocket('**/*', async (route) => {
      if (!this.#urlAllowed(route.url())) {
        if (policyDenials && policyDenials.length < 200) {
          policyDenials.push(this.#sensitiveBrowserState
            ? AUTH_POLICY_URL_OMITTED
            : this.#redact(`WebSocket ${cleanUrl(route.url())} was denied by the origin policy`));
        }
        await route.close({ code: 1008, reason: 'Origin blocked by Juror QA policy' });
      } else {
        const server = route.connectToServer();
        if (readOnlyInteractionGuard) {
          route.onMessage((message) => {
            if (!readOnlyInteractionGuard.armed) {
              server.send(message);
              return;
            }
            const denial = 'An outbound WebSocket message was denied by the read-only interaction policy.';
            if (policyDenials && policyDenials.length < 200) policyDenials.push(denial);
            if (blockingPolicyDenials && blockingPolicyDenials.length < 200) {
              blockingPolicyDenials.push(denial);
            }
          });
        }
      }
    });
    return context;
  }

  #urlAllowed(raw: string): boolean {
    if (/^(?:about:blank|data:|blob:)/.test(raw)) return true;
    try {
      const url = new URL(raw);
      const websocket = url.protocol === 'wss:' || url.protocol === 'ws:';
      const effectiveProtocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
      const effectiveOrigin = `${effectiveProtocol}//${url.host}`;
      const secure = effectiveProtocol === 'https:';
      const localHttp = effectiveProtocol === 'http:' && isLoopbackHostname(url.hostname);
      return (secure || localHttp) && this.#allowedOrigins.has(websocket ? effectiveOrigin : url.origin);
    } catch {
      return false;
    }
  }

  #topLevelUrlAllowed(raw: string): boolean {
    try {
      const url = new URL(raw);
      const secure = url.protocol === 'https:';
      const localHttp = url.protocol === 'http:' && isLoopbackHostname(url.hostname);
      return (secure || localHttp) && !url.username && !url.password && this.#allowedOrigins.has(url.origin);
    } catch {
      return false;
    }
  }

  #page(expected?: ActiveScenario): Page {
    if (!this.#plan) throw new Error('Submit a valid QA plan before using the browser');
    if (!this.#active) throw new Error('Start a scenario before using the browser');
    if (expected && this.#active !== expected) {
      throw new SafeBrokerError('A completed browser operation cannot access a later scenario');
    }
    const active = expected ?? this.#active;
    if (!active.page) throw new Error(AUTH_BROWSER_ERROR_OMITTED);
    return active.page;
  }

  async #browserOperation(
    name: string,
    params: unknown,
    operation: (active: ActiveScenario) => Promise<unknown>,
  ): Promise<unknown> {
    if (!this.#plan) throw new Error('Submit a valid QA plan before using the browser');
    if (!this.#active) throw new Error('Start a scenario before using the browser');
    if (this.#operationCount >= this.#options.maxOperations) {
      throw new Error(`QA browser operation budget exhausted at ${this.#options.maxOperations}`);
    }
    const active = this.#active;
    this.#operationCount++;
    const sequence = this.#operationCount;
    const startedAt = Date.now();
    const safeParams = recordOf(params, `${name} input`);
    const ledgerParams = { ...safeParams };
    if ('value' in ledgerParams && name === 'fill') ledgerParams['value'] = '[input omitted]';
    let sealedDeadline: NodeJS.Timeout | undefined;
    const finalize = async (status: QaBrokerOperation['status'], error: string | null): Promise<void> => {
      const record: QaBrokerOperation = {
        sequence,
        action: this.#operationAction(name),
        summary: this.#redact(`${name} ${JSON.stringify(ledgerParams)}`).slice(0, 2_000),
        status,
        started_at: new Date(startedAt).toISOString(),
        duration_ms: Date.now() - startedAt,
        error: error ? this.#redact(error).slice(0, 2_000) : null,
      };
      active.operations.push(record);
      await this.#appendLedger(active, record);
    };
    try {
      if (active.setupBlocked) {
        if (name === 'assert') this.#recordBlockedSetupAssertion(params, active);
        throw new SafeBrokerError(AUTH_BROWSER_ERROR_OMITTED);
      }
      const result = await (this.#sensitiveBrowserState
        ? Promise.race([
            operation(active),
            new Promise<never>((_resolve, reject) => {
              const responseWindow = SENSITIVE_OPERATION_WINDOWS_MS[name] ?? 1_000;
              sealedDeadline = setTimeout(() => {
                // Close the page to terminate Playwright work that outlived its
                // category-fixed response window. The attempt ledger, not this
                // fixed response, records the infrastructure failure.
                void active.page?.close({ runBeforeUnload: false }).catch(() => {});
                reject(new Error(AUTH_BROWSER_ERROR_OMITTED));
              }, Math.max(1, responseWindow - 100));
            }),
          ])
        : operation(active));
      if (sealedDeadline) {
        clearTimeout(sealedDeadline);
        sealedDeadline = undefined;
      }
      if (!this.#topLevelUrlAllowed(this.#page(active).url())) {
        throw new Error('Browser operation ended outside an allowlisted HTTP(S) origin');
      }
      await finalize('succeeded', null);
      if (this.#sensitiveBrowserState) await padSealedOperation(name, startedAt);
      return this.#sensitiveBrowserState ? sealedAcknowledgement() : result;
    } catch (error) {
      if (sealedDeadline) {
        clearTimeout(sealedDeadline);
        sealedDeadline = undefined;
      }
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = this.#sensitiveBrowserState
        ? AUTH_BROWSER_ERROR_OMITTED
        : this.#redact(rawMessage);
      const denied = /(?:allowlist|not authorize|denied|blocked by .*policy)/i.test(rawMessage);
      await finalize(denied ? 'denied' : 'failed', message);
      if (this.#sensitiveBrowserState) {
        await padSealedOperation(name, startedAt);
        return sealedAcknowledgement();
      }
      throw new Error(message);
    } finally {
      if (sealedDeadline) clearTimeout(sealedDeadline);
    }
  }

  #operationAction(name: string): QaBrokerOperation['action'] {
    if (name === 'snapshot') return 'inspect_text';
    if (name === 'assert') return 'checkpoint';
    if (name === 'check') return 'click';
    return name as QaBrokerOperation['action'];
  }

  #recordBlockedSetupAssertion(params: unknown, active: ActiveScenario): void {
    const value = recordOf(params, 'assert input');
    const checkpoint = stringOf(value, 'checkpoint');
    const plannedCheckpoint = active.scenario.checkpoints.find((item) => item.id === checkpoint);
    if (!plannedCheckpoint) return;
    if (active.assertions.some((assertion) => assertion.checkpoint === checkpoint)) return;
    const kind = stringOf(value, 'kind') as QaAssertionRecord['kind'];
    const expected = stringOf(value, 'expected');
    const runtimeAssertion: QaCheckpointAssertion = {
      kind,
      locator: canonicalCheckpointLocator(value),
      url_contains: optionalString(value, 'url_contains') ?? null,
    };
    if (expected !== plannedCheckpoint.expected || !assertionMatches(plannedCheckpoint.assertion, runtimeAssertion)) return;
    active.assertions.push({
      checkpoint,
      kind,
      expected: this.#redact(expected),
      actual: AUTH_ASSERTION_NOT_MATCHED,
      passed: false,
      failureReason: 'tool_error',
    });
  }

  async #appendLedger(active: ActiveScenario, event: unknown): Promise<void> {
    // A sensitive operation's raw status, duration, and timestamp are private
    // classifier inputs. Do not incrementally persist them: a timed-out losing
    // Playwright promise may finish after the fixed MCP response window.
    if (this.#sensitiveBrowserState) return;
    await writeFile(
      path.join(active.evidenceDir, 'operations.ndjson'),
      `${this.#redact(JSON.stringify({ at: new Date().toISOString(), ...recordOf(event, 'ledger event') }))}\n`,
      { encoding: 'utf8', flag: 'a', mode: 0o600 },
    );
  }

  #locator(params: unknown, allMatches = false, active?: ActiveScenario): Locator {
    const input = locatorInput(recordOf(params, 'locator'));
    const page = this.#page(active);
    const exact = input.exact ?? false;
    let locator: Locator;
    if (input.role) {
      locator = page.getByRole(input.role as Parameters<Page['getByRole']>[0], {
        ...(input.name ? { name: input.name } : {}),
        exact,
      });
    } else if (input.label) locator = page.getByLabel(input.label, { exact });
    else if (input.placeholder) locator = page.getByPlaceholder(input.placeholder, { exact });
    else if (input.test_id) locator = page.getByTestId(input.test_id);
    else if (input.text) locator = page.getByText(input.text, { exact });
    else if (input.css) locator = page.locator(input.css);
    else throw new Error('A semantic locator is required');
    if (input.nth !== undefined) return locator.nth(input.nth);
    return allMatches ? locator : locator.first();
  }

  async #snapshot(active: ActiveScenario): Promise<unknown> {
    if (this.#sensitiveBrowserState) {
      return {
        url: AUTH_URL_OMITTED,
        title: AUTH_TEXT_OMITTED,
        accessibility: AUTH_TEXT_OMITTED,
        visible_text: AUTH_TEXT_OMITTED,
        truncated: false,
        authenticated_output_restricted: true,
      };
    }
    const page = this.#page(active);
    const body = page.locator('body');
    const [aria, text] = await Promise.all([
      body.ariaSnapshot({ timeout: 5_000 }).catch(() => '(accessibility snapshot unavailable)'),
      body.innerText({ timeout: 5_000 }).catch(() => '(visible text unavailable)'),
    ]);
    return {
      url: cleanUrl(page.url()),
      title: this.#redact(await page.title().catch(() => '')),
      accessibility: this.#redact(aria).slice(0, MAX_SNAPSHOT_CHARS),
      visible_text: this.#redact(text).slice(0, MAX_SNAPSHOT_CHARS),
      truncated: aria.length > MAX_SNAPSHOT_CHARS || text.length > MAX_SNAPSHOT_CHARS,
    };
  }

  async #navigate(params: unknown, active: ActiveScenario): Promise<unknown> {
    const value = recordOf(params, 'navigate input');
    const raw = stringOf(value, 'url');
    const rawExpected = value['expected_statuses'];
    let expectedStatuses: number[] | null = null;
    if (rawExpected !== undefined) {
      if (
        !Array.isArray(rawExpected) ||
        rawExpected.length < 1 ||
        rawExpected.length > 10 ||
        rawExpected.some((status) => !Number.isInteger(status) || status < 200 || status > 499)
      ) {
        throw new Error('expected_statuses must contain 1-10 HTTP status integers from 200 through 499');
      }
      expectedStatuses = [...new Set(rawExpected as number[])];
      const plannedStatuses = new Set(
        active.scenario.checkpoints.flatMap((checkpoint) =>
          checkpoint.assertion.kind === 'status' && /^(?:[2-4]\d{2})$/.test(checkpoint.expected)
            ? [Number(checkpoint.expected)]
            : [],
        ) ?? [],
      );
      if (expectedStatuses.some((status) => !plannedStatuses.has(status))) {
        throw new Error('expected_statuses must match an exact numeric checkpoint expectation in the accepted scenario plan');
      }
    }
    const url = new URL(raw, this.#target);
    if (!this.#topLevelUrlAllowed(url.toString())) throw new Error(`Navigation to ${url.origin} is not allowlisted`);
    const response = this.#sensitiveBrowserState
      ? await this.#page(active).goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 7_000 })
      : await this.#gotoWithRetries(this.#page(active), url.toString());
    if (!this.#topLevelUrlAllowed(this.#page(active).url())) {
      throw new Error('Navigation ended outside an allowlisted HTTP(S) origin');
    }
    const status = response?.status() ?? null;
    active.lastNavigationStatus = status;
    if (status !== null && expectedStatuses && !expectedStatuses.includes(status)) {
      throw new Error(`Navigation returned HTTP ${status}; expected ${expectedStatuses.join(', ')}`);
    }
    if (status !== null && !expectedStatuses && status >= 400) {
      throw new Error(`Navigation returned HTTP ${status}`);
    }
    return {
      url: this.#sensitiveBrowserState ? AUTH_URL_OMITTED : cleanUrl(this.#page(active).url()),
      status,
      title: this.#sensitiveBrowserState
        ? AUTH_TEXT_OMITTED
        : this.#redact(await this.#page(active).title()),
    };
  }

  async #gotoWithRetries(
    page: Page,
    url: string,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<Page['goto']>>> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (signal?.aborted) throw new SafeBrokerError('Browser navigation was cancelled');
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        if (signal?.aborted) throw new SafeBrokerError('Browser navigation was cancelled');
        return response;
      } catch (error) {
        lastError = error;
        if (!transientNavigationError(error) || attempt === 5) throw error;
        await page.waitForTimeout(attempt * 1_000);
      }
    }
    throw lastError;
  }

  async #click(params: unknown, active: ActiveScenario): Promise<unknown> {
    this.#assertMutation(params, 'click', active);
    await this.#locator(params, false, active).click({ timeout: this.#sensitiveBrowserState ? 750 : 10_000 });
    return this.#snapshot(active);
  }

  async #fill(params: unknown, active: ActiveScenario): Promise<unknown> {
    this.#assertMutation(params, 'fill', active);
    const value = recordOf(params, 'fill input');
    const input = value['value'];
    if (typeof input !== 'string') throw new Error('fill value must be a string');
    await this.#locator(params, false, active).fill(input, { timeout: this.#sensitiveBrowserState ? 750 : 10_000 });
    return { filled: true };
  }

  async #press(params: unknown, active: ActiveScenario): Promise<unknown> {
    this.#assertMutation(params, 'press', active);
    const value = recordOf(params, 'press input');
    const key = stringOf(value, 'key');
    const hasLocator = Object.keys(locatorInput(value)).some((item) => item !== 'exact' && item !== 'nth');
    if (hasLocator) await this.#locator(params, false, active).press(key, { timeout: this.#sensitiveBrowserState ? 750 : 10_000 });
    else await this.#page(active).keyboard.press(key);
    return { pressed: key };
  }

  async #select(params: unknown, active: ActiveScenario): Promise<unknown> {
    this.#assertMutation(params, 'select', active);
    const value = recordOf(params, 'select input');
    const optionValue = optionalString(value, 'value');
    const optionLabel = optionalString(value, 'option_label');
    if (!optionValue && !optionLabel) throw new Error('select needs value or option_label');
    const selected = await this.#locator(params, false, active).selectOption(
      optionValue ? { value: optionValue } : { label: optionLabel },
      { timeout: this.#sensitiveBrowserState ? 750 : 10_000 },
    );
    return this.#sensitiveBrowserState
      ? { selected: selected.map(() => AUTH_TEXT_OMITTED), selected_count: selected.length }
      : { selected: selected.map((item) => this.#redact(item)), selected_count: selected.length };
  }

  async #check(params: unknown, active: ActiveScenario): Promise<unknown> {
    this.#assertMutation(params, 'check', active);
    const value = recordOf(params, 'check input');
    const checked = boolOf(value, 'checked', true);
    if (checked) await this.#locator(params, false, active).check({ timeout: this.#sensitiveBrowserState ? 750 : 10_000 });
    else await this.#locator(params, false, active).uncheck({ timeout: this.#sensitiveBrowserState ? 750 : 10_000 });
    return { checked };
  }

  async #wait(params: unknown, active: ActiveScenario): Promise<unknown> {
    const value = recordOf(params, 'wait input');
    const text = optionalString(value, 'text');
    const urlContains = optionalString(value, 'url_contains');
    const timeout = value['timeout_ms'] === undefined ? 5_000 : finiteInt(value['timeout_ms'], 'timeout_ms', 100, 15_000);
    if (this.#sensitiveBrowserState) {
      // A content-dependent wait is a Boolean and timing oracle over private
      // state. Authenticated runs use only a fixed settling delay.
      await this.#page(active).waitForTimeout(750);
    } else if (text) await this.#page(active).getByText(text).first().waitFor({ state: 'visible', timeout });
    else if (urlContains) await this.#page(active).waitForURL((url) => url.toString().includes(urlContains), { timeout });
    else await this.#page(active).waitForTimeout(Math.min(timeout, 2_000));
    return {
      waited: true,
      url: this.#sensitiveBrowserState ? AUTH_URL_OMITTED : cleanUrl(this.#page(active).url()),
    };
  }

  async #assert(params: unknown, active: ActiveScenario): Promise<unknown> {
    this.#page(active);
    const value = recordOf(params, 'assert input');
    const checkpoint = stringOf(value, 'checkpoint');
    const plannedCheckpoint = active.scenario.checkpoints.find((item) => item.id === checkpoint);
    if (!plannedCheckpoint) {
      throw new Error(`Checkpoint ${JSON.stringify(checkpoint)} is not in the accepted scenario plan`);
    }
    if (active.assertions.some((assertion) => assertion.checkpoint === checkpoint)) {
      throw new Error(`Checkpoint ${JSON.stringify(checkpoint)} has already been asserted in this attempt`);
    }
    const kind = stringOf(value, 'kind') as QaAssertionRecord['kind'];
    if (!['visible', 'hidden', 'text', 'url', 'value', 'status'].includes(kind)) throw new Error(`Unknown assertion kind ${kind}`);
    const expected = stringOf(value, 'expected');
    if (expected !== plannedCheckpoint.expected) {
      throw new Error(`Assertion expected value for checkpoint ${JSON.stringify(checkpoint)} must exactly match the accepted scenario plan`);
    }
    const runtimeAssertion: QaCheckpointAssertion = {
      kind,
      locator: canonicalCheckpointLocator(value),
      url_contains: optionalString(value, 'url_contains') ?? null,
    };
    if (!assertionMatches(plannedCheckpoint.assertion, runtimeAssertion)) {
      throw new Error(
        `Assertion kind, locator, and URL matcher for checkpoint ${JSON.stringify(checkpoint)} must exactly match the accepted scenario plan`,
      );
    }
    if (kind === 'status' && !/^(?:[2-4]\d{2})$/.test(expected)) {
      throw new Error('A status checkpoint expectation must be an exact HTTP status string from 200 through 499');
    }
    let passed = false;
    let actual = '';
    let failureReason: QaAssertionRecord['failureReason'] = 'observed_mismatch';
    try {
      if (kind === 'status') {
        actual = active.lastNavigationStatus === null
          ? 'no navigation response status was recorded'
          : String(active.lastNavigationStatus);
        passed = actual === expected;
      } else if (kind === 'url') {
        // `expected` is retained as the human-readable checkpoint expectation.
        // A URL assertion may additionally carry the concrete substring in the
        // locator-shaped `text` field (older agents already emit this form) or
        // the purpose-built `url_contains` field.
        const matcher = plannedCheckpoint.assertion.url_contains!;
        if (this.#sensitiveBrowserState) {
          passed = await this.#page(active).evaluate((needle) => {
            const browserGlobal = globalThis as unknown as { location: { href: string } };
            const url = new URL(browserGlobal.location.href);
            url.username = '';
            url.password = '';
            url.search = '';
            url.hash = '';
            return url.toString().includes(needle);
          }, matcher);
        } else {
          actual = cleanUrl(this.#page(active).url());
          passed = actual.includes(matcher);
        }
      } else {
        const locator = this.#locator(params, kind === 'hidden', active);
        if (kind === 'hidden') {
          const count = await locator.count();
          if (count === 0) {
            actual = 'absent (therefore hidden)';
            passed = true;
          } else {
            const visibleCount = await locator.filter({ visible: true }).count();
            passed = visibleCount === 0;
            actual = count === 1
              ? (passed ? 'hidden' : 'visible')
              : (passed ? `hidden (${count} matches)` : `visible (${visibleCount} of ${count} matches)`);
          }
        } else if (kind === 'visible') {
          const count = await locator.count();
          if (count === 0) {
            actual = 'expected element was absent';
          } else {
            passed = await locator.isVisible({ timeout: this.#sensitiveBrowserState ? 500 : 5_000 });
            actual = passed ? 'visible' : 'hidden';
          }
        } else if (kind === 'text') {
          if (this.#sensitiveBrowserState) {
            passed = await locator.evaluate(
              (element, needle) => (
                (element as unknown as { innerText?: string }).innerText ?? ''
              ).trim().includes(needle),
              expected,
              { timeout: 500 },
            );
          } else {
            actual = (await locator.innerText({ timeout: 5_000 })).trim();
            passed = actual.includes(expected);
          }
        } else {
          if (this.#sensitiveBrowserState) {
            passed = await locator.evaluate(
              (element, wanted) => (
                element as unknown as { value?: string }
              ).value === wanted,
              expected,
              { timeout: 500 },
            );
          } else {
            actual = await locator.inputValue({ timeout: 5_000 });
            passed = actual === expected;
          }
        }
      }
    } catch (error) {
      failureReason = 'tool_error';
      actual = this.#sensitiveBrowserState
        ? AUTH_ASSERTION_NOT_MATCHED
        : this.#redact(error instanceof Error ? error.message : String(error));
      passed = false;
    }
    if (failureReason !== 'tool_error') failureReason = passed ? 'none' : 'observed_mismatch';
    // Persisted checkpoint and issue fields are schema-bounded and non-empty.
    // Browser text and values are not: an empty input or a large document is a
    // normal assertion result, not a reason to emit an invalid report.
    actual = this.#sensitiveBrowserState
      ? (passed ? AUTH_ASSERTION_MATCHED : AUTH_ASSERTION_NOT_MATCHED)
      : (actual.length > 0 ? this.#redact(actual).slice(0, MAX_RESULT_TEXT_CHARS) : '(empty string)');
    const assertion = {
      checkpoint,
      kind,
      expected: this.#redact(expected),
      actual,
      passed,
      failureReason,
    };
    if (this.#active !== active) {
      throw new SafeBrokerError('A completed assertion cannot mutate a later scenario');
    }
    active.assertions.push(assertion);
    return assertion;
  }

  #assertMutation(params: unknown, action: string, active: ActiveScenario): void {
    this.#page(active);
    if (!this.#options.allowMutations && !this.#options.allowReadOnlyInteractions) {
      const denial = `${action} was denied because trusted reset is not configured; use navigation and read-only inspection`;
      if (active.policyDenials.length < 200) active.policyDenials.push(denial);
      if (active.blockingPolicyDenials.length < 200) {
        active.blockingPolicyDenials.push(denial);
      }
      throw new Error(denial);
    }
    const value = recordOf(params, 'browser action input');
    const mutation = optionalString(value, 'mutation') ?? 'none';
    if (!['none', 'create', 'update', 'delete', 'upload'].includes(mutation)) {
      throw new Error(`Unknown mutation category ${JSON.stringify(mutation)}`);
    }
    if (!this.#options.allowMutations && mutation !== 'none') {
      const denial = `${action} was denied because the read-only interaction policy does not authorize ${mutation} mutations`;
      if (active.policyDenials.length < 200) active.policyDenials.push(denial);
      if (active.blockingPolicyDenials.length < 200) {
        active.blockingPolicyDenials.push(denial);
      }
      throw new Error(denial);
    }
    if (mutation !== 'none' && !active.scenario.allowedMutations.includes(mutation)) {
      throw new Error(
        `Scenario ${active.scenario.id} did not authorize ${mutation} mutations`,
      );
    }
    if (!this.#options.allowMutations && this.#options.allowReadOnlyInteractions) {
      active.readOnlyInteractionGuard.armed = true;
    }
  }

  async #finishScenario(params: unknown): Promise<unknown> {
    if (!this.#active) throw new Error('There is no active scenario to finish');
    const value = recordOf(params, 'finish_scenario input');
    const status = stringOf(value, 'status');
    if (!['passed', 'failed', 'blocked'].includes(status)) throw new Error(`Unknown scenario status ${status}`);
    const failed = this.#active.assertions.some((assertion) => !assertion.passed);
    const asserted = new Set(this.#active.assertions.map((assertion) => assertion.checkpoint));
    const missing = this.#active.scenario.checkpoints
      .map((checkpoint) => checkpoint.id)
      .filter((checkpoint) => !asserted.has(checkpoint));
    const hasSuccessfulNavigation = this.#active.operations.some(
      (operation) => operation.action === 'navigate' && operation.status === 'succeeded',
    );
    const operationalFailure = this.#active.operations.some((operation) => operation.status !== 'succeeded');
    const currentPageAllowed = this.#active.page !== null
      && this.#topLevelUrlAllowed(this.#active.page.url());
    const assertionToolError = this.#active.assertions.some(
      (assertion) => assertion.failureReason === 'tool_error',
    );
    const blockedRequiredTraffic = this.#active.blockingPolicyDenials.length > 0;

    if (this.#sensitiveBrowserState) {
      // The execution agent receives no page-dependent branch signal. The
      // controller independently derives the attempt outcome from the sealed
      // ledger after every planned assertion has run.
      const derivedStatus: QaAttemptRecord['status'] = (
        !hasSuccessfulNavigation
        || !currentPageAllowed
        || operationalFailure
        || assertionToolError
        || blockedRequiredTraffic
        || missing.length > 0
      )
        ? 'blocked'
        : failed ? 'failed' : 'passed';
      return this.#closeActive(derivedStatus, SEALED_ATTEMPT_SUMMARY);
    }
    // Optional analytics, fonts, or other third-party resources are retained as
    // observations. A corrected protocol/locator mistake does not invalidate a
    // later passing checkpoint, but it cannot coexist with an attributable
    // failure. Optional policy denials similarly downgrade reproduction later.
    const operationalFailureCouldExplainFailure = status === 'failed' && operationalFailure;
    if (!hasSuccessfulNavigation || !currentPageAllowed || operationalFailureCouldExplainFailure || blockedRequiredTraffic) {
      return this.#closeActive(
        'blocked',
        `${stringOf(value, 'summary')} Controller blocked the attempt because navigation, browser operations, or origin policy enforcement was not trustworthy.`,
      );
    }
    if (status !== 'blocked' && missing.length > 0) {
      throw new Error(`Every planned checkpoint must be asserted before ${status}: ${missing.join(', ')}`);
    }
    if (status === 'passed' && failed) throw new Error('A scenario with a failed checkpoint cannot be marked passed');
    if (status === 'failed' && !failed) throw new Error('A failed scenario needs at least one failed checkpoint assertion');
    return this.#closeActive(status as QaAttemptRecord['status'], stringOf(value, 'summary'));
  }

  async #closeActive(
    status: QaAttemptRecord['status'],
    summary: string,
    deadline?: number,
  ): Promise<unknown> {
    const sealedCloseStarted = this.#sensitiveBrowserState ? Date.now() : null;
    const active = this.#active;
    if (!active) throw new Error('There is no active scenario to close');
    this.#active = null;
    const retainFailureEvidence = status !== 'passed';
    const screenshotMode = this.#options.screenshot ?? 'failure';
    if (active.page && !this.#sensitiveBrowserState && (
      screenshotMode === 'all' || (screenshotMode === 'failure' && retainFailureEvidence)
    )) {
      await bestEffortBeforeDeadline(
        () => active.page!.screenshot({ path: path.join(active.evidenceDir, 'final.png'), fullPage: true }),
        deadline,
      );
    }
    if (active.tracing && active.context) {
      const traceMode = this.#options.trace ?? 'failure';
      if (traceMode === 'all' || (traceMode === 'failure' && retainFailureEvidence)) {
        await bestEffortBeforeDeadline(
          () => active.context!.tracing.stop({ path: path.join(active.evidenceDir, 'trace.zip') }),
          deadline,
        );
      } else {
        await bestEffortBeforeDeadline(() => active.context!.tracing.stop(), deadline);
      }
    }
    const closeDeadline = deadline ?? (sealedCloseStarted === null ? undefined : sealedCloseStarted + 2_000);
    if (active.context && closeDeadline === undefined) await active.context.close();
    else if (active.context) await bestEffortBeforeDeadline(() => active.context?.close() ?? Promise.resolve(), closeDeadline);
    if ((this.#options.video ?? 'all') === 'failure' && !retainFailureEvidence) {
      const files = await readdir(active.evidenceDir).catch(() => []);
      await Promise.all(
        files
          .filter((file) => file.endsWith('.webm'))
          .map((file) => rm(path.join(active.evidenceDir, file), { force: true })),
      );
    }
    const finishedAt = Date.now();
    const record: QaAttemptRecord = {
      scenarioId: active.scenario.id,
      scenarioTitle: active.scenario.title,
      attempt: active.attempt,
      status,
      summary: this.#redact(summary),
      startedAt: new Date(active.startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - active.startedAt,
      assertions: structuredClone(active.assertions),
      operations: structuredClone(active.operations),
      console: structuredClone(active.console),
      failedRequests: structuredClone(active.failedRequests),
      policyDenials: structuredClone(active.policyDenials),
      operationCount: this.#operationCount - active.operationStart,
      evidenceDir: active.evidenceDir,
      sensitiveOutput: this.#sensitiveBrowserState,
    };
    this.#attempts.push(record);
    if (this.#sensitiveBrowserState) {
      // The final report carries the bounded checkpoint/status projection.
      // Per-attempt files contain raw timing and conditional event presence, so
      // they are controller-private and must never become upload candidates.
      await Promise.all([
        'attempt.json',
        'console.json',
        'failed-requests.json',
        'operations.ndjson',
      ].map((name) => rm(path.join(active.evidenceDir, name), { force: true }).catch(() => {})));
    } else {
      await Promise.all([
        writeFile(path.join(active.evidenceDir, 'attempt.json'), JSON.stringify(record, null, 2), { mode: 0o600 }),
        writeFile(path.join(active.evidenceDir, 'console.json'), JSON.stringify(record.console, null, 2), { mode: 0o600 }),
        writeFile(path.join(active.evidenceDir, 'failed-requests.json'), JSON.stringify(record.failedRequests, null, 2), { mode: 0o600 }),
      ]);
    }
    if (sealedCloseStarted !== null) {
      const remaining = 2_250 - (Date.now() - sealedCloseStarted);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    return this.#sensitiveBrowserState ? sealedAcknowledgement() : {
      finalized: true,
      status,
      failed_checkpoints: record.assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.checkpoint),
      evidence_dir: active.evidenceDir,
    };
  }

  #finish(params: unknown): unknown {
    if (!this.#plan) throw new Error('Submit a plan before finishing the QA run');
    if (this.#active) throw new Error('Finish the active scenario before finishing the QA run');
    if (!this.#plan.no_testable_surface) {
      const missing = this.#plan.scenarios.filter(
        (scenario) => !this.#attempts.some((attempt) => attempt.scenarioId === scenario.id),
      );
      if (missing.length > 0) throw new Error(`Planned scenarios were not run: ${missing.map((item) => item.id).join(', ')}`);
      if (this.#sensitiveBrowserState) {
        const incompleteRetries = this.#plan.scenarios.filter((scenario) =>
          !([1, 2] as const).every((attempt) => this.#attempts.some(
            (record) => record.scenarioId === scenario.id && record.attempt === attempt,
          )),
        );
        if (incompleteRetries.length > 0) {
          throw new Error(
            `Authenticated scenarios require two sealed attempts: ${incompleteRetries.map((item) => item.id).join(', ')}`,
          );
        }
      }
    }
    const value = recordOf(params, 'finish input');
    const rawIssues = value['issues'];
    if (!Array.isArray(rawIssues) || rawIssues.length > 20) throw new Error('issues must be a list of at most 20 entries');
    const issues = rawIssues.map((raw): QaAgentIssueInput => {
      const issue = recordOf(raw, 'issue');
      const severity = stringOf(issue, 'severity');
      if (!['P0', 'P1', 'P2', 'P3'].includes(severity)) throw new Error(`Unknown issue severity ${severity}`);
      return {
        title: this.#redact(stringOf(issue, 'title')),
        severity: severity as QaAgentIssueInput['severity'],
        scenario_id: stringOf(issue, 'scenario_id'),
        checkpoint: stringOf(issue, 'checkpoint'),
        expected: this.#redact(stringOf(issue, 'expected')),
        actual: this.#redact(stringOf(issue, 'actual')),
      };
    });
    this.#agentFinish = { summary: this.#redact(stringOf(value, 'summary')), issues };
    return { accepted: true, attempts: this.#attempts.length, operations: this.#operationCount };
  }

  async #mintSupportSession(signal: AbortSignal): Promise<URL | null> {
    const bootstrap = this.#sessionBootstrap;
    if (!bootstrap) return null;
    const secret = this.#options.secrets?.[bootstrap.secret];
    if (!secret) throw new SafeBrokerError('The staging session credential is unavailable');

    let response: Response;
    try {
      response = await fetch(bootstrap.url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${secret}`,
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json',
        },
        body: '{}',
        redirect: 'error',
        signal,
      });
    } catch {
      throw new SafeBrokerError('The staging session endpoint could not be reached');
    }
    if (response.status !== 201) {
      await response.body?.cancel().catch(() => {});
      throw new SafeBrokerError('The staging session endpoint returned an unexpected status');
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
      await response.body?.cancel().catch(() => {});
      throw new SafeBrokerError('The staging session endpoint did not return JSON');
    }

    const rawBody = await readBoundedBootstrapBody(response);
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new SafeBrokerError('The staging session endpoint returned invalid JSON');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new SafeBrokerError('The staging session response did not match the required contract');
    }
    const envelope = payload as Record<string, unknown>;
    if (envelope['status'] !== 'success') {
      throw new SafeBrokerError('The staging session response did not match the required contract');
    }
    const rawData = envelope['data'];
    if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
      throw new SafeBrokerError('The staging session response did not match the required contract');
    }
    const data = rawData as Record<string, unknown>;
    if (Object.keys(data).sort().join(',') !== 'expires_at,redirect_url,token_type') {
      throw new SafeBrokerError('The staging session response did not match the required contract');
    }
    const rawRedirect = data['redirect_url'];
    const rawExpiry = data['expires_at'];
    if (
      typeof rawRedirect !== 'string'
      || rawRedirect.length === 0
      || rawRedirect !== rawRedirect.trim()
      || typeof rawExpiry !== 'string'
      || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(rawExpiry)
      || data['token_type'] !== 'support_session'
    ) {
      throw new SafeBrokerError('The staging session response did not match the required contract');
    }
    const expiresAt = Date.parse(rawExpiry);
    const now = Date.now();
    if (
      !Number.isFinite(expiresAt)
      || expiresAt <= now
      || expiresAt > now + MAX_SUPPORT_SESSION_LIFETIME_MS + SUPPORT_SESSION_CLOCK_TOLERANCE_MS
    ) {
      throw new SafeBrokerError('The staging support session expiry was outside its allowed lifetime');
    }
    if (/\r|\n/.test(rawRedirect)) {
      throw new SafeBrokerError('The staging support session redirect was invalid');
    }
    let redirect: URL;
    try {
      redirect = new URL(rawRedirect);
    } catch {
      throw new SafeBrokerError('The staging support session redirect was invalid');
    }
    if (
      !isSecureOrLoopbackHttp(redirect)
      || redirect.username
      || redirect.password
      || redirect.hash
      || redirect.origin !== bootstrap.targetOrigin
    ) {
      throw new SafeBrokerError('The staging support session redirect was outside its bound target origin');
    }
    const queryEntries = [...redirect.searchParams.entries()];
    const tokenValues = redirect.searchParams.getAll('token').filter((value) => value.length > 0);
    if (
      queryEntries.length !== 1
      || queryEntries[0]?.[0] !== 'token'
      || tokenValues.length !== 1
    ) {
      throw new SafeBrokerError('The staging support session redirect did not contain one token');
    }
    // Dynamic one-time material is retained only in controller memory and is
    // registered before Playwright can surface any page/network diagnostics.
    this.#secretValues.push(rawRedirect, redirect.toString(), ...tokenValues);
    return redirect;
  }

  async #runAuthStep(page: Page, step: QaAuthStep, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new SafeBrokerError('Authentication setup was cancelled');
    switch (step.action) {
      case 'navigate': {
        const url = new URL(step.url, this.#target);
        if (!this.#topLevelUrlAllowed(url.toString())) {
          throw new SafeBrokerError(`Authentication navigation to ${url.origin} is not allowlisted`);
        }
        const response = await this.#gotoWithRetries(page, url.toString(), signal);
        if (!this.#topLevelUrlAllowed(page.url())) {
          throw new SafeBrokerError('Authentication navigation ended outside an allowlisted HTTP(S) origin');
        }
        if (response && response.status() >= 400) {
          throw new SafeBrokerError(`Authentication navigation returned HTTP ${response.status()}`);
        }
        return;
      }
      case 'fill': {
        const value = step.secret ? this.#options.secrets?.[step.secret] : step.value;
        if (value === undefined) {
          throw new SafeBrokerError(`Authentication fill is missing ${step.secret ? `secret ${step.secret}` : 'value'}`);
        }
        await this.#authLocator(page, step).fill(value, { timeout: 10_000 });
        if (signal.aborted) throw new SafeBrokerError('Authentication setup was cancelled');
        return;
      }
      case 'click':
        await this.#authLocator(page, step).click({ timeout: 10_000 });
        return;
      case 'press':
        await this.#authLocator(page, step).press(step.key, { timeout: 10_000 });
        return;
      case 'wait': {
        const timeout = step.timeout_ms ?? 10_000;
        const hasLocator = Boolean(step.role || step.label || step.placeholder || step.test_id || step.css);
        if (hasLocator) {
          await this.#authLocator(page, step).waitFor({ state: step.state ?? 'visible', timeout });
        } else if (step.text) await page.getByText(step.text).first().waitFor({ state: step.state ?? 'visible', timeout });
        else if (step.url_contains) await page.waitForURL((url) => url.toString().includes(step.url_contains ?? ''), { timeout });
        else await page.waitForTimeout(Math.min(timeout, 2_000));
      }
    }
    if (signal.aborted) throw new SafeBrokerError('Authentication setup was cancelled');
  }

  async #runAuthRecipe(page: Page, signal: AbortSignal): Promise<void> {
    // The caller's sealed setup deadline covers reset, browser launch, context
    // creation, and this entire recipe as one operation. Closing the pending
    // context at that deadline aborts any in-flight Playwright step.
    const redirect = await this.#mintSupportSession(signal);
    if (redirect) {
      if (signal.aborted) throw new SafeBrokerError('Authentication setup was cancelled');
      // Support-session redirects are single-use. Retrying the same URL could
      // only replay a consumed credential; a later sealed attempt mints fresh.
      const oneTimeUrl = redirect.toString();
      if (this.#oneTimeBootstrapAdmissions.has(oneTimeUrl)) {
        throw new SafeBrokerError('The staging session endpoint repeated a one-time redirect');
      }
      this.#oneTimeBootstrapAdmissions.set(oneTimeUrl, 'pending');
      const response = await page.goto(oneTimeUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 15_000,
      });
      if (signal.aborted) throw new SafeBrokerError('Authentication setup was cancelled');
      if (response && response.status() >= 400) {
        throw new SafeBrokerError('The staging support session navigation failed');
      }
      let finalUrl: URL;
      try {
        finalUrl = new URL(page.url());
      } catch {
        throw new SafeBrokerError('The staging support session navigation ended outside its target');
      }
      if (finalUrl.origin !== this.#sessionBootstrap?.targetOrigin || !this.#topLevelUrlAllowed(finalUrl.toString())) {
        throw new SafeBrokerError('The staging support session navigation ended outside its target');
      }
      const readiness = await page.waitForFunction(
        '(key) => Boolean(localStorage.getItem(key) || sessionStorage.getItem(key))',
        this.#sessionBootstrap.readyStorageKey,
        { polling: 100, timeout: SENSITIVE_SETUP_WINDOW_MS },
      );
      await readiness.dispose();
      if (signal.aborted) throw new SafeBrokerError('Authentication setup was cancelled');
    }
    for (const step of this.#options.authSteps ?? []) await this.#runAuthStep(page, step, signal);
  }

  #authLocator(page: Page, input: QaLocatorInput): Locator {
    const exact = input.exact ?? false;
    let locator: Locator;
    if (input.role) locator = page.getByRole(input.role as Parameters<Page['getByRole']>[0], { ...(input.name ? { name: input.name } : {}), exact });
    else if (input.label) locator = page.getByLabel(input.label, { exact });
    else if (input.placeholder) locator = page.getByPlaceholder(input.placeholder, { exact });
    else if (input.test_id) locator = page.getByTestId(input.test_id);
    else if (input.text) locator = page.getByText(input.text, { exact });
    else if (input.css) locator = page.locator(input.css);
    else throw new Error('Authentication step needs a semantic locator');
    return input.nth === undefined ? locator.first() : locator.nth(input.nth);
  }
}
