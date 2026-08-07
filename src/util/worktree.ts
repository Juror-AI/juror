/**
 * Ephemeral checkouts.
 *
 * The whole premise is that the agent greps the repo rather than reading a diff in isolation
 * — which only works if the repo on disk is at the PR's head commit. In Actions that is free
 * (`actions/checkout` already put you there). Locally it is not: `juror review --pr 1234`
 * from a branch you happen to be on would have every model reading the wrong code and
 * confidently reporting on functions the PR already changed.
 *
 * Every review uses a detached `git worktree`, even when the source checkout already points
 * at the requested SHA. Besides making the bytes deterministic, this keeps untracked local
 * files such as `.env` outside every model's read root. Local working-tree reviews can copy
 * their tracked/staged patch into that clean view without copying unrelated untracked files.
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
  /** Remove the worktree's pointer back to credential-bearing repository metadata. */
  seal(): Promise<void>;
  cleanup(): Promise<void>;
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
  o: { prNumber?: number | null; includeWorkingTree?: boolean } = {},
): Promise<EphemeralCheckout> {
  if (!(await ensureCommit(repoDir, sha, o.prNumber ?? null))) {
    throw new Error(
      `Could not fetch review head ${sha.slice(0, 12)}; refusing to expose or review the ` +
        'operator checkout as a fallback.',
    );
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

    if (o.includeWorkingTree) {
      // `git diff <sha>` contains staged and unstaged tracked changes plus staged additions.
      // Untracked files are intentionally absent: collectLocalDiff does not review them, and
      // copying them would reintroduce the `.env` exposure this checkout exists to prevent.
      const patch = await runOrThrow(
        ['git', 'diff', '--binary', '--full-index', '--no-color', sha],
        { cwd: repoDir, timeoutMs: 120_000 },
      );
      if (patch.trim()) {
        await runOrThrow(['git', 'apply', '--binary', '--whitespace=nowarn', '-'], {
          cwd: target,
          stdin: patch,
          timeoutMs: 300_000,
        });
      }
    }
  } catch (error) {
    // `add` or local-patch application may fail before the cleanup closure below exists to
    // reap it. Remove both the registration and the temp directory here.
    await run(['git', 'worktree', 'remove', '--force', target], {
      cwd: repoDir,
      timeoutMs: 120_000,
    });
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  log.debug(`reviewing detached worktree at ${sha.slice(0, 12)}`);

  return {
    dir: target,
    ephemeral: true,
    seal: async () => {
      // Linked worktrees contain a `.git` text file pointing at the source checkout's common
      // git directory. Models do not need repository plumbing, and following that pointer
      // could expose checkout credentials stored by Actions. Remove it only after Juror has
      // loaded trusted base-revision config and AGENTS.md files.
      await rm(path.join(target, '.git'), { force: true });
    },
    cleanup: async () => {
      const removed = await run(['git', 'worktree', 'remove', '--force', target], {
        cwd: repoDir,
        timeoutMs: 120_000,
      });
      await rm(dir, { recursive: true, force: true });
      if (removed.exitCode !== 0) {
        await run(['git', 'worktree', 'prune'], { cwd: repoDir, timeoutMs: 60_000 });
      }
    },
  };
}
