/** Tiny leveled logger. Writes to stderr so stdout stays clean for `--json` output. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const COLOR = process.stderr.isTTY && !process.env.NO_COLOR;
const dim = (s: string) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);
const red = (s: string) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const yellow = (s: string) => (COLOR ? `\x1b[33m${s}\x1b[0m` : s);
const cyan = (s: string) => (COLOR ? `\x1b[36m${s}\x1b[0m` : s);

let warnedInvalidLogLevel = false;

/** Resolve an env/CLI log level; unknown values fall back to `info`. */
export function resolveLogLevel(raw: string | undefined): LogLevel {
  if (!raw) return 'info';
  if (Object.prototype.hasOwnProperty.call(ORDER, raw)) return raw as LogLevel;
  if (!warnedInvalidLogLevel) {
    warnedInvalidLogLevel = true;
    const allowed = Object.keys(ORDER).join(', ');
    process.stderr.write(
      yellow('  !') + ` JUROR_LOG_LEVEL="${raw}" is not recognized (expected one of: ${allowed}); using info\n`,
    );
  }
  return 'info';
}

let current: LogLevel = resolveLogLevel(process.env.JUROR_LOG_LEVEL);

export function setLogLevel(level: LogLevel): void {
  current = level;
}

export function getLogLevel(): LogLevel {
  return current;
}

function emit(level: LogLevel, prefix: string, args: unknown[]): void {
  if (ORDER[level] < ORDER[current]) return;
  process.stderr.write(`${prefix} ${args.map(fmt).join(' ')}\n`);
}

function fmt(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack ?? v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  debug: (...a: unknown[]) => emit('debug', dim('  ·'), a),
  info: (...a: unknown[]) => emit('info', cyan('  ›'), a),
  warn: (...a: unknown[]) => emit('warn', yellow('  !'), a),
  error: (...a: unknown[]) => emit('error', red('  ✗'), a),
  step: (...a: unknown[]) => emit('info', cyan('▸'), a),
};

/** Redact anything that looks like a provider key before it reaches a log or a comment. */
const SECRET_PATTERNS: RegExp[] = [
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

/**
 * Replace secret-shaped substrings with `[redacted]`. Applied to every string that
 * crosses a trust boundary: logs, diagnostics, and anything posted to GitHub.
 */
export function redact(text: string): string {
  return redactPatterns(text, '[redacted]');
}

function redactPatterns(text: string, marker: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, marker);
  return out;
}

/** Select a readable marker that cannot reproduce any exact value it replaces. */
export function safeRedactionMarker(secrets: Iterable<string>): string {
  const values = [...new Set([...secrets].filter((value) => value.length > 0))];
  const readable = ['[redacted]', '[secret removed]', '[credential omitted]'];
  for (const candidate of readable) {
    if (values.every((secret) => !candidate.includes(secret) && !secret.includes(candidate))) {
      return candidate;
    }
  }
  // Tests and downstream safety tooling intentionally support very short
  // canaries. A private-use scalar gives us thousands of deterministic marker
  // choices without ever reproducing one of those exact values.
  for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint++) {
    const candidate = String.fromCodePoint(codePoint);
    if (values.every((secret) => !candidate.includes(secret) && !secret.includes(candidate))) {
      return candidate;
    }
  }
  // Reaching this would require configuring every private-use scalar as a
  // separate one-character secret. Keep the failure independent of their values.
  throw new Error('Unable to select a collision-free redaction marker');
}

/**
 * Apply exact and shape-based redaction with a caller-selected collision-safe
 * marker. This is used when another boundary must share that same marker.
 */
export function redactWithMarker(
  text: string,
  secrets: Iterable<string>,
  marker: string,
): string {
  const exact = [...new Set([...secrets].filter((value) => value.length > 0))]
    .sort((left, right) => right.length - left.length);
  if (exact.length === 0) return redactPatterns(text, marker);

  // QA credentials may intentionally be short fixture values. Sort longest-first
  // and merge every match range so overlapping values are still removed. Existing
  // redaction markers are protected from another pass, making artifact/controller
  // pipelines idempotent even for a canary such as `a` or `redacted`.
  const protectedMarkers: Array<{ start: number; end: number }> = [];
  for (let offset = 0; offset < text.length;) {
    const start = text.indexOf(marker, offset);
    if (start < 0) break;
    protectedMarkers.push({ start, end: start + marker.length });
    offset = start + marker.length;
  }
  const insideExistingMarker = (start: number, end: number): boolean => {
    let low = 0;
    let high = protectedMarkers.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const range = protectedMarkers[middle]!;
      if (start < range.start) high = middle - 1;
      else if (start >= range.end) low = middle + 1;
      else return end <= range.end;
    }
    return false;
  };
  const ranges: Array<{ start: number; end: number }> = [];
  for (const secret of exact) {
    for (let offset = 0; offset <= text.length - secret.length;) {
      const start = text.indexOf(secret, offset);
      if (start < 0) break;
      const end = start + secret.length;
      if (!insideExistingMarker(start, end)) ranges.push({ start, end });
      offset = start + 1;
    }
  }
  if (ranges.length === 0) return redactPatterns(text, marker);
  ranges.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  let cursor = 0;
  let out = '';
  for (const range of merged) {
    out += text.slice(cursor, range.start) + marker;
    cursor = range.end;
  }
  return redactPatterns(out + text.slice(cursor), marker);
}

/** Redact known live secret values (from env) in addition to shape-based matching. */
export function redactWith(text: string, secrets: Iterable<string>): string {
  const exact = [...new Set([...secrets].filter((value) => value.length > 0))];
  if (exact.length === 0) return redact(text);
  return redactWithMarker(text, exact, safeRedactionMarker(exact));
}
