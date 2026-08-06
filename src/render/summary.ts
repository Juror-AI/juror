/**
 * The sticky summary comment — §3.1.
 *
 * This markdown *is* the product: it is the only artifact most reviewers will ever see,
 * so its shape is a contract, not a preference. Two invariants hold everywhere below:
 * the sticky marker appears exactly once (the upsert in `github/publish.ts` finds the
 * comment by it), and every string that originated in a model passes through `redact()`
 * plus a defanger before it reaches the page.
 */

import type {
  Cluster,
  DiffContext,
  FileOverview,
  JurorConfig,
  ModelReport,
  ModelRun,
  ReviewResult,
  ReviewSummary,
  Severity,
  Verdict,
} from '../types.js';
import { SEVERITIES } from '../types.js';
import type { RollingSpend } from '../cost/rolling.js';
import { redact } from '../util/log.js';
import { REPO_SLUG, renderReceipt, type ReceiptNote } from './receipt.js';

export const STICKY_MARKER = '<!-- juror:summary:v1 -->';

export interface RenderOptions {
  version: string;
  headSha: string;
  repo?: string;
  prNumber?: number;
  rolling?: RollingSpend | null;
  config: JurorConfig;
}

/** A model could list a hundred files; the comment still has to be readable. */
const MAX_FILE_OVERVIEWS = 20;
const MAX_SUPPRESSED_ROWS = 20;

// ─────────────────────────────────────────────────────────────────────────────
// Untrusted text
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prose written by a model. Beyond secret redaction it must not be able to forge our
 * sticky marker (which would break the upsert) or close a block we opened.
 *
 * The one-liners this is used for — summary, highlights, titles — have no legitimate
 * reason to contain a code fence, and a truncated model leaves an unbalanced one that
 * renders the whole rest of the comment as a code block.
 */
