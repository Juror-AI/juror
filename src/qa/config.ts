/** Strict parsing and secure defaults for the optional post-merge QA configuration. */

import type {
  QaAuthSecretHeader,
  QaAuthSessionBootstrapConfig,
  QaAuthStep,
  QaConfig,
  QaEvidenceMode,
  QaLocator,
  QaReasoningEffort,
  QaResetConfig,
  QaResetSecretHeader,
} from './types.js';
import { QA_REASONING_EFFORTS } from './types.js';
import { isIpLiteralHostname, isLoopbackHostname } from '../util/url.js';
import {
  QA_EARLY_EXIT_MAX_PATTERNS,
  safeQaEarlyExitPattern,
} from './testability.js';

const EVIDENCE_MODES: readonly QaEvidenceMode[] = ['all', 'failure', 'off'];

/** @internal Classify loader diagnostics that make the trusted QA policy unsafe to execute. */
export function unsafeQaConfigProblems(problems: readonly string[]): string[] {
  return problems.filter((problem) => /(?:^|[`.])qa(?:[.`:]|$)/.test(problem));
}

export function defaultQaConfig(): QaConfig {
  return {
    enabled: false,
    model: { id: 'gpt-5.6-luna', reasoning_effort: 'medium' },
    testability: { early_exit_paths: [] },
    target: {
      strategy: 'staging-first',
      environment: 'staging',
      static_url: null,
      readiness_path: '/',
      readiness_statuses: null,
      commit_probe: null,
      preview_fallback: true,
      wait_seconds: 900,
    },
    auth: { session_bootstrap: null, browser_secret_headers: [], steps: [] },
    sandbox: { allowed_origins: [], reset: null },
    limits: {
      max_scenarios: 6,
      max_browser_operations: 40,
      timeout_seconds: 1200,
      mobile_when_relevant: true,
    },
    evidence: {
      video: 'all',
      trace: 'failure',
      screenshot: 'failure',
      retention_days: 14,
    },
  };
}

export function applyQaConfig(config: QaConfig, raw: unknown, problems: string[]): void {
  const root = section(raw, 'qa', problems);
  if (!root) return;
  unknownKeys(root, ['enabled', 'model', 'testability', 'target', 'auth', 'sandbox', 'limits', 'evidence'], 'qa', problems);

  const enabled = boolean(root['enabled'], 'qa.enabled', problems);
  if (enabled !== null) config.enabled = enabled;
  applyModel(config, root['model'], problems);
  applyTestability(config, root['testability'], problems);
  applyTarget(config, root['target'], problems);
  applyAuth(config, root['auth'], problems);
  applySandbox(config, root['sandbox'], problems);
  validateAuthPolicy(config, problems);
  applyLimits(config, root['limits'], problems);
  applyEvidence(config, root['evidence'], problems);
}

function applyTestability(config: QaConfig, raw: unknown, problems: string[]): void {
  const value = section(raw, 'qa.testability', problems);
  if (!value) return;
  unknownKeys(value, ['early_exit_paths'], 'qa.testability', problems);
  if (!('early_exit_paths' in value)) return;
  const patterns = value['early_exit_paths'];
  if (
    !Array.isArray(patterns) ||
    patterns.length > QA_EARLY_EXIT_MAX_PATTERNS ||
    !patterns.every(safeQaEarlyExitPattern)
  ) {
    problems.push(
      `qa.testability.early_exit_paths: expected at most ${QA_EARLY_EXIT_MAX_PATTERNS} safe, relative, non-negated glob strings — using []`,
    );
    config.testability.early_exit_paths = [];
    return;
  }
  config.testability.early_exit_paths = [...new Set(patterns)];
}

function applyModel(config: QaConfig, raw: unknown, problems: string[]): void {
  const value = section(raw, 'qa.model', problems);
  if (!value) return;
  unknownKeys(value, ['id', 'reasoning_effort'], 'qa.model', problems);
  const id = string(value['id']);
  if ('id' in value) {
    if (id && /^[A-Za-z0-9._/-]+$/.test(id)) config.model.id = id;
    else problems.push(`qa.model.id: expected a model id, got ${format(value['id'])} — using ${config.model.id}`);
  }
  if ('reasoning_effort' in value) {
    const effort = string(value['reasoning_effort']);
    if (effort && QA_REASONING_EFFORTS.includes(effort as QaReasoningEffort)) {
      config.model.reasoning_effort = effort as QaReasoningEffort;
    } else {
      problems.push(
        `qa.model.reasoning_effort: expected one of ${QA_REASONING_EFFORTS.join(', ')}, got ${format(value['reasoning_effort'])} — using ${config.model.reasoning_effort}`,
      );
    }
  }
}

