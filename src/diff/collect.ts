/**
 * Build the `DiffContext` every later stage reads: from a local git checkout, or from a
 * patch the GitHub API already handed us.
 *
 * Both paths run the same normalization — filter by `paths_ignore`, clamp to
 * `max_diff_bytes`, then parse — so a review of a fetched patch and a review of the same
 * commits locally produce identical anchors.
 */

import type { DiffContext } from '../types.js';
import { log } from '../util/log.js';
import { run, runOrThrow } from '../util/proc.js';
import { filterPatch, parseUnifiedPatch, truncatePatch } from './patch.js';

export interface CollectOptions {
  repoDir: string;
  /** Ref or SHA; default: merge-base with the PR base. */
  base?: string;
  /** Default: `HEAD`. */
  head?: string;
  /** Incremental: only lines changed after this SHA. */
  sinceSha?: string | null;
  pathsIgnore: string[];
  maxDiffBytes: number;
}

const GIT_TIMEOUT_MS = 120_000;

export async function collectLocalDiff(o: CollectOptions): Promise<DiffContext> {
  const headSha = (await git(o.repoDir, ['rev-parse', o.head ?? 'HEAD'])).trim();
  const baseRef = o.base ?? (await defaultBaseRef(o.repoDir));
  const baseSha = await resolveBaseSha(o.repoDir, baseRef, headSha);

  const raw = await git(o.repoDir, [
    'diff',
    '--unified=3',
    '--no-color',
    '--find-renames',
    `${baseSha}..${headSha}`,
  ]);

  const sinceSha = o.sinceSha ?? null;
  const ctx = normalize(raw, {
    baseSha,
    headSha,
    sinceSha,
    pathsIgnore: o.pathsIgnore,
    maxDiffBytes: o.maxDiffBytes,
  });

  if (sinceSha) await markIncremental(ctx, o.repoDir, sinceSha, headSha);
  return ctx;
}

export function collectFromPatch(
  patch: string,
  o: {
    baseSha: string;
    headSha: string;
    sinceSha?: string | null;
    pathsIgnore: string[];
    maxDiffBytes: number;
  },
): DiffContext {
  // No repository here, so the incremental file set cannot be recomputed; the caller
  // that fetched this patch is the one that can narrow it.
  return normalize(patch, {
    baseSha: o.baseSha,
    headSha: o.headSha,
    sinceSha: o.sinceSha ?? null,
    pathsIgnore: o.pathsIgnore,
    maxDiffBytes: o.maxDiffBytes,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalization
// ─────────────────────────────────────────────────────────────────────────────

function normalize(
  raw: string,
  o: { baseSha: string; headSha: string; sinceSha: string | null; pathsIgnore: string[]; maxDiffBytes: number },
): DiffContext {
  const filtered = filterPatch(raw, o.pathsIgnore);
  const clamped = truncatePatch(filtered.patch, o.maxDiffBytes);
  const files = parseUnifiedPatch(clamped.patch);

  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const f of files) {
    totalAdditions += f.additions;
    totalDeletions += f.deletions;
  }

  if (clamped.truncated) {
    log.warn(`diff exceeded max_diff_bytes (${o.maxDiffBytes}); trailing files were dropped`);
  }
  if (filtered.ignored.length) {
    log.debug(`paths_ignore dropped ${filtered.ignored.length} file(s)`);
  }

  return {
    patch: clamped.patch,
    files,
    baseSha: o.baseSha,
    headSha: o.headSha,
    sinceSha: o.sinceSha,
    totalAdditions,
    totalDeletions,
    ignoredPaths: filtered.ignored,
    truncated: clamped.truncated,
  };
}

/**
 * Incremental re-review: keep the whole patch so the models still have context, but mark
 * files untouched since the last reviewed SHA so nothing gets re-reported on them.
 * A force-push can make `sinceSha` unreachable — that degrades to a full review.
 */
async function markIncremental(ctx: DiffContext, repoDir: string, sinceSha: string, headSha: string): Promise<void> {
  const io = await run(['git', 'diff', '--unified=0', '--no-color', '--find-renames', `${sinceSha}..${headSha}`], {
    cwd: repoDir,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (io.exitCode !== 0) {
    log.warn(`incremental base ${sinceSha.slice(0, 8)} is unreachable; reviewing the full diff`);
    return;
  }

  const touched = new Set<string>();
  for (const f of parseUnifiedPatch(io.stdout)) {
    touched.add(f.path);
    if (f.previousPath) touched.add(f.previousPath);
  }

  let ignored = 0;
  for (const f of ctx.files) {
    if (touched.has(f.path) || (f.previousPath && touched.has(f.previousPath))) continue;
    f.ignored = true;
    ignored++;
  }
  if (ignored) log.debug(`incremental: ${ignored} file(s) unchanged since ${sinceSha.slice(0, 8)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// git plumbing
// ─────────────────────────────────────────────────────────────────────────────

function git(repoDir: string, args: string[]): Promise<string> {
  return runOrThrow(['git', ...args], { cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS });
}

/** `merge-base` is what a PR is actually diffed against; a shallow clone may not have one. */
async function resolveBaseSha(repoDir: string, baseRef: string, headSha: string): Promise<string> {
  const io = await run(['git', 'merge-base', baseRef, headSha], { cwd: repoDir, timeoutMs: GIT_TIMEOUT_MS });
  const sha = io.stdout.trim();
  if (io.exitCode === 0 && sha) return sha;

  log.warn(`no merge-base between ${baseRef} and HEAD (shallow clone?); diffing against ${baseRef} directly`);
  return (await git(repoDir, ['rev-parse', baseRef])).trim();
}

async function defaultBaseRef(repoDir: string): Promise<string> {
  const probe = async (args: string[]): Promise<string | null> => {
    const io = await run(['git', ...args], { cwd: repoDir, timeoutMs: 15_000 });
    const out = io.stdout.trim();
    return io.exitCode === 0 && out ? out : null;
  };

  const originHead = await probe(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead) return originHead;

  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    if (await probe(['rev-parse', '--verify', '--quiet', candidate])) return candidate;
  }

  // Nothing to compare against — review the tip commit alone rather than failing.
  log.warn('no default branch found; falling back to HEAD~1 as the diff base');
  return 'HEAD~1';
}
