/**
 * Inline review comments — §3.2.
 *
 * Selection is as much of the product as rendering: a comment on a line GitHub cannot
 * anchor is rejected for the whole batched review, so anything without a diff position
 * is diverted to overflow (it still reaches the reader through the summary) rather than
 * risking the review call.
 */

import type { Cluster, DiffContext, DiffFile, JurorConfig } from '../types.js';
import { findingMarker } from '../github/fingerprint.js';
import { pinnedTag, REPO_SLUG } from './receipt.js';
import { dots, mdBlock, mdCell, mdText, severityRank } from './summary.js';

export interface InlineComment {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
  cluster: Cluster;
}

export interface InlineOptions {
  version: string;
  /** Denominator for the agreement dots; defaults to this cluster's own agreement. */
  modelsRun?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

export function renderInlineComment(c: Cluster, o: InlineOptions): string {
  const models = Math.max(o.modelsRun ?? c.agreement, c.agreement, 1);
  const blocks: string[] = [
    findingMarker(c),
    `${badge(c.severity, o.version)} **${mdText(c.title)}**`,
  ];

  const body = mdBlock(c.body);
  if (body) blocks.push(body);

  blocks.push(`<sub>${attribution(c, models)}</sub>`);
  return blocks.join('\n\n');
}

/**
 * Badges are SVGs in our own repo at a pinned tag — no external asset host, so a PR page
 * never makes a third-party request on our behalf, and a retag cannot restyle old
 * comments.
 */
function badge(severity: string, version: string): string {
  const name = severity.toLowerCase();
  return `<img alt="${severity}" src="https://raw.githubusercontent.com/${REPO_SLUG}/${pinnedTag(version)}/assets/badges/${name}.svg" align="top">`;
}

function attribution(c: Cluster, models: number): string {
  const parts = [
    `\`${dots(c.agreement, models)}\` **${c.agreement}/${models} models** — ${c.modelLabels.map((l) => mdCell(l)).join(', ')}`,
  ];
  // Only a survived refutation is worth advertising; a refuted cluster never gets here.
  if (c.verification && !c.verification.refuted) parts.push('verified');
  if (c.convention) parts.push(`convention: \`${mdCell(c.convention)}\``);
  return parts.join(' · ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Selection
// ─────────────────────────────────────────────────────────────────────────────

export function selectInlineComments(
  published: Cluster[],
  config: JurorConfig,
  diff: DiffContext,
  o?: Partial<InlineOptions>,
): { comments: InlineComment[]; overflow: Cluster[] } {
  const byPath = new Map<string, DiffFile>();
  for (const f of diff.files) byPath.set(f.path, f);

  const floor = severityRank(config.review.severity_floor);
  const cap = Math.max(0, config.review.max_inline_comments);
  // Everything shares one denominator so the dots are consistent across the review.
  const models = Math.max(
    o?.modelsRun ?? 0,
    published.reduce((m, c) => Math.max(m, c.agreement), 0),
    1,
  );

  const sorted = [...published].sort(byPriority);
  const comments: InlineComment[] = [];
  const overflow: Cluster[] = [];

  for (const c of sorted) {
    if (severityRank(c.severity) > floor) {
      overflow.push(c);
      continue;
    }
    const position = byPath.get(c.path)?.positionByLine.get(c.line);
    if (position === undefined) {
      overflow.push(c);
      continue;
    }
    if (comments.length >= cap) {
      overflow.push(c);
      continue;
    }
    comments.push({
      path: c.path,
      line: c.line,
      side: 'RIGHT',
      body: renderInlineComment(c, { version: o?.version ?? '', modelsRun: models }),
      cluster: c,
    });
  }

  return { comments, overflow };
}

/** P0 first, then the best-corroborated, then stable by location. */
function byPriority(a: Cluster, b: Cluster): number {
  return (
    severityRank(a.severity) - severityRank(b.severity) ||
    b.agreement - a.agreement ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
    a.line - b.line
  );
}
