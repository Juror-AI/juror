/**
 * Tolerant parsing of what a model claims is a `ModelReport`.
 *
 * This is the resilience layer between a rambling agent and a pipeline that assumes typed
 * data: be generous in what we accept (fenced blocks, prose wrappers, trailing commas,
 * `severity: high`, stringly-typed line numbers) and strict in what we emit. Every repair
 * and every drop is written to `problems` so the receipt can say what we had to fix —
 * silently "fixing" a model's output is how a reviewer stops being trustworthy.
 */

import { readFileSync } from 'node:fs';
import type {
  Category,
  FileOverview,
  FindingClaim,
  ModelReport,
  RawFinding,
  Severity,
} from './types.js';
import { CATEGORIES, SEVERITIES } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Entry points
// ─────────────────────────────────────────────────────────────────────────────

export function parseModelReport(text: string): { report: ModelReport | null; problems: string[] } {
  const problems: string[] = [];
  const extracted = extractJson(stripBom(text), problems);
  if (!extracted) {
    problems.push('no JSON object found in the model output');
    return { report: null, problems };
  }
  return { report: coerceReport(extracted.value, problems), problems };
}

export function readReportFile(path: string): { report: ModelReport | null; problems: string[] } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return { report: null, problems: [`could not read the report file ${path}: ${errText(e)}`] };
  }
  if (!text.trim()) return { report: null, problems: [`the report file ${path} is empty`] };

  const parsed = parseModelReport(text);
  if (!parsed.report) parsed.problems.push(`the report file ${path} did not contain a usable JSON object`);
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extraction — four increasingly desperate ways to find the JSON
// ─────────────────────────────────────────────────────────────────────────────

function extractJson(text: string, problems: string[]): { value: unknown } | null {
  const whole = text.trim();
  if (!whole) return null;

  const attempts: { source: string; text: string }[] = [{ source: 'the whole response', text: whole }];
  for (const block of fencedBlocks(whole, true)) attempts.push({ source: 'a ```json block', text: block });
  for (const block of fencedBlocks(whole, false)) attempts.push({ source: 'a fenced code block', text: block });
  for (const span of balancedSpans(whole, '{', '}')) attempts.push({ source: 'an embedded JSON object', text: span });
  for (const span of balancedSpans(whole, '[', ']')) attempts.push({ source: 'an embedded JSON array', text: span });

  for (const [i, attempt] of attempts.entries()) {
    const direct = tryParse(attempt.text);
    if (direct) {
      if (i > 0) problems.push(`the response was not bare JSON — recovered it from ${attempt.source}`);
      return direct;
    }
    // Last resort for this candidate: trailing commas are the single most common way a
    // model's hand-written JSON fails an otherwise perfect parse.
    const repaired = tryParse(stripTrailingCommas(attempt.text));
    if (repaired) {
      problems.push(
        i > 0
          ? `the response was not bare JSON — recovered it from ${attempt.source} after stripping trailing commas`
          : 'stripped trailing commas to parse the response',
      );
      return repaired;
    }
  }
  return null;
}

function tryParse(text: string): { value: unknown } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return { value: JSON.parse(trimmed) as unknown };
  } catch {
    return null;
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const FENCE_RE = /```[ \t]*([A-Za-z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)```/g;

function fencedBlocks(text: string, jsonOnly: boolean): string[] {
  const out: string[] = [];
  FENCE_RE.lastIndex = 0;
  for (let m = FENCE_RE.exec(text); m; m = FENCE_RE.exec(text)) {
    const lang = (m[1] ?? '').toLowerCase();
    const body = m[2] ?? '';
    const isJson = lang === 'json' || lang === 'jsonc' || lang === 'json5';
    if (jsonOnly && !isJson) continue;
    out.push(body);
  }
  return out;
}

/**
 * Every top-level balanced `open…close` span, longest first, with string literals and
 * their escapes respected so a `"}"` inside a body cannot end the span early.
 */
function balancedSpans(text: string, open: string, close: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === undefined) break;

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === close && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        spans.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  // An unterminated span still often contains everything we need up to the last close.
  if (depth > 0 && start >= 0) {
    const last = text.lastIndexOf(close);
    if (last > start) spans.push(text.slice(start, last + 1));
  }

  return spans.sort((a, b) => b.length - a.length);
}

function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === undefined) break;

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] ?? '')) j++;
      const next = text[j];
      if (next === '}' || next === ']') continue; // drop the comma
    }
    out += ch;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Coercion
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MERGE_CONFIDENCE = 3;
const DEFAULT_SEVERITY: Severity = 'P2';
const DEFAULT_CONFIDENCE = 0.5;

/** `critical`/`high`/… show up constantly despite the schema asking for `P0`–`P3`. */
const SEVERITY_ALIASES: Record<string, Severity> = {
  CRITICAL: 'P0',
  BLOCKER: 'P0',
  HIGH: 'P1',
  MAJOR: 'P1',
  MEDIUM: 'P2',
  MED: 'P2',
  MODERATE: 'P2',
  MINOR: 'P3',
  LOW: 'P3',
  NIT: 'P3',
  INFO: 'P3',
};

