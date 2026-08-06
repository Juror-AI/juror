/**
 * Snap model-reported `(path, line)` pairs onto lines the diff actually touches.
 *
 * Models are confident and slightly wrong about line numbers — they count from the
 * hunk header, or from the file as it looked before the change. A finding that misses
 * by two lines is still a real finding, so we snap it; a finding we cannot place is
 * still reported, just not inline. Nothing is ever dropped here.
 */

import type { AnchorStatus, AttributedFinding, DiffContext, DiffFile, RawFinding } from '../types.js';

export function anchorFindings(
  findings: RawFinding[],
  diff: DiffContext,
  modelId: string,
  modelLabel: string,
  tolerance: number,
): AttributedFinding[] {
  const index = buildIndex(diff.files);
  const tol = Number.isFinite(tolerance) ? Math.max(0, tolerance) : 0;
  return findings.map((f) => anchorOne(f, index, modelId, modelLabel, tol));
}

interface FileIndex {
  byPath: Map<string, DiffFile>;
  all: DiffFile[];
}

function buildIndex(files: DiffFile[]): FileIndex {
  const byPath = new Map<string, DiffFile>();
  for (const f of files) {
    byPath.set(normalizePath(f.path), f);
    // A model that read the pre-image may cite the old name of a renamed file.
    if (f.previousPath) {
      const prev = normalizePath(f.previousPath);
      if (!byPath.has(prev)) byPath.set(prev, f);
    }
  }
  return { byPath, all: files };
}

function anchorOne(
  finding: RawFinding,
  index: FileIndex,
  modelId: string,
  modelLabel: string,
  tolerance: number,
): AttributedFinding {
  const line = Number.isFinite(finding.line) ? Math.trunc(finding.line) : 0;
  const file = findFile(finding.path, index);

  if (!file) return attribute(finding, modelId, modelLabel, line, 'unknown-file', 0);

  // A binary or pure-deletion file has no post-image line to anchor to at all.
  const nearest = nearestChangedLine(file.changedLines, line);
  if (nearest === null) return attribute(finding, modelId, modelLabel, line, 'outside-diff', 0);
  if (nearest === line) return attribute(finding, modelId, modelLabel, line, 'exact', 0);

  const drift = Math.abs(nearest - line);
  if (drift <= tolerance) return attribute(finding, modelId, modelLabel, nearest, 'snapped', drift);
  return attribute(finding, modelId, modelLabel, line, 'outside-diff', drift);
}

function attribute(
  finding: RawFinding,
  modelId: string,
  modelLabel: string,
  anchoredLine: number,
  anchor: AnchorStatus,
  anchorDrift: number,
): AttributedFinding {
  return { ...finding, modelId, modelLabel, anchoredLine, anchor, anchorDrift };
}

/**
 * Exact path first, then a suffix match in either direction: models routinely emit a
 * path relative to a subdirectory they were reading (`patch.ts` for `src/diff/patch.ts`)
 * or with a workspace prefix glued on. Ambiguous suffixes resolve to the shortest
 * candidate so the result is stable regardless of file order.
 */
function findFile(rawPath: string, index: FileIndex): DiffFile | null {
  const path = normalizePath(rawPath);
  if (!path) return null;

  const exact = index.byPath.get(path);
  if (exact) return exact;

  const endsWithPath = index.all.filter((f) => normalizePath(f.path).endsWith(`/${path}`));
  const best = shortest(endsWithPath);
  if (best) return best;

  const containedBy = index.all.filter((f) => path.endsWith(`/${normalizePath(f.path)}`));
  return shortest(containedBy);
}

function shortest(files: DiffFile[]): DiffFile | null {
  let best: DiffFile | null = null;
  for (const f of files) {
    if (!best || f.path.length < best.path.length || (f.path.length === best.path.length && f.path < best.path)) {
      best = f;
    }
  }
  return best;
}

/** `changedLines` is sorted ascending, so binary-search the insertion point. Ties go low. */
function nearestChangedLine(changedLines: number[], line: number): number | null {
  if (!changedLines.length) return null;

  let lo = 0;
  let hi = changedLines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((changedLines[mid] ?? 0) < line) lo = mid + 1;
    else hi = mid;
  }

  const after = changedLines[lo];
  const before = changedLines[lo - 1];
  if (after === undefined) return before ?? null;
  if (before === undefined) return after;
  return line - before <= after - line ? before : after;
}

function normalizePath(p: string): string {
  let out = p.trim().replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  while (out.startsWith('/')) out = out.slice(1);
  return out;
}
