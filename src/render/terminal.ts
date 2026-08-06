/**
 * The local report for `juror review`.
 *
 * Same review object as the GitHub comment, rendered for a terminal: 80 columns, no
 * markdown, and colour only when someone is actually watching (a redirected stdout or
 * `NO_COLOR` gets plain text so the output stays greppable).
 */

import type { Cluster, ModelRun, ReviewResult, Severity } from '../types.js';
import { formatDuration, formatTokens, formatUsd } from './receipt.js';
import { displayVersion, dots, severityRank, totalModels } from './summary.js';
import { redact } from '../util/log.js';

const WIDTH = 78;
const LOC_WIDTH = 30;
const TITLE_WIDTH = 28;

export function renderTerminalReport(r: ReviewResult, o: { version: string }): string {
  const c = palette(colorEnabled());
  const models = totalModels(r);
  const lines: string[] = [];

  const files = r.diff.files.filter((f) => !f.ignored).length;
  lines.push(
    `${c.cyan('▸')} ${c.bold(`Juror ${displayVersion(o.version)}`)} ${c.dim(
      `· ${files} file${files === 1 ? '' : 's'} (+${r.diff.totalAdditions}/-${r.diff.totalDeletions}) · ${formatDuration(r.durationMs)}`,
    )}`,
  );
  lines.push('');

  const cap = capNote(r);
  lines.push(
    `  ${label('Merge confidence')}${scoreText(r.verdict.score, c)}${cap ? c.dim(`  ${cap}`) : ''}`,
  );
  lines.push(`  ${label('Models')}${c.dim(modelsLine(r.runs))}`);
  lines.push(
    `  ${label('Findings')}${c.dim(`${r.published.length} published, ${r.suppressed.length} suppressed`)}`,
  );

  if (r.published.length) {
    lines.push('');
    for (const cluster of r.published) lines.push(findingLine(cluster, models, c));
  } else {
    lines.push('');
    lines.push(c.dim('  No publishable findings.'));
  }

  const outsideDiff = r.published.filter((x) => x.anchor === 'outside-diff').length;
  if (outsideDiff > 0) {
    lines.push(
      c.dim(`  ${outsideDiff} finding${outsideDiff === 1 ? '' : 's'} sit outside the diff and post to the summary only.`),
    );
  }

  lines.push('');
  lines.push(...costTable(r, c));

  const notes = degradedRuns(r.runs);
  if (notes.length) {
    lines.push('');
    for (const n of notes) lines.push(`  ${c.yellow('!')} ${trunc(n, WIDTH - 4)}`);
  }

  if (r.warnings.length) {
    lines.push('');
    for (const w of r.warnings.slice(0, 5)) lines.push(c.dim(`  ${trunc(redact(w), WIDTH - 2)}`));
    if (r.warnings.length > 5) lines.push(c.dim(`  …and ${r.warnings.length - 5} more warnings`));
  }

  return `${lines.join('\n')}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sections
// ─────────────────────────────────────────────────────────────────────────────

function findingLine(x: Cluster, models: number, c: Palette): string {
  const sev = paintSeverity(x.severity, c);
  const loc = pad(trunc(`${x.path}:${x.line}`, LOC_WIDTH), LOC_WIDTH);
  const title = pad(trunc(redact(x.title), TITLE_WIDTH), TITLE_WIDTH);
  const agree = `${dots(x.agreement, models)} ${x.agreement}/${models}`;
  return `  ${sev}  ${c.dim(loc)}  ${title} ${c.dim(agree)}`;
}

function costTable(r: ReviewResult, c: Palette): string[] {
  const out: string[] = [];
  // A skipped model provably spent nothing; printing "$0.00 estimated" implies we did
  // the arithmetic on a run that never happened.
  const skipped = new Set(r.runs.filter((x) => x.skipped).map((x) => x.modelLabel));
  out.push(
    c.dim(
      `  ${pad('Model', 18)} ${pad('Harness', 12)} ${padStart('Input', 8)} ${padStart('Output', 8)} ${padStart('Cost', 9)}  Source`,
    ),
  );
  for (const row of r.totals.rows) {
    const u = skipped.has(row.label) ? null : row.usage;
    out.push(
      `  ${pad(trunc(row.label, 18), 18)} ${c.dim(pad(trunc(row.harnessLabel, 12), 12))} ` +
        `${padStart(u ? formatTokens(u.uncachedIn + u.cacheRead + u.cacheWrite) : '—', 8)} ` +
        `${padStart(u ? formatTokens(u.out) : '—', 8)} ` +
        `${padStart(skipped.has(row.label) ? '—' : formatUsd(row.cost.usd), 9)}  ` +
        c.dim(skipped.has(row.label) ? 'skipped' : row.cost.source),
    );
  }
  const total = r.totals.usd === null ? 'unknown' : formatUsd(r.totals.usd);
  out.push(
    `  ${c.bold(pad('Total', 18))} ${pad('', 12)} ${padStart(formatTokens(r.totals.usage.uncachedIn + r.totals.usage.cacheRead + r.totals.usage.cacheWrite), 8)} ` +
      `${padStart(formatTokens(r.totals.usage.out), 8)} ${c.bold(padStart(r.totals.partial && r.totals.usd !== null ? `≥ ${total}` : total, 9))}`,
  );
  if (r.totals.partial) {
    out.push(c.dim('  Total is a lower bound — at least one model reported no cost or usage.'));
  }
  return out;
}

function modelsLine(runs: ModelRun[]): string {
  const ran = runs.filter((x) => !x.skipped && x.ok).length;
  const skipped = runs.filter((x) => x.skipped).length;
  const failed = runs.filter((x) => !x.skipped && !x.ok).length;
  const parts = [`${ran} ran`];
  if (skipped) parts.push(`${skipped} skipped`);
  if (failed) parts.push(`${failed} failed`);
  return parts.join(', ');
}

function degradedRuns(runs: ModelRun[]): string[] {
  const out: string[] = [];
  for (const run of runs) {
    if (run.skipped) out.push(`${run.modelLabel} skipped — ${redact(run.skipReason ?? 'no reason given')}`);
    else if (!run.ok) out.push(`${run.modelLabel} failed — ${redact(run.error ?? 'no error text')}`);
  }
  return out;
}

function capNote(r: ReviewResult): string {
  const { base, penalty, confirmed } = r.verdict;
  const parts: string[] = [];
  for (const s of ['P0', 'P1', 'P2'] as const) {
    const n = confirmed[s] ?? 0;
    if (n > 0) parts.push(`${n} ${s}`);
  }
  const median = Number.isInteger(base) ? String(base) : String(Math.round(base * 10) / 10);
  if (parts.length === 0) return `(median ${median})`;
  return `(median ${median}, capped at ${Math.max(1, 5 - penalty)} by ${parts.join(', ')})`;
}

function scoreText(score: number, c: Palette): string {
  const text = `${score}/5`;
  if (score <= 2) return c.red(text);
  if (score === 3) return c.yellow(text);
  return c.green(text);
}

function paintSeverity(s: Severity, c: Palette): string {
  const rank = severityRank(s);
  if (rank === 0) return c.boldRed(s);
  if (rank === 1) return c.red(s);
  if (rank === 2) return c.yellow(s);
  return c.dim(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout & colour
// ─────────────────────────────────────────────────────────────────────────────

function label(s: string): string {
  return pad(s, 18);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function padStart(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

function trunc(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : `${flat.slice(0, Math.max(0, n - 1))}…`;
}

interface Palette {
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  boldRed: (s: string) => string;
  yellow: (s: string) => string;
  green: (s: string) => string;
  cyan: (s: string) => string;
}

/** Read at call time, not module load: tests and piped runs flip these between calls. */
function colorEnabled(): boolean {
  return !process.env.NO_COLOR && process.stdout.isTTY === true;
}

function palette(on: boolean): Palette {
  const wrap = (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    red: wrap('31'),
    boldRed: wrap('1;31'),
    yellow: wrap('33'),
    green: wrap('32'),
    cyan: wrap('36'),
  };
}