function applyTarget(config: QaConfig, raw: unknown, problems: string[]): void {
  const value = section(raw, 'qa.target', problems);
  if (!value) return;
  unknownKeys(
    value,
    ['strategy', 'environment', 'static_url', 'readiness_path', 'readiness_statuses', 'commit_probe', 'preview_fallback', 'wait_seconds'],
    'qa.target',
    problems,
  );
  if ('strategy' in value && value['strategy'] !== 'staging-first') {
    problems.push('qa.target.strategy: v1 supports only `staging-first` — using staging-first');
  }
  assignString(value, 'environment', 'qa.target.environment', problems, (next) => {
    config.target.environment = next;
  });
  if ('static_url' in value) {
    if (value['static_url'] === null) config.target.static_url = null;
    else {
      const next = httpUrl(value['static_url']);
      const parsed = next ? new URL(next) : null;
      if (parsed && !parsed.search && !parsed.hash) config.target.static_url = next;
      else problems.push(`qa.target.static_url: expected an HTTP(S) URL without credentials, query, or fragment, or null, got ${format(value['static_url'])} — using ${format(config.target.static_url)}`);
    }
  }
  if ('readiness_path' in value) {
    const next = sameOriginPath(value['readiness_path']);
    if (next) config.target.readiness_path = next;
    else problems.push(`qa.target.readiness_path: expected a same-origin path beginning with / — using ${config.target.readiness_path}`);
  }
  if ('readiness_statuses' in value) {
    const statuses = value['readiness_statuses'];
    if (statuses === null) config.target.readiness_statuses = null;
    else if (
      Array.isArray(statuses) &&
      statuses.length >= 1 &&
      statuses.length <= 20 &&
      statuses.every((status) => Number.isInteger(status) && status >= 200 && status <= 499)
    ) {
      config.target.readiness_statuses = [...new Set(statuses as number[])];
    } else {
      problems.push('qa.target.readiness_statuses: expected null or 1-20 HTTP status integers from 200 through 499 — using the default');
    }
  }
  if ('commit_probe' in value) {
    if (value['commit_probe'] === null) config.target.commit_probe = null;
    else {
      const probe = section(value['commit_probe'], 'qa.target.commit_probe', problems);
      if (probe) {
        unknownKeys(probe, ['path', 'json_pointer'], 'qa.target.commit_probe', problems);
        const probePath = sameOriginPath(probe['path']);
        const pointer = string(probe['json_pointer']);
        if (probePath && pointer !== null && (pointer === '' || pointer.startsWith('/'))) {
          config.target.commit_probe = { path: probePath, json_pointer: pointer };
        } else {
          problems.push('qa.target.commit_probe: path must be same-origin and json_pointer must be an RFC 6901 pointer — using null');
        }
      }
    }
  }
  const preview = boolean(value['preview_fallback'], 'qa.target.preview_fallback', problems);
  if (preview !== null) config.target.preview_fallback = preview;
  const wait = integer(value['wait_seconds'], 'qa.target.wait_seconds', 0, 3600, problems);
  if (wait !== null) config.target.wait_seconds = wait;
}

function applyAuth(config: QaConfig, raw: unknown, problems: string[]): void {
  const value = section(raw, 'qa.auth', problems);
  if (!value) return;
  unknownKeys(value, ['session_bootstrap', 'browser_secret_headers', 'steps'], 'qa.auth', problems);
  if ('session_bootstrap' in value) {
    config.auth.session_bootstrap = value['session_bootstrap'] === null
      ? null
      : parseSessionBootstrap(value['session_bootstrap'], problems);
  }
  if ('browser_secret_headers' in value) {
    config.auth.browser_secret_headers = parseBrowserSecretHeaders(
      value['browser_secret_headers'],
      problems,
    );
  }
  if ('steps' in value) applyAuthSteps(config, value['steps'], problems);
}

