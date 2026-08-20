/** Human-readable post-merge QA report for the workflow summary and PR sticky. */

import { domainToUnicode } from 'node:url';

import type { QaRunResult } from '../qa/types.js';
import { redactWith, redactWithMarker, safeRedactionMarker } from '../util/log.js';
import { mdCell, mdText } from './summary.js';

export const QA_STICKY_MARKER = '<!-- juror:qa:v1 -->';

/** GitHub's documented comment limit. The renderer stays below this itself. */
export const MAX_QA_COMMENT_CHARS = 65_000;
const MAX_QA_LINK_URL_CHARS = 4_096;
const MAX_RENDERED_ITEMS = 8;
const MAX_PROSE_CHARS = 700;
const MAX_CELL_CHARS = 240;

export interface QaRenderOptions {
  jobUrl?: string | null;
  artifactUrl?: string | null;
  /** Exact controller-held values to remove at the final presentation boundary. */
  secrets?: readonly string[];
}

/**
 * Render one external URL without letting URL path characters terminate the
 * CommonMark destination and introduce a second link. Invalid or credentialed
 * URLs deliberately produce no active link.
 */
export function renderQaMarkdownLink(
  label: string,
  rawUrl: string | null | undefined,
  exactSecrets: readonly string[] = [],
): string | null {
  const destination = normalizedQaLinkDestination(rawUrl, exactSecrets);
  return destination ? `[${inertQaLinkLabel(label, exactSecrets)}](${destination})` : null;
}

function normalizedQaLinkDestination(
  rawUrl: string | null | undefined,
  exactSecrets: readonly string[],
): string | null {
  if (!rawUrl || rawUrl.length > MAX_QA_LINK_URL_CHARS) return null;
  // Never publish a URL whose raw form would be changed by the presentation
  // redactor. Unlike prose, destinations cannot safely display a placeholder.
  if (
    redactWith(rawUrl, exactSecrets) !== rawUrl ||
    containsQaPresentationSecret(rawUrl, exactSecrets)
  ) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username ||
    parsed.password
  ) {
    return null;
  }
  // URL#toString normalizes whitespace and encodes angle brackets. Preserve
  // brackets that delimit an IPv6 host, but encode CommonMark delimiters in the
  // path/query/fragment so an adversarial deployment URL cannot introduce a
  // second link.
  const normalized = parsed.toString();
  const authority = `${parsed.protocol}//${parsed.host}`;
  const destination = authority + normalized.slice(authority.length).replace(
    /[\\()[\]]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  // URL normalization percent-encodes Unicode and can make a raw URL that was
  // within the cap much larger. Keep each rendered destination bounded too.
  if (destination.length > MAX_QA_LINK_URL_CHARS) return null;
  if (
    redactWith(destination, exactSecrets) !== destination ||
    containsQaPresentationSecret(destination, exactSecrets)
  ) return null;
  return destination;
}

/** A non-final sticky used while the immutable semantic result is still being committed. */
export function renderQaPending(result: QaRunResult, options: QaRenderOptions = {}): string {
  const redactions = targetRedactions(result, options.secrets ?? []);
  const jobLink = renderTargetSafeQaMarkdownLink(
    'Open the QA workflow run', options.jobUrl, redactions, options.secrets ?? [],
  );
  const job = jobLink ? `\n\n${jobLink}` : '';
  return [
    `${QA_STICKY_MARKER}\n## ⏳ Juror QA — Finalizing evidence`,
    '> [!NOTE]\n> Browser execution is complete. Juror is sealing the evidence before publishing a verdict.',
    `<details><summary>Run details</summary>\n\n` +
      `- Change scope: ${result.base_resolution}\n` +
      `- Source base: \`${result.source_base_sha.slice(0, 12)}\`\n` +
      `- Run: ${inertQaText(result.run_id, redactions, 200)}${job}\n\n` +
      '</details>',
  ].join('\n\n');
}

