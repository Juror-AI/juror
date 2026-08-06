/**
 * Ephemeral checkouts.
 *
 * The whole premise is that the agent greps the repo rather than reading a diff in isolation
 * — which only works if the repo on disk is at the PR's head commit. In Actions that is free
 * (`actions/checkout` already put you there). Locally it is not: `juror review --pr 1234`
 * from a branch you happen to be on would have every model reading the wrong code and
 * confidently reporting on functions the PR already changed.
 *
 * So when the checkout isn't at the head SHA, we add a detached `git worktree` and review
 * that instead. It shares the object store, leaves the operator's working tree completely
 * alone, and is removed afterwards.
 */

import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { run, runOrThrow } from './proc.js';
import { log } from './log.js';

export interface EphemeralCheckout {
  dir: string;
  /** True when we created a worktree that must be torn down. */
  ephemeral: boolean;
  cleanup(): Promise<void>;
}

const NOOP = async (): Promise<void> => {};

async function headSha(repoDir: string): Promise<string | null> {
  const io = await run(['git', 'rev-parse', 'HEAD'], { cwd: repoDir, timeoutMs: 30_000 });
  return io.exitCode === 0 ? io.stdout.trim() : null;
}

async function hasCommit(repoDir: string, sha: string): Promise<boolean> {
  const io = await run(['git', 'cat-file', '-e', `${sha}^{commit}`], {
    cwd: repoDir,
    timeoutMs: 30_000,
  });
  return io.exitCode === 0;
}

/**
 * Ensure `sha` is reachable in the local object store. A PR head from a fork is not reachable
 * by SHA alone, so fall back to the `refs/pull/N/head` ref GitHub publishes.
 */
async function ensureCommit(repoDir: string, sha: string, prNumber: number | null): Promise<boolean> {
  if (await hasCommit(repoDir, sha)) return true;

  log.debug(`fetching ${sha.slice(0, 12)}`);
  const attempts: string[][] = [['git', 'fetch', '--no-tags', '--depth=50', 'origin', sha]];
  if (prNumber !== null) {
    attempts.push(['git', 'fetch', '--no-tags', 'origin', `pull/${prNumber}/head`]);
  }
  attempts.push(['git', 'fetch', '--no-tags', 'origin']);

  for (const argv of attempts) {
    const io = await run(argv, { cwd: repoDir, timeoutMs: 300_000 });
    if (io.exitCode === 0 && (await hasCommit(repoDir, sha))) return true;
  }
  return false;
}

export async function checkoutAt(
  repoDir: string,
  sha: string,
  o: { prNumber?: number | null } = {},
): Promise<EphemeralCheckout> {
  const current = await headSha(repoDir);
  if (current && current === sha) {
    log.debug('checkout is already at the head commit');
    return { dir: repoDir, ephemeral: false, cleanup: NOOP };
  }

  if (!(await ensureCommit(repoDir, sha, o.prNumber ?? null))) {
    log.warn(
      `Could not fetch ${sha.slice(0, 12)} — reviewing the checkout as-is at ` +
        `${current?.slice(0, 12) ?? 'unknown'}. Findings may reference stale code.`,
    );
    return { dir: repoDir, ephemeral: false, cleanup: NOOP };
  }

  // Nothing can clean up after SIGKILL, so reap earlier leaks here instead. `prune` only
  // drops registrations whose directory is already gone, which is exactly the leaked case.
  await run(['git', 'worktree', 'prune'], { cwd: repoDir, timeoutMs: 60_000 });

  // realpath, because on macOS `os.tmpdir()` is `/var/folders/...`, a symlink to
  // `/private/var/folders/...`. Handing the symlinked form to a harness makes it compare a
  // resolved file path against an unresolved root and conclude that files inside the repo
  // are outside it — opencode auto-rejects those reads and the review comes back empty.
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'juror-')));
  const target = path.join(dir, 'repo');
  try {
    await runOrThrow(['git', 'worktree', 'add', '--detach', '--quiet', target, sha], {
      cwd: repoDir,
      timeoutMs: 600_000,
    });
  } catch (error) {
    // `add` may fail (disk full, target already registered) before the cleanup closure below
    // exists to reap it, so remove the mkdtemp dir here rather than leak it into os.tmpdir().
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  log.debug(`reviewing detached worktree at ${sha.slice(0, 12)}`);

  return {
    dir: target,
    ephemeral: true,
    cleanup: async () => {
      await run(['git', 'worktree', 'remove', '--force', target], {
        cwd: repoDir,
        timeoutMs: 120_000,
      });
      await rm(dir, { recursive: true, force: true });
    },
  };
}