function parseSessionBootstrap(
  raw: unknown,
  problems: string[],
): QaAuthSessionBootstrapConfig | null {
  const value = section(raw, 'qa.auth.session_bootstrap', problems);
  if (!value) return null;
  unknownKeys(
    value,
    ['url', 'secret_ref', 'target_origin', 'ready_storage_key'],
    'qa.auth.session_bootstrap',
    problems,
  );
  const url = absoluteSecureUrlWithoutQuery(value['url']);
  const secretRef = envName(value['secret_ref']);
  const targetOrigin = exactOrigin(value['target_origin']);
  const readyStorageKey = webStorageKey(value['ready_storage_key']);
  if (!url || !secretRef || !targetOrigin || !readyStorageKey) {
    problems.push(
      'qa.auth.session_bootstrap: expected a secure absolute URL without query or fragment, logical secret_ref, exact secure target_origin, and ready_storage_key — using null',
    );
    return null;
  }
  return {
    url,
    secret_ref: secretRef,
    target_origin: targetOrigin,
    ready_storage_key: readyStorageKey,
  };
}

function parseBrowserSecretHeaders(raw: unknown, problems: string[]): QaAuthSecretHeader[] {
  if (!Array.isArray(raw) || raw.length > 20) {
    problems.push(
      'qa.auth.browser_secret_headers: expected a list with at most 20 entries — using []',
    );
    return [];
  }
  const headers: QaAuthSecretHeader[] = [];
  const bindings = new Set<string>();
  for (const [index, rawHeader] of raw.entries()) {
    const at = `qa.auth.browser_secret_headers[${index}]`;
    const header = record(rawHeader);
    if (!header) {
      problems.push(`${at}: expected a mapping — dropped`);
      continue;
    }
    unknownKeys(header, ['name', 'secret_ref', 'origins'], at, problems);
    const name = qaBrowserSecretHeaderName(header['name']);
    const secretRef = envName(header['secret_ref']);
    const rawOrigins = header['origins'];
    if (!Array.isArray(rawOrigins) || rawOrigins.length < 1 || rawOrigins.length > 10) {
      problems.push(`${at}.origins: expected 1-10 exact secure origins — dropped`);
      continue;
    }
    const origins = rawOrigins.map(exactOrigin);
    if (!name || !secretRef || origins.some((origin) => origin === null)) {
      problems.push(
        `${at}: expected an X-* token header name or a standard Cloudflare Access service-token header, logical secret_ref, and 1-10 exact secure origins — dropped`,
      );
      continue;
    }
    const normalizedOrigins = [...new Set(origins as string[])];
    const candidateBindings = normalizedOrigins.map(
      (origin) => `${name.toLowerCase()}\n${origin}`,
    );
    if (candidateBindings.some((binding) => bindings.has(binding))) {
      problems.push(`${at}: duplicate header name and origin binding — dropped`);
      continue;
    }
    for (const binding of candidateBindings) bindings.add(binding);
    headers.push({
      name,
      secret_ref: secretRef,
      origins: normalizedOrigins,
    });
  }
  return headers;
}

function applyAuthSteps(config: QaConfig, raw: unknown, problems: string[]): void {
  if (!Array.isArray(raw) || raw.length > 50) {
    problems.push('qa.auth.steps: expected a list with at most 50 steps — using no login steps');
    config.auth.steps = [];
    return;
  }
  const steps: QaAuthStep[] = [];
  for (const [index, rawStep] of raw.entries()) {
    const at = `qa.auth.steps[${index}]`;
    const step = record(rawStep);
    if (!step) {
      problems.push(`${at}: expected a mapping — dropped`);
      continue;
    }
    const type = string(step['type']);
    if (type === 'goto') {
      unknownKeys(step, ['type', 'path'], at, problems);
      const next = sameOriginPath(step['path']);
      if (next) steps.push({ type, path: next });
      else problems.push(`${at}.path: expected a same-origin path — dropped`);
      continue;
    }
    if (type === 'fill') {
      unknownKeys(step, ['type', 'locator', 'secret_ref'], at, problems);
      const locator = parseLocator(step['locator'], `${at}.locator`, problems);
      const secretRef = envName(step['secret_ref']);
      if (locator && secretRef) steps.push({ type, locator, secret_ref: secretRef });
      else problems.push(`${at}: fill needs a valid locator and logical secret_ref — dropped`);
      continue;
    }
    if (type === 'click') {
      unknownKeys(step, ['type', 'locator'], at, problems);
      const locator = parseLocator(step['locator'], `${at}.locator`, problems);
      if (locator) steps.push({ type, locator });
      else problems.push(`${at}: click needs a valid locator — dropped`);
      continue;
    }
    if (type === 'wait') {
      unknownKeys(step, ['type', 'locator', 'state', 'timeout_seconds'], at, problems);
      const locator = parseLocator(step['locator'], `${at}.locator`, problems);
      const state = step['state'];
      const timeout = integer(step['timeout_seconds'], `${at}.timeout_seconds`, 1, 60, problems);
      if (locator && (state === 'visible' || state === 'hidden')) {
        steps.push({ type, locator, state, ...(timeout !== null ? { timeout_seconds: timeout } : {}) });
      } else problems.push(`${at}: wait needs a valid locator and visible/hidden state — dropped`);
      continue;
    }
    problems.push(`${at}.type: expected goto, fill, click, or wait — dropped`);
  }
  config.auth.steps = steps;
}

