/**
 * Workspace guard.
 *
 * Two of the four harnesses cannot be pinned to a read-only filesystem: opencode drops its
 * write tool entirely if you deny edits by glob (measured — see docs/harness-notes.md),
 * and Claude Code sandboxes by tool removal rather than by kernel. Since a reviewer must be
 * able to write its findings file, "the agent can write" is a property we have to live with.
 *
 * So we make it observable instead: snapshot which tracked files are clean before fan-out,
 * and afterwards restore exactly those that the run dirtied. A file that was ALREADY dirty
 * before the run is never touched — restoring it would destroy the operator's uncommitted
 * work, which is a far worse failure than a stray agent edit.
 */

import { run, runOrThrow } from './proc.js';
import { log } from './log.js';

export interface WorkspaceSnapshot {
  repoDir: string;
  /** Tracked paths that were already modified before the run — off limits. */
  dirtyBefore: Set<string>;
  /** Untracked paths that existed before the run — off limits. */
  untrackedBefore: Set<string>;
  /** Path prefix that the run is allowed to create freely. */
  scratchPrefix: string;
}

export interface WorkspaceDrift {
  restored: string[];
  removed: string[];
  /** Paths we detected but deliberately left alone, with the reason. */
  left: { path: string; reason: string }[];
}

function parsePorcelain(out: string): { dirty: Set<string>; untracked: Set<string> } {
  const dirty = new Set<string>();
  const untracked = new Set<string>();
  for (const line of out.split('\n')) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    // Renames read as "R  old -> new"; the post-image path is what we care about.
    const raw = line.slice(3);
    const path = raw.includes(' -> ') ? raw.slice(raw.indexOf(' -> ') + 4) : raw;
    const clean = path.replace(/^"|"$/g, '');
    if (code === '??') untracked.add(clean);
    else dirty.add(clean);
  }
  return { dirty, untracked };
}

export async function snapshotWorkspace(
  repoDir: string,
  scratchPrefix: string,
): Promise<WorkspaceSnapshot | null> {
  const io = await run(['git', 'status', '--porcelain', '--untracked-files=all'], {
    cwd: repoDir,
    timeoutMs: 120_000,
  });
  if (io.exitCode !== 0) {
    log.debug('workspace guard disabled: not a git repository');
    return null;
  }
  const { dirty, untracked } = parsePorcelain(io.stdout);
  return { repoDir, dirtyBefore: dirty, untrackedBefore: untracked, scratchPrefix };
}

/** Undo whatever the agents changed outside their scratch dirs, and report what we found. */
export async function restoreWorkspace(snap: WorkspaceSnapshot | null): Promise<WorkspaceDrift> {
  const drift: WorkspaceDrift = { restored: [], removed: [], left: [] };
  if (!snap) return drift;

  const io = await run(['git', 'status', '--porcelain', '--untracked-files=all'], {
    cwd: snap.repoDir,
    timeoutMs: 120_000,
  });
  if (io.exitCode !== 0) return drift;

  const { dirty, untracked } = parsePorcelain(io.stdout);

  const toRestore: string[] = [];
  for (const p of dirty) {
    if (p.startsWith(snap.scratchPrefix)) continue;
    if (snap.dirtyBefore.has(p)) {
      drift.left.push({ path: p, reason: 'already modified before the review started' });
      continue;
    }
    toRestore.push(p);
  }

  const toRemove: string[] = [];
  for (const p of untracked) {
    if (p.startsWith(snap.scratchPrefix)) continue;
    if (snap.untrackedBefore.has(p)) continue;
    toRemove.push(p);
  }

  if (toRestore.length) {
    // `git checkout --` only ever writes the committed content back, so this cannot
    // touch anything beyond the paths we verified were clean a moment ago.
    const res = await run(['git', 'checkout', '--', ...toRestore], {
      cwd: snap.repoDir,
      timeoutMs: 120_000,
    });
    if (res.exitCode === 0) drift.restored.push(...toRestore);
    else for (const p of toRestore) drift.left.push({ path: p, reason: 'git checkout failed' });
  }

  for (const p of toRemove) {
    const res = await run(['git', 'clean', '-fq', '--', p], { cwd: snap.repoDir, timeoutMs: 60_000 });
    if (res.exitCode === 0) drift.removed.push(p);
    else drift.left.push({ path: p, reason: 'git clean failed' });
  }

  return drift;
}

/** Resolve the repository root, so a run started in a subdirectory still anchors correctly. */
export async function repoRoot(dir: string): Promise<string> {
  try {
    return (await runOrThrow(['git', 'rev-parse', '--show-toplevel'], { cwd: dir })).trim();
  } catch {
    return dir;
  }
}