const OUTCOME_PRESENTATION: Record<QaRunResult['outcome'], {
  icon: string;
  label: string;
  alert: 'NOTE' | 'TIP' | 'WARNING' | 'CAUTION';
  verdict: string;
}> = {
  passed: {
    icon: '✅',
    label: 'Passed',
    alert: 'TIP',
    verdict: 'All planned browser checks passed.',
  },
  no_testable_surface: {
    icon: '➖',
    label: 'Browser QA not applicable',
    alert: 'NOTE',
    verdict: 'Neutral — not scored. No browser was launched because this change has no user-testable surface.',
  },
  flaky: {
    icon: '⚠️',
    label: 'Passed on retry',
    alert: 'WARNING',
    verdict: 'The affected journey passed only after a retry. Review the evidence for instability.',
  },
  advisory: {
    icon: 'ℹ️',
    label: 'Advisory findings',
    alert: 'NOTE',
    verdict: 'Juror recorded findings that are not eligible for a product verdict because of target, range, or policy limitations.',
  },
  product_issue: {
    icon: '❌',
    label: 'Product issue found',
    alert: 'CAUTION',
    verdict: 'Juror reproduced a user-visible issue in an affected product flow.',
  },
  blocked: {
    icon: '⛔',
    label: 'QA blocked',
    alert: 'WARNING',
    verdict: 'No product verdict was produced because Juror could not produce a trustworthy result.',
  },
  infrastructure_error: {
    icon: '🛑',
    label: 'Infrastructure error',
    alert: 'CAUTION',
    verdict: 'No product verdict was produced because the QA runner or evidence pipeline failed.',
  },
  cancelled: {
    icon: '⏹️',
    label: 'Cancelled',
    alert: 'WARNING',
    verdict: 'No product verdict was produced because the QA run was cancelled.',
  },
};

type QaAttempt = QaRunResult['attempts'][number];

/**
 * QA report prose is model- or browser-originated. Make it readable while
 * breaking GitHub extensions and every Markdown construct that could change
 * surrounding structure. Renderer-authored Markdown remains outside this.
 */
function inertQaText(value: string, redactions: readonly TopologyRedaction[], max = MAX_PROSE_CHARS): string {
  const marker = qaRedactionMarker(redactions);
  const clipped = redactWithMarker(
    redactTargetTopology(value, redactions, marker),
    [],
    marker,
  ).slice(0, max);
  const omitted = value.length > max ? ` … [${value.length - max} characters omitted]` : '';
  return defangQaText(clipped) + omitted;
}

/** Keep exported link labels inert and bounded so they cannot create a second link. */
function inertQaLinkLabel(value: string, exactSecrets: readonly string[]): string {
  const redactions = exactSecrets.filter(Boolean).map((secret) => ({ value: secret }));
  const marker = qaRedactionMarker(redactions);
  const safe = redactWithMarker(redactTargetTopology(value, redactions, marker), [], marker);
  return defangQaText(safe.slice(0, 120)) || 'Link';
}