function validateAuthPolicy(config: QaConfig, problems: string[]): void {
  const bootstrap = config.auth.session_bootstrap;
  const headers = config.auth.browser_secret_headers;
  if (!bootstrap && headers.length === 0) return;

  if (config.target.environment !== 'staging') {
    problems.push(
      'qa.auth: session bootstrap and browser secret headers require qa.target.environment to be exactly `staging`',
    );
  }
  if (config.target.preview_fallback) {
    problems.push(
      'qa.auth: session bootstrap and browser secret headers require qa.target.preview_fallback=false',
    );
  }

  if (config.target.static_url === null) {
    problems.push(
      'qa.target.static_url: canonical staging URL is required by session bootstrap and browser secret headers',
    );
  }

  const allowed = new Set(config.sandbox.allowed_origins);
  const canonicalOrigin = config.target.static_url === null
    ? null
    : new URL(config.target.static_url).origin;
  if (bootstrap) {
    const bootstrapOrigin = new URL(bootstrap.url).origin;
    if (!allowed.has(bootstrapOrigin)) {
      problems.push(
        `qa.auth.session_bootstrap.url: origin ${bootstrapOrigin} must be listed in qa.sandbox.allowed_origins`,
      );
    }
    if (!allowed.has(bootstrap.target_origin)) {
      problems.push(
        `qa.auth.session_bootstrap.target_origin: ${bootstrap.target_origin} must be listed in qa.sandbox.allowed_origins`,
      );
    }
    if (
      config.target.static_url !== null &&
      new URL(config.target.static_url).origin !== bootstrap.target_origin
    ) {
      problems.push(
        'qa.target.static_url: origin must exactly match qa.auth.session_bootstrap.target_origin',
      );
    }
  }

  for (const [index, header] of headers.entries()) {
    for (const origin of header.origins) {
      if (!allowed.has(origin)) {
        problems.push(
          `qa.auth.browser_secret_headers[${index}].origins: ${origin} must be listed in qa.sandbox.allowed_origins`,
        );
      }
      if (canonicalOrigin !== null && origin !== canonicalOrigin) {
        problems.push(
          `qa.auth.browser_secret_headers[${index}].origins: ${origin} must exactly match the canonical qa.target.static_url origin ${canonicalOrigin}`,
        );
      }
    }
  }
}

function parseLocator(raw: unknown, at: string, problems: string[]): QaLocator | null {
  const value = record(raw);
  if (!value) return null;
  const by = string(value['by']);
  if (by === 'role') {
    unknownKeys(value, ['by', 'role', 'name'], at, problems);
    const role = string(value['role']);
    const name = string(value['name']);
    return role && name ? { by, role, name } : null;
  }
  if (by === 'label' || by === 'placeholder' || by === 'text' || by === 'test-id') {
    unknownKeys(value, ['by', 'value'], at, problems);
    const locatorValue = string(value['value']);
    return locatorValue ? { by, value: locatorValue } : null;
  }
  return null;
}