function coerceReport(value: unknown, problems: string[]): ModelReport | null {
  let raw: Record<string, unknown>;

  if (Array.isArray(value)) {
    // Some models skip the envelope and just emit the findings list.
    problems.push('the response was a bare array — treating it as the findings list');
    raw = { findings: value };
  } else if (isRecord(value)) {
    raw = value;
  } else {
    problems.push(`expected a JSON object, got ${typeName(value)}`);
    return null;
  }

  const report: ModelReport = {
    merge_confidence: DEFAULT_MERGE_CONFIDENCE,
    confidence_reason: '',
    summary: '',
    highlights: [],
    file_overviews: [],
    async_contracts: [],
    sequence_diagram: null,
    findings: [],
  };

  const mc = asNumber(raw['merge_confidence']);
  if (mc === null) {
    problems.push(
      `merge_confidence: expected 1–5, got ${fmt(raw['merge_confidence'])} — using ${DEFAULT_MERGE_CONFIDENCE}`,
    );
  } else {
    const clamped = clamp(Math.round(mc), 1, 5);
    if (clamped !== mc) problems.push(`merge_confidence: ${mc} clamped to ${clamped}`);
    report.merge_confidence = clamped;
  }

  report.confidence_reason = stringField(raw['confidence_reason'], 'confidence_reason', problems);
  report.summary = stringField(raw['summary'], 'summary', problems);

  if (raw['highlights'] !== undefined && raw['highlights'] !== null) {
    if (Array.isArray(raw['highlights'])) {
      for (const item of raw['highlights']) {
        const s = asString(item);
        if (s) report.highlights.push(s);
        else problems.push(`highlights: dropped a non-string entry (${fmt(item)})`);
      }
    } else {
      problems.push(`highlights: expected a list, got ${fmt(raw['highlights'])} — using []`);
    }
  }

  if (raw['file_overviews'] !== undefined && raw['file_overviews'] !== null) {
    if (Array.isArray(raw['file_overviews'])) {
      raw['file_overviews'].forEach((item, i) => {
        const overview = coerceOverview(item, i, problems);
        if (overview) report.file_overviews.push(overview);
      });
    } else {
      problems.push(`file_overviews: expected a list, got ${fmt(raw['file_overviews'])} — using []`);
    }
  }

  if (raw['async_contracts'] !== undefined && raw['async_contracts'] !== null) {
    if (Array.isArray(raw['async_contracts'])) {
      for (const item of raw['async_contracts']) {
        const contract = asString(item);
        if (contract) report.async_contracts.push(contract);
        else problems.push(`async_contracts: dropped a non-string entry (${fmt(item)})`);
      }
    } else {
      problems.push(`async_contracts: expected a list, got ${fmt(raw['async_contracts'])} — using []`);
    }
  }

  const diagram = asString(raw['sequence_diagram']);
  if (diagram) {
    report.sequence_diagram = diagram;
  } else if (raw['sequence_diagram'] !== undefined && raw['sequence_diagram'] !== null) {
    problems.push(
      `sequence_diagram: expected a mermaid string or null, got ${fmt(raw['sequence_diagram'])} — using null`,
    );
  }

  const findings = raw['findings'];
  if (findings === undefined || findings === null) {
    problems.push('findings: missing — using []');
  } else if (!Array.isArray(findings)) {
    problems.push(`findings: expected a list, got ${fmt(findings)} — using []`);
  } else {
    findings.forEach((item, i) => {
      const finding = coerceFinding(item, i, problems);
      if (finding) report.findings.push(finding);
    });
  }

  return report;
}

function coerceOverview(raw: unknown, index: number, problems: string[]): FileOverview | null {
  if (!isRecord(raw)) {
    problems.push(`file_overviews[${index}]: expected an object, got ${fmt(raw)} — dropped`);
    return null;
  }
  const path = normalizePath(asString(raw['path']));
  if (!path) {
    problems.push(`file_overviews[${index}]: no \`path\` — dropped`);
    return null;
  }
  return { path, overview: asString(raw['overview']) ?? '' };
}

