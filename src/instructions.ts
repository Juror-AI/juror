/**
 * Repository review instructions.
 *
 * Agents are unreliable at remembering to discover AGENTS.md on their own, so Juror
 * resolves the files that apply to the changed paths and puts their contents directly in
 * the prompt. Read from the base revision whenever possible: a pull request must not be
 * able to rewrite the rules used to review itself.
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { run } from './util/proc.js';

export interface LoadedAgentInstructions {
  rendered: string;
  paths: string[];
  problems: string[];
}

const NONE = '(No applicable AGENTS.md file exists at the review base.)';
const CACHE = new Map<string, Promise<LoadedAgentInstructions>>();

function candidateDirectories(changedPaths: string[]): string[] {
  const dirs = new Set<string>(['']);

  for (const raw of changedPaths) {
    const normalized = path.posix.normalize(raw.replaceAll('\\', '/'));
    if (
      path.posix.isAbsolute(normalized) ||
      normalized === '..' ||
      normalized.startsWith('../')
    ) {
      continue;
    }

    const parts = normalized.split('/').filter(Boolean);
    // The last segment is the changed file. Every preceding directory can scope it.
    for (let depth = 1; depth < parts.length; depth++) {
      dirs.add(parts.slice(0, depth).join('/'));
    }
  }

  return [...dirs].sort((a, b) => {
    const depth = a.split('/').filter(Boolean).length - b.split('/').filter(Boolean).length;
    return depth || a.localeCompare(b);
  });
}

async function listBaseInstructions(
  repoDir: string,
  baseSha: string,
  signal?: AbortSignal,
): Promise<string[] | null> {
  if (!baseSha.trim()) return null;
  // `git ls-tree` does not support pathspec magic such as `icase` or `glob`, so list names
  // once and filter in-process. One tree walk is still much cheaper than two git processes
  // for every directory touched by a large pull request.
  const io = await run(['git', 'ls-tree', '-r', '--name-only', baseSha], {
    cwd: repoDir,
    timeoutMs: 30_000,
    ...(signal ? { signal } : {}),
  });
  signal?.throwIfAborted();
  if (io.exitCode !== 0) return null;
  return io.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && path.posix.basename(line).toLowerCase() === 'agents.md');
}

async function readFromBase(
  repoDir: string,
  baseSha: string,
  file: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const io = await run(['git', 'show', `${baseSha}:${file}`], {
    cwd: repoDir,
    timeoutMs: 30_000,
    ...(signal ? { signal } : {}),
  });
  signal?.throwIfAborted();
  return io.exitCode === 0 ? io.stdout : null;
}

async function readFromWorkspace(
  repoDir: string,
  dir: string,
): Promise<{ path: string } | null> {
  try {
    const absoluteDir = dir ? path.join(repoDir, ...dir.split('/')) : repoDir;
    const entries = await readdir(absoluteDir, { withFileTypes: true });
    const entry =
      entries.find((e) => e.name === 'AGENTS.md') ??
      entries.find((e) => e.name.toLowerCase() === 'agents.md');
    if (!entry || (!entry.isFile() && !entry.isSymbolicLink())) return null;
    const file = dir ? `${dir}/${entry.name}` : entry.name;
    // A head-only instruction is untrusted and ignored; only its repository-relative name is
    // needed for the diagnostic. Never follow or read a PR-controlled symlink here (for example
    // AGENTS.md -> /dev/zero), which could otherwise create an unbounded pre-agent read.
    return { path: file };
  } catch {
    return null;
  }
}

function render(files: { path: string; contents: string }[]): string {
  if (files.length === 0) return NONE;
  return files
    .map(({ path: file, contents }) => {
      const body = contents.trim() || '(empty file)';
      return `--- BEGIN ${file} ---\n${body}\n--- END ${file} ---`;
    })
    .join('\n\n');
}

async function loadUncached(
  repoDir: string,
  baseSha: string,
  changedPaths: string[],
  signal?: AbortSignal,
): Promise<LoadedAgentInstructions> {
  signal?.throwIfAborted();
  const directories = candidateDirectories(changedPaths);
  const changed = new Set(changedPaths);
  const basePaths = await listBaseInstructions(repoDir, baseSha, signal);
  const reachable = basePaths !== null;
  if (!reachable) {
    // Never promote the checked-out PR head to trusted policy. The visible patch can be
    // path-filtered, incrementally narrowed, or truncated, so `changedPaths` is not proof
    // that an apparently unchanged workspace AGENTS.md was absent from the full change.
    return {
      rendered: NONE,
      paths: [],
      problems: [
        `review base ${baseSha.slice(0, 12) || '(unknown)'} unavailable; workspace AGENTS.md was not trusted`,
      ],
    };
  }
  const baseByDirectory = new Map<string, string>();
  for (const file of basePaths ?? []) {
    const dir = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);
    const existing = baseByDirectory.get(dir);
    // Prefer the conventional uppercase spelling if a repository somehow has both.
    if (!existing || path.posix.basename(file) === 'AGENTS.md') baseByDirectory.set(dir, file);
  }
  const files: { path: string; contents: string }[] = [];
  const problems: string[] = [];

  for (const dir of directories) {
    const basePath = baseByDirectory.get(dir);
    if (basePath) {
      const contents = await readFromBase(repoDir, baseSha, basePath, signal);
      if (contents !== null) {
        files.push({ path: basePath, contents });
      } else {
        // The tree walk already proved this path exists at the base, so a failed read means
        // the blob itself is unreachable — the normal cause is a partial clone whose on-demand
        // fetch could not reach the promisor remote. Reviewing without a rule the repository
        // does have is a quieter failure than reviewing with a rule it does not, so say so.
        problems.push(`could not read ${basePath} at review base ${baseSha.slice(0, 12)}`);
      }
      continue;
    }

    // A newly added instruction file is part of the untrusted PR, not review policy.
    const workspace = await readFromWorkspace(repoDir, dir);
    if (workspace && changed.has(workspace.path)) {
      problems.push(`ignored ${workspace.path} because it does not exist at the review base`);
    }
  }

  return { rendered: render(files), paths: files.map((f) => f.path), problems };
}

/** Load root and nested AGENTS.md files that scope at least one changed file. */
export function loadAgentInstructions(
  repoDir: string,
  baseSha: string,
  changedPaths: string[],
  signal?: AbortSignal,
): Promise<LoadedAgentInstructions> {
  // A command-scoped signal must not poison the process-wide cache for later callers.
  if (signal) return loadUncached(repoDir, baseSha, changedPaths, signal);
  // Main fan-out and verification use the same context. Keep their policy byte-identical
  // and avoid walking a large repository tree twice during one review process.
  const key = `${repoDir}\0${baseSha}\0${[...new Set(changedPaths)].sort().join('\0')}`;
  const cached = CACHE.get(key);
  if (cached) return cached;
  const pending = loadUncached(repoDir, baseSha, changedPaths);
  CACHE.set(key, pending);
  return pending;
}