function applySandbox(config: QaConfig, raw: unknown, problems: string[]): void {
  const value = section(raw, 'qa.sandbox', problems);
  if (!value) return;
  unknownKeys(value, ['allowed_origins', 'reset'], 'qa.sandbox', problems);
  if ('allowed_origins' in value) {
    const rawOrigins = value['allowed_origins'];
    if (!Array.isArray(rawOrigins) || rawOrigins.length > 50) {
      problems.push('qa.sandbox.allowed_origins: expected a list with at most 50 origins — using []');
    } else {
      const origins: string[] = [];
      for (const rawOrigin of rawOrigins) {
        const origin = exactOrigin(rawOrigin);
        if (!origin) {
          problems.push(`qa.sandbox.allowed_origins: ${format(rawOrigin)} is not an exact HTTP(S) origin — ignored`);
          continue;
        }
        if (!origins.includes(origin)) origins.push(origin);
      }
      config.sandbox.allowed_origins = origins;
    }
  }
  if ('reset' in value) {
    config.sandbox.reset = value['reset'] === null
      ? null
      : parseReset(value['reset'], problems);
  }
}

function parseReset(raw: unknown, problems: string[]): QaResetConfig | null {
  const value = section(raw, 'qa.sandbox.reset', problems);
  if (!value) return null;
  unknownKeys(value, ['url', 'method', 'secret_headers', 'expected_statuses', 'timeout_seconds'], 'qa.sandbox.reset', problems);
  const url = sameOriginPath(value['url']) ?? httpUrl(value['url']);
  const method = string(value['method'])?.toUpperCase();
  const rawHeaders = value['secret_headers'];
  const rawStatuses = value['expected_statuses'];
  if (!url || !method || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    problems.push('qa.sandbox.reset: invalid URL or method — reset disabled');
    return null;
  }
  if (!Array.isArray(rawHeaders) || rawHeaders.length > 20) {
    problems.push('qa.sandbox.reset.secret_headers: expected a list with at most 20 entries — reset disabled');
    return null;
  }
  const secretHeaders = rawHeaders.flatMap((rawHeader, index) => {
    const header = record(rawHeader);
    const name = header && string(header['name']);
    const secretRef = header && envName(header['secret_ref']);
    const formatValue = header?.['format'];
    if (!header || !name || !secretRef || (formatValue !== 'bearer' && formatValue !== 'raw')) {
      problems.push(`qa.sandbox.reset.secret_headers[${index}]: invalid header — dropped`);
      return [];
    }
    unknownKeys(header, ['name', 'secret_ref', 'format'], `qa.sandbox.reset.secret_headers[${index}]`, problems);
    return [{ name, secret_ref: secretRef, format: formatValue as QaResetSecretHeader['format'] }];
  });
  if (!Array.isArray(rawStatuses) || rawStatuses.length === 0 || rawStatuses.some((item) => !Number.isInteger(item) || item < 200 || item > 499)) {
    problems.push('qa.sandbox.reset.expected_statuses: expected HTTP status integers from 200 through 499 — reset disabled');
    return null;
  }
  const timeout = integer(value['timeout_seconds'], 'qa.sandbox.reset.timeout_seconds', 1, 60, problems);
  return {
    url,
    method: method as QaResetConfig['method'],
    secret_headers: secretHeaders,
    expected_statuses: [...new Set(rawStatuses as number[])],
    ...(timeout !== null ? { timeout_seconds: timeout } : {}),
  };
}

function applyLimits(config: QaConfig, raw: unknown, problems: string[]): void {
  const value = section(raw, 'qa.limits', problems);
  if (!value) return;
  unknownKeys(value, ['max_scenarios', 'max_browser_operations', 'timeout_seconds', 'mobile_when_relevant'], 'qa.limits', problems);
  const scenarios = integer(value['max_scenarios'], 'qa.limits.max_scenarios', 1, 6, problems);
  if (scenarios !== null) config.limits.max_scenarios = scenarios;
  const operations = integer(value['max_browser_operations'], 'qa.limits.max_browser_operations', 1, 40, problems);
  if (operations !== null) config.limits.max_browser_operations = operations;
  const timeout = integer(value['timeout_seconds'], 'qa.limits.timeout_seconds', 30, 1200, problems);
  if (timeout !== null) config.limits.timeout_seconds = timeout;
  const mobile = boolean(value['mobile_when_relevant'], 'qa.limits.mobile_when_relevant', problems);
  if (mobile !== null) config.limits.mobile_when_relevant = mobile;
}

