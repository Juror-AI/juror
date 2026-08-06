/** Tiny leveled logger. Writes to stderr so stdout stays clean for `--json` output. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const COLOR = process.stderr.isTTY && !process.env.NO_COLOR;
const dim = (s: string) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);
const red = (s: string) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const yellow = (s: string) => (COLOR ? `\x1b[33m${s}\x1b[0m` : s);
const cyan = (s: string) => (COLOR ? `\x1b[36m${s}\x1b[0m` : s);

let current: LogLevel = (process.env.JUROR_LOG_LEVEL as LogLevel) || 'info';

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
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}

/** Redact known live secret values (from env) in addition to shape-based matching. */
export function redactWith(text: string, secrets: Iterable<string>): string {
  let out = redact(text);
  for (const s of secrets) {
    if (s && s.length >= 12) out = out.split(s).join('[redacted]');
  }
  return out;
}