function defangQaText(value: string): string {
  return value
    .replace(/\r\n?|\n/g, ' ')
    .replace(/\\/g, '\\\\')
    // Escape ampersands first: otherwise &commat; and &num; can restore the
    // GitHub extensions we defang below.
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\[\]()`*_!]/g, '\\$&')
    .replace(/~/g, '\\~')
    .replace(/(^|\s)([-+])(?=\s)/g, '$1\\$2')
    .replace(/(^|\s)(\d{1,9})([.)])(?=\s)/g, '$1$2\\$3')
    .replace(/(^|\s)((?:-\s*){3,})(?=\s|$)/g, (_match, before, rule) =>
      `${before}${rule.replace(/-/g, '\\-')}`)
    // These zero-width separators prevent GitHub issue/reference and mention expansion.
    .replace(/#/g, '#\u200B')
    .replace(/@/g, '@\u200B')
    .replace(/\bGH-(?=\d+\b)/gi, (match) => `${match.slice(0, 2)}\u200B-`)
    .replace(/\b[0-9a-f]{7,40}\b/gi, (match) => match.match(/.{1,6}/g)?.join('\u200B') ?? match)
    // GitHub autolinks bare URLs independently of CommonMark link syntax.
    .replace(/\bhttps?:\/\//gi, (match) => `${match.slice(0, 4)}\u200B${match.slice(4)}`)
    .replace(/\bwww\./gi, 'www\u200B.')
    .replace(/\s+/g, ' ')
    .trim();
}

function bounded<T>(items: readonly T[], render: (item: T) => string, label: string): string[] {
  const shown = items.slice(0, MAX_RENDERED_ITEMS).map(render);
  if (items.length > shown.length) {
    const omitted = items.length - shown.length;
    shown.push(`- _${omitted} ${label}${omitted === 1 ? '' : 's'} omitted from this comment._`);
  }
  return shown;
}

function boundedTable<T>(
  items: readonly T[],
  render: (item: T) => string,
  columns: number,
  label: string,
): string[] {
  const shown = items.slice(0, MAX_RENDERED_ITEMS).map(render);
  if (items.length > shown.length) {
    const omitted = items.length - shown.length;
    shown.push(`| _${omitted} ${label}${omitted === 1 ? '' : 's'} omitted from this comment._ |${' — |'.repeat(columns - 1)}`);
  }
  return shown;
}

/** Target topology is private even when it is repeated inside untrusted prose. */
interface TopologyRedaction {
  value: string;
  insensitive?: boolean;
  standaloneNumber?: boolean;
  tokenBounded?: boolean;
  percentEncodingInsensitive?: boolean;
}

function targetRedactions(result: QaRunResult, secrets: readonly string[]): TopologyRedaction[] {
  const values: TopologyRedaction[] = secrets.map((value) => ({ value }));
  if (!result.target) return values;
  for (const raw of [result.target.url, result.target.allowed_origin]) {
    values.push({ value: raw });
    try {
      const parsed = new URL(raw);
      values.push({ value: parsed.origin, insensitive: true }, { value: parsed.host, insensitive: true },
        { value: parsed.hostname, insensitive: true });
      const unicodeHostname = domainToUnicode(parsed.hostname);
      if (unicodeHostname) {
        values.push(
          { value: unicodeHostname, insensitive: true },
          { value: parsed.port ? `${unicodeHostname}:${parsed.port}` : unicodeHostname, insensitive: true },
        );
      }
      const rawAuthority = raw.match(/^https?:\/\/([^/?#]+)/i)?.[1];
      if (rawAuthority) values.push({ value: rawAuthority, insensitive: true });
      // URL preserves the wire pathname/query/fragment, while decodeURIComponent
      // covers browser echoes that have already decoded them for display.
      const decodedPath = safeDecode(parsed.pathname);
      const pathVariants = [parsed.pathname, decodedPath, safeEncodePath(decodedPath)];
      for (const component of pathVariants) {
        if (component.length > 1) values.push({
          value: component,
          tokenBounded: true,
          percentEncodingInsensitive: true,
        });
        const withoutLeadingSlash = component.replace(/^\/+/, '');
        if (withoutLeadingSlash.length >= 3) values.push({
          value: withoutLeadingSlash,
          tokenBounded: true,
          percentEncodingInsensitive: true,
        });
      }
      for (const component of [parsed.hash.slice(1), safeDecode(parsed.hash.slice(1))]) {
        if (component) values.push({
          value: component,
          tokenBounded: true,
          percentEncodingInsensitive: true,
        });
      }
      const rawQuery = parsed.search.slice(1);
      for (const pair of rawQuery.split('&')) {
        if (!pair) continue;
        const separator = pair.indexOf('=');
        const key = separator === -1 ? pair : pair.slice(0, separator);
        const value = separator === -1 ? '' : pair.slice(separator + 1);
        const decodedKey = safeFormDecode(key);
        const decodedValue = safeFormDecode(value);
        const encodedPair = `${safeEncodeQuery(decodedKey)}${separator === -1 ? '' : `=${safeEncodeQuery(decodedValue)}`}`;
        const formPair = `${safeFormEncode(decodedKey)}${separator === -1 ? '' : `=${safeFormEncode(decodedValue)}`}`;
        for (const part of [pair, safeDecode(pair), safeFormDecode(pair), encodedPair, formPair]) {
          if (part.length >= 3 || separator !== -1) values.push({
            value: part,
            tokenBounded: true,
            percentEncodingInsensitive: true,
          });
        }
        for (const part of [
          key,
          value,
          safeDecode(key),
          safeDecode(value),
          decodedKey,
          decodedValue,
          safeEncodeQuery(decodedKey),
          safeEncodeQuery(decodedValue),
          safeFormEncode(decodedKey),
          safeFormEncode(decodedValue),
        ]) {
          if (part.length >= 3) values.push({
            value: part,
            tokenBounded: true,
            percentEncodingInsensitive: true,
          });
        }
      }
      const port = Number(parsed.port);
      if (Number.isInteger(port) && port >= 1024) values.push({ value: parsed.port, standaloneNumber: true });
    } catch {
      // The persisted validator rejects this; retain the exact value as a safe fallback.
    }
  }
  return values.filter(({ value }) => value.length > 0);
}

function safeDecode(value: string): string {
  return value.replace(/(?:%[0-9a-f]{2})+/gi, (encoded) => {
    const bytes = encoded.match(/[0-9a-f]{2}/gi)?.map((byte) => Number.parseInt(byte, 16)) ?? [];
    return new TextDecoder().decode(Uint8Array.from(bytes));
  });
}

/** Decode query components as application/x-www-form-urlencoded values. */
function safeFormDecode(value: string): string {
  return safeDecode(value.replace(/\+/g, ' '));
}

function safeEncodePath(value: string): string {
  try { return encodeURI(value); } catch { return value; }
}

function safeEncodeQuery(value: string): string {
  try { return encodeURIComponent(value); } catch { return value; }
}

function safeFormEncode(value: string): string {
  return safeEncodeQuery(value)
    .replace(/[!'()~]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/gi, '+');
}

interface DecodingVariants { values: string[]; exhausted: boolean }

/** Bound nested URL/form decoding; unusually deep input fails closed at presentation. */
function decodingVariants(value: string): DecodingVariants {
  const seen = new Set([value]);
  let frontier = [value];
  for (let pass = 0; pass < 8; pass++) {
    const next: string[] = [];
    for (const candidate of frontier) {
      for (const decoded of [
        safeDecode(candidate),
        safeFormDecode(candidate),
        candidate.normalize('NFC'),
        candidate.normalize('NFD'),
      ]) {
        if (!seen.has(decoded)) {
          seen.add(decoded);
          next.push(decoded);
        }
      }
    }
    if (next.length === 0) return { values: [...seen], exhausted: false };
    frontier = next;
  }
  const exhausted = frontier.some((candidate) =>
    [
      safeDecode(candidate),
      safeFormDecode(candidate),
      candidate.normalize('NFC'),
      candidate.normalize('NFD'),
    ].some((decoded) => !seen.has(decoded)));
  return { values: [...seen], exhausted };
}

/** Long values win, and encoded equivalents inherit the same matching policy. */
function orderedRedactions(redactions: readonly TopologyRedaction[]): TopologyRedaction[] {
  const expanded = new Map<string, TopologyRedaction>();
  for (const redaction of redactions) {
    const decoded = decodingVariants(redaction.value);
    if (decoded.exhausted) {
      throw new Error('QA presentation redaction exceeded the nested encoding limit');
    }
    for (const value of decoded.values) {
      const candidate = { ...redaction, value };
      const key = JSON.stringify(candidate);
      if (!expanded.has(key)) expanded.set(key, candidate);
    }
  }
  return [...expanded.values()].sort((left, right) => right.value.length - left.value.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function percentEncodingPattern(value: string): string {
  return escapeRegExp(value).replace(/%([0-9a-f])([0-9a-f])/gi, (_match, first, second) => {
    const hex = (character: string) => /[a-f]/i.test(character)
      ? `[${character.toLowerCase()}${character.toUpperCase()}]`
      : character;
    return `%${hex(first)}${hex(second)}`;
  });
}

function qaRedactionMarker(redactions: readonly TopologyRedaction[]): string {
  const expanded = orderedRedactions(redactions);
  const values = expanded.map((redaction) =>
    redaction.insensitive ? redaction.value.toLowerCase() : redaction.value);
  return safeRedactionMarker(values);
}

function tokenBoundedPattern(value: string, literal: string): string {
  const decoded = safeDecode(value);
  const tokenCharacter = /[\p{L}\p{N}_]/u;
  const left = tokenCharacter.test(decoded.at(0) ?? '') ? '(?<![\\p{L}\\p{N}_])' : '';
  const right = tokenCharacter.test(decoded.at(-1) ?? '') ? '(?![\\p{L}\\p{N}_])' : '';
  return `${left}${literal}${right}`;
}

/** Mask private target topology before exact secret redaction and Markdown escaping. */
function redactTargetTopology(
  value: string,
  redactions: readonly TopologyRedaction[],
  marker = '[redacted]',
): string {
  const ordered = orderedRedactions(redactions);
  const findRanges = (candidate: string): Array<{ start: number; end: number }> => {
    const ranges: Array<{ start: number; end: number }> = [];
    for (const redaction of ordered) {
      if (redaction.value.length > candidate.length) continue;
      const literal = redaction.percentEncodingInsensitive
        ? percentEncodingPattern(redaction.value)
        : escapeRegExp(redaction.value);
      const source = redaction.standaloneNumber
        ? `(?<!\\d)${literal}(?!\\d)`
        : redaction.tokenBounded
          ? tokenBoundedPattern(redaction.value, literal)
          : literal;
      const flags = redaction.insensitive ? 'giu' : 'gu';
      for (const match of candidate.matchAll(new RegExp(source, flags))) {
        if (match.index !== undefined) ranges.push({ start: match.index, end: match.index + match[0].length });
      }
    }
    return ranges;
  };
  const decoded = decodingVariants(value);
  if (ordered.length > 0 && (
    decoded.exhausted ||
    decoded.values.slice(1).some((candidate) => findRanges(candidate).length > 0)
  )) return marker;
  const ranges = findRanges(value);
  if (ranges.length === 0) return value;
  ranges.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  let safe = '';
  let cursor = 0;
  for (const range of merged) {
    safe += value.slice(cursor, range.start) + marker;
    cursor = range.end;
  }
  return safe + value.slice(cursor);
}

/** Detect raw or equivalently URL/form-encoded configured values before publication. */
export function containsQaPresentationSecret(value: string, secrets: readonly string[]): boolean {
  const redactions = secrets.filter(Boolean).map((secret) => ({ value: secret }));
  if (redactions.length === 0) return false;
  return redactTargetTopology(value, redactions, qaRedactionMarker(redactions)) !== value;
}

function renderTargetSafeQaMarkdownLink(
  label: string,
  rawUrl: string | null | undefined,
  redactions: readonly TopologyRedaction[],
  exactSecrets: readonly string[],
): string | null {
  const marker = qaRedactionMarker(redactions);
  if (rawUrl && redactTargetTopology(rawUrl, redactions, marker) !== rawUrl) return null;
  const destination = normalizedQaLinkDestination(rawUrl, exactSecrets);
  if (!destination || redactTargetTopology(destination, redactions, marker) !== destination) return null;
  return `[${inertQaLinkLabel(label, exactSecrets)}](${destination})`;
}

function finalAttempts(result: QaRunResult): Map<string, QaAttempt> {
  const final = new Map<string, QaAttempt>();
  for (const attempt of result.attempts) {
    const current = final.get(attempt.scenario_id);
    if (!current || attempt.attempt > current.attempt) final.set(attempt.scenario_id, attempt);
  }
  return final;
}

function scenarioIds(result: QaRunResult, final: ReadonlyMap<string, QaAttempt>): string[] {
  const ids = result.plan?.scenarios.map((scenario) => scenario.id) ?? [];
  for (const id of final.keys()) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function scenarioTitle(result: QaRunResult, id: string): string {
  return result.plan?.scenarios.find((scenario) => scenario.id === id)?.title ?? id;
}

function attemptStatus(status: QaAttempt['status'] | null): string {
  switch (status) {
    case 'passed': return '✅ Passed';
    case 'failed': return '❌ Failed';
    case 'blocked': return '⛔ Blocked';
    case 'infrastructure_error': return '🛑 Infrastructure error';
    default: return '➖ Not run';
  }
}

export function renderQaSummary(result: QaRunResult, options: QaRenderOptions = {}): string {
  const redactions = targetRedactions(result, options.secrets ?? []);
  const outcome = OUTCOME_PRESENTATION[result.outcome];
  const final = finalAttempts(result);
  const ids = scenarioIds(result, final);
  const finalCheckpoints = [...final.values()].flatMap((attempt) => attempt.checkpoints);
  const passedCheckpoints = finalCheckpoints.filter((checkpoint) => checkpoint.status === 'passed').length;
  const executedChecks = finalCheckpoints.length > 0
    ? `${passedCheckpoints}/${finalCheckpoints.length} passed`
    : 'Not run';
  const targetRevision = result.target
    ? `${result.target.kind} · ${result.target.revision.observed_sha
      ? `\`${result.target.revision.observed_sha.slice(0, 12)}\``
      : 'unverified'} (${result.target.revision.relation})`
    : 'not resolved';
  const blocks: string[] = [
    `${QA_STICKY_MARKER}\n## ${outcome.icon} Juror QA — ${outcome.label}`,
    `> [!${outcome.alert}]\n> ${outcome.verdict}`,
  ];

  blocks.push([
    '| Scope | Target revision | Journeys | Executed checks | Duration |',
    '| --- | --- | ---: | ---: | ---: |',
    `| ${mdCell(result.base_resolution)} | ${targetRevision} | ${ids.length} | ${executedChecks} | ${Math.round(result.duration_ms / 1000)}s |`,
  ].join('\n'));

  if (result.plan) {
    blocks.push(`### What changed\n\n${inertQaText(result.plan.impact_assessment, redactions)}`);
    if (result.plan.testability === 'no_testable_surface') {
      blocks.push(
        `### Why browser QA was skipped\n\n${inertQaText(
          result.plan.no_testable_surface_reason ?? 'No browser scenario was justified.',
          redactions,
        )}`,
      );
    }
    if (result.plan.risk_notes.length > 0 || result.plan.blind_spots.length > 0) {
      const auditNotes: string[] = [];
      if (result.plan.risk_notes.length > 0) {
        auditNotes.push('#### Risk notes', ...bounded(result.plan.risk_notes, (note) => `- ${inertQaText(note, redactions)}`, 'risk note'));
      }
      if (result.plan.blind_spots.length > 0) {
        auditNotes.push('#### Blind spots', ...bounded(result.plan.blind_spots, (note) => `- ${inertQaText(note, redactions)}`, 'blind spot'));
      }
      blocks.push(`<details><summary>Plan risks and blind spots</summary>\n\n${auditNotes.join('\n\n')}\n\n</details>`);
    }
  }

  if (result.issues.length > 0) {
    const severity = { P0: 0, P1: 1, P2: 2, P3: 3 } as const;
    const issueBlocks = bounded([...result.issues].sort((left, right) =>
      severity[left.severity] - severity[right.severity] ||
      (left.classification === right.classification ? 0 : left.classification === 'verified' ? -1 : 1)), (issue) => [
      `#### ${issue.severity} · ${inertQaText(issue.title, redactions, MAX_CELL_CHARS)}`,
      `- **Journey:** ${inertQaText(scenarioTitle(result, issue.scenario_id), redactions, MAX_CELL_CHARS)} · checkpoint ${inertQaText(issue.checkpoint_id, redactions, 80)}`,
      `- **Expected:** ${inertQaText(issue.expected, redactions)}`,
      `- **Observed:** ${inertQaText(issue.actual, redactions)}`,
      `- **Reproduced:** attempt${issue.attempt_numbers.length === 1 ? '' : 's'} ${issue.attempt_numbers.join(' and ')} · ${issue.classification}`,
    ].join('\n\n'), 'issue');
    const issuesHeading = result.outcome === 'product_issue' &&
      result.issues.some((issue) => issue.classification === 'verified')
      ? 'Product issues'
      : result.outcome === 'advisory' || result.issues.every((issue) => issue.classification === 'advisory')
        ? 'Advisory findings'
        : 'Retained browser findings';
    blocks.push(`### ${issuesHeading}\n\n${issueBlocks.join('\n\n---\n\n')}`);
  }

  if (ids.length > 0 && result.plan?.testability !== 'no_testable_surface') {
    const rows = ['| Journey | Final result | Checks | Attempts |', '| --- | --- | ---: | ---: |'];
    rows.push(...boundedTable(ids, (id) => {
      const attempt = final.get(id) ?? null;
      const passed = attempt?.checkpoints.filter((checkpoint) => checkpoint.status === 'passed').length ?? 0;
      const attempts = result.attempts.filter((candidate) => candidate.scenario_id === id).length;
      return `| ${mdCell(inertQaText(scenarioTitle(result, id), redactions, MAX_CELL_CHARS))} | ${attemptStatus(attempt?.status ?? null)} | ` +
        `${attempt ? `${passed}/${attempt.checkpoints.length}` : '—'} | ${attempts} |`;
    }, 4, 'journey'));
    blocks.push(`### What Juror tested\n\n${rows.join('\n')}`);
  }

  const unresolved = [...final.entries()].flatMap(([id, attempt]) => attempt.checkpoints
    .filter((checkpoint) => checkpoint.status !== 'passed')
    .map((checkpoint) => ({ id, checkpoint })));
  if (result.outcome === 'blocked' || result.outcome === 'infrastructure_error') {
    let reason: string;
    if (result.cleanup.status === 'failed') {
      reason = `Cleanup failed: ${result.cleanup.error ?? result.cleanup.summary}`;
    } else if (result.target?.stability === 'drifted') {
      reason = 'The deployed target changed while Juror was testing it, so the result could not be trusted.';
    } else if (result.outcome === 'infrastructure_error') {
      reason = 'The QA runner or evidence pipeline could not finalize a trustworthy product result.';
    } else if (unresolved.length > 0) {
      reason = `The final attempt left ${unresolved.length} planned check${unresolved.length === 1 ? '' : 's'} unresolved.`;
    } else {
      reason = 'Juror could not start or complete the planned browser journey.';
    }
    blocks.push(`### Why QA stopped\n\n${inertQaText(reason, redactions)}`);
  } else if (result.outcome === 'cancelled') {
    blocks.push(
      '### Why QA stopped\n\nThe workflow was cancelled before Juror could finalize the planned browser result.',
    );
  }
  if (
    unresolved.length > 0 &&
    (result.outcome === 'blocked' || result.outcome === 'infrastructure_error')
  ) {
    const rows = [
      '| Journey | Check | Result | Expected | Observed |',
      '| --- | --- | --- | --- | --- |',
      ...boundedTable(unresolved, ({ id, checkpoint }) =>
        `| ${mdCell(inertQaText(scenarioTitle(result, id), redactions, MAX_CELL_CHARS))} | ${mdCell(inertQaText(checkpoint.checkpoint_id, redactions, 80))} | ` +
        `${attemptStatus(checkpoint.status === 'blocked' ? 'blocked' : 'failed')} | ` +
        `${mdCell(inertQaText(checkpoint.expected, redactions, MAX_CELL_CHARS))} | ${mdCell(inertQaText(checkpoint.observed, redactions, MAX_CELL_CHARS))} |`, 5, 'unresolved check'),
    ];
    blocks.push(`### Unresolved checks\n\n${rows.join('\n')}`);
  }

  const retryFailures = result.outcome === 'flaky'
    ? result.attempts.flatMap((attempt) => {
      const finalAttempt = final.get(attempt.scenario_id);
      if (!finalAttempt || attempt.attempt >= finalAttempt.attempt) return [];
      return attempt.checkpoints
        .filter((checkpoint) => checkpoint.status !== 'passed')
        .map((checkpoint) => ({ attempt, checkpoint }));
    })
    : [];
  if (retryFailures.length > 0) {
    const rows = [
      '| Journey | Attempt | Check | Result | Observed |',
      '| --- | ---: | --- | --- | --- |',
      ...boundedTable(retryFailures, ({ attempt, checkpoint }) =>
        `| ${mdCell(inertQaText(scenarioTitle(result, attempt.scenario_id), redactions, MAX_CELL_CHARS))} | ${attempt.attempt} | ` +
          `${mdCell(inertQaText(checkpoint.checkpoint_id, redactions, 80))} | ` +
          `${attemptStatus(checkpoint.status === 'blocked' ? 'blocked' : 'failed')} | ` +
          `${mdCell(inertQaText(checkpoint.observed, redactions, MAX_CELL_CHARS))} |`, 5, 'retry failure'),
    ];
    blocks.push(`<details><summary>Retry history</summary>\n\n${rows.join('\n')}\n\n</details>`);
  }

  const videos = result.artifacts.filter((artifact) => artifact.kind === 'video');
  const evidenceLink = renderTargetSafeQaMarkdownLink(
    videos.length > 0 ? 'View evidence & video' : 'View evidence',
    options.artifactUrl,
    redactions,
    options.secrets ?? [],
  );
  const workflowLink = renderTargetSafeQaMarkdownLink(
    'Open workflow run', options.jobUrl, redactions, options.secrets ?? [],
  );
  const links = [evidenceLink, workflowLink].filter((link): link is string => Boolean(link));
  const videoRetentionDays = result.artifacts
    .filter((artifact) => artifact.kind === 'video')
    .map((artifact) => artifact.retention_days);
  const videoRetention = videoRetentionDays.length > 0
    ? ` · videos retained for ${Math.min(...videoRetentionDays)} day${Math.min(...videoRetentionDays) === 1 ? '' : 's'}`
    : '';
  if (links.length > 0 || result.artifacts.length > 0) {
    blocks.push(
      `### Evidence\n\n${links.join(' · ')}` +
      `${links.length > 0 ? '\n\n' : ''}` +
      `${result.artifacts.length} artifact${result.artifacts.length === 1 ? '' : 's'} · ` +
      `${videos.length} video${videos.length === 1 ? '' : 's'}${videoRetention}`,
    );
  }

  const cost = result.cost.usd === null ? 'unknown' : `$${result.cost.usd.toFixed(4)}`;
  blocks.push(
    '<details><summary>Run details</summary>\n\n' +
      `- Run: ${inertQaText(result.run_id, redactions, 200)}\n` +
      `- Change scope: ${result.base_resolution} · source base \`${result.source_base_sha.slice(0, 12)}\` · ` +
        `${result.policy_base_shas.length} policy-base candidate${result.policy_base_shas.length === 1 ? '' : 's'}\n` +
      `- Target: ${result.target ? mdText(result.target.kind) : 'not resolved'} · revision ` +
        `${result.target?.revision.observed_sha ? `\`${result.target.revision.observed_sha.slice(0, 12)}\`` : 'unverified'} ` +
        `(${result.target?.revision.relation ?? 'unverified'}) · verdict eligible ` +
        `${result.target?.verdict_eligible ? 'yes' : 'no'}\n` +
      `- Runtime: ${mdText(result.runtime.browser_name)} ${inertQaText(result.runtime.browser_version, redactions, 200)} · ` +
        `${inertQaText(result.runtime.model_id, redactions, 200)} · cost ${cost}\n` +
      `- Cleanup: ${result.cleanup.status} — ${inertQaText(result.cleanup.summary, redactions)}\n` +
      `- Attempts: ${result.attempts.length} · artifacts: ${result.artifacts.length}${videoRetention}\n\n` +
      (result.base_resolution === 'conservative'
        ? 'The tested range can include changes older than this PR, so findings are advisory.\n\n'
        : '') +
      '</details>',
  );
  if (result.warnings.length > 0) {
    blocks.push(`<details><summary>Warnings (${result.warnings.length})</summary>\n\n${bounded(result.warnings, (warning) => `- ${inertQaText(warning, redactions)}`, 'warning').join('\n')}\n\n</details>`);
  }
  const rendered = blocks.join('\n\n');
  if (rendered.length > MAX_QA_COMMENT_CHARS) {
    return renderCompactQaSummary(result, options, outcome, redactions);
  }
  return rendered;
}

/** A closed, useful last-resort comment; do not slice Markdown at the API boundary. */
function renderCompactQaSummary(
  result: QaRunResult,
  options: QaRenderOptions,
  outcome: typeof OUTCOME_PRESENTATION[QaRunResult['outcome']],
  redactions: readonly TopologyRedaction[],
): string {
  const links = [
    renderTargetSafeQaMarkdownLink('View evidence', options.artifactUrl, redactions, options.secrets ?? []),
    renderTargetSafeQaMarkdownLink('Open workflow run', options.jobUrl, redactions, options.secrets ?? []),
  ].filter((link): link is string => Boolean(link));
  const overview = result.plan
    ? inertQaText(result.plan.impact_assessment, redactions, 160)
    : 'No plan overview was available.';
  return [
    `${QA_STICKY_MARKER}\n## ${outcome.icon} Juror QA — ${outcome.label}`,
    `> [!${outcome.alert}]\n> ${outcome.verdict}`,
    `### What changed\n\n${overview}`,
    '### Overview counts\n\n| Journeys | Attempts | Issues | Artifacts |\n| ---: | ---: | ---: | ---: |\n' +
      `| ${result.plan?.scenarios.length ?? 0} | ${result.attempts.length} | ${result.issues.length} | ${result.artifacts.length} |`,
    '### Details omitted\n\nThe full QA detail was omitted because it exceeded the safe comment size.',
    links.length ? `### Evidence\n\n${links.join(' · ')}` : '',
    '<details><summary>Run details</summary>\n\n- The compact QA presentation is structurally complete.\n\n</details>',
  ].filter(Boolean).join('\n\n');
}