function applyEvidence(config: QaConfig, raw: unknown, problems: string[]): void {
  const value = section(raw, 'qa.evidence', problems);
  if (!value) return;
  unknownKeys(value, ['video', 'trace', 'screenshot', 'retention_days'], 'qa.evidence', problems);
  for (const key of ['video', 'trace', 'screenshot'] as const) {
    if (!(key in value)) continue;
    const mode = string(value[key]);
    if (mode && EVIDENCE_MODES.includes(mode as QaEvidenceMode)) config.evidence[key] = mode as QaEvidenceMode;
    else problems.push(`qa.evidence.${key}: expected one of ${EVIDENCE_MODES.join(', ')} — using ${config.evidence[key]}`);
  }
  const retention = integer(value['retention_days'], 'qa.evidence.retention_days', 1, 14, problems);
  if (retention !== null) config.evidence.retention_days = retention;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function section(value: unknown, at: string, problems: string[]): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  const mapped = record(value);
  if (!mapped) problems.push(`${at}: expected a mapping — using defaults`);
  return mapped;
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[], at: string, problems: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) problems.push(`unknown key \`${at}.${key}\` — ignored`);
  }
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function assignString(
  value: Record<string, unknown>,
  key: string,
  at: string,
  problems: string[],
  assign: (next: string) => void,
): void {
  if (!(key in value)) return;
  const next = string(value[key]);
  if (next) assign(next);
  else problems.push(`${at}: expected a non-empty string — using the default`);
}

function boolean(value: unknown, at: string, problems: string[]): boolean | null {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value;
  problems.push(`${at}: expected true or false — using the default`);
  return null;
}

function integer(value: unknown, at: string, min: number, max: number, problems: string[]): number | null {
  if (value === undefined) return null;
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value;
  problems.push(`${at}: expected an integer from ${min} to ${max} — using the default`);
  return null;
}

function sameOriginPath(value: unknown): string | null {
  const next = string(value);
  if (!next || !next.startsWith('/') || next.startsWith('//')) return null;
  try {
    const parsed = new URL(next, 'https://juror.invalid');
    return parsed.origin === 'https://juror.invalid' ? `${parsed.pathname}${parsed.search}` : null;
  } catch {
    return null;
  }
}

function httpUrl(value: unknown): string | null {
  const next = string(value);
  if (!next) return null;
  try {
    const parsed = new URL(next);
    const local = isLoopbackHostname(parsed.hostname);
    const protocolAllowed = parsed.protocol === 'https:' || (local && parsed.protocol === 'http:');
    const safeAuthority =
      Boolean(parsed.hostname) &&
      !parsed.hostname.includes('*') &&
      !(parsed.protocol === 'https:' && isIpLiteralHostname(parsed.hostname)) &&
      !parsed.username &&
      !parsed.password;
    return protocolAllowed && safeAuthority ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function absoluteSecureUrlWithoutQuery(value: unknown): string | null {
  const next = httpUrl(value);
  if (!next) return null;
  const parsed = new URL(next);
  return !parsed.search && !parsed.hash ? parsed.toString() : null;
}

function exactOrigin(value: unknown): string | null {
  const next = httpUrl(value);
  if (!next) return null;
  const parsed = new URL(next);
  return !parsed.search && !parsed.hash && (parsed.pathname === '/' || parsed.pathname === '')
    ? parsed.origin
    : null;
}

const CLOUDFLARE_ACCESS_SERVICE_TOKEN_HEADERS = new Set([
  'cf-access-client-id',
  'cf-access-client-secret',
]);

/** @internal Keep browser credentials limited to custom X-* headers and Cloudflare's service-token pair. */
export function qaBrowserSecretHeaderName(value: unknown): string | null {
  const next = string(value);
  if (!next) return null;
  if (
    /^x-[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/i.test(next)
    || CLOUDFLARE_ACCESS_SERVICE_TOKEN_HEADERS.has(next.toLowerCase())
  ) return next;
  return null;
}

function envName(value: unknown): string | null {
  const next = string(value);
  return next && /^[A-Za-z_][A-Za-z0-9_]*$/.test(next) ? next : null;
}

function webStorageKey(value: unknown): string | null {
  const next = string(value);
  return next && next.length <= 128 && /^[\x21-\x7e]+$/.test(next) ? next : null;
}

function format(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