export function mdText(s: string): string {
  return defang(redact(s)).replace(/`{3,}/g, '`').trim();
}

/**
 * Multi-line model prose where a fenced suggestion is legitimate (an inline comment
 * body). Fences survive; an odd one is closed for the model rather than left to eat
 * everything below it.
 */
export function mdBlock(s: string): string {
  const text = defang(redact(s)).trim();
  const fences = text.match(/`{3,}/g)?.length ?? 0;
  return fences % 2 === 0 ? text : `${text}\n\`\`\``;
}

function defang(s: string): string {
  return s.replace(/<!--/g, '&lt;!--').replace(/<\/(details|summary)>/gi, '&lt;/$1&gt;');
}

/**
 * Model text inside a table cell. A single `|` would otherwise split the row and shift
 * every column after it, so escape it and flatten the newlines a cell cannot contain.
 */
export function mdCell(s: string): string {
  return redact(s)
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .trim();
}

/** A model-authored mermaid body cannot be allowed to close the fence we put it in. */
function mermaidBody(s: string): string {
  return redact(s).replace(/`{3,}/g, '').trim();
}

export function severityRank(s: Severity): number {
  const i = SEVERITIES.indexOf(s);
  return i < 0 ? SEVERITIES.length : i;
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary synthesis — no extra model call
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge the models' prose deterministically. Paying for a fifth model call to write a
 * paragraph the other four already wrote would be exactly the kind of invisible cost
 * this tool exists to expose, so the median voter's summary is used verbatim and the
 * rest of the fields are unioned.
 */
export function synthesizeSummary(runs: ModelRun[], diff: DiffContext): ReviewSummary {
  const reported: { report: ModelReport; order: number }[] = [];
  runs.forEach((run, order) => {
    const report = run.result?.report;
    if (report) reported.push({ report, order });
  });
  if (reported.length === 0) return degradedSummary(diff);

  // Ties break on run order so the same inputs always render the same comment.
  const ranked = [...reported].sort(
    (a, b) => a.report.merge_confidence - b.report.merge_confidence || a.order - b.order,
  );
  const median = ranked[Math.floor((ranked.length - 1) / 2)];
  if (!median) return degradedSummary(diff);

  // The median voter's prose anchors the comment; its highlights come first.
  const ordered = [median, ...reported.filter((r) => r !== median)];

  const highlights: string[] = [];
  const seen = new Set<string>();
  for (const { report } of ordered) {
    for (const h of report.highlights) {
      const text = h.trim();
      const key = normalizeKey(text);
      if (!text || seen.has(key)) continue;
      seen.add(key);
      highlights.push(text);
      if (highlights.length >= 3) break;
    }
    if (highlights.length >= 3) break;
  }

  const overviews = new Map<string, FileOverview>();
  for (const { report } of reported) {
    for (const fo of report.file_overviews) {
      const path = fo.path?.trim();
      if (!path || !fo.overview?.trim()) continue;
      const existing = overviews.get(path);
      // Longest wins: the model that had the most to say about a file usually read it.
      if (!existing || fo.overview.length > existing.overview.length) {
        overviews.set(path, { path, overview: fo.overview.trim() });
      }
    }
  }

  let diagram: string | null = null;
  for (const { report } of reported) {
    const d = report.sequence_diagram?.trim();
    if (d) {
      diagram = d;
      break;
    }
  }

  return {
    summary: median.report.summary.trim(),
    highlights,
    fileOverviews: [...overviews.values()],
    sequenceDiagram: diagram,
    confidenceReason: median.report.confidence_reason.trim(),
  };
}

function degradedSummary(diff: DiffContext): ReviewSummary {
  const files = diff.files.filter((f) => !f.ignored).length;
  return {
    summary:
      `No model returned a usable report, so nothing in this diff was reviewed — ` +
      `${files} file${files === 1 ? '' : 's'} (+${diff.totalAdditions}/-${diff.totalDeletions}) went unread. ` +
      `The receipt below shows what each model did instead.`,
    highlights: [],
    fileOverviews: [],
    sequenceDiagram: null,
    confidenceReason: 'No model reported, so there is no confidence to report.',
  };
}

function normalizeKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// The comment
// ─────────────────────────────────────────────────────────────────────────────

export function renderSummaryComment(r: ReviewResult, o: RenderOptions): string {
  const models = totalModels(r);
  // The marker rides on the heading's block: `github/publish.ts` finds this comment by
  // it, so it must be the first thing in the body and must never be separated from it.
  const blocks: string[] = [`${STICKY_MARKER}\n### Juror Review`];

  const summary = mdText(r.summary.summary);
  if (summary) blocks.push(summary);

  const highlights = r.summary.highlights.map((h) => `- ${mdText(h).replace(/\n+/g, ' ')}`);
  if (highlights.length) blocks.push(highlights.join('\n'));

  blocks.push(`### Merge Confidence: ${r.verdict.score}/5`);

  const reason = mdText(r.summary.confidenceReason);
  if (reason) blocks.push(reason);

  const votes = votesLine(r.verdict);
  if (votes) blocks.push(votes);

  const attention = filesNeedingAttention(r.published);
  if (attention) blocks.push(`**Files needing attention:** ${attention}`);

  blocks.push(findingsSection(r.published, models));

  const suppressed = suppressedSection(r.suppressed, o.config);
  if (suppressed) blocks.push(suppressed);

  const overviews = importantFilesSection(r.summary.fileOverviews);
  if (overviews) blocks.push(overviews);

  const diagram = diagramSection(r.summary.sequenceDiagram, o.config);
  if (diagram) blocks.push(diagram);

  const skipped = skippedNotes(r.runs);
  const failed = failedNotes(r.runs);
  if (o.config.output.cost_receipt) {
    blocks.push(
      renderReceipt(r.totals, {
        durationMs: r.durationMs,
        rolling: o.rolling ?? null,
        skipped,
        failed,
        version: o.version,
      }),
    );
  } else if (skipped.length || failed.length) {
    // With the receipt switched off this is the only place a missing key can surface,
    // and a silently single-model review is worse than a noisy one.
    blocks.push(`<sub>${degradedNote(skipped, failed)}</sub>`);
  }

  blocks.push(footer(o));
  return `${blocks.join('\n\n')}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sections
// ─────────────────────────────────────────────────────────────────────────────

function votesLine(v: Verdict): string {
  if (v.votes.length === 0) return '';
  const votes = v.votes.map((x) => `${mdCell(x.modelLabel)} \`${x.vote}\``).join(' · ');
  return `<sub>Model votes: ${votes} → median **${trimNum(v.base)}**${capClause(v)}.</sub>`;
}

/**
 * The score's arithmetic is the pitch — show the ceiling the confirmed findings impose,
 * not the final score again, so `median 3, capped at 4` explains itself. P3s never
 * appear here because they carry no penalty.
 */
function capClause(v: Verdict): string {
  const parts: string[] = [];
  for (const s of PENALIZED) {
    const n = v.confirmed[s] ?? 0;
    if (n > 0) parts.push(`${n} ${s}${n === 1 ? '' : 's'}`);
  }
  if (parts.length === 0) return v.score < v.base ? `, rounded to **${v.score}**` : '';
  const first = parts[0] ?? '';
  const phrase = [first.replace(/^(\d+) /, '$1 confirmed '), ...parts.slice(1)].join(', ');
  return `, capped at **${trimNum(Math.max(1, 5 - v.penalty))}** by ${phrase}`;
}

/** The severities that actually move the score, in the order the penalty weights them. */
const PENALIZED = ['P0', 'P1', 'P2'] as const;

function filesNeedingAttention(published: Cluster[]): string {
  const best = new Map<string, number>();
  for (const c of published) {
    const rank = severityRank(c.severity);
    const prev = best.get(c.path);
    if (prev === undefined || rank < prev) best.set(c.path, rank);
  }
  if (best.size === 0) return '';
  return [...best.entries()]
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([path]) => `\`${mdCell(path)}\``)
    .join(', ');
}

function findingsSection(published: Cluster[], models: number): string {
  if (published.length === 0) {
    return '### Findings\n\nNo publishable findings.';
  }
  const lines = [
    '### Findings',
    '',
    '| | Severity | Location | Finding | Agreement |',
    '|---|---|---|---|---|',
  ];
  published.forEach((c, i) => {
    lines.push(
      `| ${i + 1} | ${severityCell(c.severity)} | \`${mdCell(location(c))}\` | ${mdCell(c.title)} | \`${dots(c.agreement, models)}\` ${c.agreement}/${models} |`,
    );
  });
  return lines.join('\n');
}

function suppressedSection(suppressed: Cluster[], config: JurorConfig): string {
  const mode = config.output.suppressed_findings;
  if (mode === 'hidden' || suppressed.length === 0) return '';

  const shown = suppressed.slice(0, MAX_SUPPRESSED_ROWS);
  const table = [
    '| Location | Finding | Raised by | Why suppressed |',
    '|---|---|---|---|',
    ...shown.map(
      (c) =>
        `| \`${mdCell(location(c))}\` | ${mdCell(c.title)} | ${mdCell(c.modelLabels.join(', '))} | ${mdCell(suppressionReason(c))} |`,
    ),
  ];
  const hidden = suppressed.length - shown.length;
  if (hidden > 0) table.push(`| … | ${hidden} more suppressed finding${hidden === 1 ? '' : 's'} | | |`);

  const heading = `${suppressed.length} finding${suppressed.length === 1 ? '' : 's'} suppressed — ${reasonSummary(suppressed)}`;
  if (mode === 'inline') return `**${heading}**\n\n${table.join('\n')}`;
  return `<details><summary>${heading}</summary>\n\n${table.join('\n')}\n</details>`;
}

function suppressionReason(c: Cluster): string {
  if (c.verification?.refuted) {
    const why = c.verification.reason.trim();
    return `Verifier (${c.verification.byModel}): ${why || 'refuted'}`;
  }
  return c.suppressedReason ?? 'below the publish bar';
}

function reasonSummary(suppressed: Cluster[]): string {
  const seen = new Set<string>();
  for (const c of suppressed) {
    if (c.verification?.refuted) seen.add('refuted on verification');
    else if (c.suppressedReason) seen.add(c.suppressedReason);
    else seen.add('below the publish bar');
  }
  return [...seen].slice(0, 3).map(mdCell).join(', ');
}

function importantFilesSection(overviews: FileOverview[]): string {
  if (overviews.length === 0) return '';
  const shown = overviews.slice(0, MAX_FILE_OVERVIEWS);
  const lines = ['### Important Files Changed', '', '| Filename | Overview |', '|---|---|'];
  for (const fo of shown) {
    lines.push(`| \`${mdCell(fo.path)}\` | ${mdCell(fo.overview)} |`);
  }
  const hidden = overviews.length - shown.length;
  if (hidden > 0) lines.push(`| … | ${hidden} more file${hidden === 1 ? '' : 's'} |`);
  return lines.join('\n');
}

function diagramSection(diagram: string | null, config: JurorConfig): string {
  if (!config.output.sequence_diagram || !diagram) return '';
  const body = mermaidBody(diagram);
  if (!body) return '';
  return `### Sequence Diagram\n\n\`\`\`mermaid\n${body}\n\`\`\``;
}

function footer(o: RenderOptions): string {
  const short = o.headSha.slice(0, 7) || 'unknown';
  const sha = o.repo
    ? `[\`${short}\`](https://github.com/${o.repo}/commit/${o.headSha})`
    : `\`${short}\``;
  return `<sub>Juror ${displayVersion(o.version)} · reviewed ${sha} · reply \`@juror ignore\` to any finding · [docs](https://github.com/${REPO_SLUG})</sub>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

/** `●●●○` — filled per agreeing model, empty for the models that stayed silent. */
export function dots(agreement: number, models: number): string {
  const total = Math.max(models, agreement, 1);
  const filled = Math.max(0, Math.min(agreement, total));
  return '●'.repeat(filled) + '○'.repeat(total - filled);
}

export function totalModels(r: ReviewResult): number {
  const maxAgreement = r.clusters.reduce((m, c) => Math.max(m, c.agreement), 0);
  return Math.max(r.totals.modelsRun, maxAgreement, 1);
}

function severityCell(s: Severity): string {
  return s === 'P0' || s === 'P1' ? `**${s}**` : s;
}

function location(c: Cluster): string {
  return `${c.path}:${c.line}`;
}

function skippedNotes(runs: ModelRun[]): ReceiptNote[] {
  return runs
    .filter((run) => run.skipped)
    .map((run) => ({ label: run.modelLabel, reason: redact(run.skipReason ?? 'skipped') }));
}

function failedNotes(runs: ModelRun[]): ReceiptNote[] {
  return runs
    .filter((run) => !run.skipped && !run.ok)
    .map((run) => ({ label: run.modelLabel, reason: redact(run.error ?? 'failed') }));
}

function degradedNote(skipped: ReceiptNote[], failed: ReceiptNote[]): string {
  const parts: string[] = [];
  if (skipped.length) parts.push(`Skipped: ${skipped.map(noteText).join(' · ')}`);
  if (failed.length) parts.push(`Failed: ${failed.map(noteText).join(' · ')}`);
  return parts.join(' · ');
}

function noteText(n: ReceiptNote): string {
  return `\`${mdCell(n.label)}\` (${mdCell(n.reason)})`;
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

export function displayVersion(version: string): string {
  const v = version.trim().replace(/^v/, '');
  return v ? `v${v}` : 'dev';
}
