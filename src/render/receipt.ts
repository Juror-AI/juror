/**
 * The cost receipt — §3.1's `<details>` block, under §9's rules.
 *
 * This file only formats; it never computes. A figure the cost engine could not
 * establish arrives here as `null` and prints as `unknown`, because a fabricated
 * number in this table discredits every other number in the comment.
 */

import type { CostRow, CostTotals } from '../types.js';
import type { RollingSpend } from '../cost/rolling.js';

export interface ReceiptOptions {
  durationMs: number;
  rolling?: RollingSpend | null;
  /** Models that never ran — §10 "degrade, never fail" has to be visible, not silent. */
  skipped?: ReceiptNote[];
  /** Models that started and blew up. Same reason: the blank row needs an explanation. */
  failed?: ReceiptNote[];
  /** Models whose last on-disk report survived an interrupted agent loop. */
  partial?: ReceiptNote[];
  /** Pinned tag for the `pricing.json` link in the legend. */
  version?: string;
}

export interface ReceiptNote {
  label: string;
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Number formatting
// ─────────────────────────────────────────────────────────────────────────────

export function formatUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return 'unknown';
  if (n === 0) return '$0.00';
  if (Math.abs(n) >= 0.01) return `$${n.toFixed(2)}`;
  // Sub-cent charges are real at fan-out scale — a $0.0043 referee call must not
  // round to `$0.00`, which reads as "free" rather than "cheap".
  const small = n.toFixed(4);
  return Number(small) === 0 ? '<$0.0001' : `$${small}`;
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  const v = Math.round(n);
  if (v < 1_000) return String(v);
  if (v < 100_000) return `${(v / 1_000).toFixed(1)}k`;
  if (v < 1_000_000) return `${Math.round(v / 1_000)}k`;
  return `${(v / 1_000_000).toFixed(1)}M`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1_000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The receipt
// ─────────────────────────────────────────────────────────────────────────────

const DASH = '—';

export function renderReceipt(totals: CostTotals, o: ReceiptOptions): string {
  const skipped = o.skipped ?? [];
  const failed = o.failed ?? [];
  const partial = o.partial ?? [];
  const skippedLabels = new Set(skipped.map((s) => s.label));

  const headline = `<b>💸 This review cost ${headlineAmount(totals)}</b>`;
  const lines: string[] = [];
  lines.push(
    `<details><summary>${headline} · ${plural(totals.modelsRun, 'model')} · ${formatDuration(o.durationMs)}</summary>`,
  );
  lines.push('');
  lines.push('| Model | Harness | Input | Cached | Output | Cost | Source |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const row of totals.rows) lines.push(modelRow(row, skippedLabels.has(row.label)));
  lines.push(totalRow(totals));
  lines.push('');

  lines.push('*reported* = provider-computed figure returned by the harness.');
  lines.push(
    `*estimated* = token counts × published list price (${pricingLink(o.version)}). Long-context tiers applied.`,
  );
  lines.push(
    '*Cached* combines cache reads and cache writes; writes bill at a premium, so the first review of a diff costs more than a re-review of it.',
  );

  if (totals.partial) {
    const unknown = totals.rows
      .filter((r) => r.cost.source === 'unknown' || r.cost.partial === true)
      .map((r) => code(r.label));
    lines.push('');
    lines.push(
      unknown.length
        ? `**The total is a lower bound** — no cost or usage was reported for ${unknown.join(', ')}.`
        : '**The total is a lower bound** — at least one row reported neither cost nor tokens.',
    );
  }

  const notes = totals.rows
    .filter((r) => r.cost.note && !skippedLabels.has(r.label))
    .map((r) => `*${cell(r.label)}: ${cell(r.cost.note ?? '')}*`);
  if (notes.length) {
    lines.push('');
    for (const n of notes) lines.push(n);
  }

  if (skipped.length || failed.length || partial.length) {
    lines.push('');
    if (skipped.length) lines.push(`Skipped: ${skipped.map(noteText).join(' · ')}`);
    if (failed.length) lines.push(`Failed: ${failed.map(noteText).join(' · ')}`);
    if (partial.length) lines.push(`Partial: ${partial.map(noteText).join(' · ')}`);
  }

  if (o.rolling) lines.push('', rollingLine(o.rolling));

  lines.push('</details>');
  return lines.join('\n');
}

function headlineAmount(totals: CostTotals): string {
  if (totals.usd === null) return 'an unknown amount';
  return totals.partial ? `at least ${formatUsd(totals.usd)}` : formatUsd(totals.usd);
}

function modelRow(row: CostRow, isSkipped: boolean): string {
  const model = row.modelRef
    ? `${cell(row.label)}<br><sub>${cell(row.modelRef)}</sub>`
    : code(row.label);
  const harness = cell(row.harnessLabel);
  if (isSkipped) {
    return `| ${model} | ${harness} | ${DASH} | ${DASH} | ${DASH} | ${DASH} | *skipped* |`;
  }
  const u = row.usage;
  const input = u ? formatTokens(u.uncachedIn) : DASH;
  const cached = u ? formatTokens(u.cacheRead + u.cacheWrite) : DASH;
  const out = u ? formatTokens(u.out) : DASH;
  return `| ${model} | ${harness} | ${input} | ${cached} | ${out} | ${formatUsd(row.cost.usd)} | ${sourceCell(row)} |`;
}

function totalRow(totals: CostTotals): string {
  const u = totals.usage;
  const usd = totals.usd === null ? 'unknown' : formatUsd(totals.usd);
  const total = totals.partial && totals.usd !== null ? `≥ ${usd}` : usd;
  return `| **Total** | | **${formatTokens(u.uncachedIn)}** | **${formatTokens(u.cacheRead + u.cacheWrite)}** | **${formatTokens(u.out)}** | **${total}** | |`;
}

function sourceCell(row: CostRow): string {
  const base = row.cost.source === 'reported' ? 'reported' : `*${row.cost.source}*`;
  const usage = row.usageSource ? ` (${row.usageSource} usage)` : '';
  return `${base}${row.cost.longContext ? ', long-context' : ''}${usage}`;
}

function rollingLine(r: RollingSpend): string {
  const avg = r.prCount > 0 && r.totalUsd > 0 ? ` (avg ${formatUsd(r.totalUsd / r.prCount)}/PR)` : '';
  return `Rolling ${r.windowDays}d for this repo: **${formatUsd(r.totalUsd)}** across ${plural(r.prCount, 'PR')}${avg}`;
}

function pricingLink(version: string | undefined): string {
  const tag = pinnedTag(version);
  return `[pricing.json](https://github.com/${REPO_SLUG}/blob/${tag}/src/cost/pricing.json)`;
}

function noteText(n: ReceiptNote): string {
  return `${code(n.label)} (${cell(n.reason)})`;
}

/** Our own repo, pinned: the receipt links must not drift with `main`. */
export const REPO_SLUG = 'juror-ai/juror';

/**
 * `v1` is the action's floating major tag — the only ref we can name when the caller
 * could not tell us its own version, and it always resolves.
 */
export function pinnedTag(version: string | undefined): string {
  const v = (version ?? '').trim().replace(/^v/, '');
  return v ? `v${v}` : 'v1';
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Every row label is backticked — model ids and display labels alike line the column up. */
function code(s: string): string {
  return `\`${cell(s)}\``;
}

/** Table cells here hold config and harness strings, not model prose — pipes still bite. */
function cell(s: string): string {
  return s.replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim();
}