function coerceFinding(raw: unknown, index: number, problems: string[]): RawFinding | null {
  const at = `findings[${index}]`;
  if (!isRecord(raw)) {
    problems.push(`${at}: expected an object, got ${fmt(raw)} — dropped`);
    return null;
  }

  const path = normalizePath(asString(raw['path']) ?? asString(raw['file']));
  if (!path) {
    problems.push(`${at}: no \`path\` — dropped`);
    return null;
  }
  const title = asString(raw['title']);
  if (!title) {
    problems.push(`${at} (${path}): no \`title\` — dropped`);
    return null;
  }

  let line = 1;
  const lineNum = asNumber(raw['line']);
  if (lineNum === null || !Number.isFinite(lineNum) || Math.floor(lineNum) < 1) {
    problems.push(`${at} (${path}): line ${fmt(raw['line'])} is not a positive integer — using 1`);
  } else {
    line = Math.floor(lineNum);
  }

  let endLine: number | null = null;
  if (raw['end_line'] !== undefined && raw['end_line'] !== null) {
    const n = asNumber(raw['end_line']);
    if (n === null || Math.floor(n) < line) {
      problems.push(`${at} (${path}): end_line ${fmt(raw['end_line'])} is not a line at or after ${line} — using null`);
    } else {
      endLine = Math.floor(n);
    }
  }

  const severity = coerceSeverity(raw['severity'], at, path, problems);
  const category = coerceCategory(raw['category'], at, path, problems);
  const claim = coerceClaim(raw['claim'], at, path, problems);

  let confidence = DEFAULT_CONFIDENCE;
  if (raw['confidence'] !== undefined && raw['confidence'] !== null) {
    const n = asNumber(raw['confidence']);
    if (n === null) {
      problems.push(`${at} (${path}): confidence ${fmt(raw['confidence'])} is not a number — using ${DEFAULT_CONFIDENCE}`);
    } else if (n >= 10 && n <= 100) {
      // A model that answers in percent means 80%, not "impossibly certain". The floor of
      // 10 is deliberate: a stray 1–5 scale value must clamp, not become 0.03.
      confidence = clamp(n / 100, 0, 1);
      problems.push(`${at} (${path}): confidence ${n} read as a percentage — using ${confidence}`);
    } else {
      confidence = clamp(n, 0, 1);
      if (confidence !== n) problems.push(`${at} (${path}): confidence ${n} clamped to ${confidence}`);
    }
  }

  return {
    path,
    line,
    end_line: endLine,
    severity,
    title,
    body: asString(raw['body']) ?? asString(raw['description']) ?? '',
    category,
    confidence,
    convention: asString(raw['convention']),
    ...(claim ? { claim } : {}),
  };
}

function coerceClaim(
  raw: unknown,
  at: string,
  path: string,
  problems: string[],
): FindingClaim | null {
  // Backward compatibility for custom prompts and partial reports written before the
  // atomic schema existed. Missing structure makes merging more conservative, never less.
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    problems.push(`${at} (${path}): claim must be an object — ignoring its dedupe metadata`);
    return null;
  }

  const trigger = asString(raw['trigger']);
  const mechanism = asString(raw['mechanism']);
  const consequence = asString(raw['consequence']);
  const fix = asString(raw['fix']);
  const missing = [
    ['trigger', trigger],
    ['mechanism', mechanism],
    ['consequence', consequence],
    ['fix', fix],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0 || !trigger || !mechanism || !consequence || !fix) {
    problems.push(
      `${at} (${path}): claim is missing ${missing.join(', ')} — ignoring its dedupe metadata`,
    );
    return null;
  }
  return { trigger, mechanism, consequence, fix };
}

function coerceSeverity(raw: unknown, at: string, path: string, problems: string[]): Severity {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 3) {
    return `P${raw}` as Severity;
  }
  const s = asString(raw)?.toUpperCase().replace(/\s+/g, '');
  if (s) {
    const direct = SEVERITIES.find((x) => x === s);
    if (direct) return direct;
    const numeric = /^[0-3]$/.test(s) ? (`P${s}` as Severity) : null;
    if (numeric) return numeric;
    const alias = SEVERITY_ALIASES[s];
    if (alias) {
      problems.push(`${at} (${path}): severity ${fmt(raw)} mapped to ${alias}`);
      return alias;
    }
  }
  problems.push(`${at} (${path}): unknown severity ${fmt(raw)} — using ${DEFAULT_SEVERITY}`);
  return DEFAULT_SEVERITY;
}

function coerceCategory(raw: unknown, at: string, path: string, problems: string[]): Category {
  const s = asString(raw)?.toLowerCase().replace(/[\s_]+/g, '-');
  if (s) {
    const direct = CATEGORIES.find((c) => c === s);
    if (direct) return direct;
    problems.push(`${at} (${path}): unknown category ${fmt(raw)} — using correctness`);
  } else if (raw !== undefined && raw !== null) {
    problems.push(`${at} (${path}): unknown category ${fmt(raw)} — using correctness`);
  }
  return 'correctness';
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    // `"line": "212"` and `"line": "L212"` both happen.
    const m = /-?\d+(\.\d+)?/.exec(v);
    if (m) {
      const n = Number(m[0]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function stringField(v: unknown, key: string, problems: string[]): string {
  const s = asString(v);
  if (s) return s;
  if (v !== undefined && v !== null) problems.push(`${key}: expected a string, got ${fmt(v)} — using ''`);
  return '';
}

/** Repo-relative paths only: leading `./` and `/` are noise the anchor stage would miss on. */
function normalizePath(path: string | null): string | null {
  if (!path) return null;
  const cleaned = path.replace(/^\.\/+/, '').replace(/^\/+/, '').trim();
  return cleaned ? cleaned : null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return `a ${typeof v}`;
}

function fmt(v: unknown): string {
  if (v === undefined) return 'nothing';
  if (typeof v === 'string') return JSON.stringify(v.length > 60 ? `${v.slice(0, 57)}…` : v);
  try {
    const s = JSON.stringify(v);
    if (s === undefined) return String(v);
    return s.length > 60 ? `${s.slice(0, 57)}…` : s;
  } catch {
    return String(v);
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
