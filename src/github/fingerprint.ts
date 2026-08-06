/**
 * A stable identity for a finding, so a re-review can recognize what it already said.
 *
 * The inputs are deliberately the three things that stay put when a model rewords itself:
 * file, severity, and the shape of the title. Line number is excluded on purpose — the same
 * bug drifts by a few lines every push, and a fingerprint that changes on every push is
 * useless for stable deduplication across reruns.
 */

import { createHash } from 'node:crypto';
import type { Cluster } from '../types.js';

/** Two models saying "Off-by-one in `slice`" and "off by one in slice!" must hash alike. */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function fingerprint(c: Cluster): string {
  const material = `${c.path}\n${c.severity}\n${normalizeTitle(c.title)}`;
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 12);
}

const MARKER_RE = /<!--\s*juror:finding:([0-9a-f]{12})\s*-->/gi;

/** Hidden identity embedded in inline comments so a later push does not repost the bug. */
export function findingMarker(c: Cluster): string {
  return `<!-- juror:finding:${fingerprint(c)} -->`;
}

export function fingerprintsIn(body: string): string[] {
  const out = new Set<string>();
  for (const match of body.matchAll(MARKER_RE)) {
    const value = match[1]?.toLowerCase();
    if (value) out.add(value);
  }
  return [...out];
}
